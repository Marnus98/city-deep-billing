// auth.js - minimal cookie-session auth, no external dependencies.
// Sessions are held in-memory (fine for a single-process prototype) and the cookie is an
// HMAC-signed random token so it can't be forged without the server secret.
const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const sessions = new Map(); // token -> { userId, username, role, fullName, createdAt }

function sign(value) {
  const h = crypto.createHmac('sha256', SECRET).update(value).digest('hex');
  return `${value}.${h}`;
}
function unsign(signed) {
  if (!signed) return null;
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const h = signed.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(value).digest('hex');
  if (h.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(expected))) return null;
  return value;
}

function verifyPassword(password, salt, hash) {
  const computed = crypto.scryptSync(password, salt, 64).toString('hex');
  return computed.length === hash.length && crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
}

// `currentProperty` (a slug from properties.js) rides along on the in-memory session so a single
// login can browse whichever property the nav dropdown last selected, without touching the DB -
// see server.js's /switch-property route and getRequestPropertyDb().
function createSession(user, defaultPropertySlug) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, {
    userId: user.id, username: user.username, role: user.role, fullName: user.full_name,
    createdAt: Date.now(), currentProperty: defaultPropertySlug,
  });
  return token;
}
function destroySession(token) { sessions.delete(token); }

function setCurrentProperty(req, slug) {
  const raw = getCookie(req, 'sid');
  const token = unsign(raw);
  const session = token && sessions.get(token);
  if (!session) return false;
  session.currentProperty = slug;
  return true;
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function currentUser(req) {
  const raw = getCookie(req, 'sid');
  const token = unsign(raw);
  if (!token) return null;
  return sessions.get(token) || null;
}

function setSessionCookie(res, token) {
  const signed = sign(token);
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(signed)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=28800`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
}

// Role hierarchy for simple gating. Roles: admin, billing, reviewer, readonly.
const CAN_EDIT = new Set(['admin', 'billing', 'reviewer']);
const CAN_FINALISE = new Set(['admin', 'reviewer']);
const CAN_MANAGE = new Set(['admin']);

module.exports = {
  verifyPassword, createSession, destroySession, currentUser, setCurrentProperty,
  setSessionCookie, clearSessionCookie, getCookie,
  CAN_EDIT, CAN_FINALISE, CAN_MANAGE,
};
