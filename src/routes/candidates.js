'use strict';
const { requireRole } = require('../auth');
const { audit, history } = require('../audit');
const { isUniqueViolation } = require('../db');
const google = require('../google');
const {
  bad, notFound, forbidden, conflict, str, int, oneOf, bool, isValidDateTime, isValidDate, normPhone, normName, idParam,
  addMinutes, weekdayOf,
} = require('../util');

const STATUSES = ['Scheduled', 'Time Required', 'Needs Review', 'Completed', 'Cancelled', 'Follow-up'];
const SALES_STATUSES = ['Scheduled', 'Time Required', 'Follow-up', 'Cancelled'];
const CONFIRMATIONS = ['Not Confirmed', 'Confirmed', 'Reschedule Requested'];
const COURSES = ['Starter', 'Reader', 'Writer', 'Malayalam Master'];
const ADMISSION = ['Confirmed', 'Follow-up', 'Not Interested'];
const GENDERS = ['Male', 'Female', 'Prefer not to say'];
const RELATIONSHIPS = ['Mother', 'Father', 'Guardian', 'Other'];
const ADULT_AGE = 18;
const PRETEST_MINUTES = 30; // assumed pre-test length, used for the teacher clash check

const SELECT = `
  SELECT c.*, r.name AS sales_rep_name, t.name AS teacher_name, t.active AS teacher_active,
         pr.id AS result_id, pr.admission_status, pr.recommended_course, pr.reviewed_at,
         s.id AS student_id,
         (SELECT COUNT(*) FROM enrollments e WHERE e.student_id = s.id) AS enrollment_count
  FROM candidates c
  JOIN users r ON r.id = c.sales_rep_id
  LEFT JOIN teachers t ON t.id = c.pretest_teacher_id
  LEFT JOIN pretest_results pr ON pr.candidate_id = c.id
  LEFT JOIN students s ON s.candidate_id = c.id`;

// Teachers only see what they need to run the pre-test.
function redactForTeacher(c) {
  const { phone, phone_norm, student_phone, idempotency_key, ...rest } = c;
  return rest;
}

function canSee(user, c) {
  if (user.role === 'manager' || user.role === 'sales') return true;
  return user.role === 'teacher' && c.pretest_teacher_id === user.teacher_id;
}

async function nextLeadId(t) {
  for (;;) {
    const { id } = await t.get(`SELECT 'NM-' || lpad(nextval('lead_number_seq')::text, 5, '0') AS id`);
    if (!(await t.get('SELECT 1 AS x FROM candidates WHERE lower(lead_id) = lower(?)', [id]))) return id;
  }
}

async function validateSalesRep(db, id) {
  const r = await db.get(`SELECT id FROM users WHERE id = ? AND active = 1 AND role IN ('sales','manager')`, [id]);
  if (!r) throw bad('Assigned Sales Representative must be an active Sales Team member or Manager', { field: 'Assigned Sales Representative' });
}
async function validateTeacher(db, id) {
  if (id == null) return;
  const t = await db.get('SELECT active FROM teachers WHERE id = ?', [id]);
  if (!t) throw bad('Pre-test teacher not found');
  if (!t.active) throw bad('Pre-test teacher is inactive');
}
async function findDuplicates(db, phoneNorm, studentName, excludeId = 0) {
  const rows = await db.all('SELECT id, lead_id, student_name, status FROM candidates WHERE phone_norm = ? AND id <> ?', [phoneNorm, excludeId]);
  return rows.filter(d => normName(d.student_name) === normName(studentName));
}


function splitName(full) {
  const s = String(full || '').trim().replace(/\s+/g, ' ');
  const i = s.indexOf(' ');
  return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
}

/**
 * Reads the student's and parent's details into `c`.
 * The form sends first_name + last_name; older clients may still send student_name (split on the first space).
 * Returns true when the request touched these details, so the age-based rules must be checked.
 */
function readPerson(b, c, { creating }) {
  let touched = creating;
  if (b.first_name !== undefined || b.last_name !== undefined) {
    c.first_name = str(b.first_name, { required: true, name: 'First name', max: 60 });
    c.last_name = str(b.last_name, { required: true, name: 'Last name', max: 60 });
    touched = true;
  } else if (b.student_name !== undefined || creating) {
    [c.first_name, c.last_name] = splitName(str(b.student_name, { required: true, name: 'Student name', max: 100 }));
    touched = true;
  }
  c.student_name = [c.first_name, c.last_name].filter(Boolean).join(' ');
  if (b.age !== undefined) { c.age = int(b.age, { min: 2, max: 99, name: 'Age' }); touched = true; }
  if (b.gender !== undefined) c.gender = oneOf(b.gender, GENDERS, { name: 'Gender' });
  if (b.parent_name !== undefined) c.parent_name = str(b.parent_name, { name: 'Parent name', max: 100 });
  if (b.parent_relationship !== undefined) c.parent_relationship = oneOf(b.parent_relationship, RELATIONSHIPS, { name: 'Relationship' });
  if (b.student_phone !== undefined) {
    c.student_phone = str(b.student_phone, { name: 'Student phone', max: 30 });
    const n = normPhone(c.student_phone);
    if (c.student_phone && (n.length < 6 || n.length > 15)) throw bad('Enter a valid student phone number (6–15 digits)', { field: 'Student phone' });
  }
  if (b.phone !== undefined || creating) {
    const minor = c.age != null && c.age < ADULT_AGE;
    const label = minor ? 'Parent phone' : 'Phone';
    c.phone = str(b.phone, { required: true, name: label, max: 30 });
    c.phone_norm = normPhone(c.phone);
    if (c.phone_norm.length < 6 || c.phone_norm.length > 15) throw bad(`Enter a valid ${label.toLowerCase()} number (6–15 digits, country code allowed)`, { field: label });
  }
  return touched;
}

/** Age decides which contact details are required. */
function checkPersonRules(c) {
  if (c.age == null) throw bad('Age is required', { field: 'Age' });
  if (c.age < ADULT_AGE) {
    if (!c.parent_name) throw bad('Parent name is required for a student under 18', { field: 'Parent name' });
    if (!c.parent_relationship) throw bad('Relationship is required for a student under 18', { field: 'Relationship' });
  } else {
    // An adult's own number is the main phone; there is no separate student phone.
    c.student_phone = null;
  }
}

/**
 * Keeps the candidate's Google Meet event in step with the pre-test (best effort, never blocks a save).
 * Creates a meeting once the time is confirmed, moves it when the time or name changes,
 * and removes it when the pre-test is cancelled or its time is cleared.
 * Returns { meet_error } or { meet_status: 'not_connected' } for the browser to show, or {}.
 */
async function syncMeet(db, before, c) {
  const wants = !!c.pretest_at && c.status !== 'Cancelled' && (c.time_confirmation === 'Confirmed' || !!c.meet_event_id);
  const s = await google.readSettings(db);
  if (!google.isConnected(s)) return wants && !c.meet_event_id ? { meet_status: 'not_connected' } : {};
  const save = (link, eventId) => db.run('UPDATE candidates SET meet_link = ?, meet_event_id = ? WHERE id = ?', [link, eventId, c.id]);
  try {
    if (c.meet_event_id && !wants) {
      await google.deleteMeeting(db, s, c.meet_event_id);
      await save(null, null);
    } else if (c.meet_event_id && before && (before.pretest_at !== c.pretest_at || before.student_name !== c.student_name)) {
      try { await google.moveMeeting(db, s, c, PRETEST_MINUTES); } catch (e) {
        if (e.status !== 404 && e.status !== 410) throw e;
        const m = await google.createMeeting(db, s, c, PRETEST_MINUTES); // removed in Google Calendar: make a new one
        await save(m.meet_link, m.meet_event_id);
      }
    } else if (!c.meet_event_id && wants) {
      const m = await google.createMeeting(db, s, c, PRETEST_MINUTES);
      await save(m.meet_link, m.meet_event_id);
    }
    return {};
  } catch (e) {
    console.error('Google Meet sync failed:', e.message);
    return { meet_error: `The pre-test was saved, but the Google Meet link could not be ${c.meet_event_id ? 'updated' : 'created'}: ${e.message}` };
  }
}

module.exports = (app, { db }) => {
  const byId = id => db.get(`${SELECT} WHERE c.id = ?`, [id]);

  // ---------- Pre-Test Queue ----------
  app.get('/api/candidates', async (req, res) => {
    const q = req.query;
    const where = [];
    const p = {};
    if (req.user.role === 'teacher') { where.push('c.pretest_teacher_id = @me'); p.me = req.user.teacher_id; }
    if (q.q) {
      const digits = normPhone(q.q);
      const byPhone = req.user.role !== 'teacher' && digits.length >= 3;
      where.push(`(c.student_name ILIKE @q OR c.parent_name ILIKE @q OR c.lead_id ILIKE @q OR c.location ILIKE @q
        ${byPhone ? 'OR c.phone_norm LIKE @qp' : ''})`);
      p.q = `%${String(q.q).trim()}%`;
      if (byPhone) p.qp = `%${digits}%`;
    }
    if (q.status) {
      const list = String(q.status).split(',').filter(s => STATUSES.includes(s));
      if (list.length) { where.push(`c.status IN (${list.map((_, i) => `@st${i}`).join(',')})`); list.forEach((s, i) => { p['st' + i] = s; }); }
    }
    if (q.teacher) {
      if (q.teacher === 'unassigned') where.push('c.pretest_teacher_id IS NULL');
      else { where.push('c.pretest_teacher_id = @tid'); p.tid = idParam(q.teacher); }
    }
    if (q.confirmation && CONFIRMATIONS.includes(q.confirmation)) { where.push('c.time_confirmation = @conf'); p.conf = q.confirmation; }
    if (q.date) {
      if (q.date === 'none') where.push('c.pretest_at IS NULL');
      else if (isValidDate(q.date)) { where.push('substr(c.pretest_at,1,10) = @date'); p.date = q.date; }
    }
    if (q.date_from && isValidDate(q.date_from)) { where.push('substr(c.pretest_at,1,10) >= @df'); p.df = q.date_from; }
    if (q.date_to && isValidDate(q.date_to)) { where.push('substr(c.pretest_at,1,10) <= @dt'); p.dt = q.date_to; }
    if (q.sales_rep && req.user.role !== 'teacher') { where.push('c.sales_rep_id = @rep'); p.rep = idParam(q.sales_rep); }
    if (q.result === 'none') where.push('pr.id IS NULL');
    if (q.review === 'pending') where.push('pr.id IS NOT NULL AND pr.reviewed_at IS NULL');
    if (q.result && ADMISSION.includes(q.result)) { where.push('pr.admission_status = @res'); p.res = q.result; }
    const sql = `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (c.pretest_at IS NULL) DESC, c.pretest_at ASC, c.id DESC LIMIT 1000`;
    let rows = await db.all(sql, p);
    if (req.user.role === 'teacher') rows = rows.map(redactForTeacher);
    res.json(rows);
  });

  app.get('/api/candidates/:id', async (req, res) => {
    const c = await byId(idParam(req.params.id));
    if (!c || !canSee(req.user, c)) throw notFound('Candidate');
    const result = (await db.get(`SELECT pr.*, t.name AS teacher_name, u.name AS submitted_by_name, rv.name AS reviewed_by_name
      FROM pretest_results pr JOIN teachers t ON t.id = pr.teacher_id JOIN users u ON u.id = pr.submitted_by
      LEFT JOIN users rv ON rv.id = pr.reviewed_by WHERE pr.candidate_id = ?`, [c.id])) || null;
    const out = req.user.role === 'teacher' ? redactForTeacher(c) : c;
    res.json({ ...out, result, history: req.user.role === 'manager' ? await history(db, 'candidate', c.id) : undefined });
  });

  app.post('/api/candidates', requireRole('manager', 'sales'), async (req, res) => {
    const b = req.body;
    const key = str(b.idempotency_key, { max: 80, name: 'Request key' });
    const replay = async () => {
      const prior = key && (await db.get('SELECT id FROM candidates WHERE idempotency_key = ?', [key]));
      return prior ? { ...(await byId(prior.id)), replayed: true } : null;
    };
    const earlier = await replay();
    if (earlier) return res.status(200).json(earlier);

    const c = {
      first_name: null, last_name: null, gender: null, parent_name: null, parent_relationship: null, student_phone: null, age: null,
      location: str(b.location, { name: 'Location', max: 100 }),
      sales_rep_id: int(b.sales_rep_id, { min: 1, name: 'Assigned Sales Representative' }) || req.user.id,
      pretest_at: str(b.pretest_at, { name: 'Pre-test date/time', max: 16 }),
      time_confirmation: oneOf(b.time_confirmation || 'Not Confirmed', CONFIRMATIONS, { name: 'Time confirmation' }),
      pretest_teacher_id: null,
      notes: str(b.notes, { name: 'Notes', max: 2000 }),
    };
    readPerson(b, c, { creating: true });
    checkPersonRules(c);
    if (c.pretest_at && !isValidDateTime(c.pretest_at)) throw bad('Pre-test date/time is not valid', { field: 'Pre-test date/time' });
    if (c.time_confirmation === 'Confirmed' && !c.pretest_at) throw bad('A confirmed pre-test needs a date and time', { field: 'Date' });
    await validateSalesRep(db, c.sales_rep_id);
    if (b.pretest_teacher_id) {
      if (req.user.role !== 'manager') throw forbidden();
      c.pretest_teacher_id = int(b.pretest_teacher_id, { min: 1, name: 'Pre-test teacher' });
      await validateTeacher(db, c.pretest_teacher_id);
    }
    let status = b.status ? oneOf(b.status, ['Scheduled', 'Time Required', 'Follow-up'], { name: 'Status' }) : null;
    if (!status) status = c.pretest_at ? 'Scheduled' : 'Time Required';
    if (status === 'Scheduled' && !c.pretest_at) throw bad('A Scheduled pre-test needs a date and time', { field: 'Pre-test date/time' });
    c.status = status;

    const leadId = str(b.lead_id, { name: 'Lead ID', max: 30 });
    if (leadId) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_\-/]*$/.test(leadId)) throw bad('Lead ID may contain letters, numbers, - _ / only', { field: 'Lead ID' });
      if (await db.get('SELECT 1 AS x FROM candidates WHERE lower(lead_id) = lower(?)', [leadId])) throw conflict(`Lead ID ${leadId} is already used`, { field: 'Lead ID' });
    }

    // Duplicate guard: same phone AND same student name (siblings may share a phone).
    if (!bool(b.confirm_duplicate)) {
      const dups = await findDuplicates(db, c.phone_norm, c.student_name);
      if (dups.length) {
        throw conflict(`A candidate named ${dups[0].student_name} with this phone already exists (${dups[0].lead_id}, ${dups[0].status}).`,
          { code: 'POSSIBLE_DUPLICATE', duplicates: dups });
      }
    }

    let id;
    try {
      id = await db.tx(async t => {
        c.lead_id = leadId || (await nextLeadId(t));
        const r = await t.get(`INSERT INTO candidates (lead_id, student_name, first_name, last_name, gender, parent_name,
          parent_relationship, phone, phone_norm, student_phone, location, age,
          sales_rep_id, pretest_at, time_confirmation, pretest_teacher_id, status, notes, idempotency_key, created_by)
          VALUES (@lead_id, @student_name, @first_name, @last_name, @gender, @parent_name,
          @parent_relationship, @phone, @phone_norm, @student_phone, @location, @age, @sales_rep_id, @pretest_at,
          @time_confirmation, @pretest_teacher_id, @status, @notes, @key, @by) RETURNING id`, { ...c, key, by: req.user.id });
        await audit(t, req.user, 'candidate', r.id, 'created', null, c);
        return r.id;
      });
    } catch (e) {
      // A simultaneous identical submission won the race: return that record.
      if (isUniqueViolation(e)) { const again = await replay(); if (again) return res.status(200).json(again); }
      throw e;
    }
    const meet = await syncMeet(db, null, await db.get('SELECT * FROM candidates WHERE id = ?', [id]));
    res.status(201).json({ ...(await byId(id)), ...meet });
  });

  app.patch('/api/candidates/:id', requireRole('manager', 'sales'), async (req, res) => {
    const before = await db.get('SELECT * FROM candidates WHERE id = ?', [idParam(req.params.id)]);
    if (!before) throw notFound('Candidate');
    const b = req.body;
    const isMgr = req.user.role === 'manager';
    const c = { ...before };
    if (readPerson(b, c, { creating: false })) checkPersonRules(c);
    if (b.location !== undefined) c.location = str(b.location, { name: 'Location', max: 100 });
    if (b.notes !== undefined) c.notes = str(b.notes, { name: 'Notes', max: 2000 });
    if (b.sales_rep_id !== undefined) {
      c.sales_rep_id = int(b.sales_rep_id, { min: 1, required: true, name: 'Assigned Sales Representative' });
      if (c.sales_rep_id !== before.sales_rep_id) await validateSalesRep(db, c.sales_rep_id);
    }
    if (b.pretest_at !== undefined) {
      c.pretest_at = str(b.pretest_at, { name: 'Pre-test date/time', max: 16 });
      if (c.pretest_at && !isValidDateTime(c.pretest_at)) throw bad('Pre-test date/time is not valid', { field: 'Pre-test date/time' });
    }
    if (b.time_confirmation !== undefined) c.time_confirmation = oneOf(b.time_confirmation, CONFIRMATIONS, { required: true, name: 'Time confirmation' });
    const hasResult = !!(await db.get('SELECT 1 AS x FROM pretest_results WHERE candidate_id = ?', [before.id]));
    if (b.pretest_teacher_id !== undefined) {
      if (!isMgr) throw forbidden();
      c.pretest_teacher_id = b.pretest_teacher_id === null || b.pretest_teacher_id === '' ? null : int(b.pretest_teacher_id, { min: 1, name: 'Pre-test teacher' });
      if (c.pretest_teacher_id !== before.pretest_teacher_id) {
        await validateTeacher(db, c.pretest_teacher_id);
        if (hasResult) throw bad('The assessment is already recorded; the pre-test teacher can no longer be changed');
      }
    }
    if (b.status !== undefined) {
      c.status = oneOf(b.status, isMgr ? STATUSES : SALES_STATUSES, { required: true, name: 'Status' });
      if (!isMgr && ['Completed', 'Needs Review'].includes(before.status) && c.status !== before.status)
        throw bad('Only a Manager can change the status of an assessed pre-test');
      if (c.status === 'Completed' && !hasResult) throw bad('Status can be Completed only after the assessment is recorded');
    }
    if (c.status === 'Scheduled' && !c.pretest_at) throw bad('A Scheduled pre-test needs a date and time', { field: 'Pre-test date/time' });

    if ((c.phone_norm !== before.phone_norm || normName(c.student_name) !== normName(before.student_name)) && !bool(b.confirm_duplicate)) {
      const d = await findDuplicates(db, c.phone_norm, c.student_name, before.id);
      if (d.length) throw conflict(`Another candidate (${d[0].lead_id}) has the same name and phone.`, { code: 'POSSIBLE_DUPLICATE', duplicates: d });
    }
    await db.tx(async t => {
      await t.run(`UPDATE candidates SET student_name=@student_name, first_name=@first_name, last_name=@last_name, gender=@gender,
        parent_name=@parent_name, parent_relationship=@parent_relationship, phone=@phone, phone_norm=@phone_norm,
        student_phone=@student_phone, location=@location, age=@age, sales_rep_id=@sales_rep_id, pretest_at=@pretest_at, time_confirmation=@time_confirmation,
        pretest_teacher_id=@pretest_teacher_id, status=@status, notes=@notes, updated_at=now_iso() WHERE id=@id`, c);
      await audit(t, req.user, 'candidate', before.id, 'updated', before, c, str(b.reason, { max: 500 }));
    });
    const meet = await syncMeet(db, before, c);
    res.json({ ...(await byId(before.id)), ...meet });
  });

  // Create the Meet link on demand (older candidates, or after connecting Google / fixing an error).
  app.post('/api/candidates/:id/meet', requireRole('manager', 'sales'), async (req, res) => {
    const c = await db.get('SELECT * FROM candidates WHERE id = ?', [idParam(req.params.id)]);
    if (!c) throw notFound('Candidate');
    if (!c.pretest_at) throw bad('Set the pre-test date and time first');
    if (c.status === 'Cancelled') throw bad('This pre-test is cancelled');
    if (!google.isConnected(await google.readSettings(db))) throw bad('Google is not connected yet. The Manager can connect it in Settings.', { code: 'GOOGLE_NOT_CONNECTED' });
    const meet = await syncMeet(db, c, { ...c, time_confirmation: 'Confirmed' });
    if (meet.meet_error) throw bad(meet.meet_error);
    res.json(await byId(c.id));
  });

  // ---------- Teacher clash check for a pre-test time (warning only, never blocks) ----------
  app.get('/api/pretest-clash', requireRole('manager'), async (req, res) => {
    const q = req.query;
    const teacherId = idParam(q.teacher);
    const at = String(q.at || '');
    if (!isValidDateTime(at)) throw bad('Choose a valid pre-test date and time');
    const teacher = await db.get('SELECT id, name, active FROM teachers WHERE id = ?', [teacherId]);
    if (!teacher) throw notFound('Teacher');
    const end = addMinutes(at, PRETEST_MINUTES);
    const date = at.slice(0, 10);
    const overlaps = (s, mins) => s < end && at < addMinutes(s, mins);
    const busy = [];
    const classes = await db.all(`SELECT cl.class_code, cl.scheduled_at, cl.duration_min, c.student_name
      FROM classes cl JOIN enrollments e ON e.id = cl.enrollment_id JOIN students s ON s.id = e.student_id
      JOIN candidates c ON c.id = s.candidate_id
      WHERE cl.teacher_id = ? AND substr(cl.scheduled_at,1,10) = ? AND cl.status NOT IN ('Cancelled','Rescheduled')`, [teacherId, date]);
    for (const r of classes) if (overlaps(r.scheduled_at, r.duration_min))
      busy.push({ kind: 'Class', code: r.class_code, student_name: r.student_name, start: r.scheduled_at, end: addMinutes(r.scheduled_at, r.duration_min) });
    const pretests = await db.all(`SELECT id, lead_id, student_name, pretest_at FROM candidates
      WHERE pretest_teacher_id = ? AND substr(pretest_at,1,10) = ? AND status <> 'Cancelled' AND id <> ?`,
    [teacherId, date, q.candidate ? idParam(q.candidate) : 0]);
    for (const r of pretests) if (overlaps(r.pretest_at, PRETEST_MINUTES))
      busy.push({ kind: 'Pre-test', code: r.lead_id, student_name: r.student_name, start: r.pretest_at, end: addMinutes(r.pretest_at, PRETEST_MINUTES) });
    const warnings = [];
    if (!teacher.active) warnings.push(`${teacher.name} is inactive`);
    const hours = await db.all('SELECT start_time, end_time FROM teacher_hours WHERE teacher_id = ? AND weekday = ?', [teacherId, weekdayOf(at)]);
    const st = at.slice(11); const et = end.slice(11);
    if (end.slice(0, 10) !== date || !hours.some(h => h.start_time <= st && et <= h.end_time)) warnings.push('outside working hours');
    busy.sort((a, b) => a.start.localeCompare(b.start));
    res.json({ teacher: teacher.name, minutes: PRETEST_MINUTES, busy, warnings });
  });

  // ---------- Pre-Test Result ----------
  app.put('/api/candidates/:id/result', requireRole('manager', 'teacher'), async (req, res) => {
    const cand = await db.get('SELECT * FROM candidates WHERE id = ?', [idParam(req.params.id)]);
    if (!cand || !canSee(req.user, cand)) throw notFound('Candidate');
    if (!cand.pretest_teacher_id) throw bad('Assign a pre-test teacher before recording the assessment');
    if (cand.status === 'Cancelled') throw bad('This pre-test is cancelled. Change its status before recording a result.');
    const b = req.body;
    const r = {
      candidate_id: cand.id,
      teacher_id: cand.pretest_teacher_id,
      recommended_course: oneOf(b.recommended_course, COURSES, { required: true, name: 'Recommended course' }),
      assessment: str(b.assessment, { required: true, name: 'Assessment', max: 4000 }),
      admission_status: oneOf(b.admission_status, ADMISSION, { required: true, name: 'Admission status' }),
      objection: str(b.objection, { name: 'Objection', max: 2000 }),
      recommendation: str(b.recommendation, { name: 'Recommendation', max: 2000 }),
      notes: str(b.notes, { name: 'Notes', max: 4000 }),
    };

    await db.tx(async t => {
      // Lock the candidate row so concurrent submissions are applied one after another.
      await t.get('SELECT id FROM candidates WHERE id = ? FOR UPDATE', [cand.id]);
      const prior = await t.get('SELECT * FROM pretest_results WHERE candidate_id = ?', [cand.id]);
      if (prior && prior.reviewed_at && req.user.role !== 'manager') throw bad('This result has been reviewed by the Manager and is now locked');
      const student = await t.get('SELECT * FROM students WHERE candidate_id = ?', [cand.id]);
      const enrolled = student ? (await t.get('SELECT COUNT(*) n FROM enrollments WHERE student_id = ?', [student.id])).n : 0;
      if (enrolled && r.admission_status !== 'Confirmed') throw bad('This student already has an enrollment; admission status must stay Confirmed');

      if (prior) {
        await t.run(`UPDATE pretest_results SET recommended_course=@recommended_course, assessment=@assessment,
          admission_status=@admission_status, objection=@objection, recommendation=@recommendation, notes=@notes,
          updated_at=now_iso() WHERE id=@id`, { ...r, id: prior.id });
        await audit(t, req.user, 'pretest_result', prior.id, 'updated', prior, { ...prior, ...r });
      } else {
        const ins = await t.get(`INSERT INTO pretest_results (candidate_id, teacher_id, recommended_course, assessment,
          admission_status, objection, recommendation, notes, submitted_by)
          VALUES (@candidate_id, @teacher_id, @recommended_course, @assessment, @admission_status, @objection, @recommendation, @notes, @by)
          RETURNING id`, { ...r, by: req.user.id });
        await audit(t, req.user, 'pretest_result', ins.id, 'submitted', null, r);
      }
      // Confirmed => create/link Student (no Enrollment). Not confirmed => unlink a student that has no enrollment.
      if (r.admission_status === 'Confirmed' && !student) {
        await t.run('INSERT INTO students (candidate_id) VALUES (?)', [cand.id]);
      } else if (r.admission_status !== 'Confirmed' && student && !enrolled) {
        await t.run('DELETE FROM students WHERE id = ?', [student.id]);
      }
      const newStatus = r.admission_status === 'Follow-up' ? 'Follow-up' : 'Completed';
      if (cand.status !== newStatus) {
        await t.run('UPDATE candidates SET status = ?, updated_at=now_iso() WHERE id = ?', [newStatus, cand.id]);
        await audit(t, req.user, 'candidate', cand.id, 'status_from_assessment', { status: cand.status }, { status: newStatus });
      }
    });
    res.json(await db.get('SELECT * FROM pretest_results WHERE candidate_id = ?', [cand.id]));
  });

  app.post('/api/candidates/:id/result/review', requireRole('manager'), async (req, res) => {
    const r = await db.get('SELECT * FROM pretest_results WHERE candidate_id = ?', [idParam(req.params.id)]);
    if (!r) throw notFound('Assessment');
    const reviewed = bool(req.body.reviewed ?? true);
    await db.run('UPDATE pretest_results SET reviewed_by = ?, reviewed_at = ? WHERE id = ?',
      [reviewed ? req.user.id : null, reviewed ? new Date().toISOString() : null, r.id]);
    await audit(db, req.user, 'pretest_result', r.id, reviewed ? 'reviewed' : 'review_cleared');
    res.json(await db.get('SELECT * FROM pretest_results WHERE id = ?', [r.id]));
  });
};

module.exports.COURSES = COURSES;
module.exports.PRETEST_MINUTES = PRETEST_MINUTES;
