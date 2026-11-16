'use strict';
// AD-02: a public page for the parent (no login) — teacher, weekly slot, class calendar, end date and terms.
const crypto = require('crypto');
const { requireRole } = require('../auth');
const { audit } = require('../audit');
const { notFound, str, idParam, bool } = require('../util');

const DEFAULT_TERMS = [
  'Classes run at the agreed weekly time (IST).',
  'To reschedule, tell us at least 24 hours before the class.',
  'If the student misses more than 2 classes without notice, the end date moves and the extra classes are charged at the per-class rate.',
  'Classes cancelled by the teacher are rescheduled free of charge.',
  'Fees are as agreed at admission; the final payment is due by the date given.',
].join('\n');

async function termsText(db) {
  const r = await db.get(`SELECT value FROM app_settings WHERE key = 'student_terms'`);
  return r && r.value != null && r.value.trim() ? r.value : DEFAULT_TERMS;
}

module.exports = (app, { db }) => {
  const own = (user, e) => user.role === 'manager' || (user.role === 'teacher' && user.teacher_id === e.teacher_id);

  // Create (or renew) the share link of an enrollment.
  app.post('/api/enrollments/:id/share-link', requireRole('manager', 'teacher'), async (req, res) => {
    const e = await db.get('SELECT id, teacher_id, share_token FROM enrollments WHERE id = ?', [idParam(req.params.id)]);
    if (!e || !own(req.user, e)) throw notFound('Enrollment');
    const renew = bool(req.body?.renew);
    if (e.share_token && !renew) return res.json({ token: e.share_token });
    if (renew && req.user.role !== 'manager') throw notFound('Enrollment');
    const token = crypto.randomBytes(18).toString('base64url');
    await db.tx(async t => {
      await t.run('UPDATE enrollments SET share_token = ? WHERE id = ?', [token, e.id]);
      await audit(t, req.user, 'enrollment', e.id, renew ? 'student_page_link_renewed' : 'student_page_link_created', null, null);
    });
    res.status(renew ? 200 : 201).json({ token });
  });

  app.get('/api/settings/terms', requireRole('manager'), async (_req, res) => res.json({ terms: await termsText(db), default: DEFAULT_TERMS }));
  app.put('/api/settings/terms', requireRole('manager'), async (req, res) => {
    const terms = str(req.body.terms, { name: 'Terms', max: 3000 }) || '';
    await db.run(`INSERT INTO app_settings (key, value, updated_by) VALUES ('student_terms', ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now_iso()`, [terms, req.user.id]);
    res.json({ terms: await termsText(db) });
  });
};

/** Public routes (no login): registered before the login check. */
module.exports.publicRoutes = (app, { db }) => {
  const load = token => db.get(`SELECT e.*, c.first_name, c.last_name, c.student_name, t.name AS teacher_name, t.about AS teacher_about,
      (t.photo IS NOT NULL) AS teacher_has_photo
    FROM enrollments e JOIN students s ON s.id = e.student_id JOIN candidates c ON c.id = s.candidate_id
    JOIN teachers t ON t.id = e.teacher_id WHERE e.share_token = ?`, [String(token || '').slice(0, 64)]);

  app.get('/api/public/student/:token', async (req, res) => {
    const e = await load(req.params.token);
    if (!e) throw notFound('Student page');
    const classes = await db.all(`SELECT cl.scheduled_at, cl.duration_min, cl.status, t.name AS teacher
      FROM classes cl JOIN teachers t ON t.id = cl.teacher_id
      WHERE cl.enrollment_id = ? AND cl.status <> 'Rescheduled' ORDER BY cl.scheduled_at`, [e.id]);
    const kind = s => (s === 'Completed' ? 'done' : s === 'Scheduled' ? 'upcoming' : s === 'Student Absent' ? 'missed' : 'cancelled');
    res.set('Cache-Control', 'no-store');
    res.json({
      student: e.first_name ? `${e.first_name}${e.last_name ? ' ' + e.last_name : ''}` : e.student_name,
      course: e.course, class_mode: e.class_mode, status: e.status,
      teacher: { name: e.teacher_name, about: e.teacher_about || null, photo: !!e.teacher_has_photo },
      slot_days: e.slot_days, slot_time: e.slot_time, start_date: e.start_date, end_date: e.end_date,
      total_classes: e.total_classes, completed_classes: e.completed_classes,
      missed: classes.filter(c => c.status === 'Student Absent').length,
      classes: classes.map(c => ({ at: c.scheduled_at, minutes: c.duration_min, kind: kind(c.status), substitute: c.teacher !== e.teacher_name ? c.teacher : undefined })),
      terms: (await termsText(db)).split('\n').map(x => x.trim()).filter(Boolean),
    });
  });

  app.get('/api/public/student/:token/teacher-photo', async (req, res) => {
    const e = await db.get(`SELECT t.photo, t.photo_mime FROM enrollments e JOIN teachers t ON t.id = e.teacher_id WHERE e.share_token = ?`,
      [String(req.params.token || '').slice(0, 64)]);
    if (!e || !e.photo) throw notFound('Photo');
    res.set({ 'Content-Type': e.photo_mime, 'Cache-Control': 'private, max-age=600' }).send(e.photo);
  });
};

module.exports.DEFAULT_TERMS = DEFAULT_TERMS;
