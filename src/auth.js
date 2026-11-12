'use strict';

const crypto = require('node:crypto');

const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return { token, expiresAt };
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function getSessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

function setSessionCookie(res, token, expiresAt) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Expires=${new Date(expiresAt).toUTCString()}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** Express middleware: attaches req.user (or null) from the session cookie. */
function loadUser(db) {
  const stmt = db.prepare(`
    SELECT u.id, u.email, u.display_name, u.role, u.rep_status, u.university_id, un.name AS university_name
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN universities un ON un.id = u.university_id
    WHERE s.token = ? AND s.expires_at > ?
  `);
  return (req, _res, next) => {
    const token = getSessionToken(req);
    req.sessionToken = token;
    req.user = token ? stmt.get(token, Date.now()) || null : null;
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'You need to log in first.' });
  next();
}

/**
 * True if `email` belongs to `domain` (exact domain or a subdomain of it),
 * e.g. "a@mail.utoronto.ca" belongs to "utoronto.ca".
 */
function emailMatchesDomain(email, domain) {
  if (!email || !domain) return false;
  const emailDomain = String(email).toLowerCase().split('@')[1];
  const d = String(domain).toLowerCase();
  return emailDomain === d || (emailDomain || '').endsWith(`.${d}`);
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  loadUser,
  requireAuth,
  emailMatchesDomain,
};
