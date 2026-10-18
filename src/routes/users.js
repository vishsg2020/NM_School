'use strict';
const bcrypt = require('bcryptjs');
const { requireRole, hashPassword } = require('../auth');
const { audit } = require('../audit');
const { bad, notFound, conflict, str, oneOf, int, bool } = require('../util');

const PUBLIC = 'u.id, u.name, u.email, u.role, u.teacher_id, u.active, u.created_at';

module.exports = (app, { db }) => {
  app.get('/api/me', (req, res) => res.json({ user: req.user }));

  app.post('/api/me/password', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(String(req.body.current_password || ''), u.password_hash)) throw bad('Current password is incorrect');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.new_password), u.id);
    audit(db, req.user, 'user', u.id, 'password_changed');
    res.json({ ok: true });
  });

  // Names of people who can own a lead (for dropdowns). Manager + Sales only.
  app.get('/api/users/sales-reps', requireRole('manager', 'sales'), (_req, res) => {
    res.json(db.prepare(`SELECT id, name, role, active FROM users u WHERE role IN ('sales','manager') ORDER BY active DESC, name`).all());
  });

  app.get('/api/users', requireRole('manager'), (_req, res) => {
    res.json(db.prepare(`SELECT ${PUBLIC}, t.name AS teacher_name FROM users u
      LEFT JOIN teachers t ON t.id = u.teacher_id ORDER BY u.active DESC, u.role, u.name`).all());
  });

  app.post('/api/users', requireRole('manager'), (req, res) => {
    const b = req.body;
    const name = str(b.name, { required: true, name: 'Name', max: 100 });
    const email = str(b.email, { required: true, name: 'Email', max: 200 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address', { field: 'Email' });
    const role = oneOf(b.role, ['manager', 'sales', 'teacher'], { required: true, name: 'Role' });
    let teacherId = null;
    if (role === 'teacher') {
      teacherId = int(b.teacher_id, { required: true, name: 'Teacher record', min: 1 });
      if (!db.prepare('SELECT 1 FROM teachers WHERE id = ?').get(teacherId)) throw bad('Teacher record not found');
      if (db.prepare('SELECT 1 FROM users WHERE teacher_id = ?').get(teacherId)) throw conflict('This teacher already has a login');
    }
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw conflict('A user with this email already exists');
    const r = db.prepare('INSERT INTO users (name, email, password_hash, role, teacher_id) VALUES (?,?,?,?,?)')
      .run(name, email, hashPassword(b.password), role, teacherId);
    audit(db, req.user, 'user', r.lastInsertRowid, 'created', null, { name, email, role, teacher_id: teacherId });
    res.status(201).json(db.prepare(`SELECT ${PUBLIC} FROM users u WHERE id = ?`).get(r.lastInsertRowid));
  });

  app.patch('/api/users/:id', requireRole('manager'), (req, res) => {
    const before = db.prepare(`SELECT ${PUBLIC} FROM users u WHERE id = ?`).get(req.params.id);
    if (!before) throw notFound('User');
    const b = req.body;
    const next = { ...before };
    if (b.name !== undefined) next.name = str(b.name, { required: true, name: 'Name', max: 100 });
    if (b.active !== undefined) {
      next.active = bool(b.active) ? 1 : 0;
      if (!next.active && before.id === req.user.id) throw bad('You cannot deactivate your own account');
      if (!next.active && before.role === 'manager') {
        const others = db.prepare(`SELECT COUNT(*) n FROM users WHERE role='manager' AND active=1 AND id <> ?`).get(before.id).n;
        if (!others) throw bad('At least one active Manager is required');
      }
    }
    db.prepare('UPDATE users SET name = ?, active = ? WHERE id = ?').run(next.name, next.active, before.id);
    if (b.password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), before.id);
      audit(db, req.user, 'user', before.id, 'password_reset');
    }
    if (!next.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(before.id);
    audit(db, req.user, 'user', before.id, 'updated', before, next);
    res.json(db.prepare(`SELECT ${PUBLIC} FROM users u WHERE id = ?`).get(before.id));
  });
};
