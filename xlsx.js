// ตัวอ่านไฟล์ .xlsx แบบไม่พึ่งไลบรารีภายนอก อ่านเฉพาะชีตแรก คืนค่าเป็นอาร์เรย์ของแถว
const fs = require('node:fs');
const zlib = require('node:zlib');

function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('ไฟล์นี้ไม่ใช่ไฟล์ .xlsx');
  const total = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < total; i++) {
    const method = buf.readUInt16LE(pos + 10);
    const size = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files.set(name, () => (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8'));
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescape = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, '&');

const text = (xml) => unescape([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

function columnIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readSheet(source) {
  const files = unzip(Buffer.isBuffer(source) ? source : fs.readFileSync(source));
  const sheetName = [...files.keys()].filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw new Error('ไม่พบชีตในไฟล์');
  const shared = files.has('xl/sharedStrings.xml')
    ? [...files.get('xl/sharedStrings.xml')().matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => text(m[1]))
    : [];

  const rows = [];
  for (const rowMatch of files.get(sheetName)().matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cell of rowMatch[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = cell[2] || '';
      const ref = /r="([A-Z]+\d+)"/.exec(cell[1])?.[1];
      const type = /t="(\w+)"/.exec(cell[1])?.[1];
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      row[ref ? columnIndex(ref) : row.length] =
        type === 's' ? shared[+value] : type === 'inlineStr' ? text(body) : unescape(value);
    }
    rows.push(Array.from(row, (v) => (v ?? '').trim()));
  }
  return rows;
}

module.exports = { readSheet };
