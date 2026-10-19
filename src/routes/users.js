'use strict';
const bcrypt = require('bcryptjs');
const { requireRole, hashPassword } = require('../auth');
const { audit } = require('../audit');
const { bad, notFound, conflict, str, oneOf, int, bool } = require('../util');

const PUBLIC = 'u.id, u.name, u.email, u.role, u.teacher_id, u.active, u.created_at';

module.exports = (app, { db }) => {
  app.get('/api/me', (req, res) => res.json({ user: req.user }));

  app.post('/api/me/password', async (req, res) => {
    const u = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!(await bcrypt.compare(String(req.body.current_password || ''), u.password_hash))) throw bad('Current password is incorrect');
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(req.body.new_password), u.id]);
    await audit(db, req.user, 'user', u.id, 'password_changed');
    res.json({ ok: true });
  });

  // Names of people who can own a lead (for dropdowns). Manager + Sales only.
  app.get('/api/users/sales-reps', requireRole('manager', 'sales'), async (_req, res) => {
    res.json(await db.all(`SELECT id, name, role, active FROM users u WHERE role IN ('sales','manager') ORDER BY active DESC, name`));
  });

  app.get('/api/users', requireRole('manager'), async (_req, res) => {
    res.json(await db.all(`SELECT ${PUBLIC}, t.name AS teacher_name FROM users u
      LEFT JOIN teachers t ON t.id = u.teacher_id ORDER BY u.active DESC, u.role, u.name`));
  });

  app.post('/api/users', requireRole('manager'), async (req, res) => {
    const b = req.body;
    const name = str(b.name, { required: true, name: 'Name', max: 100 });
    const email = str(b.email, { required: true, name: 'Email', max: 200 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address', { field: 'Email' });
    const role = oneOf(b.role, ['manager', 'sales', 'teacher'], { required: true, name: 'Role' });
    let teacherId = null;
    if (role === 'teacher') {
      teacherId = int(b.teacher_id, { required: true, name: 'Teacher record', min: 1 });
      if (!(await db.get('SELECT 1 AS x FROM teachers WHERE id = ?', [teacherId]))) throw bad('Teacher record not found');
      if (await db.get('SELECT 1 AS x FROM users WHERE teacher_id = ?', [teacherId])) throw conflict('This teacher already has a login');
    }
    if (await db.get('SELECT 1 AS x FROM users WHERE lower(email) = lower(?)', [email])) throw conflict('A user with this email already exists');
    const r = await db.get('INSERT INTO users (name, email, password_hash, role, teacher_id) VALUES (?,?,?,?,?) RETURNING id',
      [name, email, hashPassword(b.password), role, teacherId]);
    await audit(db, req.user, 'user', r.id, 'created', null, { name, email, role, teacher_id: teacherId });
    res.status(201).json(await db.get(`SELECT ${PUBLIC} FROM users u WHERE id = ?`, [r.id]));
  });

  app.patch('/api/users/:id', requireRole('manager'), async (req, res) => {
    const before = await db.get(`SELECT ${PUBLIC} FROM users u WHERE id = ?`, [int(req.params.id, { min: 1, name: 'User' })]);
    if (!before) throw notFound('User');
    const b = req.body;
    const next = { ...before };
    if (b.name !== undefined) next.name = str(b.name, { required: true, name: 'Name', max: 100 });
    if (b.active !== undefined) {
      next.active = bool(b.active) ? 1 : 0;
      if (!next.active && before.id === req.user.id) throw bad('You cannot deactivate your own account');
      if (!next.active && before.role === 'manager') {
        const others = (await db.get(`SELECT COUNT(*) n FROM users WHERE role='manager' AND active=1 AND id <> ?`, [before.id])).n;
        if (!others) throw bad('At least one active Manager is required');
      }
    }
    await db.tx(async t => {
      await t.run('UPDATE users SET name = ?, active = ? WHERE id = ?', [next.name, next.active, before.id]);
      if (b.password) {
        await t.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(b.password), before.id]);
        await audit(t, req.user, 'user', before.id, 'password_reset');
      }
      if (!next.active) await t.run('DELETE FROM sessions WHERE user_id = ?', [before.id]);
      await audit(t, req.user, 'user', before.id, 'updated', before, next);
    });
    res.json(await db.get(`SELECT ${PUBLIC} FROM users u WHERE id = ?`, [before.id]));
  });
};
