'use strict';
const { requireRole } = require('../auth');
const { audit } = require('../audit');
const { bad, notFound, str, int, oneOf, bool, isValidTime, minutesOf, today } = require('../util');

function loadTeacher(db, id) {
  const t = db.prepare('SELECT * FROM teachers WHERE id = ?').get(id);
  if (!t) return null;
  t.hours = db.prepare('SELECT weekday, start_time, end_time FROM teacher_hours WHERE teacher_id = ? ORDER BY weekday, start_time').all(id);
  t.slots = db.prepare('SELECT weekday, start_time, end_time, format FROM teacher_slots WHERE teacher_id = ? ORDER BY weekday, start_time').all(id);
  t.login = db.prepare('SELECT id, email, active FROM users WHERE teacher_id = ?').get(id) || null;
  return t;
}

function parseWindows(list, { withFormat, label }) {
  if (!Array.isArray(list)) throw bad(`${label} must be a list`);
  if (list.length > 100) throw bad(`Too many ${label.toLowerCase()} entries`);
  const out = list.map((w, i) => {
    const weekday = int(w.weekday, { min: 0, max: 6, required: true, name: `${label} row ${i + 1} day` });
    if (!isValidTime(w.start_time) || !isValidTime(w.end_time)) throw bad(`${label} row ${i + 1}: enter start and end times as HH:MM`);
    if (w.start_time >= w.end_time) throw bad(`${label} row ${i + 1}: end time must be after start time`);
    const r = { weekday, start_time: w.start_time, end_time: w.end_time };
    if (withFormat) r.format = oneOf(w.format || 'Any', ['Any', '1:1', '3:1'], { name: `${label} row ${i + 1} format` });
    return r;
  });
  // Reject overlapping windows on the same day.
  for (const a of out) for (const b of out) {
    if (a !== b && a.weekday === b.weekday && a.start_time < b.end_time && b.start_time < a.end_time)
      throw bad(`${label}: overlapping times on the same day`);
  }
  return out;
}

function teacherInput(b, existing = {}) {
  const t = existing.id ? { ...existing } : { phone: null, email: null, monthly_capacity: null, notes: null };
  if (b.name !== undefined || !existing.id) t.name = str(b.name, { required: true, name: 'Name', max: 100 });
  if (b.phone !== undefined) t.phone = str(b.phone, { name: 'Phone', max: 30 });
  if (b.email !== undefined) t.email = str(b.email, { name: 'Email', max: 200 });
  if (b.employment_type !== undefined || !existing.id) t.employment_type = oneOf(b.employment_type || 'Regular', ['Regular', 'Freelance'], { name: 'Employment type' });
  if (b.supports_1to1 !== undefined || !existing.id) t.supports_1to1 = bool(b.supports_1to1 ?? true) ? 1 : 0;
  if (b.supports_3to1 !== undefined || !existing.id) t.supports_3to1 = bool(b.supports_3to1) ? 1 : 0;
  if (!t.supports_1to1 && !t.supports_3to1) throw bad('Select at least one supported class format');
  if (b.monthly_capacity !== undefined) t.monthly_capacity = int(b.monthly_capacity, { min: 0, max: 2000, name: 'Monthly class capacity' });
  if (b.notes !== undefined) t.notes = str(b.notes, { name: 'Notes', max: 1000 });
  return t;
}

module.exports = (app, { db }) => {
  // Minimal list for dropdowns (any signed-in role). No contact details.
  app.get('/api/teachers/options', (_req, res) => {
    res.json(db.prepare(`SELECT id, name, active, supports_1to1, supports_3to1 FROM teachers ORDER BY active DESC, name`).all());
  });

  app.get('/api/teachers', requireRole('manager'), (_req, res) => {
    const month = today().slice(0, 7);
    const rows = db.prepare(`
      SELECT t.*,
        (SELECT COUNT(*) FROM enrollments e WHERE e.teacher_id = t.id AND e.status = 'Active') AS active_enrollments,
        (SELECT COUNT(*) FROM (SELECT DISTINCT scheduled_at FROM classes c WHERE c.teacher_id = t.id
            AND substr(c.scheduled_at,1,7) = ? AND c.status NOT IN ('Cancelled','Rescheduled'))) AS sessions_this_month,
        (SELECT email FROM users u WHERE u.teacher_id = t.id) AS login_email
      FROM teachers t ORDER BY t.active DESC, t.name`).all(month);
    for (const r of rows) {
      r.hours = db.prepare('SELECT weekday, start_time, end_time FROM teacher_hours WHERE teacher_id = ? ORDER BY weekday, start_time').all(r.id);
      r.slots = db.prepare('SELECT weekday, start_time, end_time, format FROM teacher_slots WHERE teacher_id = ? ORDER BY weekday, start_time').all(r.id);
    }
    res.json(rows);
  });

  app.get('/api/teachers/:id', requireRole('manager', 'teacher'), (req, res) => {
    const id = Number(req.params.id);
    if (req.user.role === 'teacher' && req.user.teacher_id !== id) throw notFound('Teacher');
    const t = loadTeacher(db, id);
    if (!t) throw notFound('Teacher');
    res.json(t);
  });

  app.post('/api/teachers', requireRole('manager'), (req, res) => {
    const t = teacherInput(req.body);
    const hours = parseWindows(req.body.hours || [], { label: 'Working hours' });
    const slots = parseWindows(req.body.slots || [], { label: 'Availability slots', withFormat: true });
    checkSlotsInsideHours(hours, slots);
    const id = db.transaction(() => {
      const r = db.prepare(`INSERT INTO teachers (name, phone, email, employment_type, supports_1to1, supports_3to1, monthly_capacity, notes)
        VALUES (@name, @phone, @email, @employment_type, @supports_1to1, @supports_3to1, @monthly_capacity, @notes)`)
        .run(t);
      saveWindows(db, r.lastInsertRowid, hours, slots);
      audit(db, req.user, 'teacher', r.lastInsertRowid, 'created', null, { ...t, hours, slots });
      return r.lastInsertRowid;
    })();
    res.status(201).json(loadTeacher(db, id));
  });

  app.patch('/api/teachers/:id', requireRole('manager'), (req, res) => {
    const before = loadTeacher(db, req.params.id);
    if (!before) throw notFound('Teacher');
    const { hours: bh, slots: bs, login, ...base } = before;
    const t = teacherInput(req.body, base);
    if (req.body.active !== undefined) t.active = bool(req.body.active) ? 1 : 0;
    const hours = req.body.hours !== undefined ? parseWindows(req.body.hours, { label: 'Working hours' }) : bh;
    const slots = req.body.slots !== undefined ? parseWindows(req.body.slots, { label: 'Availability slots', withFormat: true }) : bs;
    checkSlotsInsideHours(hours, slots);

    // Format removal must not strand active enrollments.
    for (const [flag, mode] of [['supports_1to1', '1:1'], ['supports_3to1', '3:1']]) {
      if (before[flag] && !t[flag]) {
        const n = db.prepare(`SELECT COUNT(*) n FROM enrollments WHERE teacher_id = ? AND status='Active' AND class_mode = ?`).get(before.id, mode).n;
        if (n) throw bad(`Cannot remove ${mode}: this teacher has ${n} active ${mode} enrollment(s). Reassign them first.`);
      }
    }
    let impact = null;
    if (before.active && t.active === 0) {
      impact = deactivationImpact(db, before.id);
      if ((impact.active_enrollments || impact.upcoming_classes || impact.open_pretests) && !bool(req.body.confirm)) {
        throw bad('This teacher has assigned work. Confirm to deactivate anyway.', { code: 'NEEDS_CONFIRM', impact });
      }
    }
    db.transaction(() => {
      db.prepare(`UPDATE teachers SET name=@name, phone=@phone, email=@email, employment_type=@employment_type,
        supports_1to1=@supports_1to1, supports_3to1=@supports_3to1, monthly_capacity=@monthly_capacity,
        notes=@notes, active=@active, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`).run(t);
      if (req.body.hours !== undefined || req.body.slots !== undefined) saveWindows(db, before.id, hours, slots);
      if (t.active === 0) {
        const u = db.prepare('SELECT id FROM users WHERE teacher_id = ?').get(before.id);
        if (u) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      }
      audit(db, req.user, 'teacher', before.id, t.active === 0 && before.active ? 'deactivated' : 'updated',
        { ...base, hours: bh, slots: bs }, { ...t, hours, slots });
    })();
    res.json({ ...loadTeacher(db, before.id), impact });
  });

  app.get('/api/teachers/:id/impact', requireRole('manager'), (req, res) => {
    res.json(deactivationImpact(db, Number(req.params.id)));
  });
};

function deactivationImpact(db, id) {
  const now = today();
  return {
    active_enrollments: db.prepare(`SELECT COUNT(*) n FROM enrollments WHERE teacher_id=? AND status='Active'`).get(id).n,
    upcoming_classes: db.prepare(`SELECT COUNT(*) n FROM classes WHERE teacher_id=? AND status='Scheduled' AND scheduled_at >= ?`).get(id, now).n,
    open_pretests: db.prepare(`SELECT COUNT(*) n FROM candidates WHERE pretest_teacher_id=? AND status IN ('Scheduled','Time Required','Needs Review','Follow-up')`).get(id).n,
  };
}

function checkSlotsInsideHours(hours, slots) {
  for (const s of slots) {
    const ok = hours.some(h => h.weekday === s.weekday && h.start_time <= s.start_time && s.end_time <= h.end_time);
    if (!ok) throw bad(`Availability slot ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][s.weekday]} ${s.start_time}–${s.end_time} is outside the teacher's working hours`);
  }
}

function saveWindows(db, id, hours, slots) {
  db.prepare('DELETE FROM teacher_hours WHERE teacher_id = ?').run(id);
  db.prepare('DELETE FROM teacher_slots WHERE teacher_id = ?').run(id);
  const ih = db.prepare('INSERT INTO teacher_hours (teacher_id, weekday, start_time, end_time) VALUES (?,?,?,?)');
  const is = db.prepare('INSERT INTO teacher_slots (teacher_id, weekday, start_time, end_time, format) VALUES (?,?,?,?,?)');
  for (const h of hours) ih.run(id, h.weekday, h.start_time, h.end_time);
  for (const s of slots) is.run(id, s.weekday, s.start_time, s.end_time, s.format || 'Any');
}

module.exports.loadTeacher = loadTeacher;
module.exports.minutesOf = minutesOf;
