'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { HttpError, forbidden } = require('./util');

const COOKIE = 'nm_session';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const MAX_FAILURES = 10;
const WINDOW_MIN = 15;
// HTTPS-only cookie on Netlify (always HTTPS) or when NODE_ENV=production; plain cookie for http://localhost.
const SECURE_COOKIE = process.env.NODE_ENV === 'production' || !!process.env.NETLIFY || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');

function hashPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (pw.length > 200) throw new HttpError(400, 'Password is too long');
  return bcrypt.hashSync(pw, 10);
}

function createAuth(db) {
  // Throttle failed sign-ins per email + IP. Stored in the database so it holds across serverless instances.
  async function isThrottled(key) {
    const f = await db.get(`SELECT count, first_at > now() - interval '${WINDOW_MIN} minutes' AS recent FROM login_failures WHERE key = ?`, [key]);
    return !!(f && f.recent && f.count >= MAX_FAILURES);
  }
  async function noteFailure(key) {
    await db.run(`INSERT INTO login_failures (key) VALUES (?)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN login_failures.first_at > now() - interval '${WINDOW_MIN} minutes' THEN login_failures.count + 1 ELSE 1 END,
        first_at = CASE WHEN login_failures.first_at > now() - interval '${WINDOW_MIN} minutes' THEN login_failures.first_at ELSE now() END`, [key]);
  }

  async function login(req, res, email, password) {
    email = String(email || '').trim();
    const key = `${req.ip}|${email.toLowerCase()}`;
    if (await isThrottled(key)) throw new HttpError(429, `Too many failed attempts. Try again in ${WINDOW_MIN} minutes.`);
    const u = await db.get(`SELECT u.*, (u.active = 1 AND (u.role <> 'teacher' OR t.active = 1)) AS can_login
      FROM users u LEFT JOIN teachers t ON t.id = u.teacher_id WHERE lower(u.email) = lower(?)`, [email]);
    const ok = u && u.can_login && (await bcrypt.compare(String(password || ''), u.password_hash));
    if (!ok) { await noteFailure(key); throw new HttpError(401, 'Incorrect email or password'); }
    await db.run('DELETE FROM login_failures WHERE key = ? OR first_at < now() - interval \'1 day\'', [key]);
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
    await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', [hashToken(token), u.id, expires]);
    await db.run('DELETE FROM sessions WHERE expires_at < ?', [new Date().toISOString()]);
    res.cookie(COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIE,
      maxAge: SESSION_HOURS * 3600e3, path: '/',
    });
    return { id: u.id, name: u.name, email: u.email, role: u.role, teacher_id: u.teacher_id };
  }

  async function logout(req, res) {
    const t = req.cookies && req.cookies[COOKIE];
    if (t) await db.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(t)]);
    res.clearCookie(COOKIE, { path: '/' });
  }

  // Attaches req.user when a valid session cookie is present.
  async function loadUser(req, _res, next) {
    try {
      const t = req.cookies && req.cookies[COOKIE];
      if (t) {
        const s = await db.get(`
          SELECT u.id, u.name, u.email, u.role, u.teacher_id, s.expires_at,
                 (u.active = 1 AND (u.role <> 'teacher' OR t.active = 1)) AS active
          FROM sessions s JOIN users u ON u.id = s.user_id
          LEFT JOIN teachers t ON t.id = u.teacher_id WHERE s.token_hash = ?`, [hashToken(t)]);
        if (s && s.active && s.expires_at > new Date().toISOString()) {
          req.user = { id: s.id, name: s.name, email: s.email, role: s.role, teacher_id: s.teacher_id };
        }
      }
      next();
    } catch (e) { next(e); }
  }

  return { login, logout, loadUser };
}

function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in'));
  next();
}
const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Please sign in'));
  if (!roles.includes(req.user.role)) return next(forbidden());
  next();
};

module.exports = { createAuth, requireAuth, requireRole, hashPassword, COOKIE };
