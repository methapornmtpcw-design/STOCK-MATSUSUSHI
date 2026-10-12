const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// เซิร์ฟเวอร์ออนไลน์มักตั้งเวลาเป็น UTC: ใช้เวลาไทยเพื่อให้วันที่ของเอกสารและยอดใช้ตรงกับร้าน
process.env.TZ ||= 'Asia/Bangkok';

// ที่เก็บไฟล์ฐานข้อมูล: STOCK_DB กำหนดเองได้ / บน Railway ใช้ดิสก์ถาวร (Volume) / ในเครื่องเก็บข้างโค้ด
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const dbPath = process.env.STOCK_DB || path.join(volume || __dirname, 'stock.db');
const restorePath = `${dbPath}.restore`;

// ไฟล์กู้คืนที่อัปโหลดไว้ก่อนรีสตาร์ต: สลับเข้ามาแทนก่อนเปิดฐานข้อมูล และเก็บของเดิมไว้เผื่อย้อนกลับ
if (fs.existsSync(restorePath)) {
  if (fs.existsSync(dbPath)) fs.renameSync(dbPath, `${dbPath}.before-restore`);
  fs.renameSync(restorePath, dbPath);
}

const db = new DatabaseSync(dbPath);

// วันที่แบบ YYYY-MM-DD ตามเวลาเครื่อง
const today = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('sv-SE');
};

db.exec(`
CREATE TABLE IF NOT EXISTS branches (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, contact TEXT,
  lead_days INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, code TEXT, category TEXT NOT NULL, unit TEXT NOT NULL,
  -- weekly = สั่งรายสัปดาห์ตามยอดใช้ 7 วันล่าสุด, daily = สั่งทุกวันเติมถึงพาร์, rop = สั่งเมื่อถึงจุดสั่งซื้อ
  policy TEXT NOT NULL CHECK (policy IN ('weekly', 'daily', 'rop')),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  price REAL NOT NULL DEFAULT 0,
  pack REAL NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS par (
  branch_id INTEGER NOT NULL, item_id INTEGER NOT NULL, par_qty REAL NOT NULL,
  PRIMARY KEY (branch_id, item_id)
);
-- qty เป็นบวกเมื่อของเข้า ลบเมื่อของออก ยอดคงเหลือ = ผลรวม qty
CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY, day TEXT NOT NULL, branch_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('receive', 'use', 'waste', 'adjust')),
  qty REAL NOT NULL, ref TEXT
);
CREATE INDEX IF NOT EXISTS movements_lookup ON movements (branch_id, item_id, day);
CREATE TABLE IF NOT EXISTS po (
  id INTEGER PRIMARY KEY, created TEXT NOT NULL, supplier_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'received')),
  deliver_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS po_lines (
  id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
  qty REAL NOT NULL, price REAL NOT NULL, received_qty REAL
);
-- ผู้จัดจำหน่ายทั้งหมดที่ซื้อสินค้านี้ได้ รายหลักที่ใช้ออกใบสั่งซื้อคือ items.supplier_id
CREATE TABLE IF NOT EXISTS item_suppliers (
  item_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL,
  PRIMARY KEY (item_id, supplier_id)
);
-- สูตรตัดสต็อกจาก FoodStory: ขายเมนูนี้ 1 หน่วย ใช้วัตถุดิบ qty ในหน่วยหลักของวัตถุดิบ
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL, menu_category TEXT, menu_name TEXT NOT NULL,
  menu_code TEXT, item_id INTEGER NOT NULL, qty REAL NOT NULL, unit TEXT NOT NULL
);
`);

// ฐานข้อมูลเดิมยังไม่รู้จักวิธีสั่งรายสัปดาห์: สร้างตาราง items ใหม่ให้รับค่าได้
// สินค้าเดิมใช้ค่าเริ่มต้น rop ที่ระบบตั้งให้ จึงย้ายเป็นรายสัปดาห์ซึ่งเป็นค่าเริ่มต้นใหม่
if (!db.prepare("SELECT sql FROM sqlite_master WHERE name = 'items'").get().sql.includes("'weekly'")) {
  db.exec(`
    BEGIN;
    CREATE TABLE items_new (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, code TEXT, category TEXT NOT NULL, unit TEXT NOT NULL,
      policy TEXT NOT NULL CHECK (policy IN ('weekly', 'daily', 'rop')),
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      price REAL NOT NULL DEFAULT 0,
      pack REAL NOT NULL DEFAULT 1
    );
    INSERT INTO items_new (id, name, code, category, unit, policy, supplier_id, price, pack)
      SELECT id, name, code, category, unit, CASE policy WHEN 'rop' THEN 'weekly' ELSE policy END, supplier_id, price, pack
      FROM items;
    DROP TABLE items;
    ALTER TABLE items_new RENAME TO items;
    COMMIT;
  `);
}

// คอลัมน์ที่เพิ่มภายหลัง ใส่ให้ฐานข้อมูลเดิมที่ยังไม่มี
function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('suppliers', 'code', 'TEXT');
addColumn('suppliers', 'address', 'TEXT');
addColumn('suppliers', 'tax_id', 'TEXT');
addColumn('suppliers', 'credit_days', 'INTEGER');
addColumn('suppliers', 'vat', 'INTEGER');
addColumn('suppliers', 'fs_item_count', 'INTEGER');
// หน่วยสั่งซื้อที่ต่างจากหน่วยสต็อก: 1 หน่วยสั่งซื้อ = unit_factor หน่วยสต็อก
addColumn('po_lines', 'unit', 'TEXT');
addColumn('po_lines', 'unit_factor', 'REAL');
// ข้อมูลบนเอกสารใบสั่งซื้อ: ผู้สั่งซื้อคือนิติบุคคลของสาขา ใบสั่งซื้อหนึ่งใบจึงเป็นของสาขาเดียว
addColumn('branches', 'address', 'TEXT');
addColumn('branches', 'tax_id', 'TEXT');
addColumn('branches', 'phone', 'TEXT');
addColumn('po', 'branch_id', 'INTEGER');
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
// หน่วยสั่งซื้อที่ใช้ล่าสุดของสินค้า ใช้เป็นค่าเริ่มต้นของรอบถัดไป
addColumn('items', 'order_unit', 'TEXT');
addColumn('items', 'order_factor', 'REAL');

// ชื่อที่ใช้พักสินค้าที่ยังไม่ได้เลือกผู้จัดจำหน่าย ไม่นับเป็นผู้จัดจำหน่ายจริงใน item_suppliers
const UNKNOWN_SUPPLIER = 'ยังไม่ระบุซัพพลายเออร์';

function unknownSupplierId() {
  db.prepare('INSERT OR IGNORE INTO suppliers (name, lead_days) VALUES (?, 1)').run(UNKNOWN_SUPPLIER);
  return db.prepare('SELECT id FROM suppliers WHERE name = ?').get(UNKNOWN_SUPPLIER).id;
}

// ฐานข้อมูลเดิมที่มีแต่รายหลัก: ใส่รายหลักเข้าไปในรายการผู้จัดจำหน่ายของสินค้า
db.prepare(
  `INSERT OR IGNORE INTO item_suppliers (item_id, supplier_id)
   SELECT i.id, i.supplier_id FROM items i JOIN suppliers s ON s.id = i.supplier_id WHERE s.name <> ?`
).run(UNKNOWN_SUPPLIER);

function seed() {
  // สุ่มแบบกำหนดค่าเริ่มต้น เพื่อให้ข้อมูลตัวอย่างเหมือนเดิมทุกครั้ง
  let s = 42;
  const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);

  const branches = ['สาขา 1', 'สาขา 2', 'สาขา 3', 'สาขา 4'];
  const branchFactor = [1.2, 1.0, 0.8, 0.6];
  const suppliers = [
    ['ตลาดผักสด', 'LINE: @freshveg', 1],
    ['ตัวแทนเครื่องดื่ม', 'LINE: @drinks', 2],
    ['ผู้นำเข้าสาเก', 'LINE: @sake', 5],
    ['ห้องเย็นอาหารแช่แข็ง', 'LINE: @frozen', 3],
  ];
  // ชื่อ, หมวด, หน่วย, นโยบาย, ซัพพลายเออร์, ราคา, ขนาดแพ็ก, ยอดใช้เฉลี่ยต่อวันต่อสาขา
  const items = [
    ['กะหล่ำปลี', 'ผักสด', 'กก.', 'daily', 1, 25, 1, 6],
    ['ต้นหอมญี่ปุ่น', 'ผักสด', 'กก.', 'daily', 1, 120, 1, 2],
    ['แตงกวาญี่ปุ่น', 'ผักสด', 'กก.', 'daily', 1, 60, 1, 3],
    ['หัวไชเท้า', 'ผักสด', 'กก.', 'daily', 1, 30, 1, 4],
    ['ผักกาดหอม', 'ผักสด', 'กก.', 'daily', 1, 80, 1, 2],
    ['น้ำดื่ม 600 มล.', 'เครื่องดื่ม', 'ขวด', 'rop', 2, 6, 12, 30],
    ['โค้ก 325 มล.', 'เครื่องดื่ม', 'กระป๋อง', 'rop', 2, 13, 24, 20],
    ['เบียร์อาซาฮี 330 มล.', 'เครื่องดื่ม', 'ขวด', 'rop', 2, 55, 24, 15],
    ['สาเก Dassai 45 720 มล.', 'สาเก', 'ขวด', 'rop', 3, 1450, 6, 1.2],
    ['สาเก Hakutsuru 1.8 ล.', 'สาเก', 'ขวด', 'rop', 3, 890, 6, 0.8],
    ['แซลมอนแช่แข็ง', 'แช่แข็ง', 'กก.', 'rop', 4, 520, 5, 4],
    ['กุ้งเทมปุระแช่แข็ง', 'แช่แข็ง', 'ถุง', 'rop', 4, 180, 10, 5],
    ['เกี๊ยวซ่าแช่แข็ง', 'แช่แข็ง', 'ถุง', 'rop', 4, 95, 10, 4],
  ];

  const HISTORY_DAYS = 14;
  const addMove = db.prepare(
    'INSERT INTO movements (day, branch_id, item_id, type, qty, ref) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const addPar = db.prepare('INSERT INTO par (branch_id, item_id, par_qty) VALUES (?, ?, ?)');

  db.exec('BEGIN');
  branches.forEach((name) => db.prepare('INSERT INTO branches (name) VALUES (?)').run(name));
  suppliers.forEach((row) =>
    db.prepare('INSERT INTO suppliers (name, contact, lead_days) VALUES (?, ?, ?)').run(...row)
  );
  items.forEach((row) =>
    db
      .prepare(
        'INSERT INTO items (name, category, unit, policy, supplier_id, price, pack) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(...row.slice(0, 7))
  );

  items.forEach((row, idx) => {
    const [, , unit, policy, supplierId, , pack, avgUse] = row;
    const itemId = idx + 1;
    const lead = suppliers[supplierId - 1][2];
    const round = (n) => (unit === 'กก.' ? Math.round(n * 10) / 10 : Math.round(n));

    branchFactor.forEach((factor, bIdx) => {
      const branchId = bIdx + 1;
      const avg = avgUse * factor;
      const par =
        policy === 'daily' ? Math.ceil(avg * 1.3) : Math.ceil((avg * (lead + 7)) / pack) * pack;
      addPar.run(branchId, itemId, par);

      const uses = [];
      for (let d = HISTORY_DAYS; d >= 1; d--) uses.push([d, round(avg * (0.7 + rand() * 0.6))]);
      const ending = round(par * (policy === 'daily' ? rand() * 0.4 : 0.1 + rand() * 0.9));
      const opening = uses.reduce((sum, [, q]) => sum + q, 0) + ending;

      addMove.run(today(-HISTORY_DAYS - 1), branchId, itemId, 'receive', opening, 'ยอดยกมา');
      uses.forEach(([d, q]) => q > 0 && addMove.run(today(-d), branchId, itemId, 'use', -q, null));
    });
  });
  db.exec('COMMIT');
}

// ข้อมูลตัวอย่างสำหรับทดลองระบบ: node server.js --sample (ใช้ได้กับฐานข้อมูลที่ยังว่างเท่านั้น)
if (process.argv.includes('--sample') && db.prepare('SELECT COUNT(*) n FROM branches').get().n === 0)
  seed();

module.exports = { db, today, unknownSupplierId, dbPath, restorePath, hasVolume: Boolean(volume) };
