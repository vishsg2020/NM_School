'use strict';
const { requireRole } = require('../auth');
const { audit, history } = require('../audit');
const { COURSES } = require('./candidates');
const {
  bad, notFound, conflict, unprocessable, str, int, oneOf, bool, isValidDate, today, inr,
} = require('../util');

const METHODS = ['UPI', 'Bank Transfer', 'Cash', 'Card', 'Other'];
const MODES = ['1:1', '3:1'];

/** Money summary for one enrollment, derived from payment rows only. */
function moneySummary(fee, payments, onDate = today()) {
  const paid = payments.filter(p => p.status === 'Paid').reduce((s, p) => s + p.amount, 0);
  const pending = payments.filter(p => p.status === 'Pending').reduce((s, p) => s + p.amount, 0);
  const overdue = payments.filter(p => p.status === 'Pending' && p.date < onDate).reduce((s, p) => s + p.amount, 0);
  return { total_fee: fee, total_paid: paid, outstanding: fee - paid, pending_amount: pending, overdue_amount: overdue };
}

function parsePayment(p, stage) {
  if (!p || typeof p !== 'object') throw bad(`${stage} payment details are required`);
  const out = {
    stage,
    amount: int(p.amount, { min: 0, max: 10_000_000, required: true, name: `${stage} amount` }),
    status: oneOf(p.status, ['Paid', 'Pending'], { required: true, name: `${stage} status` }),
    date: str(p.date, { name: `${stage} date`, max: 10 }),
    method: oneOf(p.method || null, METHODS, { name: `${stage} method` }),
    reference: str(p.reference, { name: `${stage} reference`, max: 100 }),
  };
  checkPaymentRules(out, stage);
  return out;
}

function checkPaymentRules(p, stage) {
  const label = p.status === 'Paid' ? 'received date' : 'due date';
  if (!p.date) throw bad(`${stage}: ${label} is required`, { field: `${stage} date` });
  if (!isValidDate(p.date)) throw bad(`${stage}: ${label} is not a valid date`, { field: `${stage} date` });
  if (p.status === 'Paid') {
    if (p.date > today()) throw bad(`${stage}: received date cannot be in the future`, { field: `${stage} date` });
    if (!p.method) throw bad(`${stage}: payment method is required for a Paid payment`, { field: `${stage} method` });
  }
}

function feeMismatchMessage(total, adv, fin) {
  const sum = adv + fin;
  const diff = Math.abs(total - sum);
  return `Advance ${inr(adv)} + Final ${inr(fin)} = ${inr(sum)}, which is ${inr(diff)} ${sum < total ? 'less' : 'more'} than the Total Course Fee of ${inr(total)}. Adjust the amounts so they add up exactly.`;
}

const ENROLL_SELECT = `
  SELECT e.*, c.student_name, c.parent_name, c.phone, c.id AS candidate_id, t.name AS teacher_name,
         r.name AS sales_rep_name, (e.total_classes - e.completed_classes) AS remaining_classes
  FROM enrollments e
  JOIN students s ON s.id = e.student_id
  JOIN candidates c ON c.id = s.candidate_id
  JOIN teachers t ON t.id = e.teacher_id
  JOIN users r ON r.id = e.sales_rep_id`;

function teacherSafe(e) {
  const { total_fee, phone, idempotency_key, ...rest } = e;
  return rest;
}

module.exports = (app, { db }) => {
  const paymentsOf = id => db.prepare(`SELECT * FROM payments WHERE enrollment_id = ? ORDER BY CASE stage WHEN 'Advance' THEN 0 ELSE 1 END`).all(id);

  // Students with a Confirmed assessment and no enrollment yet.
  app.get('/api/admissions/pending', requireRole('manager'), (_req, res) => {
    res.json(db.prepare(`
      SELECT s.id AS student_id, c.id AS candidate_id, c.lead_id, c.student_name, c.parent_name, c.age, c.location,
             r.name AS sales_rep_name, c.sales_rep_id, pr.recommended_course, pr.submitted_at, pr.recommendation,
             t.name AS pretest_teacher_name
      FROM students s JOIN candidates c ON c.id = s.candidate_id
      JOIN pretest_results pr ON pr.candidate_id = c.id AND pr.admission_status = 'Confirmed'
      JOIN users r ON r.id = c.sales_rep_id
      JOIN teachers t ON t.id = pr.teacher_id
      WHERE NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id)
      ORDER BY pr.submitted_at`).all());
  });

  app.post('/api/admissions', requireRole('manager'), (req, res) => {
    const b = req.body;
    const key = str(b.idempotency_key, { max: 80, name: 'Request key' });
    if (key) {
      const prior = db.prepare('SELECT id FROM enrollments WHERE idempotency_key = ?').get(key);
      if (prior) return res.status(200).json({ ...db.prepare(`${ENROLL_SELECT} WHERE e.id = ?`).get(prior.id), payments: paymentsOf(prior.id), replayed: true });
    }
    const studentId = int(b.student_id, { min: 1, required: true, name: 'Student' });
    const st = db.prepare(`SELECT s.*, c.lead_id, c.sales_rep_id, pr.admission_status FROM students s
      JOIN candidates c ON c.id = s.candidate_id LEFT JOIN pretest_results pr ON pr.candidate_id = c.id WHERE s.id = ?`).get(studentId);
    if (!st) throw notFound('Student');
    if (st.admission_status !== 'Confirmed') throw bad('Admission requires a Confirmed pre-test assessment');

    const e = {
      student_id: studentId,
      course: oneOf(b.course, COURSES, { required: true, name: 'Course' }),
      class_mode: oneOf(b.class_mode, MODES, { required: true, name: 'Class mode' }),
      total_classes: int(b.total_classes, { min: 1, max: 1000, required: true, name: 'Total classes' }),
      teacher_id: int(b.teacher_id, { min: 1, required: true, name: 'Teaching teacher' }),
      start_date: str(b.start_date, { required: true, name: 'Start date', max: 10 }),
      total_fee: int(b.total_fee, { min: 0, max: 10_000_000, required: true, name: 'Total course fee' }),
      notes: str(b.notes, { name: 'Notes', max: 2000 }),
    };
    if (!isValidDate(e.start_date)) throw bad('Start date is not valid', { field: 'Start date' });
    const t = db.prepare('SELECT * FROM teachers WHERE id = ?').get(e.teacher_id);
    if (!t) throw bad('Teaching teacher not found');
    if (!t.active) throw bad('Teaching teacher is inactive');
    if (e.class_mode === '1:1' && !t.supports_1to1) throw bad(`${t.name} is not configured for 1:1 classes`);
    if (e.class_mode === '3:1' && !t.supports_3to1) throw bad(`${t.name} is not configured for 3:1 classes`);

    const adv = parsePayment(b.advance, 'Advance');
    const fin = parsePayment(b.final, 'Final');
    // Rule: validate the split only at submit time, and only on a real mismatch.
    if (adv.amount + fin.amount !== e.total_fee) {
      throw unprocessable(feeMismatchMessage(e.total_fee, adv.amount, fin.amount), {
        code: 'FEE_MISMATCH', difference: e.total_fee - (adv.amount + fin.amount),
      });
    }
    if (db.prepare(`SELECT 1 FROM enrollments WHERE student_id = ? AND status = 'Active'`).get(studentId)) {
      throw conflict('This student already has an active enrollment', { code: 'ALREADY_ENROLLED' });
    }

    const id = db.transaction(() => {
      const r = db.prepare(`INSERT INTO enrollments (student_id, course, class_mode, total_classes, teacher_id, start_date,
        admission_date, total_fee, lead_id, sales_rep_id, notes, idempotency_key, created_by)
        VALUES (@student_id, @course, @class_mode, @total_classes, @teacher_id, @start_date, @admission_date, @total_fee,
        @lead_id, @sales_rep_id, @notes, @key, @by)`).run({
        ...e, admission_date: today(), lead_id: st.lead_id, sales_rep_id: st.sales_rep_id, key, by: req.user.id,
      });
      const ins = db.prepare(`INSERT INTO payments (enrollment_id, stage, amount, status, date, method, reference)
        VALUES (@eid, @stage, @amount, @status, @date, @method, @reference)`);
      for (const p of [adv, fin]) ins.run({ ...p, eid: r.lastInsertRowid });
      audit(db, req.user, 'enrollment', r.lastInsertRowid, 'admitted', null, { ...e, advance: adv, final: fin });
      return r.lastInsertRowid;
    })();
    res.status(201).json({ ...db.prepare(`${ENROLL_SELECT} WHERE e.id = ?`).get(id), payments: paymentsOf(id) });
  });

  // ---------- Enrollments ----------
  app.get('/api/enrollments', requireRole('manager', 'teacher'), (req, res) => {
    const q = req.query; const where = []; const p = {};
    if (req.user.role === 'teacher') { where.push('e.teacher_id = @me'); p.me = req.user.teacher_id; }
    if (q.status) { where.push('e.status = @status'); p.status = q.status; }
    if (q.teacher && req.user.role === 'manager') { where.push('e.teacher_id = @tid'); p.tid = Number(q.teacher); }
    if (q.course) { where.push('e.course = @course'); p.course = q.course; }
    if (q.mode) { where.push('e.class_mode = @mode'); p.mode = q.mode; }
    if (q.sales_rep && req.user.role === 'manager') { where.push('e.sales_rep_id = @rep'); p.rep = Number(q.sales_rep); }
    if (q.month && /^\d{4}-\d{2}$/.test(q.month)) { where.push('substr(e.admission_date,1,7) = @month'); p.month = q.month; }
    if (q.q) { where.push('(c.student_name LIKE @q OR c.lead_id LIKE @q OR c.parent_name LIKE @q)'); p.q = `%${q.q}%`; }
    let rows = db.prepare(`${ENROLL_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.id DESC`).all(p);
    if (req.user.role === 'teacher') rows = rows.map(teacherSafe);
    else {
      const pays = db.prepare('SELECT * FROM payments WHERE enrollment_id = ?');
      rows = rows.map(r => ({ ...r, money: moneySummary(r.total_fee, pays.all(r.id)) }));
    }
    res.json(rows);
  });

  app.get('/api/enrollments/:id', requireRole('manager', 'teacher'), (req, res) => {
    const e = db.prepare(`${ENROLL_SELECT} WHERE e.id = ?`).get(req.params.id);
    if (!e || (req.user.role === 'teacher' && e.teacher_id !== req.user.teacher_id)) throw notFound('Enrollment');
    if (req.user.role === 'teacher') return res.json(teacherSafe(e));
    const payments = paymentsOf(e.id);
    res.json({ ...e, payments, money: moneySummary(e.total_fee, payments), history: history(db, 'enrollment', e.id) });
  });

  app.patch('/api/enrollments/:id', requireRole('manager'), (req, res) => {
    const before = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(req.params.id);
    if (!before) throw notFound('Enrollment');
    const b = req.body; const e = { ...before };
    if (b.teacher_id !== undefined) {
      e.teacher_id = int(b.teacher_id, { min: 1, required: true, name: 'Teaching teacher' });
      const t = db.prepare('SELECT * FROM teachers WHERE id = ?').get(e.teacher_id);
      if (!t || !t.active) throw bad('Teaching teacher must be active');
      if ((e.class_mode === '1:1' && !t.supports_1to1) || (e.class_mode === '3:1' && !t.supports_3to1)) throw bad(`${t.name} is not configured for ${e.class_mode}`);
    }
    if (b.total_classes !== undefined) {
      e.total_classes = int(b.total_classes, { min: 1, max: 1000, required: true, name: 'Total classes' });
      if (e.total_classes < before.completed_classes) throw bad(`Total classes cannot be less than the ${before.completed_classes} already completed`);
    }
    if (b.status !== undefined) {
      e.status = oneOf(b.status, ['Active', 'Completed', 'Paused', 'Cancelled'], { required: true, name: 'Status' });
      if (e.status === 'Active' && before.status !== 'Active' &&
          db.prepare(`SELECT 1 FROM enrollments WHERE student_id = ? AND status='Active' AND id <> ?`).get(before.student_id, before.id))
        throw conflict('This student already has another active enrollment');
    }
    if (b.start_date !== undefined) {
      e.start_date = str(b.start_date, { required: true, name: 'Start date', max: 10 });
      if (!isValidDate(e.start_date)) throw bad('Start date is not valid');
    }
    if (b.notes !== undefined) e.notes = str(b.notes, { name: 'Notes', max: 2000 });
    db.transaction(() => {
      db.prepare(`UPDATE enrollments SET teacher_id=@teacher_id, total_classes=@total_classes, status=@status,
        start_date=@start_date, notes=@notes, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`).run(e);
      audit(db, req.user, 'enrollment', before.id, 'updated', before, e, str(b.reason, { max: 500 }));
    })();
    res.json(db.prepare(`${ENROLL_SELECT} WHERE e.id = ?`).get(before.id));
  });

  // Changing money amounts goes through one endpoint so Advance + Final always equals the fee.
  app.put('/api/enrollments/:id/fee-plan', requireRole('manager'), (req, res) => {
    const e = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(req.params.id);
    if (!e) throw notFound('Enrollment');
    const b = req.body;
    const fee = int(b.total_fee, { min: 0, max: 10_000_000, required: true, name: 'Total course fee' });
    const adv = int(b.advance_amount, { min: 0, max: 10_000_000, required: true, name: 'Advance amount' });
    const fin = int(b.final_amount, { min: 0, max: 10_000_000, required: true, name: 'Final amount' });
    const reason = str(b.reason, { required: true, name: 'Reason for change', max: 500 });
    if (adv + fin !== fee) throw unprocessable(feeMismatchMessage(fee, adv, fin), { code: 'FEE_MISMATCH', difference: fee - adv - fin });
    const pays = paymentsOf(e.id);
    for (const p of pays) {
      const amt = p.stage === 'Advance' ? adv : fin;
      if (p.status === 'Paid' && p.amount !== amt) throw bad(`${p.stage} is already marked Paid; change its status to Pending first if the received amount was wrong`);
    }
    db.transaction(() => {
      db.prepare(`UPDATE enrollments SET total_fee = ?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(fee, e.id);
      audit(db, req.user, 'enrollment', e.id, 'fee_changed', { total_fee: e.total_fee }, { total_fee: fee }, reason);
      for (const p of pays) {
        const amt = p.stage === 'Advance' ? adv : fin;
        if (amt !== p.amount) {
          db.prepare(`UPDATE payments SET amount = ?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(amt, p.id);
          audit(db, req.user, 'payment', p.id, 'amount_changed', { amount: p.amount }, { amount: amt }, reason);
        }
      }
    })();
    const payments = paymentsOf(e.id);
    res.json({ payments, money: moneySummary(fee, payments) });
  });

  // ---------- Payments ----------
  app.get('/api/payments', requireRole('manager'), (req, res) => {
    const q = req.query; const where = []; const p = { today: today() };
    if (q.status === 'Paid' || q.status === 'Pending') { where.push('p.status = @status'); p.status = q.status; }
    if (q.status === 'Overdue') where.push(`p.status = 'Pending' AND p.date < @today`);
    if (q.stage === 'Advance' || q.stage === 'Final') { where.push('p.stage = @stage'); p.stage = q.stage; }
    if (q.student) { where.push('e.student_id = @sid'); p.sid = Number(q.student); }
    if (q.enrollment) { where.push('e.id = @eid'); p.eid = Number(q.enrollment); }
    if (q.date_from && isValidDate(q.date_from)) { where.push('p.date >= @df'); p.df = q.date_from; }
    if (q.date_to && isValidDate(q.date_to)) { where.push('p.date <= @dt'); p.dt = q.date_to; }
    if (q.sales_rep) { where.push('e.sales_rep_id = @rep'); p.rep = Number(q.sales_rep); }
    if (q.q) { where.push('(c.student_name LIKE @q OR c.lead_id LIKE @q OR p.reference LIKE @q)'); p.q = `%${q.q}%`; }
    const rows = db.prepare(`
      SELECT p.*, e.student_id, e.course, e.total_fee, e.lead_id, c.student_name, c.parent_name, c.phone,
             r.name AS sales_rep_name, (p.status = 'Pending' AND p.date < @today) AS overdue
      FROM payments p JOIN enrollments e ON e.id = p.enrollment_id
      JOIN students s ON s.id = e.student_id JOIN candidates c ON c.id = s.candidate_id
      JOIN users r ON r.id = e.sales_rep_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (p.status = 'Pending') DESC, p.date ASC, p.id`).all(p);
    const totals = {
      paid: rows.filter(r => r.status === 'Paid').reduce((s, r) => s + r.amount, 0),
      pending: rows.filter(r => r.status === 'Pending').reduce((s, r) => s + r.amount, 0),
      overdue: rows.filter(r => r.overdue).reduce((s, r) => s + r.amount, 0),
      count: rows.length,
    };
    res.json({ rows, totals, today: p.today });
  });

  app.patch('/api/payments/:id', requireRole('manager'), (req, res) => {
    const before = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!before) throw notFound('Payment');
    const b = req.body; const p = { ...before };
    if (b.amount !== undefined && Number(b.amount) !== before.amount) throw bad('Change amounts with “Edit fee plan” so Advance + Final stays equal to the course fee');
    if (b.status !== undefined) p.status = oneOf(b.status, ['Paid', 'Pending'], { required: true, name: 'Status' });
    if (b.date !== undefined) p.date = str(b.date, { name: 'Date', max: 10 });
    if (b.method !== undefined) p.method = oneOf(b.method || null, METHODS, { name: 'Method' });
    if (b.reference !== undefined) p.reference = str(b.reference, { name: 'Reference', max: 100 });
    checkPaymentRules(p, p.stage);
    const reason = str(b.reason, { name: 'Reason', max: 500 });
    if (before.status === 'Paid' && p.status === 'Pending' && !reason) throw bad('Give a reason when reverting a Paid payment to Pending', { field: 'Reason' });
    db.transaction(() => {
      db.prepare(`UPDATE payments SET status=@status, date=@date, method=@method, reference=@reference,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`).run(p);
      audit(db, req.user, 'payment', p.id, before.status !== p.status ? `status_${p.status.toLowerCase()}` : 'updated', before, p, reason);
    })();
    res.json(db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id));
  });

  app.get('/api/payments/:id/history', requireRole('manager'), (req, res) => {
    res.json(history(db, 'payment', Number(req.params.id)));
  });

  // ---------- Students ----------
  app.get('/api/students', requireRole('manager', 'teacher'), (req, res) => {
    const q = req.query; const where = []; const p = {};
    if (req.user.role === 'teacher') { where.push('EXISTS (SELECT 1 FROM enrollments x WHERE x.student_id = s.id AND x.teacher_id = @me)'); p.me = req.user.teacher_id; }
    if (q.q) { where.push('(c.student_name LIKE @q OR c.parent_name LIKE @q OR c.lead_id LIKE @q)'); p.q = `%${q.q}%`; }
    if (q.status === 'awaiting') where.push('NOT EXISTS (SELECT 1 FROM enrollments x WHERE x.student_id = s.id)');
    if (q.admitted && /^\d{4}-\d{2}$/.test(q.admitted)) { where.push(`EXISTS (SELECT 1 FROM enrollments x WHERE x.student_id = s.id AND substr(x.admission_date,1,7) = @adm)`); p.adm = q.admitted; }
    if (q.status === 'active') where.push(`EXISTS (SELECT 1 FROM enrollments x WHERE x.student_id = s.id AND x.status='Active')`);
    const rows = db.prepare(`
      SELECT s.id, s.created_at, c.id AS candidate_id, c.lead_id, c.student_name, c.parent_name, c.age, c.location,
             ${req.user.role === 'manager' ? 'c.phone,' : ''} r.name AS sales_rep_name,
             e.id AS enrollment_id, e.course, e.class_mode, e.status AS enrollment_status, t.name AS teacher_name,
             e.total_classes, e.completed_classes, (e.total_classes - e.completed_classes) AS remaining_classes
      FROM students s JOIN candidates c ON c.id = s.candidate_id JOIN users r ON r.id = c.sales_rep_id
      LEFT JOIN enrollments e ON e.id = (SELECT id FROM enrollments x WHERE x.student_id = s.id ORDER BY (x.status='Active') DESC, x.id DESC LIMIT 1)
      LEFT JOIN teachers t ON t.id = e.teacher_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.student_name`).all(p);
    res.json(rows);
  });

  app.get('/api/students/:id', requireRole('manager', 'teacher'), (req, res) => {
    const s = db.prepare(`SELECT s.id, s.created_at, c.*, c.id AS candidate_id, s.id AS id, r.name AS sales_rep_name
      FROM students s JOIN candidates c ON c.id = s.candidate_id JOIN users r ON r.id = c.sales_rep_id WHERE s.id = ?`).get(req.params.id);
    if (!s) throw notFound('Student');
    let enrollments = db.prepare(`${ENROLL_SELECT} WHERE e.student_id = ? ORDER BY e.id DESC`).all(s.id);
    if (req.user.role === 'teacher') {
      enrollments = enrollments.filter(e => e.teacher_id === req.user.teacher_id);
      if (!enrollments.length) throw notFound('Student');
      enrollments = enrollments.map(teacherSafe);
      delete s.phone; delete s.phone_norm;
    } else {
      enrollments = enrollments.map(e => { const pays = paymentsOf(e.id); return { ...e, payments: pays, money: moneySummary(e.total_fee, pays) }; });
    }
    delete s.idempotency_key;
    const result = db.prepare(`SELECT pr.*, t.name AS teacher_name FROM pretest_results pr JOIN teachers t ON t.id = pr.teacher_id WHERE candidate_id = ?`).get(s.candidate_id);
    const ids = enrollments.map(e => e.id);
    const classes = ids.length ? db.prepare(`SELECT cl.*, t.name AS teacher_name FROM classes cl JOIN teachers t ON t.id = cl.teacher_id
      WHERE cl.enrollment_id IN (${ids.map(() => '?').join(',')}) ORDER BY cl.scheduled_at DESC LIMIT 200`).all(...ids) : [];
    res.json({ ...s, result, enrollments, classes });
  });
};

module.exports.moneySummary = moneySummary;
module.exports.bool = bool;
