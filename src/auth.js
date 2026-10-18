'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { HttpError, forbidden } = require('./util');

const COOKIE = 'nm_session';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');

function hashPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (pw.length > 200) throw new HttpError(400, 'Password is too long');
  return bcrypt.hashSync(pw, 11);
}

// Simple in-memory login throttle: 10 failures per email+IP per 15 minutes.
const failures = new Map();
function throttleKey(req, email) { return `${req.ip}|${String(email).toLowerCase()}`; }
function isThrottled(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) { failures.delete(key); return false; }
  return f.count >= 10;
}
function noteFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60e3) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}

function createAuth(db) {
  const getSession = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.teacher_id, s.expires_at,
           (u.active = 1 AND (u.role <> 'teacher' OR t.active = 1)) AS active
    FROM sessions s JOIN users u ON u.id = s.user_id
    LEFT JOIN teachers t ON t.id = u.teacher_id WHERE s.token_hash = ?`);

  function login(req, res, email, password) {
    const key = throttleKey(req, email);
    if (isThrottled(key)) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    const u = db.prepare(`SELECT u.*, (u.active = 1 AND (u.role <> 'teacher' OR t.active = 1)) AS can_login
      FROM users u LEFT JOIN teachers t ON t.id = u.teacher_id WHERE u.email = ?`).get(String(email || '').trim());
    const ok = u && u.can_login && bcrypt.compareSync(String(password || ''), u.password_hash);
    if (!ok) { noteFailure(key); throw new HttpError(401, 'Incorrect email or password'); }
    failures.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(hashToken(token), u.id, expires);
    db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(new Date().toISOString());
    res.cookie(COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_HOURS * 3600e3, path: '/',
    });
    return { id: u.id, name: u.name, email: u.email, role: u.role, teacher_id: u.teacher_id };
  }

  function logout(req, res) {
    const t = req.cookies && req.cookies[COOKIE];
    if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(t));
    res.clearCookie(COOKIE, { path: '/' });
  }

  // Attaches req.user when a valid session cookie is present.
  function loadUser(req, _res, next) {
    const t = req.cookies && req.cookies[COOKIE];
    if (t) {
      const s = getSession.get(hashToken(t));
      if (s && s.active && s.expires_at > new Date().toISOString()) {
        req.user = { id: s.id, name: s.name, email: s.email, role: s.role, teacher_id: s.teacher_id };
      }
    }
    next();
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
