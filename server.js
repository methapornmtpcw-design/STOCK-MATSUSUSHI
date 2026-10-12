const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { db, today, unknownSupplierId, dbPath, restorePath, hasVolume } = require('./db');
const auth = require('./auth');
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
        "SELECT l.branch_id, l.item_id, SUM(l.qty * COALESCE(l.unit_factor, 1)) q FROM po_lines l JOIN po p ON p.id = l.po_id WHERE p.status = 'approved' GROUP BY l.branch_id, l.item_id"
      )
      .all()
  );
  const pars = toMap(db.prepare('SELECT branch_id, item_id, par_qty q FROM par').all());
  // ยอดที่ออกจากสต็อกในช่วงวัน (ใช้ไปและของเสีย) เพราะทั้งสองอย่างต้องซื้อมาทดแทน
  const consumed = (from, to) =>
    toMap(
      db
        .prepare(
          "SELECT branch_id, item_id, -SUM(qty) q FROM movements WHERE type IN ('use', 'waste') AND day > ? AND day <= ? GROUP BY branch_id, item_id"
        )
        .all(today(from), today(to))
    );
  const week = consumed(-7, 0);
  const prevWeek = consumed(-14, -7);
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
      const weekUse = r2(week.get(k) || 0);
      // รายสัปดาห์: สั่งให้มีพอกับยอดใช้ 7 วันล่าสุด / รายวัน: เติมถึงพาร์ / จุดสั่งซื้อ: สั่งเมื่อเหลือถึงจุดที่กำหนด
      const target = it.policy === 'weekly' ? weekUse : par;
      const rop = it.policy === 'rop' ? avg * (it.lead_days + SAFETY_DAYS) : target;
      const due = it.policy === 'rop' ? position <= rop : position < target;
      const need = due ? Math.max(0, Math.ceil(r2(target - position) / it.pack) * it.pack) : 0;
      rows.push({
        branch_id: b.id,
        item_id: it.id,
        on_hand: have,
        on_order: onOrder,
        avg_use: r2(avg),
        week_use: weekUse,
        prev_week_use: r2(prevWeek.get(k) || 0),
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
    .map((p) => {
      const own = lines.filter((l) => l.po_id === p.id);
      // ใบสั่งซื้อรุ่นเก่าไม่ได้เก็บสาขาไว้ ใช้สาขาของบรรทัดแรกแทน
      return { ...p, branch_id: p.branch_id ?? own[0]?.branch_id ?? null, lines: own };
    });
  const itemSuppliers = new Map();
  for (const { item_id, supplier_id } of db.prepare('SELECT * FROM item_suppliers').all())
    itemSuppliers.set(item_id, [...(itemSuppliers.get(item_id) || []), supplier_id]);
  return {
    today: today(),
    unknown_supplier_id: unknownSupplierId(),
    auth: auth.enabled,
    // ออนไลน์แต่ไม่มีดิสก์ถาวร: ข้อมูลจะหายเมื่อ deploy ใหม่
    storage_warning: auth.HOSTED && !hasVolume && !process.env.STOCK_DB,
    settings: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value])),
    branches: db.prepare('SELECT * FROM branches').all(),
    suppliers: db.prepare('SELECT * FROM suppliers ORDER BY name').all(),
    items: db
      .prepare('SELECT * FROM items')
      .all()
      .map((it) => ({ ...it, supplier_ids: itemSuppliers.get(it.id) || [] })),
    rows: computeRows(),
    pos,
    units: db
      .prepare('SELECT unit FROM items UNION SELECT unit FROM recipes UNION SELECT order_unit FROM items')
      .all()
      .map((r) => r.unit)
      .filter(Boolean)
      .sort(),
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
  // สร้างร่างใบสั่งซื้อจากบรรทัดที่ยืนยันในหน้าแนะนำสั่งซื้อ แยกตามผู้จัดจำหน่ายที่เลือกในแต่ละบรรทัด
  '/api/po/generate': ({ lines = [] }) =>
    transaction(() => {
      const unknown = unknownSupplierId();
      const items = new Map(db.prepare('SELECT * FROM items').all().map((i) => [i.id, i]));
      const suppliers = new Map(db.prepare('SELECT * FROM suppliers').all().map((s) => [s.id, s]));
      const branches = new Set(db.prepare('SELECT id FROM branches').all().map((b) => b.id));
      const wanted = lines
        .map((l) => ({ ...l, qty: +l.qty || 0, price: Math.max(0, +l.price || 0), factor: +l.factor > 0 ? +l.factor : 1 }))
        .filter((l) => l.qty > 0);
      if (!wanted.length) throw new Error('ยังไม่มีรายการที่จะสั่ง');
      for (const l of wanted) {
        const item = items.get(l.item_id);
        if (!item || !branches.has(l.branch_id)) throw new Error('พบรายการที่ไม่มีในระบบ');
        if (l.supplier_id === unknown || !suppliers.has(l.supplier_id))
          throw new Error(`ยังไม่ได้เลือกผู้จัดจำหน่ายของ ${item.name}`);
      }

      db.exec(
        "DELETE FROM po_lines WHERE po_id IN (SELECT id FROM po WHERE status = 'draft'); DELETE FROM po WHERE status = 'draft';"
      );
      // ใบสั่งซื้อแยกตามผู้จัดจำหน่ายและสาขา เพราะแต่ละสาขาเป็นผู้สั่งซื้อคนละนิติบุคคล
      const poIds = new Map();
      const orderUnits = new Map();
      wanted.sort((a, b) => a.supplier_id - b.supplier_id || a.branch_id - b.branch_id);
      for (const l of wanted) {
        const poKey = key(l.supplier_id, l.branch_id);
        const item = items.get(l.item_id);
        const unit = l.unit || item.unit;
        const factor = unit === item.unit ? 1 : l.factor;
        if (!poIds.has(poKey)) {
          const { lastInsertRowid } = db
            .prepare("INSERT INTO po (created, supplier_id, branch_id, status, deliver_date) VALUES (?, ?, ?, 'draft', ?)")
            .run(today(), l.supplier_id, l.branch_id, today(suppliers.get(l.supplier_id).lead_days));
          poIds.set(poKey, lastInsertRowid);
        }
        db.prepare(
          'INSERT INTO po_lines (po_id, branch_id, item_id, qty, price, unit, unit_factor) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(poIds.get(poKey), l.branch_id, l.item_id, l.qty, l.price, unit, factor);

        // จำหน่วยสั่งซื้อและผู้จัดจำหน่ายที่ใช้ ไว้เป็นค่าเริ่มต้นของรอบถัดไป
        // ถ้าสาขาหนึ่งสั่งเป็นหน่วยอื่นและอีกสาขาสั่งเป็นหน่วยสต็อก ให้จำหน่วยอื่นไว้
        if (!orderUnits.has(item.id) || unit !== item.unit) orderUnits.set(item.id, { unit, factor });
        db.prepare('INSERT OR IGNORE INTO item_suppliers (item_id, supplier_id) VALUES (?, ?)').run(item.id, l.supplier_id);
        if (item.supplier_id === unknown) {
          db.prepare('UPDATE items SET supplier_id = ? WHERE id = ?').run(l.supplier_id, item.id);
          item.supplier_id = l.supplier_id;
        }
      }
      for (const [id, { unit, factor }] of orderUnits)
        db.prepare('UPDATE items SET order_unit = ?, order_factor = ? WHERE id = ?').run(unit, factor, id);
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
          addMove.run(
            today(), line.branch_id, line.item_id, 'receive', r2(received_qty * (line.unit_factor || 1)), `PO-${id}`
          );
      }
      db.prepare("UPDATE po SET status = 'received' WHERE id = ?").run(id);
    }),

  // แก้ข้อมูลสั่งซื้อของสินค้า: ส่งมาเฉพาะช่องที่ต้องการเปลี่ยน
  '/api/item': ({ id, policy, pack }) => {
    if (policy != null) db.prepare('UPDATE items SET policy = ? WHERE id = ?').run(policy, id);
    if (pack != null) db.prepare('UPDATE items SET pack = ? WHERE id = ?').run(pack > 0 ? pack : 1, id);
  },

  // กำหนดผู้จัดจำหน่ายทั้งชุดของสินค้าหนึ่งรายการ รายหลักคือรายที่ใช้ออกใบสั่งซื้อ
  '/api/item/suppliers': ({ id, supplier_ids, primary_id }) =>
    transaction(() => {
      const unknown = unknownSupplierId();
      const chosen = [...new Set(supplier_ids)].filter((s) => s !== unknown);
      db.prepare('DELETE FROM item_suppliers WHERE item_id = ?').run(id);
      for (const s of chosen)
        db.prepare('INSERT INTO item_suppliers (item_id, supplier_id) VALUES (?, ?)').run(id, s);
      const primary = chosen.includes(primary_id) ? primary_id : chosen[0] ?? unknown;
      db.prepare('UPDATE items SET supplier_id = ? WHERE id = ?').run(primary, id);
    }),

  // เพิ่มผู้จัดจำหน่ายหนึ่งรายให้สินค้าหลายรายการ ตั้งเป็นรายหลักเมื่อสั่ง หรือเมื่อสินค้ายังไม่มีรายหลัก
  '/api/items/supplier': ({ ids, supplier_id, primary }) =>
    transaction(() => {
      const unknown = unknownSupplierId();
      if (supplier_id === unknown || !db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplier_id))
        throw new Error('เลือกผู้จัดจำหน่ายก่อน');
      for (const id of ids) {
        db.prepare('INSERT OR IGNORE INTO item_suppliers (item_id, supplier_id) VALUES (?, ?)').run(id, supplier_id);
        const item = db.prepare('SELECT supplier_id FROM items WHERE id = ?').get(id);
        if (item && (primary || item.supplier_id === unknown))
          db.prepare('UPDATE items SET supplier_id = ? WHERE id = ?').run(supplier_id, id);
      }
    }),

  // แก้ข้อมูลผู้จัดจำหน่าย: ส่งมาเฉพาะช่องที่ต้องการเปลี่ยน
  '/api/supplier': ({ id, ...fields }) => {
    const text = (v) => String(v ?? '').trim() || null;
    const days = (v) => (v === '' || v == null ? null : Math.max(0, Math.round(+v) || 0));
    const clean = {
      lead_days: (v) => days(v) ?? 1,
      credit_days: days,
      vat: (v) => (v === '' || v == null ? null : +v ? 1 : 0),
      address: text,
      tax_id: text,
      contact: text,
    };
    for (const [field, value] of Object.entries(fields))
      if (clean[field]) db.prepare(`UPDATE suppliers SET ${field} = ? WHERE id = ?`).run(clean[field](value), id);
  },

  '/api/branch': ({ id, address, tax_id, phone }) =>
    db
      .prepare('UPDATE branches SET address = ?, tax_id = ?, phone = ? WHERE id = ?')
      .run(String(address ?? '').trim() || null, String(tax_id ?? '').trim() || null, String(phone ?? '').trim() || null, id),

  // ค่าที่ใช้บนเอกสารใบสั่งซื้อ
  '/api/settings': (values) => {
    const allowed = ['buyer_name', 'buyer_position', 'vat_rate', 'price_includes_vat', 'signature'];
    for (const k of allowed)
      if (k in values)
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
          k, String(values[k] ?? '')
        );
  },

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

// รับไฟล์ฐานข้อมูลสำรอง ตรวจว่าเป็นฐานข้อมูลของระบบนี้ แล้ววางไว้รอสลับตอนเริ่มทำงานรอบถัดไป
function stageRestore(buffer) {
  if (buffer.subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw new Error('ไฟล์นี้ไม่ใช่ไฟล์สำรองของระบบ');
  fs.writeFileSync(restorePath, buffer);
  try {
    const check = new DatabaseSync(restorePath, { readOnly: true });
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    check.close();
    if (!['items', 'branches', 'movements'].every((t) => tables.includes(t))) throw new Error('ไม่พบตารางของระบบ');
  } catch (err) {
    fs.rmSync(restorePath, { force: true });
    throw new Error(`ไฟล์สำรองใช้ไม่ได้: ${err.message}`);
  }
}

const page = (name) => fs.readFileSync(path.join(__dirname, 'public', name));

http
  .createServer(async (req, res) => {
    const json = (code, body, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(body));
    };
    const html = (name) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page(name));
    };
    try {
      const url = req.url.split('?')[0];
      if (url === '/health') return json(200, { ok: true });
      if (auth.misconfigured) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('ยังไม่ได้ตั้งรหัสผ่าน: เพิ่มตัวแปร APP_PASSWORD ในการตั้งค่าของโฮสต์ แล้ว deploy ใหม่');
      }

      if (req.method === 'POST' && url === '/api/login') {
        const { password } = JSON.parse(await readBody(req));
        try {
          return json(200, { ok: true }, { 'set-cookie': auth.login(req, password) });
        } catch (err) {
          return json(401, { error: err.message });
        }
      }
      if (req.method === 'POST' && url === '/api/logout') return json(200, { ok: true }, { 'set-cookie': auth.logoutCookie() });
      if (req.method === 'GET' && url === '/login') {
        if (auth.isLoggedIn(req)) return res.writeHead(302, { location: '/' }).end();
        return html('login.html');
      }
      if (!auth.isLoggedIn(req)) {
        if (url.startsWith('/api/')) return json(401, { error: 'กรุณาเข้าสู่ระบบ' });
        return res.writeHead(302, { location: '/login' }).end();
      }

      if (req.method === 'GET' && url === '/api/state') return json(200, getState());
      if (req.method === 'GET' && url === '/api/backup') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="stock-backup-${today()}.db"`,
        });
        return res.end(fs.readFileSync(dbPath));
      }
      if (req.method === 'POST' && url === '/api/restore') {
        stageRestore(await readBody(req));
        json(200, { ok: true, restarting: auth.HOSTED });
        // บนโฮสต์ออนไลน์ระบบจะถูกเปิดใหม่เองและใช้ไฟล์ที่กู้คืน ในเครื่องต้องปิดแล้วเปิดเซิร์ฟเวอร์เอง
        if (auth.HOSTED) setTimeout(() => process.exit(0), 500);
        return;
      }
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
      if (req.method === 'GET' && url === '/') return html('index.html');
      json(404, { error: 'ไม่พบหน้านี้' });
    } catch (err) {
      json(400, { error: err.message });
    }
  })
  .listen(PORT, () => console.log(`ระบบสต็อกและจัดซื้อ: http://localhost:${PORT}`));
