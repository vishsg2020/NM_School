'use strict';
const { requireRole } = require('../auth');
const { audit, history } = require('../audit');
const { isUniqueViolation } = require('../db');
const { COURSES } = require('./candidates');
const {
  bad, notFound, conflict, unprocessable, str, int, oneOf, isValidDate, isValidTime, today, inr, idParam,
  projectDates, isValidAadhaar, addMinutes, weekdayOf,
} = require('../util');
const { PRETEST_MINUTES } = require('./candidates');

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DURATION = { '1:1': 30, '3:1': 40 };

/** Preferred weekly slot: { slot_days: '1,3,5', slot_time: '17:00' } from the request. */
function parseSlot(b, { required }) {
  const raw = Array.isArray(b.slot_days) ? b.slot_days : String(b.slot_days ?? '').split(',').filter(x => x !== '');
  const days = [...new Set(raw.map(Number))].filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (raw.length && days.length !== new Set(raw.map(String)).size) throw bad('Preferred days are not valid', { field: 'Days' });
  if (required && !days.length) throw bad('Choose at least one preferred day', { field: 'Days' });
  const time = str(b.slot_time, { required, name: 'Time (IST)', max: 5 });
  if (time && !isValidTime(time)) throw bad('Preferred time is not valid', { field: 'Time (IST)' });
  return { slot_days: days.length ? days.join(',') : null, slot_time: time };
}
const endDateOf = e => (e.slot_days ? projectDates(e.start_date, e.slot_days.split(',').map(Number), e.total_classes).at(-1) || null : null);

/** Student ID typed by the Manager, and Aadhaar reduced to its last four digits. */
async function parseIdentity(db, b, studentId) {
  const out = {};
  if (b.student_code !== undefined && b.student_code !== null && String(b.student_code).trim() !== '') {
    out.student_code = str(b.student_code, { name: 'Student ID', max: 30 });
    if (!/^[A-Za-z0-9][A-Za-z0-9_\-/]*$/.test(out.student_code)) throw bad('Student ID may contain letters, numbers, - _ / only', { field: 'Student ID' });
    if (await db.get('SELECT 1 AS x FROM students WHERE lower(student_code) = lower(?) AND id <> ?', [out.student_code, studentId]))
      throw conflict(`Student ID ${out.student_code} is already used`, { field: 'Student ID' });
  }
  if (b.aadhaar !== undefined) {
    const digits = String(b.aadhaar ?? '').replace(/\s|-/g, '');
    if (!digits) out.aadhaar_last4 = null;
    else if (/^[0-9]{4}$/.test(digits) && b.aadhaar_keep_last4) out.aadhaar_last4 = digits; // unchanged value shown as XXXX XXXX 1234
    else if (!isValidAadhaar(digits)) throw bad('This is not a valid Aadhaar number. Check the 12 digits.', { field: 'Aadhaar number' });
    else out.aadhaar_last4 = digits.slice(-4); // the full number is never stored
  }
  return out;
}

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
  const paymentsOf = (id, t = db) => t.all(`SELECT * FROM payments WHERE enrollment_id = ? ORDER BY CASE stage WHEN 'Advance' THEN 0 ELSE 1 END`, [id]);
  const enrollmentById = id => db.get(`${ENROLL_SELECT} WHERE e.id = ?`, [id]);

  // Students with a Confirmed assessment and no enrollment yet.
  app.get('/api/admissions/pending', requireRole('manager'), async (_req, res) => {
    res.json(await db.all(`
      SELECT s.id AS student_id, s.student_code, s.aadhaar_last4, c.id AS candidate_id, c.lead_id, c.student_name, c.parent_name, c.age, c.location,
             r.name AS sales_rep_name, c.sales_rep_id, pr.recommended_course, pr.submitted_at, pr.recommendation,
             t.name AS pretest_teacher_name
      FROM students s JOIN candidates c ON c.id = s.candidate_id
      JOIN pretest_results pr ON pr.candidate_id = c.id AND pr.admission_status = 'Confirmed'
      JOIN users r ON r.id = c.sales_rep_id
      JOIN teachers t ON t.id = pr.teacher_id
      WHERE NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id)
      ORDER BY pr.submitted_at`));
  });

  app.post('/api/admissions', requireRole('manager'), async (req, res) => {
    const b = req.body;
    const key = str(b.idempotency_key, { max: 80, name: 'Request key' });
    const replay = async () => {
      const prior = key && (await db.get('SELECT id FROM enrollments WHERE idempotency_key = ?', [key]));
      return prior ? { ...(await enrollmentById(prior.id)), payments: await paymentsOf(prior.id), replayed: true } : null;
    };
    const earlier = await replay();
    if (earlier) return res.status(200).json(earlier);

    const studentId = int(b.student_id, { min: 1, required: true, name: 'Student' });
    const st = await db.get(`SELECT s.*, c.lead_id, c.sales_rep_id, pr.admission_status FROM students s
      JOIN candidates c ON c.id = s.candidate_id LEFT JOIN pretest_results pr ON pr.candidate_id = c.id WHERE s.id = ?`, [studentId]);
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
      ...parseSlot(b, { required: true }),
    };
    if (!isValidDate(e.start_date)) throw bad('Start date is not valid', { field: 'Start date' });
    e.end_date = endDateOf(e);
    const identity = await parseIdentity(db, b, studentId);
    const t = await db.get('SELECT * FROM teachers WHERE id = ?', [e.teacher_id]);
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
    if (await db.get(`SELECT 1 AS x FROM enrollments WHERE student_id = ? AND status = 'Active'`, [studentId])) {
      throw conflict('This student already has an active enrollment', { code: 'ALREADY_ENROLLED' });
    }

    let id;
    try {
      id = await db.tx(async tx => {
        const r = await tx.get(`INSERT INTO enrollments (student_id, course, class_mode, total_classes, teacher_id, start_date,
          admission_date, total_fee, lead_id, sales_rep_id, notes, slot_days, slot_time, end_date, idempotency_key, created_by)
          VALUES (@student_id, @course, @class_mode, @total_classes, @teacher_id, @start_date, @admission_date, @total_fee,
          @lead_id, @sales_rep_id, @notes, @slot_days, @slot_time, @end_date, @key, @by) RETURNING id`, {
          ...e, admission_date: today(), lead_id: st.lead_id, sales_rep_id: st.sales_rep_id, key, by: req.user.id,
        });
        for (const p of [adv, fin]) {
          await tx.run(`INSERT INTO payments (enrollment_id, stage, amount, status, date, method, reference)
            VALUES (@eid, @stage, @amount, @status, @date, @method, @reference)`, { ...p, eid: r.id });
        }
        if (Object.keys(identity).length) {
          const sets = Object.keys(identity).map(k => `${k} = @${k}`).join(', ');
          await tx.run(`UPDATE students SET ${sets} WHERE id = @id`, { ...identity, id: studentId });
        }
        await audit(tx, req.user, 'enrollment', r.id, 'admitted', null, { ...e, ...identity, advance: adv, final: fin });
        return r.id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const again = await replay();
        if (again) return res.status(200).json(again);
        throw conflict('This student already has an active enrollment', { code: 'ALREADY_ENROLLED' });
      }
      throw err;
    }
    res.status(201).json({ ...(await enrollmentById(id)), payments: await paymentsOf(id) });
  });

  // ---------- Enrollments ----------
  app.get('/api/enrollments', requireRole('manager', 'teacher'), async (req, res) => {
    const q = req.query; const where = []; const p = {};
    if (req.user.role === 'teacher') { where.push('e.teacher_id = @me'); p.me = req.user.teacher_id; }
    if (q.status) { where.push('e.status = @status'); p.status = q.status; }
    if (q.teacher && req.user.role === 'manager') { where.push('e.teacher_id = @tid'); p.tid = idParam(q.teacher); }
    if (q.course) { where.push('e.course = @course'); p.course = q.course; }
    if (q.mode) { where.push('e.class_mode = @mode'); p.mode = q.mode; }
    if (q.sales_rep && req.user.role === 'manager') { where.push('e.sales_rep_id = @rep'); p.rep = idParam(q.sales_rep); }
    if (q.month && /^\d{4}-\d{2}$/.test(q.month)) { where.push('substr(e.admission_date,1,7) = @month'); p.month = q.month; }
    if (q.q) { where.push('(c.student_name ILIKE @q OR c.lead_id ILIKE @q OR c.parent_name ILIKE @q)'); p.q = `%${q.q}%`; }
    let rows = await db.all(`${ENROLL_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.id DESC`, p);
    if (req.user.role === 'teacher') rows = rows.map(teacherSafe);
    else {
      const ids = rows.map(r => r.id);
      const pays = ids.length ? await db.all('SELECT * FROM payments WHERE enrollment_id = ANY(?::int[])', [ids]) : [];
      rows = rows.map(r => ({ ...r, money: moneySummary(r.total_fee, pays.filter(x => x.enrollment_id === r.id)) }));
    }
    res.json(rows);
  });

  app.get('/api/enrollments/:id', requireRole('manager', 'teacher'), async (req, res) => {
    const e = await enrollmentById(idParam(req.params.id));
    if (!e || (req.user.role === 'teacher' && e.teacher_id !== req.user.teacher_id)) throw notFound('Enrollment');
    if (req.user.role === 'teacher') return res.json(teacherSafe(e));
    const payments = await paymentsOf(e.id);
    res.json({ ...e, payments, money: moneySummary(e.total_fee, payments), history: await history(db, 'enrollment', e.id) });
  });

  app.patch('/api/enrollments/:id', requireRole('manager'), async (req, res) => {
    const before = await db.get('SELECT * FROM enrollments WHERE id = ?', [idParam(req.params.id)]);
    if (!before) throw notFound('Enrollment');
    const b = req.body; const e = { ...before };
    if (b.teacher_id !== undefined) {
      e.teacher_id = int(b.teacher_id, { min: 1, required: true, name: 'Teaching teacher' });
      const t = await db.get('SELECT * FROM teachers WHERE id = ?', [e.teacher_id]);
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
          (await db.get(`SELECT 1 AS x FROM enrollments WHERE student_id = ? AND status='Active' AND id <> ?`, [before.student_id, before.id])))
        throw conflict('This student already has another active enrollment');
    }
    if (b.start_date !== undefined) {
      e.start_date = str(b.start_date, { required: true, name: 'Start date', max: 10 });
      if (!isValidDate(e.start_date)) throw bad('Start date is not valid');
    }
    if (b.notes !== undefined) e.notes = str(b.notes, { name: 'Notes', max: 2000 });
    if (b.slot_days !== undefined || b.slot_time !== undefined) Object.assign(e, parseSlot({ slot_days: b.slot_days ?? before.slot_days, slot_time: b.slot_time ?? before.slot_time }, { required: false }));
    e.end_date = endDateOf(e);
    await db.tx(async tx => {
      // Guarded update: completed_classes may have changed since we read it.
      const r = await tx.run(`UPDATE enrollments SET teacher_id=@teacher_id, total_classes=@total_classes, status=@status,
        start_date=@start_date, notes=@notes, slot_days=@slot_days, slot_time=@slot_time, end_date=@end_date,
        updated_at=now_iso() WHERE id=@id AND completed_classes <= @total_classes`, e);
      if (!r.rowCount) throw bad('Total classes cannot be less than the classes already completed');
      await audit(tx, req.user, 'enrollment', before.id, 'updated', before, e, str(b.reason, { max: 500 }));
    });
    res.json(await enrollmentById(before.id));
  });

  // Changing money amounts goes through one endpoint so Advance + Final always equals the fee.
  app.put('/api/enrollments/:id/fee-plan', requireRole('manager'), async (req, res) => {
    const e = await db.get('SELECT * FROM enrollments WHERE id = ?', [idParam(req.params.id)]);
    if (!e) throw notFound('Enrollment');
    const b = req.body;
    const fee = int(b.total_fee, { min: 0, max: 10_000_000, required: true, name: 'Total course fee' });
    const adv = int(b.advance_amount, { min: 0, max: 10_000_000, required: true, name: 'Advance amount' });
    const fin = int(b.final_amount, { min: 0, max: 10_000_000, required: true, name: 'Final amount' });
    const reason = str(b.reason, { required: true, name: 'Reason for change', max: 500 });
    if (adv + fin !== fee) throw unprocessable(feeMismatchMessage(fee, adv, fin), { code: 'FEE_MISMATCH', difference: fee - adv - fin });
    await db.tx(async tx => {
      const pays = await tx.all(`SELECT * FROM payments WHERE enrollment_id = ? ORDER BY id FOR UPDATE`, [e.id]);
      for (const p of pays) {
        const amt = p.stage === 'Advance' ? adv : fin;
        if (p.status === 'Paid' && p.amount !== amt) throw bad(`${p.stage} is already marked Paid; change its status to Pending first if the received amount was wrong`);
      }
      await tx.run('UPDATE enrollments SET total_fee = ?, updated_at=now_iso() WHERE id = ?', [fee, e.id]);
      await audit(tx, req.user, 'enrollment', e.id, 'fee_changed', { total_fee: e.total_fee }, { total_fee: fee }, reason);
      for (const p of pays) {
        const amt = p.stage === 'Advance' ? adv : fin;
        if (amt !== p.amount) {
          await tx.run('UPDATE payments SET amount = ?, updated_at=now_iso() WHERE id = ?', [amt, p.id]);
          await audit(tx, req.user, 'payment', p.id, 'amount_changed', { amount: p.amount }, { amount: amt }, reason);
        }
      }
    });
    const payments = await paymentsOf(e.id);
    res.json({ payments, money: moneySummary(fee, payments) });
  });

  // ---------- Payments ----------
  app.get('/api/payments', requireRole('manager'), async (req, res) => {
    const q = req.query; const where = []; const p = { today: today() };
    if (q.status === 'Paid' || q.status === 'Pending') { where.push('p.status = @status'); p.status = q.status; }
    if (q.status === 'Overdue') where.push(`p.status = 'Pending' AND p.date < @today`);
    if (q.stage === 'Advance' || q.stage === 'Final') { where.push('p.stage = @stage'); p.stage = q.stage; }
    if (q.student) { where.push('e.student_id = @sid'); p.sid = idParam(q.student); }
    if (q.enrollment) { where.push('e.id = @eid'); p.eid = idParam(q.enrollment); }
    if (q.date_from && isValidDate(q.date_from)) { where.push('p.date >= @df'); p.df = q.date_from; }
    if (q.date_to && isValidDate(q.date_to)) { where.push('p.date <= @dt'); p.dt = q.date_to; }
    if (q.sales_rep) { where.push('e.sales_rep_id = @rep'); p.rep = idParam(q.sales_rep); }
    if (q.q) { where.push('(c.student_name ILIKE @q OR c.lead_id ILIKE @q OR p.reference ILIKE @q)'); p.q = `%${q.q}%`; }
    const rows = await db.all(`
      SELECT p.*, e.student_id, e.course, e.total_fee, e.lead_id, c.student_name, c.parent_name, c.phone,
             r.name AS sales_rep_name, (p.status = 'Pending' AND p.date < @today) AS overdue
      FROM payments p JOIN enrollments e ON e.id = p.enrollment_id
      JOIN students s ON s.id = e.student_id JOIN candidates c ON c.id = s.candidate_id
      JOIN users r ON r.id = e.sales_rep_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (p.status = 'Pending') DESC, p.date ASC, p.id`, p);
    const totals = {
      paid: rows.filter(r => r.status === 'Paid').reduce((s, r) => s + r.amount, 0),
      pending: rows.filter(r => r.status === 'Pending').reduce((s, r) => s + r.amount, 0),
      overdue: rows.filter(r => r.overdue).reduce((s, r) => s + r.amount, 0),
      count: rows.length,
    };
    res.json({ rows, totals, today: p.today });
  });

  app.patch('/api/payments/:id', requireRole('manager'), async (req, res) => {
    const before = await db.get('SELECT * FROM payments WHERE id = ?', [idParam(req.params.id)]);
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
    await db.tx(async tx => {
      await tx.run(`UPDATE payments SET status=@status, date=@date, method=@method, reference=@reference, updated_at=now_iso() WHERE id=@id`, p);
      await audit(tx, req.user, 'payment', p.id, before.status !== p.status ? `status_${p.status.toLowerCase()}` : 'updated', before, p, reason);
    });
    res.json(await db.get('SELECT * FROM payments WHERE id = ?', [p.id]));
  });

  app.get('/api/payments/:id/history', requireRole('manager'), async (req, res) => {
    res.json(await history(db, 'payment', idParam(req.params.id)));
  });

  // ---------- Students ----------
  app.get('/api/students', requireRole('manager', 'teacher'), async (req, res) => {
    const q = req.query; const where = []; const p = {};
    if (req.user.role === 'teacher') { where.push('EXISTS (SELECT 1 FROM enrollments x WHERE x.student_id = s.id AND x.teacher_id = @me)'); p.me = req.user.teacher_id; }
    if (q.q) { where.push('(c.student_name ILIKE @q OR c.parent_name ILIKE @q OR c.lead_id ILIKE @q OR s.student_code ILIKE @q)'); p.q = `%${q.q}%`; }
    if (q.status === 'awaiting') where.push('NOT EXISTS (SELECT 1 FROM enrollments x WHERE x.student_id = s.id)');
    if (q.admitted && /^\d{4}-\d{2}$/.test(q.admitted)) { where.push('EXISTS (SELECT 1 FROM enrollments x WHERE x.student_id = s.id AND substr(x.admission_date,1,7) = @adm)'); p.adm = q.admitted; }
    if (q.status === 'active') where.push(`EXISTS (SELECT 1 FROM enrollments x WHERE x.student_id = s.id AND x.status='Active')`);
    const rows = await db.all(`
      SELECT s.id, s.student_code, s.created_at, c.id AS candidate_id, c.lead_id, c.student_name, c.parent_name, c.age, c.location,
             ${req.user.role === 'manager' ? 'c.phone,' : ''} r.name AS sales_rep_name,
             e.id AS enrollment_id, e.course, e.class_mode, e.status AS enrollment_status, t.name AS teacher_name,
             e.total_classes, e.completed_classes, (e.total_classes - e.completed_classes) AS remaining_classes
      FROM students s JOIN candidates c ON c.id = s.candidate_id JOIN users r ON r.id = c.sales_rep_id
      LEFT JOIN enrollments e ON e.id = (SELECT x.id FROM enrollments x WHERE x.student_id = s.id ORDER BY (x.status='Active') DESC, x.id DESC LIMIT 1)
      LEFT JOIN teachers t ON t.id = e.teacher_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.student_name`, p);
    res.json(rows);
  });

  app.get('/api/students/:id', requireRole('manager', 'teacher'), async (req, res) => {
    const s = await db.get(`SELECT c.*, c.id AS candidate_id, s.id AS id, s.student_code, s.aadhaar_last4, s.created_at AS student_created_at, r.name AS sales_rep_name
      FROM students s JOIN candidates c ON c.id = s.candidate_id JOIN users r ON r.id = c.sales_rep_id WHERE s.id = ?`, [idParam(req.params.id)]);
    if (!s) throw notFound('Student');
    let enrollments = await db.all(`${ENROLL_SELECT} WHERE e.student_id = ? ORDER BY e.id DESC`, [s.id]);
    if (req.user.role === 'teacher') {
      enrollments = enrollments.filter(e => e.teacher_id === req.user.teacher_id);
      if (!enrollments.length) throw notFound('Student');
      enrollments = enrollments.map(teacherSafe);
      delete s.phone; delete s.phone_norm; delete s.student_phone; delete s.aadhaar_last4;
    } else {
      for (const e of enrollments) { e.payments = await paymentsOf(e.id); e.money = moneySummary(e.total_fee, e.payments); }
    }
    delete s.idempotency_key;
    const result = await db.get(`SELECT pr.*, t.name AS teacher_name FROM pretest_results pr JOIN teachers t ON t.id = pr.teacher_id WHERE candidate_id = ?`, [s.candidate_id]);
    const ids = enrollments.map(e => e.id);
    const classes = ids.length ? await db.all(`SELECT cl.*, t.name AS teacher_name FROM classes cl JOIN teachers t ON t.id = cl.teacher_id
      WHERE cl.enrollment_id = ANY(?::int[]) ORDER BY cl.scheduled_at DESC LIMIT 200`, [ids]) : [];
    const files = await db.all(`SELECT id, kind FROM pretest_files WHERE candidate_id = ? AND kind IN ('student_photo','id_proof') ORDER BY id DESC`, [s.candidate_id]);
    s.photo_file_id = files.find(f => f.kind === 'student_photo')?.id ?? null;
    s.id_proof_file_id = req.user.role === 'manager' ? (files.find(f => f.kind === 'id_proof')?.id ?? null) : null;
    res.json({ ...s, result, enrollments, classes });
  });

  // Manager edits the student's ID / Aadhaar later (photos use the file upload).
  app.patch('/api/students/:id', requireRole('manager'), async (req, res) => {
    const st = await db.get('SELECT * FROM students WHERE id = ?', [idParam(req.params.id)]);
    if (!st) throw notFound('Student');
    const identity = await parseIdentity(db, req.body, st.id);
    if (Object.keys(identity).length) {
      await db.tx(async tx => {
        await tx.run(`UPDATE students SET ${Object.keys(identity).map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`, { ...identity, id: st.id });
        await audit(tx, req.user, 'student', st.id, 'updated', { student_code: st.student_code, aadhaar_last4: st.aadhaar_last4 }, identity);
      });
    }
    res.json(await db.get('SELECT id, student_code, aadhaar_last4 FROM students WHERE id = ?', [st.id]));
  });

  // Warn (never block) when the teacher already has something in the preferred weekly slot.
  app.post('/api/admissions/slot-check', requireRole('manager'), async (req, res) => {
    const b = req.body;
    const teacherId = int(b.teacher_id, { min: 1, required: true, name: 'Teaching teacher' });
    const mode = oneOf(b.class_mode || '1:1', MODES, { name: 'Class mode' });
    const slot = parseSlot(b, { required: true });
    const start = str(b.start_date, { required: true, name: 'Start date', max: 10 });
    if (!isValidDate(start)) throw bad('Start date is not valid');
    const total = int(b.total_classes, { min: 1, max: 1000, required: true, name: 'Total classes' });
    const excludeEnrollment = b.enrollment_id ? idParam(b.enrollment_id) : 0;
    const teacher = await db.get('SELECT id, name FROM teachers WHERE id = ?', [teacherId]);
    if (!teacher) throw notFound('Teacher');
    const days = slot.slot_days.split(',').map(Number);
    const dates = projectDates(start, days, total);
    const end = dates.at(-1);
    const minutes = DURATION[mode];
    const st = slot.slot_time; const et = addMinutes(`2000-01-01T${st}`, minutes).slice(11);
    const overlap = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;
    const warnings = []; const info = [];

    // 1. Other active students with the same teacher in an overlapping weekly slot.
    const others = await db.all(`SELECT e.id, e.class_mode, e.slot_days, e.slot_time, e.start_date, e.end_date, c.student_name
      FROM enrollments e JOIN students s ON s.id = e.student_id JOIN candidates c ON c.id = s.candidate_id
      WHERE e.teacher_id = ? AND e.status = 'Active' AND e.slot_days IS NOT NULL AND e.id <> ?`, [teacherId, excludeEnrollment]);
    const group = [];
    for (const o of others) {
      const od = o.slot_days.split(',').map(Number).filter(d => days.includes(d));
      const oet = addMinutes(`2000-01-01T${o.slot_time}`, DURATION[o.class_mode]).slice(11);
      if (!od.length || !overlap(st, et, o.slot_time, oet) || (o.end_date && o.end_date < start) || o.start_date > end) continue;
      if (mode === '3:1' && o.class_mode === '3:1' && o.slot_time === st) { group.push(o); continue; }
      warnings.push(`${teacher.name} already teaches ${o.student_name} on ${od.map(d => DAY[d]).join('/')} at ${o.slot_time} (${o.class_mode})`);
    }
    if (group.length >= 3) warnings.push(`The 3:1 group at ${st} already has ${group.length} students (${group.map(g => g.student_name).join(', ')})`);
    else if (group.length) info.push(`Joins the 3:1 group with ${group.map(g => g.student_name).join(', ')} (${group.length + 1}/3)`);

    // 2. Booked classes and pre-tests on the projected dates.
    if (dates.length) {
      const booked = await db.all(`SELECT cl.scheduled_at, cl.duration_min, cl.format, c.student_name, e.id AS enrollment_id
        FROM classes cl JOIN enrollments e ON e.id = cl.enrollment_id JOIN students s ON s.id = e.student_id JOIN candidates c ON c.id = s.candidate_id
        WHERE cl.teacher_id = ? AND substr(cl.scheduled_at,1,10) = ANY(?::text[]) AND cl.status NOT IN ('Cancelled','Rescheduled') AND e.id <> ?`,
      [teacherId, dates, excludeEnrollment]);
      const clash = booked.filter(c => overlap(st, et, c.scheduled_at.slice(11), addMinutes(c.scheduled_at, c.duration_min).slice(11))
        && !(mode === '3:1' && c.format === '3:1' && c.scheduled_at.slice(11) === st && group.some(g => g.id === c.enrollment_id)));
      if (clash.length) warnings.push(`${clash.length} booked class${clash.length === 1 ? '' : 'es'} at that time, first: ${clash[0].student_name} on ${clash[0].scheduled_at.slice(0, 10)}`);
      const pre = await db.all(`SELECT pretest_at, student_name FROM candidates WHERE pretest_teacher_id = ? AND substr(pretest_at,1,10) = ANY(?::text[]) AND status <> 'Cancelled'`, [teacherId, dates]);
      const pclash = pre.filter(p => overlap(st, et, p.pretest_at.slice(11), addMinutes(p.pretest_at, PRETEST_MINUTES).slice(11)));
      if (pclash.length) warnings.push(`${pclash.length} pre-test${pclash.length === 1 ? '' : 's'} at that time, first: ${pclash[0].student_name} on ${pclash[0].pretest_at.slice(0, 10)}`);
    }
    // 3. Working hours.
    const hours = await db.all('SELECT weekday, start_time, end_time FROM teacher_hours WHERE teacher_id = ?', [teacherId]);
    const outside = days.filter(d => !hours.some(h => h.weekday === d && h.start_time <= st && et <= h.end_time));
    if (outside.length) warnings.push(`${outside.map(d => DAY[d]).join('/')} ${st}–${et} is outside ${teacher.name}'s working hours`);

    res.json({ teacher: teacher.name, end_date: end || null, classes: dates.length, warnings, info });
  });
};

module.exports.moneySummary = moneySummary;
