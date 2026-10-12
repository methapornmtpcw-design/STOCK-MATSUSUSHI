// นำเข้าไฟล์ที่ส่งออกจาก FoodStory (Wongnai POS Owner)
const { readSheet } = require('./xlsx');
const { db, unknownSupplierId } = require('./db');

const num = (s) => +String(s ?? '').replace(/,/g, '') || 0;
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const mostCommon = (values) => {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
};

// รายงาน "ส่วนผสม": สูตรตัดสต็อกของแต่ละเมนู แยกตามสาขา
// สร้างสาขาและวัตถุดิบที่ยังไม่มี อัปเดตราคาและหน่วย แล้วแทนที่สูตรทั้งหมดด้วยชุดใหม่
function importRecipes(source) {
  const rows = readSheet(source);
  const headerAt = rows.findIndex((r) => r.includes('ชื่อสินค้าคงคลัง') && r.includes('ปริมาณที่ใช้'));
  if (headerAt < 0) throw new Error('ไฟล์นี้ไม่ใช่รายงาน "ส่วนผสม" ของ FoodStory');
  const header = rows[headerAt];
  const col = Object.fromEntries(
    Object.entries({
      menuCategory: 'หมวดหมู่',
      menuName: 'ชื่อสินค้า',
      menuCode: 'รหัส',
      item: 'ชื่อสินค้าคงคลัง',
      itemCode: 'รหัสสินค้าคงคลัง',
      tag: 'ป้ายสินค้าคงคลัง',
      price: 'ราคาต่อหน่วย',
      unit: 'หน่วยหลัก',
      qty: 'ปริมาณที่ใช้',
      branch: 'สาขา',
    }).map(([key, title]) => [key, header.indexOf(title)])
  );
  const missing = Object.entries(col).filter(([, i]) => i < 0);
  if (missing.length) throw new Error(`ไม่พบคอลัมน์: ${missing.map(([k]) => k).join(', ')}`);

  const data = rows
    .slice(headerAt + 1)
    .map((r) => Object.fromEntries(Object.entries(col).map(([key, i]) => [key, clean(r[i])])))
    .filter((r) => r.item && r.branch && r.menuName);

  const byItem = new Map();
  for (const r of data) byItem.set(r.item, [...(byItem.get(r.item) || []), r]);

  const summary = { rows: data.length, branches: 0, items: byItem.size, newItems: 0, menus: 0, unitConflicts: [] };

  db.exec('BEGIN');
  try {
    const supplierId = unknownSupplierId();

    const branchIds = new Map();
    for (const name of new Set(data.map((r) => r.branch))) {
      db.prepare('INSERT OR IGNORE INTO branches (name) VALUES (?)').run(name);
      branchIds.set(name, db.prepare('SELECT id FROM branches WHERE name = ?').get(name).id);
    }
    summary.branches = branchIds.size;

    const itemIds = new Map();
    const itemUnits = new Map();
    for (const [name, list] of byItem) {
      const unit = mostCommon(list.map((r) => r.unit));
      const code = mostCommon(list.map((r) => r.itemCode)) || null;
      const category = mostCommon(list.map((r) => r.tag)) || 'ไม่ระบุหมวด';
      // ราคาต่อหน่วยเฉลี่ยของแถวที่ใช้หน่วยหลักเดียวกัน
      const prices = list.filter((r) => r.unit === unit).map((r) => num(r.price));
      const price = Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100;
      const existing = db.prepare('SELECT id FROM items WHERE name = ?').get(name);
      if (existing) {
        db.prepare('UPDATE items SET code = ?, category = ?, unit = ?, price = ? WHERE id = ?').run(
          code, category, unit, price, existing.id
        );
        itemIds.set(name, existing.id);
      } else {
        const { lastInsertRowid } = db
          .prepare(
            "INSERT INTO items (name, code, category, unit, policy, supplier_id, price, pack) VALUES (?, ?, ?, ?, 'weekly', ?, ?, 1)"
          )
          .run(name, code, category, unit, supplierId, price);
        itemIds.set(name, Number(lastInsertRowid));
        summary.newItems++;
      }
      itemUnits.set(name, unit);
      const units = [...new Set(list.map((r) => r.unit).filter(Boolean))];
      if (units.length > 1) summary.unitConflicts.push({ item: name, units });
    }

    db.exec('DELETE FROM recipes');
    const addRecipe = db.prepare(
      'INSERT INTO recipes (branch_id, menu_category, menu_name, menu_code, item_id, qty, unit) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const r of data)
      addRecipe.run(
        branchIds.get(r.branch), r.menuCategory, r.menuName, r.menuCode || null, itemIds.get(r.item), num(r.qty), r.unit
      );
    summary.menus = new Set(data.map((r) => `${r.branch}|${r.menuCode}|${r.menuName}`)).size;
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return summary;
}

// ตารางผู้จัดจำหน่ายที่คัดลอกจากหน้าเว็บ FoodStory: หนึ่งช่องต่อหนึ่งบรรทัด ช่องที่ว่างจะหายไป
// แต่ละรายการจบด้วยช่อง VAT (มี/ไม่มี) ตามด้วยตัวเลขจำนวนรายการ
function parseSuppliers(text) {
  const lines = String(text).split(/\r?\n/).map(clean).filter(Boolean);
  const isVat = (s) => s === 'มี' || s === 'ไม่มี';
  const suppliers = [];
  let start = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!isVat(lines[i]) || !/^\d+$/.test(lines[i + 1]) || i === start) continue;
    const [name, ...rest] = lines.slice(start, i);
    if (/^[A-Za-z]$/.test(rest[0] ?? '')) rest.shift(); // ตัวอักษรประเภทหลังชื่อ
    const supplier = {
      name,
      code: /^\d{1,4}$/.test(rest[0] ?? '') ? rest.shift() : null,
      address: null,
      tax_id: null,
      credit_days: null,
      vat: lines[i] === 'มี' ? 1 : 0,
      fs_item_count: +lines[i + 1],
    };
    for (const value of rest) {
      if (/^\d{13}$/.test(value)) supplier.tax_id = value;
      else if (/^\d{1,3}$/.test(value)) supplier.credit_days = +value;
      else if (value !== '-') supplier.address = value;
    }
    suppliers.push(supplier);
    start = i + 2;
  }
  if (!suppliers.length) throw new Error('อ่านรายชื่อผู้จัดจำหน่ายจากข้อความนี้ไม่ได้');
  return suppliers;
}

// เพิ่มผู้จัดจำหน่ายใหม่ และอัปเดตรายที่ชื่อตรงกัน ไม่แตะระยะเวลาส่งของที่ตั้งไว้แล้ว
function importSuppliers(text) {
  const suppliers = parseSuppliers(text);
  const summary = { total: suppliers.length, added: 0, updated: 0 };
  db.exec('BEGIN');
  try {
    for (const s of suppliers) {
      const existing = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(s.name);
      if (existing) summary.updated++;
      else {
        db.prepare('INSERT INTO suppliers (name, lead_days) VALUES (?, 1)').run(s.name);
        summary.added++;
      }
      db.prepare(
        'UPDATE suppliers SET code = ?, address = ?, tax_id = ?, credit_days = ?, vat = ?, fs_item_count = ? WHERE name = ?'
      ).run(s.code, s.address, s.tax_id, s.credit_days, s.vat, s.fs_item_count, s.name);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return summary;
}

module.exports = { importRecipes, importSuppliers, parseSuppliers };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('วิธีใช้: node foodstory.js <ไฟล์ส่วนผสม.xlsx | รายชื่อผู้จัดจำหน่าย.txt>');
    process.exit(1);
  }
  const result = file.endsWith('.txt')
    ? importSuppliers(require('node:fs').readFileSync(file, 'utf8'))
    : importRecipes(file);
  console.log(JSON.stringify(result, null, 2));
}
