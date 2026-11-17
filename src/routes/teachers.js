'use strict';
const { requireRole } = require('../auth');
const { audit } = require('../audit');
const { bad, notFound, str, int, oneOf, bool, isValidTime, today } = require('../util');

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function windowsOf(db, id) {
  return {
    hours: await db.all('SELECT weekday, start_time, end_time FROM teacher_hours WHERE teacher_id = ? ORDER BY weekday, start_time', [id]),
    slots: await db.all('SELECT weekday, start_time, end_time, format FROM teacher_slots WHERE teacher_id = ? ORDER BY weekday, start_time', [id]),
  };
}

async function loadTeacher(db, id) {
  const t = await db.get('SELECT * FROM teachers WHERE id = ?', [id]);
  if (!t) return null;
  t.has_photo = !!t.photo_mime; delete t.photo; delete t.photo_mime;
  Object.assign(t, await windowsOf(db, id));
  t.login = (await db.get('SELECT id, email, active FROM users WHERE teacher_id = ?', [id])) || null;
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
  const t = existing.id ? { ...existing } : { phone: null, email: null, monthly_capacity: null, notes: null, about: null, monthly_salary: null };
  if (b.name !== undefined || !existing.id) t.name = str(b.name, { required: true, name: 'Name', max: 100 });
  if (b.phone !== undefined) t.phone = str(b.phone, { name: 'Phone', max: 30 });
  if (b.email !== undefined) t.email = str(b.email, { name: 'Email', max: 200 });
  if (b.employment_type !== undefined || !existing.id) t.employment_type = oneOf(b.employment_type || 'Regular', ['Regular', 'Freelance'], { name: 'Employment type' });
  if (b.supports_1to1 !== undefined || !existing.id) t.supports_1to1 = bool(b.supports_1to1 ?? true) ? 1 : 0;
  if (b.supports_3to1 !== undefined || !existing.id) t.supports_3to1 = bool(b.supports_3to1) ? 1 : 0;
  if (!t.supports_1to1 && !t.supports_3to1) throw bad('Select at least one supported class format');
  if (b.monthly_capacity !== undefined) t.monthly_capacity = int(b.monthly_capacity, { min: 0, max: 2000, name: 'Monthly class capacity' });
  if (b.notes !== undefined) t.notes = str(b.notes, { name: 'Notes', max: 1000 });
  // Short introduction shown to parents on the student page.
  if (b.about !== undefined) t.about = str(b.about, { name: 'About', max: 400 });
  // Regular teachers: monthly salary for the pay statement (empty = the default in Settings).
  if (b.monthly_salary !== undefined) t.monthly_salary = b.monthly_salary === '' || b.monthly_salary === null ? null : int(b.monthly_salary, { min: 0, max: 1_000_000, name: 'Monthly salary' });
  return t;
}

function checkSlotsInsideHours(hours, slots) {
  for (const s of slots) {
    const ok = hours.some(h => h.weekday === s.weekday && h.start_time <= s.start_time && s.end_time <= h.end_time);
    if (!ok) throw bad(`Availability slot ${DAY[s.weekday]} ${s.start_time}–${s.end_time} is outside the teacher's working hours`);
  }
}

async function saveWindows(t, id, hours, slots) {
  await t.run('DELETE FROM teacher_hours WHERE teacher_id = ?', [id]);
  await t.run('DELETE FROM teacher_slots WHERE teacher_id = ?', [id]);
  for (const h of hours) await t.run('INSERT INTO teacher_hours (teacher_id, weekday, start_time, end_time) VALUES (?,?,?,?)', [id, h.weekday, h.start_time, h.end_time]);
  for (const s of slots) await t.run('INSERT INTO teacher_slots (teacher_id, weekday, start_time, end_time, format) VALUES (?,?,?,?,?)', [id, s.weekday, s.start_time, s.end_time, s.format || 'Any']);
}

async function deactivationImpact(db, id) {
  const now = today();
  return {
    active_enrollments: (await db.get(`SELECT COUNT(*) n FROM enrollments WHERE teacher_id=? AND status='Active'`, [id])).n,
    upcoming_classes: (await db.get(`SELECT COUNT(*) n FROM classes WHERE teacher_id=? AND status='Scheduled' AND scheduled_at >= ?`, [id, now])).n,
    open_pretests: (await db.get(`SELECT COUNT(*) n FROM candidates WHERE pretest_teacher_id=? AND status IN ('Scheduled','Time Required','Needs Review','Follow-up')`, [id])).n,
  };
}

module.exports = (app, { db }) => {
  // Minimal list for dropdowns (any signed-in role). No contact details.
  app.get('/api/teachers/options', async (_req, res) => {
    res.json(await db.all(`SELECT id, name, active, supports_1to1, supports_3to1 FROM teachers ORDER BY active DESC, name`));
  });

  app.get('/api/teachers', requireRole('manager'), async (_req, res) => {
    const month = today().slice(0, 7);
    const rows = await db.all(`
      SELECT t.*,
        (SELECT COUNT(*) FROM enrollments e WHERE e.teacher_id = t.id AND e.status = 'Active') AS active_enrollments,
        (SELECT COUNT(DISTINCT c.scheduled_at) FROM classes c WHERE c.teacher_id = t.id
            AND substr(c.scheduled_at,1,7) = ? AND c.status NOT IN ('Cancelled','Rescheduled')) AS sessions_this_month,
        (SELECT email FROM users u WHERE u.teacher_id = t.id) AS login_email
      FROM teachers t ORDER BY t.active DESC, t.name`, [month]);
    const hours = await db.all('SELECT teacher_id, weekday, start_time, end_time FROM teacher_hours ORDER BY weekday, start_time');
    const slots = await db.all('SELECT teacher_id, weekday, start_time, end_time, format FROM teacher_slots ORDER BY weekday, start_time');
    const strip = ({ teacher_id, ...w }) => w;
    for (const r of rows) {
      r.has_photo = !!r.photo_mime; delete r.photo; delete r.photo_mime;
      r.hours = hours.filter(h => h.teacher_id === r.id).map(strip);
      r.slots = slots.filter(x => x.teacher_id === r.id).map(strip);
    }
    res.json(rows);
  });

  app.get('/api/teachers/:id', requireRole('manager', 'teacher'), async (req, res) => {
    const id = int(req.params.id, { min: 1, name: 'Teacher' });
    if (req.user.role === 'teacher' && req.user.teacher_id !== id) throw notFound('Teacher');
    const t = await loadTeacher(db, id);
    if (!t) throw notFound('Teacher');
    res.json(t);
  });

  app.post('/api/teachers', requireRole('manager'), async (req, res) => {
    const t = teacherInput(req.body);
    const hours = parseWindows(req.body.hours || [], { label: 'Working hours' });
    const slots = parseWindows(req.body.slots || [], { label: 'Availability slots', withFormat: true });
    checkSlotsInsideHours(hours, slots);
    const id = await db.tx(async tx => {
      const r = await tx.get(`INSERT INTO teachers (name, phone, email, employment_type, supports_1to1, supports_3to1, monthly_capacity, notes, about, monthly_salary)
        VALUES (@name, @phone, @email, @employment_type, @supports_1to1, @supports_3to1, @monthly_capacity, @notes, @about, @monthly_salary) RETURNING id`, t);
      await saveWindows(tx, r.id, hours, slots);
      await audit(tx, req.user, 'teacher', r.id, 'created', null, { ...t, hours, slots });
      return r.id;
    });
    res.status(201).json(await loadTeacher(db, id));
  });

  app.patch('/api/teachers/:id', requireRole('manager'), async (req, res) => {
    const before = await loadTeacher(db, int(req.params.id, { min: 1, name: 'Teacher' }));
    if (!before) throw notFound('Teacher');
    const { hours: bh, slots: bs, login, has_photo, ...base } = before;
    const t = teacherInput(req.body, base);
    if (req.body.active !== undefined) t.active = bool(req.body.active) ? 1 : 0;
    const hours = req.body.hours !== undefined ? parseWindows(req.body.hours, { label: 'Working hours' }) : bh;
    const slots = req.body.slots !== undefined ? parseWindows(req.body.slots, { label: 'Availability slots', withFormat: true }) : bs;
    checkSlotsInsideHours(hours, slots);

    // Removing a format must not strand active enrollments.
    for (const [flag, mode] of [['supports_1to1', '1:1'], ['supports_3to1', '3:1']]) {
      if (before[flag] && !t[flag]) {
        const n = (await db.get(`SELECT COUNT(*) n FROM enrollments WHERE teacher_id = ? AND status='Active' AND class_mode = ?`, [before.id, mode])).n;
        if (n) throw bad(`Cannot remove ${mode}: this teacher has ${n} active ${mode} enrollment(s). Reassign them first.`);
      }
    }
    let impact = null;
    if (before.active && t.active === 0) {
      impact = await deactivationImpact(db, before.id);
      if ((impact.active_enrollments || impact.upcoming_classes || impact.open_pretests) && !bool(req.body.confirm)) {
        throw bad('This teacher has assigned work. Confirm to deactivate anyway.', { code: 'NEEDS_CONFIRM', impact });
      }
    }
    await db.tx(async tx => {
      await tx.run(`UPDATE teachers SET name=@name, phone=@phone, email=@email, employment_type=@employment_type,
        supports_1to1=@supports_1to1, supports_3to1=@supports_3to1, monthly_capacity=@monthly_capacity,
        notes=@notes, about=@about, monthly_salary=@monthly_salary, active=@active, updated_at=now_iso() WHERE id=@id`, t);
      if (req.body.hours !== undefined || req.body.slots !== undefined) await saveWindows(tx, before.id, hours, slots);
      if (t.active === 0) {
        const u = await tx.get('SELECT id FROM users WHERE teacher_id = ?', [before.id]);
        if (u) await tx.run('DELETE FROM sessions WHERE user_id = ?', [u.id]);
      }
      await audit(tx, req.user, 'teacher', before.id, t.active === 0 && before.active ? 'deactivated' : 'updated',
        { ...base, hours: bh, slots: bs }, { ...t, hours, slots });
    });
    res.json({ ...(await loadTeacher(db, before.id)), impact });
  });

  // Teacher photo for the parents' student page (images only, shrunk in the browser first).
  app.put('/api/teachers/:id/photo', requireRole('manager'), async (req, res) => {
    const id = int(req.params.id, { min: 1, name: 'Teacher' });
    if (!(await db.get('SELECT id FROM teachers WHERE id = ?', [id]))) throw notFound('Teacher');
    if (req.body.remove) {
      await db.run('UPDATE teachers SET photo = NULL, photo_mime = NULL WHERE id = ?', [id]);
      return res.json({ has_photo: false });
    }
    const mime = oneOf(req.body.mime, ['image/jpeg', 'image/png', 'image/webp'], { required: true, name: 'Photo type' });
    const buf = Buffer.from(String(req.body.data || ''), 'base64');
    if (!buf.length || buf.length > 2 * 1024 * 1024) throw bad('Choose a photo under 2 MB');
    const ok = mime === 'image/jpeg' ? buf[0] === 0xFF && buf[1] === 0xD8
      : mime === 'image/png' ? buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47]))
        : buf.subarray(0, 4).toString('latin1') === 'RIFF';
    if (!ok) throw bad('That file is not a valid image');
    await db.tx(async tx => {
      await tx.run('UPDATE teachers SET photo = ?, photo_mime = ?, updated_at = now_iso() WHERE id = ?', [buf, mime, id]);
      await audit(tx, req.user, 'teacher', id, 'photo_changed', null, { size: buf.length });
    });
    res.json({ has_photo: true });
  });
  app.get('/api/teachers/:id/photo', async (req, res) => {
    const t = await db.get('SELECT photo, photo_mime FROM teachers WHERE id = ?', [int(req.params.id, { min: 1, name: 'Teacher' })]);
    if (!t || !t.photo) throw notFound('Photo');
    res.set({ 'Content-Type': t.photo_mime, 'Cache-Control': 'private, max-age=300' }).send(t.photo);
  });

  app.get('/api/teachers/:id/impact', requireRole('manager'), async (req, res) => {
    res.json(await deactivationImpact(db, int(req.params.id, { min: 1, name: 'Teacher' })));
  });
};
