'use strict';
// Class and course feedback: links parents open without logging in, the teacher's end-of-course report,
// and the Manager's view of the answers.
const crypto = require('crypto');
const { requireRole } = require('../auth');
const { audit } = require('../audit');
const { notify, fmtWhen } = require('../notify');
const { bad, notFound, conflict, str, int, oneOf, idParam } = require('../util');
const { COURSES } = require('./candidates');

const TAGS = ['Clear teaching', 'Fun', 'On time', 'Good homework', 'Patient'];
const FREQUENCIES = ['every', 'weekly', 'off'];
const NEXT_LEVELS = [...COURSES, 'Repeat this level', 'Course finished'];
const CLASS_DAYS = 7; const COURSE_DAYS = 14;
const plusDays = n => new Date(Date.now() + n * 86400000).toISOString();

async function frequency(db) {
  const r = await db.get(`SELECT value FROM app_settings WHERE key = 'feedback_frequency'`);
  return FREQUENCIES.includes(r?.value) ? r.value : 'every';
}
const nps = rows => {
  const v = rows.map(r => r.nps).filter(n => n !== null && n !== undefined);
  if (!v.length) return null;
  return Math.round(((v.filter(n => n >= 9).length - v.filter(n => n <= 6).length) / v.length) * 100);
};
const avg = v => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null);

/** Average ratings per teacher for a month (by answer date). */
async function feedbackSummary(db, month) {
  const rows = await db.all(`SELECT f.*, t.name AS teacher_name FROM feedback f JOIN teachers t ON t.id = f.teacher_id
    WHERE substr(f.created_at,1,7) = ? OR substr(f.submitted_at,1,7) = ?`, [month, month]);
  const byT = new Map();
  for (const r of rows) {
    if (!byT.has(r.teacher_id)) byT.set(r.teacher_id, { teacher_id: r.teacher_id, name: r.teacher_name, links: 0, class: [], course: [] });
    const t = byT.get(r.teacher_id);
    if (r.kind === 'class' && r.created_at.startsWith(month)) t.links++;
    if (r.submitted_at && r.submitted_at.startsWith(month)) t[r.kind].push(r);
  }
  return [...byT.values()].map(t => ({
    teacher_id: t.teacher_id, name: t.name, class_links: t.links, class_responses: t.class.length,
    class_rating: avg(t.class.map(r => r.rating)), course_responses: t.course.length,
    course_rating: avg(t.course.map(r => r.teacher_rating)), nps: nps(t.course),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = (app, { db }) => {
  const ownClass = (user, teacherId) => user.role === 'manager' || (user.role === 'teacher' && user.teacher_id === teacherId);
  const newToken = () => crypto.randomBytes(18).toString('base64url');

  // ---------- Links ----------
  app.post('/api/classes/:id/feedback-link', requireRole('manager', 'teacher'), async (req, res) => {
    const cl = await db.get(`SELECT cl.*, c.student_name FROM classes cl JOIN enrollments e ON e.id = cl.enrollment_id
      JOIN students s ON s.id = e.student_id JOIN candidates c ON c.id = s.candidate_id WHERE cl.id = ?`, [idParam(req.params.id)]);
    if (!cl || !ownClass(req.user, cl.teacher_id)) throw notFound('Class');
    const existing = await db.get(`SELECT token, submitted_at, expires_at FROM feedback WHERE class_id = ? AND kind = 'class'`, [cl.id]);
    if (existing) return res.json(existing);
    if (cl.status !== 'Completed') throw bad('Feedback links are for completed classes');
    const freq = await frequency(db);
    if (freq === 'off') throw bad('Class feedback links are switched off in Settings', { code: 'FEEDBACK_OFF' });
    if (freq === 'weekly') {
      const recent = await db.get(`SELECT created_at FROM feedback WHERE kind = 'class' AND enrollment_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
        [cl.enrollment_id, plusDays(-7)]);
      if (recent) throw conflict(`A feedback link for ${cl.student_name} was already created this week. Settings allow one per week.`, { code: 'WEEKLY_LIMIT' });
    }
    const row = await db.get(`INSERT INTO feedback (token, kind, class_id, enrollment_id, teacher_id, created_by, expires_at)
      VALUES (?, 'class', ?, ?, ?, ?, ?) RETURNING token, submitted_at, expires_at`,
    [newToken(), cl.id, cl.enrollment_id, cl.teacher_id, req.user.id, plusDays(CLASS_DAYS)]);
    res.status(201).json(row);
  });

  const courseDone = e => e.status === 'Completed' || e.completed_classes >= e.total_classes;
  app.post('/api/enrollments/:id/feedback-link', requireRole('manager', 'teacher'), async (req, res) => {
    const e = await db.get('SELECT * FROM enrollments WHERE id = ?', [idParam(req.params.id)]);
    if (!e || !ownClass(req.user, e.teacher_id)) throw notFound('Enrollment');
    const existing = await db.get(`SELECT token, submitted_at, expires_at FROM feedback WHERE enrollment_id = ? AND kind = 'course'`, [e.id]);
    if (existing) {
      // An unanswered, expired link can be renewed.
      if (!existing.submitted_at && existing.expires_at < new Date().toISOString()) {
        return res.json(await db.get(`UPDATE feedback SET expires_at = ? WHERE enrollment_id = ? AND kind = 'course' RETURNING token, submitted_at, expires_at`, [plusDays(COURSE_DAYS), e.id]));
      }
      return res.json(existing);
    }
    if (!courseDone(e)) throw bad('Course feedback is available once the course is completed');
    res.status(201).json(await db.get(`INSERT INTO feedback (token, kind, enrollment_id, teacher_id, created_by, expires_at)
      VALUES (?, 'course', ?, ?, ?, ?) RETURNING token, submitted_at, expires_at`, [newToken(), e.id, e.teacher_id, req.user.id, plusDays(COURSE_DAYS)]));
  });

  // ---------- Teacher's end-of-course report ----------
  app.put('/api/enrollments/:id/report', requireRole('manager', 'teacher'), async (req, res) => {
    const e = await db.get('SELECT * FROM enrollments WHERE id = ?', [idParam(req.params.id)]);
    if (!e || !ownClass(req.user, e.teacher_id)) throw notFound('Enrollment');
    if (!courseDone(e)) throw bad('The end-of-course report is written once the course is completed');
    const r = {
      final_report: str(req.body.final_report, { required: true, name: 'Summary', max: 4000 }),
      next_level: oneOf(req.body.next_level, NEXT_LEVELS, { required: true, name: 'Recommended next step' }),
    };
    await db.tx(async t => {
      await t.run(`UPDATE enrollments SET final_report = @final_report, next_level = @next_level, final_report_by = @by,
        final_report_at = @at, updated_at = now_iso() WHERE id = @id`, { ...r, by: req.user.id, at: new Date().toISOString(), id: e.id });
      await audit(t, req.user, 'enrollment', e.id, e.final_report ? 'final_report_updated' : 'final_report_written', { final_report: e.final_report, next_level: e.next_level }, r);
    });
    res.json({ ok: true, ...r });
  });

  // ---------- Manager: answers ----------
  app.get('/api/feedback', requireRole('manager'), async (req, res) => {
    const q = req.query; const where = ['f.submitted_at IS NOT NULL']; const p = {};
    if (q.teacher) { where.push('f.teacher_id = @tid'); p.tid = idParam(q.teacher); }
    if (q.month && /^\d{4}-\d{2}$/.test(q.month)) { where.push('substr(f.submitted_at,1,7) = @m'); p.m = q.month; }
    if (q.enrollment) { where.push('f.enrollment_id = @eid'); p.eid = idParam(q.enrollment); }
    res.json(await db.all(`SELECT f.id, f.kind, f.submitted_at, f.rating, f.teacher_rating, f.content_rating, f.progress_rating, f.nps,
        f.continue_choice, f.tags, f.comment, t.name AS teacher_name, c.student_name, s.id AS student_id, e.course, cl.scheduled_at, cl.class_code
      FROM feedback f JOIN teachers t ON t.id = f.teacher_id JOIN enrollments e ON e.id = f.enrollment_id
      JOIN students s ON s.id = e.student_id JOIN candidates c ON c.id = s.candidate_id LEFT JOIN classes cl ON cl.id = f.class_id
      WHERE ${where.join(' AND ')} ORDER BY f.submitted_at DESC LIMIT 500`, p));
  });

  app.get('/api/settings/feedback', requireRole('manager'), async (_req, res) => res.json({ frequency: await frequency(db) }));
  app.put('/api/settings/feedback', requireRole('manager'), async (req, res) => {
    const f = oneOf(req.body.frequency, FREQUENCIES, { required: true, name: 'Frequency' });
    await db.run(`INSERT INTO app_settings (key, value, updated_by) VALUES ('feedback_frequency', ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now_iso()`, [f, req.user.id]);
    res.json({ frequency: f });
  });
};

/** Public (no login): the page parents open from WhatsApp. Registered before the login check. */
module.exports.publicRoutes = (app, { db }) => {
  const load = token => db.get(`SELECT f.*, t.name AS teacher_name, c.first_name, c.student_name, e.course, e.total_classes, e.completed_classes,
      cl.scheduled_at, cl.parent_note
    FROM feedback f JOIN teachers t ON t.id = f.teacher_id JOIN enrollments e ON e.id = f.enrollment_id
    JOIN students s ON s.id = e.student_id JOIN candidates c ON c.id = s.candidate_id LEFT JOIN classes cl ON cl.id = f.class_id
    WHERE f.token = ?`, [String(token || '').slice(0, 64)]);
  const stateOf = f => (f.submitted_at ? 'submitted' : f.expires_at < new Date().toISOString() ? 'expired' : 'open');

  app.get('/api/public/feedback/:token', async (req, res) => {
    const f = await load(req.params.token);
    if (!f) throw notFound('Feedback link');
    res.set('Cache-Control', 'no-store');
    res.json({
      kind: f.kind, state: stateOf(f), student: f.first_name || f.student_name.split(' ')[0], teacher: f.teacher_name, course: f.course,
      class_at: f.scheduled_at || null, parent_note: f.kind === 'class' ? f.parent_note || null : null,
      total_classes: f.total_classes, tags: TAGS,
    });
  });

  app.post('/api/public/feedback/:token', async (req, res) => {
    const f = await load(req.params.token);
    if (!f) throw notFound('Feedback link');
    const st = stateOf(f);
    if (st !== 'open') throw bad(st === 'submitted' ? 'Thank you — this feedback was already sent.' : 'This feedback link has expired.', { code: st.toUpperCase() });
    const b = req.body;
    const v = { comment: str(b.comment, { name: 'Comment', max: 1000 }), tags: null, rating: null, teacher_rating: null, content_rating: null, progress_rating: null, nps: null, continue_choice: null };
    if (f.kind === 'class') {
      v.rating = int(b.rating, { min: 1, max: 5, required: true, name: 'Rating' });
      const tags = Array.isArray(b.tags) ? b.tags.filter(x => TAGS.includes(x)) : [];
      v.tags = tags.length ? [...new Set(tags)].join(', ') : null;
    } else {
      v.teacher_rating = int(b.teacher_rating, { min: 1, max: 5, required: true, name: 'Teacher rating' });
      v.content_rating = int(b.content_rating, { min: 1, max: 5, required: true, name: 'Course rating' });
      v.progress_rating = int(b.progress_rating, { min: 1, max: 5, required: true, name: 'Progress rating' });
      v.nps = int(b.nps, { min: 0, max: 10, required: true, name: 'Recommendation score' });
      v.continue_choice = oneOf(b.continue_choice || null, ['Yes', 'Maybe', 'No'], { name: 'Continue' });
    }
    await db.tx(async t => {
      const r = await t.run(`UPDATE feedback SET submitted_at = now_iso(), rating=@rating, teacher_rating=@teacher_rating, content_rating=@content_rating,
        progress_rating=@progress_rating, nps=@nps, continue_choice=@continue_choice, tags=@tags, comment=@comment
        WHERE id = @id AND submitted_at IS NULL`, { ...v, id: f.id });
      if (!r.rowCount) throw bad('Thank you — this feedback was already sent.', { code: 'SUBMITTED' });
      // Tell the Managers about every course answer and about any low class rating.
      const low = f.kind === 'class' ? v.rating <= 2 : Math.min(v.teacher_rating, v.content_rating, v.progress_rating) <= 2;
      if (f.kind === 'course' || low) {
        const managers = (await t.all(`SELECT id FROM users WHERE role = 'manager' AND active = 1`)).map(u => u.id);
        const when = f.scheduled_at ? fmtWhen(f.scheduled_at.slice(0, 10), f.scheduled_at.slice(11)) : '';
        await notify(t, managers, f.kind === 'class' ? {
          kind: 'feedback_low', title: `Low class rating: ${f.student_name} (${v.rating}★)`,
          body: `${f.teacher_name} · ${when}${v.comment ? ' · “' + v.comment.slice(0, 120) + '”' : ''}`, link: '#/reports',
        } : {
          kind: 'feedback_course', title: `${low ? 'Low course feedback' : 'Course feedback'}: ${f.student_name}`,
          body: `${f.teacher_name} · teacher ${v.teacher_rating}★ · course ${v.content_rating}★ · recommend ${v.nps}/10${v.continue_choice ? ' · continue: ' + v.continue_choice : ''}`,
          link: '#/reports',
        }, null);
      }
    });
    res.json({ ok: true });
  });
};

module.exports.feedbackSummary = feedbackSummary;
module.exports.NEXT_LEVELS = NEXT_LEVELS;
