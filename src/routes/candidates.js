'use strict';
const { requireRole } = require('../auth');
const { audit, history } = require('../audit');
const {
  bad, notFound, forbidden, conflict, str, int, oneOf, bool, isValidDateTime, isValidDate, normPhone, normName,
} = require('../util');

const STATUSES = ['Scheduled', 'Time Required', 'Needs Review', 'Completed', 'Cancelled', 'Follow-up'];
const SALES_STATUSES = ['Scheduled', 'Time Required', 'Follow-up', 'Cancelled'];
const CONFIRMATIONS = ['Not Confirmed', 'Confirmed', 'Reschedule Requested'];
const COURSES = ['Starter', 'Reader', 'Writer', 'Malayalam Master'];
const ADMISSION = ['Confirmed', 'Follow-up', 'Not Interested'];

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
  const { phone, phone_norm, idempotency_key, ...rest } = c;
  return rest;
}

function canSee(user, c) {
  if (user.role === 'manager' || user.role === 'sales') return true;
  return user.role === 'teacher' && c.pretest_teacher_id === user.teacher_id;
}

function nextLeadId(db) {
  const n = db.prepare('SELECT COALESCE(MAX(id),0) + 1 AS n FROM candidates').get().n;
  for (let i = n; ; i++) {
    const id = 'NM-' + String(i).padStart(5, '0');
    if (!db.prepare('SELECT 1 FROM candidates WHERE lead_id = ?').get(id)) return id;
  }
}

function validateSalesRep(db, id) {
  const r = db.prepare(`SELECT id FROM users WHERE id = ? AND active = 1 AND role IN ('sales','manager')`).get(id);
  if (!r) throw bad('Assigned Sales Representative must be an active Sales Team member or Manager', { field: 'Assigned Sales Representative' });
}
function validateTeacher(db, id) {
  if (id == null) return;
  const t = db.prepare('SELECT active FROM teachers WHERE id = ?').get(id);
  if (!t) throw bad('Pre-test teacher not found');
  if (!t.active) throw bad('Pre-test teacher is inactive');
}

module.exports = (app, { db }) => {
  // ---------- Pre-Test Queue ----------
  app.get('/api/candidates', (req, res) => {
    const q = req.query;
    const where = [];
    const p = {};
    if (req.user.role === 'teacher') { where.push('c.pretest_teacher_id = @me'); p.me = req.user.teacher_id; }
    if (q.q) {
      const digits = normPhone(q.q);
      const byPhone = req.user.role !== 'teacher' && digits.length >= 3;
      where.push(`(c.student_name LIKE @q OR c.parent_name LIKE @q OR c.lead_id LIKE @q OR c.location LIKE @q
        ${byPhone ? 'OR c.phone_norm LIKE @qp' : ''})`);
      p.q = `%${String(q.q).trim()}%`;
      if (byPhone) p.qp = `%${digits}%`;
    }
    if (q.status) {
      const list = String(q.status).split(',').filter(s => STATUSES.includes(s));
      if (list.length) where.push(`c.status IN (${list.map((_, i) => `@st${i}`).join(',')})`), list.forEach((s, i) => { p['st' + i] = s; });
    }
    if (q.teacher) {
      if (q.teacher === 'unassigned') where.push('c.pretest_teacher_id IS NULL');
      else { where.push('c.pretest_teacher_id = @tid'); p.tid = Number(q.teacher); }
    }
    if (q.confirmation && CONFIRMATIONS.includes(q.confirmation)) { where.push('c.time_confirmation = @conf'); p.conf = q.confirmation; }
    if (q.date) {
      if (q.date === 'none') where.push('c.pretest_at IS NULL');
      else if (isValidDate(q.date)) { where.push('substr(c.pretest_at,1,10) = @date'); p.date = q.date; }
    }
    if (q.date_from && isValidDate(q.date_from)) { where.push('substr(c.pretest_at,1,10) >= @df'); p.df = q.date_from; }
    if (q.date_to && isValidDate(q.date_to)) { where.push('substr(c.pretest_at,1,10) <= @dt'); p.dt = q.date_to; }
    if (q.sales_rep && req.user.role !== 'teacher') { where.push('c.sales_rep_id = @rep'); p.rep = Number(q.sales_rep); }
    if (q.result === 'none') where.push('pr.id IS NULL');
    if (q.review === 'pending') where.push('pr.id IS NOT NULL AND pr.reviewed_at IS NULL');
    if (q.result && ADMISSION.includes(q.result)) { where.push('pr.admission_status = @res'); p.res = q.result; }
    const sql = `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (c.pretest_at IS NULL) DESC, c.pretest_at ASC, c.id DESC LIMIT 1000`;
    let rows = db.prepare(sql).all(p);
    if (req.user.role === 'teacher') rows = rows.map(redactForTeacher);
    res.json(rows);
  });

  app.get('/api/candidates/:id', (req, res) => {
    const c = db.prepare(`${SELECT} WHERE c.id = ?`).get(req.params.id);
    if (!c || !canSee(req.user, c)) throw notFound('Candidate');
    const result = db.prepare(`SELECT pr.*, t.name AS teacher_name, u.name AS submitted_by_name, rv.name AS reviewed_by_name
      FROM pretest_results pr JOIN teachers t ON t.id = pr.teacher_id JOIN users u ON u.id = pr.submitted_by
      LEFT JOIN users rv ON rv.id = pr.reviewed_by WHERE pr.candidate_id = ?`).get(c.id) || null;
    const out = req.user.role === 'teacher' ? redactForTeacher(c) : c;
    res.json({ ...out, result, history: req.user.role === 'manager' ? history(db, 'candidate', c.id) : undefined });
  });

  app.post('/api/candidates', requireRole('manager', 'sales'), (req, res) => {
    const b = req.body;
    const key = str(b.idempotency_key, { max: 80, name: 'Request key' });
    if (key) {
      const prior = db.prepare('SELECT id FROM candidates WHERE idempotency_key = ?').get(key);
      if (prior) return res.status(200).json({ ...db.prepare(`${SELECT} WHERE c.id = ?`).get(prior.id), replayed: true });
    }
    const c = {
      student_name: str(b.student_name, { required: true, name: 'Student name', max: 100 }),
      parent_name: str(b.parent_name, { name: 'Parent name', max: 100 }),
      phone: str(b.phone, { required: true, name: 'Phone', max: 30 }),
      location: str(b.location, { name: 'Location', max: 100 }),
      age: int(b.age, { min: 2, max: 99, name: 'Age' }),
      sales_rep_id: int(b.sales_rep_id, { min: 1, name: 'Assigned Sales Representative' }) || req.user.id,
      pretest_at: str(b.pretest_at, { name: 'Pre-test date/time', max: 16 }),
      time_confirmation: oneOf(b.time_confirmation || 'Not Confirmed', CONFIRMATIONS, { name: 'Time confirmation' }),
      pretest_teacher_id: null,
      notes: str(b.notes, { name: 'Notes', max: 2000 }),
    };
    c.phone_norm = normPhone(c.phone);
    if (c.phone_norm.length < 6 || c.phone_norm.length > 15) throw bad('Enter a valid phone number (6–15 digits, country code allowed)', { field: 'Phone' });
    if (c.pretest_at && !isValidDateTime(c.pretest_at)) throw bad('Pre-test date/time is not valid', { field: 'Pre-test date/time' });
    validateSalesRep(db, c.sales_rep_id);
    if (b.pretest_teacher_id) {
      if (req.user.role !== 'manager') throw forbidden();
      c.pretest_teacher_id = int(b.pretest_teacher_id, { min: 1, name: 'Pre-test teacher' });
      validateTeacher(db, c.pretest_teacher_id);
    }
    let status = b.status ? oneOf(b.status, ['Scheduled', 'Time Required', 'Follow-up'], { name: 'Status' }) : null;
    if (!status) status = c.pretest_at ? 'Scheduled' : 'Time Required';
    if (status === 'Scheduled' && !c.pretest_at) throw bad('A Scheduled pre-test needs a date and time', { field: 'Pre-test date/time' });
    c.status = status;

    let leadId = str(b.lead_id, { name: 'Lead ID', max: 30 });
    if (leadId) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_\-/]*$/.test(leadId)) throw bad('Lead ID may contain letters, numbers, - _ / only', { field: 'Lead ID' });
      if (db.prepare('SELECT 1 FROM candidates WHERE lead_id = ?').get(leadId)) throw conflict(`Lead ID ${leadId} is already used`, { field: 'Lead ID' });
    }

    // Duplicate guard: same phone AND same student name (siblings may share a phone).
    if (!bool(b.confirm_duplicate)) {
      const dups = db.prepare(`SELECT id, lead_id, student_name, status FROM candidates WHERE phone_norm = ?`).all(c.phone_norm)
        .filter(d => normName(d.student_name) === normName(c.student_name));
      if (dups.length) {
        throw conflict(`A candidate named ${dups[0].student_name} with this phone already exists (${dups[0].lead_id}, ${dups[0].status}).`,
          { code: 'POSSIBLE_DUPLICATE', duplicates: dups });
      }
    }

    const id = db.transaction(() => {
      c.lead_id = leadId || nextLeadId(db);
      const r = db.prepare(`INSERT INTO candidates (lead_id, student_name, parent_name, phone, phone_norm, location, age,
        sales_rep_id, pretest_at, time_confirmation, pretest_teacher_id, status, notes, idempotency_key, created_by)
        VALUES (@lead_id, @student_name, @parent_name, @phone, @phone_norm, @location, @age, @sales_rep_id, @pretest_at,
        @time_confirmation, @pretest_teacher_id, @status, @notes, @key, @by)`).run({ ...c, key, by: req.user.id });
      audit(db, req.user, 'candidate', r.lastInsertRowid, 'created', null, c);
      return r.lastInsertRowid;
    })();
    res.status(201).json(db.prepare(`${SELECT} WHERE c.id = ?`).get(id));
  });

  app.patch('/api/candidates/:id', requireRole('manager', 'sales'), (req, res) => {
    const before = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
    if (!before) throw notFound('Candidate');
    const b = req.body;
    const isMgr = req.user.role === 'manager';
    const c = { ...before };
    if (b.student_name !== undefined) c.student_name = str(b.student_name, { required: true, name: 'Student name', max: 100 });
    if (b.parent_name !== undefined) c.parent_name = str(b.parent_name, { name: 'Parent name', max: 100 });
    if (b.phone !== undefined) {
      c.phone = str(b.phone, { required: true, name: 'Phone', max: 30 });
      c.phone_norm = normPhone(c.phone);
      if (c.phone_norm.length < 6 || c.phone_norm.length > 15) throw bad('Enter a valid phone number', { field: 'Phone' });
    }
    if (b.location !== undefined) c.location = str(b.location, { name: 'Location', max: 100 });
    if (b.age !== undefined) c.age = int(b.age, { min: 2, max: 99, name: 'Age' });
    if (b.notes !== undefined) c.notes = str(b.notes, { name: 'Notes', max: 2000 });
    if (b.sales_rep_id !== undefined) {
      c.sales_rep_id = int(b.sales_rep_id, { min: 1, required: true, name: 'Assigned Sales Representative' });
      if (c.sales_rep_id !== before.sales_rep_id) validateSalesRep(db, c.sales_rep_id);
    }
    if (b.pretest_at !== undefined) {
      c.pretest_at = str(b.pretest_at, { name: 'Pre-test date/time', max: 16 });
      if (c.pretest_at && !isValidDateTime(c.pretest_at)) throw bad('Pre-test date/time is not valid', { field: 'Pre-test date/time' });
    }
    if (b.time_confirmation !== undefined) c.time_confirmation = oneOf(b.time_confirmation, CONFIRMATIONS, { required: true, name: 'Time confirmation' });
    if (b.pretest_teacher_id !== undefined) {
      if (!isMgr) throw forbidden();
      c.pretest_teacher_id = b.pretest_teacher_id === null || b.pretest_teacher_id === '' ? null : int(b.pretest_teacher_id, { min: 1, name: 'Pre-test teacher' });
      if (c.pretest_teacher_id !== before.pretest_teacher_id) {
        validateTeacher(db, c.pretest_teacher_id);
        if (db.prepare('SELECT 1 FROM pretest_results WHERE candidate_id = ?').get(before.id))
          throw bad('The assessment is already recorded; the pre-test teacher can no longer be changed');
      }
    }
    if (b.status !== undefined) {
      c.status = oneOf(b.status, isMgr ? STATUSES : SALES_STATUSES, { required: true, name: 'Status' });
      if (!isMgr && ['Completed', 'Needs Review'].includes(before.status) && c.status !== before.status)
        throw bad('Only a Manager can change the status of an assessed pre-test');
      if (c.status === 'Completed' && !db.prepare('SELECT 1 FROM pretest_results WHERE candidate_id = ?').get(before.id))
        throw bad('Status can be Completed only after the assessment is recorded');
    }
    // Rescheduling a "Time Required" pre-test with a time moves it to Scheduled only if the user asked for it via status.
    if (c.status === 'Scheduled' && !c.pretest_at) throw bad('A Scheduled pre-test needs a date and time', { field: 'Pre-test date/time' });

    if (c.phone_norm !== before.phone_norm || normName(c.student_name) !== normName(before.student_name)) {
      if (!bool(b.confirm_duplicate)) {
        const d = db.prepare('SELECT id, lead_id, student_name FROM candidates WHERE phone_norm = ? AND id <> ?').all(c.phone_norm, before.id)
          .filter(x => normName(x.student_name) === normName(c.student_name));
        if (d.length) throw conflict(`Another candidate (${d[0].lead_id}) has the same name and phone.`, { code: 'POSSIBLE_DUPLICATE', duplicates: d });
      }
    }
    db.transaction(() => {
      db.prepare(`UPDATE candidates SET student_name=@student_name, parent_name=@parent_name, phone=@phone, phone_norm=@phone_norm,
        location=@location, age=@age, sales_rep_id=@sales_rep_id, pretest_at=@pretest_at, time_confirmation=@time_confirmation,
        pretest_teacher_id=@pretest_teacher_id, status=@status, notes=@notes,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`).run(c);
      audit(db, req.user, 'candidate', before.id, 'updated', before, c, str(b.reason, { max: 500 }));
    })();
    res.json(db.prepare(`${SELECT} WHERE c.id = ?`).get(before.id));
  });

  // ---------- Pre-Test Result ----------
  app.put('/api/candidates/:id/result', requireRole('manager', 'teacher'), (req, res) => {
    const cand = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
    if (!cand || !canSee(req.user, cand)) throw notFound('Candidate');
    if (!cand.pretest_teacher_id) throw bad('Assign a pre-test teacher before recording the assessment');
    if (cand.status === 'Cancelled') throw bad('This pre-test is cancelled. Change its status before recording a result.');
    const prior = db.prepare('SELECT * FROM pretest_results WHERE candidate_id = ?').get(cand.id);
    if (prior && prior.reviewed_at && req.user.role !== 'manager') throw bad('This result has been reviewed by the Manager and is now locked');

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
    const student = db.prepare('SELECT * FROM students WHERE candidate_id = ?').get(cand.id);
    const enrolled = student && db.prepare('SELECT COUNT(*) n FROM enrollments WHERE student_id = ?').get(student.id).n;
    if (enrolled && r.admission_status !== 'Confirmed') throw bad('This student already has an enrollment; admission status must stay Confirmed');

    db.transaction(() => {
      if (prior) {
        db.prepare(`UPDATE pretest_results SET recommended_course=@recommended_course, assessment=@assessment,
          admission_status=@admission_status, objection=@objection, recommendation=@recommendation, notes=@notes,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`).run({ ...r, id: prior.id });
        audit(db, req.user, 'pretest_result', prior.id, 'updated', prior, { ...prior, ...r });
      } else {
        const ins = db.prepare(`INSERT INTO pretest_results (candidate_id, teacher_id, recommended_course, assessment,
          admission_status, objection, recommendation, notes, submitted_by)
          VALUES (@candidate_id, @teacher_id, @recommended_course, @assessment, @admission_status, @objection, @recommendation, @notes, @by)`)
          .run({ ...r, by: req.user.id });
        audit(db, req.user, 'pretest_result', ins.lastInsertRowid, 'submitted', null, r);
      }
      // Confirmed => create/link Student (no Enrollment). Not confirmed => unlink a student that has no enrollment.
      if (r.admission_status === 'Confirmed' && !student) {
        db.prepare('INSERT INTO students (candidate_id) VALUES (?)').run(cand.id);
      } else if (r.admission_status !== 'Confirmed' && student && !enrolled) {
        db.prepare('DELETE FROM students WHERE id = ?').run(student.id);
      }
      const newStatus = r.admission_status === 'Follow-up' ? 'Follow-up' : 'Completed';
      if (cand.status !== newStatus) {
        db.prepare(`UPDATE candidates SET status = ?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(newStatus, cand.id);
        audit(db, req.user, 'candidate', cand.id, 'status_from_assessment', { status: cand.status }, { status: newStatus });
      }
    })();
    res.json(db.prepare('SELECT * FROM pretest_results WHERE candidate_id = ?').get(cand.id));
  });

  app.post('/api/candidates/:id/result/review', requireRole('manager'), (req, res) => {
    const r = db.prepare('SELECT * FROM pretest_results WHERE candidate_id = ?').get(req.params.id);
    if (!r) throw notFound('Assessment');
    const reviewed = bool(req.body.reviewed ?? true);
    db.prepare(`UPDATE pretest_results SET reviewed_by = ?, reviewed_at = ? WHERE id = ?`)
      .run(reviewed ? req.user.id : null, reviewed ? new Date().toISOString() : null, r.id);
    audit(db, req.user, 'pretest_result', r.id, reviewed ? 'reviewed' : 'review_cleared');
    res.json(db.prepare('SELECT * FROM pretest_results WHERE id = ?').get(r.id));
  });
};

module.exports.COURSES = COURSES;
