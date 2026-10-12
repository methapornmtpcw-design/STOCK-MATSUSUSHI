// ล็อกอินด้วยรหัสผ่านเดียวจากตัวแปร APP_PASSWORD และคุกกี้เซสชันที่เซ็นด้วย HMAC
// ไม่ตั้ง APP_PASSWORD = ไม่ต้องล็อกอิน (ใช้ในเครื่องตัวเอง) แต่บนโฮสต์ออนไลน์จะไม่ยอมให้บริการจนกว่าจะตั้ง
const crypto = require('node:crypto');

const PASSWORD = process.env.APP_PASSWORD || '';
const HOSTED = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME);
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;
const LOCK_MINUTES = 15;

// เปลี่ยนรหัสผ่านแล้วเซสชันเดิมทั้งหมดใช้ไม่ได้ทันที
const secret = crypto.createHash('sha256').update(`session:${PASSWORD}`).digest();
const sign = (value) => crypto.createHmac('sha256', secret).update(value).digest('hex');
const sameText = (a, b) =>
  crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());

const failures = new Map(); // ip -> { count, until }

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}

function isLoggedIn(req) {
  if (!PASSWORD) return true;
  const token = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
  const [expires, signature] = token.split('.');
  return Boolean(expires && signature) && +expires > Date.now() && sameText(signature, sign(expires));
}

// คืนค่าคุกกี้เมื่อรหัสผ่านถูก โยนข้อผิดพลาดเมื่อผิดหรือถูกล็อกชั่วคราว
function login(req, password) {
  const ip = clientIp(req);
  const record = failures.get(ip);
  if (record && record.count >= MAX_FAILURES && record.until > Date.now())
    throw new Error(`ใส่รหัสผ่านผิดหลายครั้ง ลองใหม่ในอีก ${LOCK_MINUTES} นาที`);
  if (!sameText(String(password ?? ''), PASSWORD)) {
    const count = record && record.until > Date.now() ? record.count + 1 : 1;
    failures.set(ip, { count, until: Date.now() + LOCK_MINUTES * 60 * 1000 });
    throw new Error('รหัสผ่านไม่ถูกต้อง');
  }
  failures.delete(ip);
  const expires = String(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  return cookie(`${expires}.${sign(expires)}`, SESSION_DAYS * 24 * 60 * 60);
}

const cookie = (value, maxAge) =>
  `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${HOSTED ? '; Secure' : ''}`;
const logoutCookie = () => cookie('', 0);

module.exports = { enabled: Boolean(PASSWORD), misconfigured: HOSTED && !PASSWORD, HOSTED, isLoggedIn, login, logoutCookie };
