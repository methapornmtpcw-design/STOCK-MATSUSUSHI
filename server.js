const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db, today } = require('./db');
const { importRecipes, importSuppliers } = require('./foodstory');

const PORT = process.env.PORT || 3210;
const USAGE_DAYS = 14; // ช่วงที่ใช้คำนวณยอดใช้เฉลี่ยต่อวัน
const SAFETY_DAYS = 2; // สต็อกกันชน คิดเป็นจำนวนวันของยอดใช้

const r2 = (n) => Math.round(n * 100) / 100;
const key = (b, i) => `${b}:${i}`;
const toMap = (rows) => new Map(rows.map((r) => [key(r.branch_id, r.item_id), r.q]));

function onHandMap() {
  return toMap(
    db.prepare('SELECT branch_id, item_id, SUM(qty) q FROM movements GROUP BY branch_id, item_id').all()
  );
}

// สถานะสต็อกและจำนวนที่ควรสั่ง ของทุกสินค้าในทุกสาขา
function computeRows() {
  const onHand = onHandMap();
  const used = toMap(
    db
      .prepare(
        "SELECT branch_id, item_id, -SUM(qty) q FROM movements WHERE type = 'use' AND day > ? GROUP BY branch_id, item_id"
      )
      .all(today(-USAGE_DAYS))
  );
  const inbound = toMap(
    db
      .prepare(
        "SELECT l.branch_id, l.item_id, SUM(l.qty) q FROM po_lines l JOIN po p ON p.id = l.po_id WHERE p.status = 'approved' GROUP BY l.branch_id, l.item_id"
      )
      .all()
  );
  const pars = toMap(db.prepare('SELECT branch_id, item_id, par_qty q FROM par').all());
  const branches = db.prepare('SELECT id FROM branches').all();
  const items = db
    .prepare('SELECT i.*, s.lead_days FROM items i JOIN suppliers s ON s.id = i.supplier_id')
    .all();

  const rows = [];
  for (const b of branches) {
    for (const it of items) {
      const k = key(b.id, it.id);
      const have = r2(onHand.get(k) || 0);
      const avg = (used.get(k) || 0) / USAGE_DAYS;
      const par = pars.get(k) || 0;
      const onOrder = inbound.get(k) || 0;
      const position = have + onOrder;
      // ของสดเติมถึงพาร์ทุกวัน ของเก็บนานสั่งเมื่อถึงจุดสั่งซื้อ
      const rop = it.policy === 'daily' ? par : avg * (it.lead_days + SAFETY_DAYS);
      const due = it.policy === 'daily' ? position < par : position <= rop;
      const need = due ? Math.max(0, Math.ceil((par - position) / it.pack) * it.pack) : 0;
      rows.push({
        branch_id: b.id,
        item_id: it.id,
        on_hand: have,
        on_order: onOrder,
        avg_use: r2(avg),
        par,
        rop: r2(rop),
        cover_days: avg > 0 ? r2(have / avg) : null,
        need,
        // สินค้าที่ยังไม่ตั้งพาร์และไม่มีประวัติการใช้ ไม่นับว่าของหมด
        status: have <= 0 && (par > 0 || avg > 0) ? 'out' : need > 0 ? 'low' : 'ok',
      });
    }
  }
  return rows;
}

function getState() {
  const lines = db.prepare('SELECT * FROM po_lines ORDER BY branch_id, item_id').all();
  const pos = db
    .prepare('SELECT * FROM po ORDER BY id DESC')
    .all()
    .map((p) => ({ ...p, lines: lines.filter((l) => l.po_id === p.id) }));
  return {
    today: today(),
    branches: db.prepare('SELECT * FROM branches').all(),
    suppliers: db.prepare('SELECT * FROM suppliers ORDER BY name').all(),
    items: db.prepare('SELECT * FROM items').all(),
    rows: computeRows(),
    pos,
    recipes: db.prepare('SELECT * FROM recipes ORDER BY menu_category, menu_name, id').all(),
  };
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const addMove = db.prepare(
  'INSERT INTO movements (day, branch_id, item_id, type, qty, ref) VALUES (?, ?, ?, ?, ?, ?)'
);

const actions = {
  // นับสต็อกสิ้นวัน: ส่วนต่างจากยอดในระบบถือเป็นยอดใช้ ของเสียบันทึกแยก
  '/api/count': ({ branch_id, lines }) =>
    transaction(() => {
      const onHand = onHandMap();
      for (const { item_id, counted, waste } of lines) {
        let have = onHand.get(key(branch_id, item_id)) || 0;
        if (waste > 0) {
          addMove.run(today(), branch_id, item_id, 'waste', -waste, 'นับสต็อก');
          have -= waste;
        }
        const diff = r2(counted - have);
        if (diff !== 0)
          addMove.run(today(), branch_id, item_id, diff < 0 ? 'use' : 'adjust', diff, 'นับสต็อก');
      }
    }),

  // สร้างร่างใบสั่งซื้อใหม่จากรายการแนะนำ แยกตามซัพพลายเออร์ รวมทุกสาขา
  '/api/po/generate': () =>
    transaction(() => {
      db.exec(
        "DELETE FROM po_lines WHERE po_id IN (SELECT id FROM po WHERE status = 'draft'); DELETE FROM po WHERE status = 'draft';"
      );
      const items = new Map(db.prepare('SELECT * FROM items').all().map((i) => [i.id, i]));
      const suppliers = db.prepare('SELECT * FROM suppliers').all();
      const needs = computeRows().filter((r) => r.need > 0);
      for (const s of suppliers) {
        const mine = needs.filter((r) => items.get(r.item_id).supplier_id === s.id);
        if (!mine.length) continue;
        const { lastInsertRowid: poId } = db
          .prepare("INSERT INTO po (created, supplier_id, status, deliver_date) VALUES (?, ?, 'draft', ?)")
          .run(today(), s.id, today(s.lead_days));
        for (const r of mine)
          db.prepare('INSERT INTO po_lines (po_id, branch_id, item_id, qty, price) VALUES (?, ?, ?, ?, ?)').run(
            poId,
            r.branch_id,
            r.item_id,
            r.need,
            items.get(r.item_id).price
          );
      }
    }),

  '/api/po/line': ({ id, qty }) =>
    db
      .prepare(
        "UPDATE po_lines SET qty = ? WHERE id = ? AND po_id IN (SELECT id FROM po WHERE status = 'draft')"
      )
      .run(Math.max(0, qty), id),

  '/api/po/approve': ({ id }) =>
    transaction(() => {
      db.prepare("DELETE FROM po_lines WHERE po_id = ? AND qty <= 0").run(id);
      db.prepare("UPDATE po SET status = 'approved' WHERE id = ? AND status = 'draft'").run(id);
    }),

  '/api/po/receive': ({ id, lines }) =>
    transaction(() => {
      const po = db.prepare("SELECT * FROM po WHERE id = ? AND status = 'approved'").get(id);
      if (!po) throw new Error('ใบสั่งซื้อนี้ยังไม่อนุมัติหรือรับของไปแล้ว');
      for (const { id: lineId, received_qty } of lines) {
        const line = db.prepare('SELECT * FROM po_lines WHERE id = ? AND po_id = ?').get(lineId, id);
        if (!line) continue;
        db.prepare('UPDATE po_lines SET received_qty = ? WHERE id = ?').run(received_qty, lineId);
        if (received_qty > 0)
          addMove.run(today(), line.branch_id, line.item_id, 'receive', received_qty, `PO-${id}`);
      }
      db.prepare("UPDATE po SET status = 'received' WHERE id = ?").run(id);
    }),

  // แก้ข้อมูลสั่งซื้อของสินค้า: ส่งมาเฉพาะช่องที่ต้องการเปลี่ยน
  '/api/item': ({ id, supplier_id, policy, pack }) => {
    if (supplier_id != null) db.prepare('UPDATE items SET supplier_id = ? WHERE id = ?').run(supplier_id, id);
    if (policy != null) db.prepare('UPDATE items SET policy = ? WHERE id = ?').run(policy, id);
    if (pack != null) db.prepare('UPDATE items SET pack = ? WHERE id = ?').run(pack > 0 ? pack : 1, id);
  },

  '/api/items/supplier': ({ ids, supplier_id }) =>
    transaction(() => {
      if (!db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplier_id))
        throw new Error('ไม่พบผู้จัดจำหน่ายนี้');
      const update = db.prepare('UPDATE items SET supplier_id = ? WHERE id = ?');
      for (const id of ids) update.run(supplier_id, id);
    }),

  '/api/supplier': ({ id, lead_days }) =>
    db.prepare('UPDATE suppliers SET lead_days = ? WHERE id = ?').run(Math.max(0, Math.round(lead_days)), id),

  '/api/par': ({ branch_id, item_id, par_qty }) =>
    db
      .prepare(
        'INSERT INTO par (branch_id, item_id, par_qty) VALUES (?, ?, ?) ON CONFLICT (branch_id, item_id) DO UPDATE SET par_qty = excluded.par_qty'
      )
      .run(branch_id, item_id, Math.max(0, par_qty)),
};

const MAX_UPLOAD = 30 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) return reject(new Error('ไฟล์ใหญ่เกิน 30 MB'));
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

http
  .createServer(async (req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = req.url.split('?')[0];
      if (req.method === 'GET' && url === '/api/state') return json(200, getState());
      if (req.method === 'POST' && url === '/api/import/recipes') {
        const result = importRecipes(await readBody(req));
        return json(200, { ...getState(), result });
      }
      if (req.method === 'POST' && url === '/api/import/suppliers') {
        const result = importSuppliers(JSON.parse(await readBody(req)).text);
        return json(200, { ...getState(), result });
      }
      if (req.method === 'POST' && actions[url]) {
        const body = await readBody(req);
        actions[url](body.length ? JSON.parse(body) : {});
        return json(200, getState());
      }
      if (req.method === 'GET' && url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
      }
      json(404, { error: 'ไม่พบหน้านี้' });
    } catch (err) {
      json(400, { error: err.message });
    }
  })
  .listen(PORT, () => console.log(`ระบบสต็อกและจัดซื้อ: http://localhost:${PORT}`));
