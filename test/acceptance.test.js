'use strict';
// Acceptance tests mapped to the prompt's ACCEPTANCE TESTS list. Run: npm test
process.env.TODAY_OVERRIDE = '2026-10-15';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const pg = require('pg');
const { createDb } = require('../src/db');
const { applyMigrations } = require('../src/migrate');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

let server, base, db, devDb, pool;
const pw = 'correct-horse-1';

function client() {
  let cookie = '';
  async function call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nm-app', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
  return {
    get: u => call('GET', u), post: (u, b) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b), put: (u, b) => call('PUT', u, b), del: u => call('DELETE', u),
    login: async email => { const r = await call('POST', '/api/login', { email, password: pw }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r; },
  };
}

const M = client(), S = client(), T1 = client(), T2 = client(), anon = client();
let teacherA, teacherB, salesId, managerId;

test.before(async () => {
  const { NetlifyDB } = await import('@netlify/database-dev');
  devDb = new NetlifyDB({ logger: () => {} });
  const cs = await devDb.start();
  pool = new pg.Pool({ connectionString: cs, max: 4 });
  await applyMigrations(pool);
  db = createDb(pool);
  const h = hashPassword(pw);
  managerId = (await db.get(`INSERT INTO users (name,email,password_hash,role) VALUES ('Anasooya','m@x.in',?,'manager') RETURNING id`, [h])).id;
  salesId = (await db.get(`INSERT INTO users (name,email,password_hash,role) VALUES ('Sam Sales','s@x.in',?,'sales') RETURNING id`, [h])).id;
  server = createApp(db).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await M.login('m@x.in'); await S.login('s@x.in');
});
test.after(async () => { server.close(); await pool.end(); await devDb.stop(); });

test('server rejects unauthenticated and cross-site style requests', async () => {
  assert.equal((await anon.get('/api/candidates')).status, 401);
  const r = await fetch(base + '/api/candidates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('Manager can add, edit, deactivate teachers and configure availability/capacity', async () => {
  let r = await M.post('/api/teachers', {
    name: 'Teacher A', supports_1to1: true, supports_3to1: true, monthly_capacity: 100, employment_type: 'Regular',
    hours: [1, 2, 3, 4, 5, 6].map(d => ({ weekday: d, start_time: '09:00', end_time: '15:00' })),
    slots: [1, 2, 3, 4, 5, 6].map(d => ({ weekday: d, start_time: '10:00', end_time: '14:00', format: 'Any' })),
  });
  assert.equal(r.status, 201, JSON.stringify(r.data)); teacherA = r.data.id;
  assert.equal(r.data.hours.length, 6);
  r = await M.post('/api/teachers', { name: 'Teacher B', supports_1to1: true, supports_3to1: false, employment_type: 'Freelance',
    hours: [{ weekday: 4, start_time: '16:00', end_time: '21:00' }] });
  assert.equal(r.status, 201); teacherB = r.data.id;
  // slot outside hours rejected
  r = await M.patch(`/api/teachers/${teacherB}`, { slots: [{ weekday: 4, start_time: '08:00', end_time: '09:00' }] });
  assert.equal(r.status, 400);
  r = await M.patch(`/api/teachers/${teacherB}`, { monthly_capacity: 40, notes: 'Evenings' });
  assert.equal(r.data.monthly_capacity, 40);
  // Sales and Teacher cannot manage teachers (server-side)
  assert.equal((await S.post('/api/teachers', { name: 'X' })).status, 403);
  assert.equal((await S.get('/api/teachers')).status, 403);
  // logins for teachers
  for (const [email, tid] of [['t1@x.in', teacherA], ['t2@x.in', teacherB]]) {
    r = await M.post('/api/users', { name: email, email, password: pw, role: 'teacher', teacher_id: tid });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  await T1.login('t1@x.in'); await T2.login('t2@x.in');
  assert.equal((await T1.patch(`/api/teachers/${teacherA}`, { monthly_capacity: 999 })).status, 403);
  // no hard-coded teacher limit: add 4 more
  for (let i = 0; i < 4; i++) assert.equal((await M.post('/api/teachers', { name: 'Extra ' + i })).status, 201);
});

let candA, candB;
test('Manager and Sales Team can add candidates; no duplicate on repeat submit', async () => {
  let r = await S.post('/api/candidates', { student_name: 'Anu Nair', parent_name: 'Rekha', parent_relationship: 'Mother', phone: '+1 (415) 555-0101', location: 'Texas', age: 8, idempotency_key: 'k-1' });
  assert.equal(r.status, 201, JSON.stringify(r.data)); candA = r.data;
  assert.match(candA.lead_id, /^NM-\d{5}$/);
  assert.equal(candA.status, 'Time Required');
  assert.equal(candA.sales_rep_id, salesId);
  // same idempotency key => same record, no new row
  r = await S.post('/api/candidates', { age: 25, student_name: 'Anu Nair', phone: '+14155550101', idempotency_key: 'k-1' });
  assert.equal(r.status, 200); assert.equal(r.data.id, candA.id);
  // same name + phone with a fresh key => duplicate warning
  r = await S.post('/api/candidates', { student_name: ' anu  nair ', phone: '14155550101', age: 8, parent_name: 'Rekha', parent_relationship: 'Mother', idempotency_key: 'k-2' });
  assert.equal(r.status, 409); assert.equal(r.data.code, 'POSSIBLE_DUPLICATE');
  // sibling sharing phone is allowed
  r = await S.post('/api/candidates', { student_name: 'Arjun Nair', phone: '14155550101', age: 10, parent_name: 'Rekha', parent_relationship: 'Mother', idempotency_key: 'k-3', pretest_at: '2026-10-16T18:00' });
  assert.equal(r.status, 201); candB = r.data; assert.equal(candB.status, 'Scheduled');
  // manager adds with supplied lead id and assigns teacher
  r = await M.post('/api/candidates', { lead_id: 'FB-2201', student_name: 'Diya', phone: '9847000001', age: 7, parent_name: 'Sita', parent_relationship: 'Mother', sales_rep_id: salesId, pretest_at: '2026-10-17T10:00', pretest_teacher_id: teacherA });
  assert.equal(r.status, 201); assert.equal(r.data.lead_id, 'FB-2201');
  assert.equal((await M.post('/api/candidates', { lead_id: 'fb-2201', student_name: 'Zed', phone: '9847000002', age: 30 })).status, 409);
  // teacher cannot add
  assert.equal((await T1.post('/api/candidates', { age: 25, student_name: 'X', phone: '9847000003' })).status, 403);
  assert.equal((await db.get('SELECT COUNT(*) n FROM candidates')).n, 3);
});

test('Sales Team and Manager can update pre-test date/time and confirmation; only Manager assigns teacher', async () => {
  let r = await S.patch(`/api/candidates/${candA.id}`, { pretest_at: '2026-10-16T17:00', time_confirmation: 'Confirmed', status: 'Scheduled' });
  assert.equal(r.status, 200); assert.equal(r.data.time_confirmation, 'Confirmed');
  r = await M.patch(`/api/candidates/${candB.id}`, { pretest_at: '2026-10-18T09:30', time_confirmation: 'Reschedule Requested' });
  assert.equal(r.status, 200);
  assert.equal((await S.patch(`/api/candidates/${candA.id}`, { pretest_teacher_id: teacherA })).status, 403);
  assert.equal((await S.patch(`/api/candidates/${candA.id}`, { status: 'Completed' })).status, 400);
  r = await M.patch(`/api/candidates/${candA.id}`, { pretest_teacher_id: teacherA });
  assert.equal(r.data.pretest_teacher_id, teacherA);
  assert.equal((await T1.patch(`/api/candidates/${candA.id}`, { pretest_at: '2026-10-20T10:00' })).status, 403);
  assert.equal((await M.patch(`/api/candidates/${candA.id}`, { status: 'Scheduled', pretest_at: '' })).status, 400);
});

test('Pre-Test Queue filters work individually and in combination; clearing restores all', async () => {
  const ids = r => r.data.map(x => x.id).sort();
  const all = await M.get('/api/candidates');
  assert.equal(all.data.length, 3);
  assert.deepEqual(ids(await M.get('/api/candidates?date=2026-10-16')), [candA.id]);
  assert.deepEqual(ids(await M.get(`/api/candidates?teacher=${teacherA}`)).length, 2);
  assert.deepEqual(ids(await M.get('/api/candidates?teacher=unassigned')), [candB.id]);
  assert.deepEqual(ids(await M.get('/api/candidates?status=Scheduled')).length, 3);
  assert.deepEqual(ids(await M.get('/api/candidates?confirmation=Confirmed')), [candA.id]);
  assert.deepEqual(ids(await M.get('/api/candidates?confirmation=Reschedule%20Requested')), [candB.id]);
  assert.deepEqual(ids(await M.get(`/api/candidates?teacher=${teacherA}&confirmation=Confirmed&date=2026-10-16&status=Scheduled`)), [candA.id]);
  assert.equal((await M.get(`/api/candidates?teacher=${teacherA}&confirmation=Reschedule%20Requested`)).data.length, 0);
  assert.equal((await M.get('/api/candidates?q=nair')).data.length, 2);
  assert.equal((await M.get('/api/candidates?q=555-0101')).data.length, 2);
  assert.equal((await M.get('/api/candidates')).data.length, all.data.length);
  // Sales sees all (decision), teacher sees assigned only and no phone numbers
  assert.equal((await S.get('/api/candidates')).data.length, 3);
  const t = await T1.get('/api/candidates');
  assert.equal(t.data.length, 2); assert.equal(t.data[0].phone, undefined);
  assert.equal((await T2.get('/api/candidates')).data.length, 0);
  assert.equal((await T2.get(`/api/candidates/${candA.id}`)).status, 404);
});

let studentId;
test('Assessment retains Lead ID and Sales Rep; Confirmed creates Student but no Enrollment', async () => {
  assert.equal((await T2.put(`/api/candidates/${candA.id}/result`, { recommended_course: 'Reader', assessment: 'x', admission_status: 'Confirmed' })).status, 404);
  assert.equal((await S.put(`/api/candidates/${candA.id}/result`, {})).status, 403);
  let r = await T1.put(`/api/candidates/${candA.id}/result`, { recommended_course: 'Reader', assessment: 'Knows letters, slow word reading', admission_status: 'Confirmed', recommendation: '1:1 twice a week' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = (await M.get(`/api/candidates/${candA.id}`)).data;
  assert.equal(c.lead_id, candA.lead_id); assert.equal(c.sales_rep_id, salesId); assert.equal(c.status, 'Completed');
  assert.ok(c.student_id); studentId = c.student_id;
  assert.equal((await db.get('SELECT COUNT(*) n FROM enrollments')).n, 0);
  const pending = (await M.get('/api/admissions/pending')).data;
  assert.equal(pending.length, 1); assert.equal(pending[0].lead_id, candA.lead_id); assert.equal(pending[0].sales_rep_name, 'Sam Sales');
  // re-submit does not create a second student
  await T1.put(`/api/candidates/${candA.id}/result`, { recommended_course: 'Reader', assessment: 'updated', admission_status: 'Confirmed' });
  assert.equal((await db.get('SELECT COUNT(*) n FROM students')).n, 1);
});

let enrollment;
test('Admission: mismatch error only on a genuine mismatch, explained; creates one Enrollment + Advance/Final', async () => {
  const body = {
    student_id: studentId, course: 'Reader', class_mode: '1:1', total_classes: 4, teacher_id: teacherA, start_date: '2026-10-15',
    total_fee: 1000, idempotency_key: 'adm-1',
    advance: { amount: 400, status: 'Paid', date: '2026-10-14', method: 'UPI', reference: 'UPI123' },
    final: { amount: 500, status: 'Pending', date: '2026-10-10' },
  };
  let r = await M.post('/api/admissions', body);
  assert.equal(r.status, 422); assert.equal(r.data.code, 'FEE_MISMATCH'); assert.equal(r.data.difference, 100);
  assert.match(r.data.error, /₹100 less than the Total Course Fee of ₹1,000/);
  assert.equal((await db.get('SELECT COUNT(*) n FROM enrollments')).n, 0);
  assert.equal((await S.post('/api/admissions', body)).status, 403);
  body.final.amount = 600;
  r = await M.post('/api/admissions', body);
  assert.equal(r.status, 201, JSON.stringify(r.data)); enrollment = r.data;
  assert.equal(enrollment.payments.length, 2);
  assert.deepEqual(enrollment.payments.map(p => p.stage), ['Advance', 'Final']);
  assert.equal(enrollment.lead_id, candA.lead_id); assert.equal(enrollment.sales_rep_id, salesId);
  // repeat click (same key) and different key both produce no second enrollment
  r = await M.post('/api/admissions', body); assert.equal(r.status, 200); assert.equal(r.data.id, enrollment.id);
  r = await M.post('/api/admissions', { ...body, idempotency_key: 'adm-2' }); assert.equal(r.status, 409);
  assert.equal((await db.get('SELECT COUNT(*) n FROM enrollments')).n, 1);
  assert.equal((await db.get('SELECT COUNT(*) n FROM payments')).n, 2);
  // pre-test teacher and teaching teacher may differ is allowed by design (teacherA used for both here)
  // confirmed admission status is locked once enrolled
  assert.equal((await M.put(`/api/candidates/${candA.id}/result`, { recommended_course: 'Reader', assessment: 'x', admission_status: 'Not Interested' })).status, 400);
});

test('Paid / Pending / Overdue totals are correct and edits are audited', async () => {
  let r = await M.get(`/api/enrollments/${enrollment.id}`);
  assert.deepEqual(r.data.money, { total_fee: 1000, total_paid: 400, outstanding: 600, pending_amount: 600, overdue_amount: 600 });
  let d = (await M.get('/api/dashboard')).data.metrics;
  assert.equal(d.fees_collected_total, 400); assert.equal(d.pending_fees, 600); assert.equal(d.overdue_fees, 600);
  assert.equal(d.students_pending_payments, 1); assert.equal(d.overdue_students, 1);
  const finalPay = enrollment.payments.find(p => p.stage === 'Final');
  // due today is NOT overdue
  r = await M.patch(`/api/payments/${finalPay.id}`, { date: '2026-10-15' });
  assert.equal(r.status, 200);
  d = (await M.get('/api/dashboard')).data.metrics;
  assert.equal(d.overdue_fees, 0); assert.equal(d.overdue_students, 0); assert.equal(d.pending_fees, 600);
  // amount changes must go through fee plan
  assert.equal((await M.patch(`/api/payments/${finalPay.id}`, { amount: 1 })).status, 400);
  assert.equal((await M.put(`/api/enrollments/${enrollment.id}/fee-plan`, { total_fee: 1100, advance_amount: 400, final_amount: 600, reason: 'x' })).status, 422);
  // Paid requires method; future received date rejected
  assert.equal((await M.patch(`/api/payments/${finalPay.id}`, { status: 'Paid', date: '2026-10-15' })).status, 400);
  assert.equal((await M.patch(`/api/payments/${finalPay.id}`, { status: 'Paid', date: '2026-10-20', method: 'Cash' })).status, 400);
  r = await M.patch(`/api/payments/${finalPay.id}`, { status: 'Paid', date: '2026-10-15', method: 'Cash', reason: 'Received in office' });
  assert.equal(r.status, 200);
  d = (await M.get('/api/dashboard')).data.metrics;
  assert.equal(d.fees_collected_total, 1000); assert.equal(d.pending_fees, 0);
  const h = (await M.get(`/api/payments/${finalPay.id}/history`)).data;
  assert.ok(h.length >= 2); assert.equal(h[0].before.status, 'Pending'); assert.equal(h[0].after.status, 'Paid'); assert.equal(h[0].user_name, 'Anasooya');
  // reverting Paid needs a reason
  assert.equal((await M.patch(`/api/payments/${finalPay.id}`, { status: 'Pending' })).status, 400);
  // sales and teachers can't see payments
  assert.equal((await S.get('/api/payments')).status, 403);
  assert.equal((await T1.get('/api/payments')).status, 403);
  assert.equal((await T1.get(`/api/enrollments/${enrollment.id}`)).data.total_fee, undefined);
});

let classIds;
test('Scheduling flags conflicts and capacity; 1:1 allows one student', async () => {
  // 2026-10-16 is a Friday (weekday 5) inside 10:00–14:00 slot
  let r = await M.post('/api/classes', { enrollment_id: enrollment.id, start_date: '2026-10-13', time: '10:00', weekdays: [2, 4], count: 3, duration_min: 30 });
  assert.equal(r.status, 409); assert.equal(r.data.code, 'NEEDS_ACK'); // first date before start date
  r = await M.post('/api/classes', { enrollment_id: enrollment.id, start_date: '2026-10-13', time: '10:00', weekdays: [2, 4], count: 3, duration_min: 30, acknowledge_warnings: true });
  assert.equal(r.status, 201, JSON.stringify(r.data)); classIds = r.data.map(c => c.id);
  assert.match(r.data[0].class_code, /^CL-\d{6}$/);
  // outside working hours => warning
  r = await M.post('/api/classes/check', { enrollment_id: enrollment.id, scheduled_at: '2026-10-21T19:00' });
  assert.ok(r.data.results[0].warnings.some(w => /working hours/.test(w)));
  // overlapping second 1:1 student for teacherA => hard error
  const c2 = (await M.post('/api/candidates', { age: 25, student_name: 'Meera', phone: '9000000001', pretest_teacher_id: teacherA, pretest_at: '2026-10-14T10:00' })).data;
  await T1.put(`/api/candidates/${c2.id}/result`, { recommended_course: 'Starter', assessment: 'none', admission_status: 'Confirmed' });
  const s2 = (await M.get(`/api/candidates/${c2.id}`)).data.student_id;
  const e2 = (await M.post('/api/admissions', { student_id: s2, course: 'Starter', class_mode: '1:1', total_classes: 2, teacher_id: teacherA, start_date: '2026-10-01', total_fee: 500,
    advance: { amount: 500, status: 'Paid', date: '2026-10-01', method: 'UPI' }, final: { amount: 0, status: 'Pending', date: '2026-11-01' } })).data;
  r = await M.post('/api/classes', { enrollment_id: e2.id, scheduled_at: '2026-10-13T10:15', duration_min: 30 });
  assert.equal(r.status, 409); assert.equal(r.data.code, 'SCHEDULE_CONFLICT');
  // teacherB does not support 3:1
  assert.equal((await M.patch(`/api/enrollments/${enrollment.id}`, { teacher_id: teacherB })).status, 200); // 1:1 ok
  assert.equal((await M.patch(`/api/enrollments/${enrollment.id}`, { teacher_id: teacherA })).status, 200);
  // Teacher B cannot schedule for an enrollment that isn't theirs
  assert.equal((await T2.post('/api/classes', { enrollment_id: enrollment.id, scheduled_at: '2026-10-22T10:00' })).status, 404);
});

test('3:1 allows up to three students per concurrent class', async () => {
  const mk = async (name) => {
    const c = (await M.post('/api/candidates', { age: 25, student_name: name, phone: '98' + Math.floor(Math.random() * 1e8), pretest_teacher_id: teacherA })).data;
    await M.put(`/api/candidates/${c.id}/result`, { recommended_course: 'Writer', assessment: 'ok', admission_status: 'Confirmed' });
    const sid = (await M.get(`/api/candidates/${c.id}`)).data.student_id;
    const e = await M.post('/api/admissions', { student_id: sid, course: 'Writer', class_mode: '3:1', total_classes: 5, teacher_id: teacherA, start_date: '2026-10-01', total_fee: 750,
      advance: { amount: 750, status: 'Paid', date: '2026-10-02', method: 'UPI' }, final: { amount: 0, status: 'Pending', date: '2026-11-02' } });
    assert.equal(e.status, 201, JSON.stringify(e.data));
    return e.data.id;
  };
  const es = [await mk('G1'), await mk('G2'), await mk('G3'), await mk('G4')];
  for (const id of es.slice(0, 3)) {
    const r = await M.post('/api/classes', { enrollment_id: id, scheduled_at: '2026-10-20T11:00', duration_min: 40 });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  const r = await M.post('/api/classes', { enrollment_id: es[3], scheduled_at: '2026-10-20T11:00', duration_min: 40 });
  assert.equal(r.status, 409); assert.match(r.data.results[0].errors[0], /already has 3 students/);
  const w = (await M.get('/api/reports?month=2026-10')).data.teacher_workload.find(t => t.id === teacherA);
  assert.ok(w.planned_sessions >= 4); // group counted once
});

test('Class completion increments once; repeats do not double-count; cancelled does not count', async () => {
  const [c1, c2, c3] = classIds;
  // Teacher records activity
  let r = await T1.patch(`/api/classes/${c1}`, { status: 'Completed', attendance: 'Present', topics: 'Vowels', homework: 'Page 2', next_class_date: '2026-10-15' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.completed_classes, 1); assert.equal(r.data.remaining_classes, 3);
  // duplicate submission
  r = await T1.patch(`/api/classes/${c1}`, { status: 'Completed', attendance: 'Present', topics: 'Vowels (edited)' });
  assert.equal(r.data.completed_classes, 1);
  await Promise.all([1, 2, 3].map(() => T1.patch(`/api/classes/${c1}`, { status: 'Completed', attendance: 'Present' })));
  assert.equal((await db.get('SELECT completed_classes FROM enrollments WHERE id = ?', [enrollment.id])).completed_classes, 1);
  // Completed requires Present/Late
  assert.equal((await T1.patch(`/api/classes/${c2}`, { status: 'Completed', attendance: 'Absent' })).status, 400);
  // future class can't be completed (c3 is 2026-10-20)
  assert.equal((await T1.patch(`/api/classes/${c3}`, { status: 'Completed', attendance: 'Present' })).status, 400);
  r = await T1.patch(`/api/classes/${c2}`, { status: 'Cancelled', notes: 'Parent travelling' });
  assert.equal(r.data.completed_classes, 1);
  // teacher can't un-complete; manager can, and the count goes back exactly once
  assert.equal((await T1.patch(`/api/classes/${c1}`, { status: 'Scheduled' })).status, 400);
  r = await M.patch(`/api/classes/${c1}`, { status: 'Scheduled', reason: 'Entered on wrong class' });
  assert.equal(r.data.completed_classes, 0);
  r = await M.patch(`/api/classes/${c1}`, { status: 'Completed', attendance: 'Late' });
  assert.equal(r.data.completed_classes, 1);
  // other teacher can't touch it
  assert.equal((await T2.patch(`/api/classes/${c1}`, { notes: 'x' })).status, 404);
});

test('Class Activity Student filter works (plus teacher/date/status)', async () => {
  const mine = (await M.get(`/api/classes?student=${studentId}`)).data;
  assert.ok(mine.length >= 3);
  assert.ok(mine.every(c => c.student_id === studentId));
  const other = (await M.get('/api/classes')).data.filter(c => c.student_id !== studentId);
  assert.ok(other.length > 0);
  assert.ok((await M.get(`/api/classes?student=${studentId}&status=Completed`)).data.every(c => c.status === 'Completed' && c.student_id === studentId));
  assert.equal((await M.get(`/api/classes?student=${studentId}&date=2026-10-13`)).data.length, 1);
  assert.equal((await T2.get('/api/classes')).data.length, 0);
});

test('Dashboard and report totals reconcile to records', async () => {
  const d = (await M.get('/api/dashboard')).data.metrics;
  const rep = (await M.get('/api/reports?month=2026-10')).data;
  const paidRows = (await M.get('/api/payments?status=Paid')).data;
  const pendRows = (await M.get('/api/payments?status=Pending')).data;
  assert.equal(d.fees_collected_total, paidRows.totals.paid);
  assert.equal(d.pending_fees, pendRows.totals.pending);
  assert.equal(rep.totals.pending_total, pendRows.totals.pending);
  assert.equal(d.total_students, (await M.get('/api/students')).data.length);
  assert.equal(d.active_enrollments, (await M.get('/api/enrollments?status=Active')).data.length);
  assert.equal(rep.payment_followup.length, pendRows.rows.length);
  const completed = (await db.get('SELECT COUNT(*) n FROM classes WHERE counted = 1')).n;
  assert.equal(rep.delivery_trend.at(-1).completed, completed);
  assert.equal((await db.get('SELECT SUM(completed_classes) n FROM enrollments')).n, completed);
  const sam = rep.by_sales_rep.find(r => r.name === 'Sam Sales');
  assert.equal(sam.admissions, 1);
  const mgr = rep.by_sales_rep.find(r => r.name === 'Anasooya');
  assert.equal(sam.admissions + mgr.admissions, rep.totals.admissions_in_month);
  assert.equal(rep.by_sales_rep.reduce((s, r) => s + r.collected_in_month, 0), rep.totals.collected_in_month);
  // sales/teacher dashboards are limited
  assert.equal((await S.get('/api/reports')).status, 403);
  assert.equal((await S.get('/api/dashboard')).data.metrics.fees_collected_total, undefined);
  assert.equal((await T1.get('/api/dashboard')).data.role, 'teacher');
});

test('Deactivating a teacher requires confirmation when work is assigned and blocks their login', async () => {
  let r = await M.patch(`/api/teachers/${teacherB}`, { active: false });
  assert.equal(r.status, 200); // teacherB has no active work
  const t = client();
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nm-app' }, body: JSON.stringify({ email: 't2@x.in', password: pw }) });
  assert.equal(res.status, 401);
  assert.equal((await T2.get('/api/dashboard')).status, 401);
  r = await M.patch(`/api/teachers/${teacherA}`, { active: false });
  assert.equal(r.status, 400); assert.equal(r.data.code, 'NEEDS_CONFIRM');
  assert.equal((await M.patch(`/api/teachers/${teacherB}`, { active: true })).status, 200);
  void t;
});

test('PT-03: candidate details follow the age rules; first/last name; confirmed timing', async () => {
  const base = { first_name: 'Meera', last_name: 'Pillai', phone: '+971 50 555 0199', location: 'Dubai' };
  // Age is required; under 18 needs parent name + relationship
  let r = await S.post('/api/candidates', { ...base, idempotency_key: 'pt03-1' });
  assert.equal(r.status, 400); assert.equal(r.data.field, 'Age');
  r = await S.post('/api/candidates', { ...base, age: 9, idempotency_key: 'pt03-2' });
  assert.equal(r.status, 400); assert.equal(r.data.field, 'Parent name');
  r = await S.post('/api/candidates', { ...base, age: 9, parent_name: 'Asha', idempotency_key: 'pt03-3' });
  assert.equal(r.status, 400); assert.equal(r.data.field, 'Relationship');
  r = await S.post('/api/candidates', { ...base, age: 9, parent_name: 'Asha', parent_relationship: 'Aunt', idempotency_key: 'pt03-4' });
  assert.equal(r.status, 400);
  // Phone is always required (the parent's for a child)
  r = await S.post('/api/candidates', { first_name: 'Meera', last_name: 'Pillai', age: 9, parent_name: 'Asha', parent_relationship: 'Mother', idempotency_key: 'pt03-5' });
  assert.equal(r.status, 400); assert.equal(r.data.field, 'Parent phone');
  // A confirmed time needs a date and time
  r = await S.post('/api/candidates', { ...base, age: 9, parent_name: 'Asha', parent_relationship: 'Mother', time_confirmation: 'Confirmed', idempotency_key: 'pt03-6' });
  assert.equal(r.status, 400);
  r = await S.post('/api/candidates', { ...base, age: 9, gender: 'Female', parent_name: 'Asha', parent_relationship: 'Mother', student_phone: '+971 50 555 0100',
    time_confirmation: 'Confirmed', pretest_at: '2026-11-02T17:00', idempotency_key: 'pt03-7' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.student_name, 'Meera Pillai'); assert.equal(r.data.first_name, 'Meera'); assert.equal(r.data.last_name, 'Pillai');
  assert.equal(r.data.gender, 'Female'); assert.equal(r.data.parent_relationship, 'Mother'); assert.equal(r.data.student_phone, '+971 50 555 0100');
  assert.equal(r.data.status, 'Scheduled'); assert.equal(r.data.time_confirmation, 'Confirmed');
  const child = r.data;
  // Teachers never see either phone number
  await M.patch(`/api/candidates/${child.id}`, { pretest_teacher_id: teacherA });
  const seen = await T1.get(`/api/candidates/${child.id}`);
  assert.equal(seen.data.phone, undefined); assert.equal(seen.data.student_phone, undefined);
  // Adult: own phone required, no separate student phone; not confirmed => Time Required
  r = await S.post('/api/candidates', { first_name: 'Arun', last_name: 'Kumar', age: 34, student_phone: '+44 7700 900000', time_confirmation: 'Not Confirmed', idempotency_key: 'pt03-8' });
  assert.equal(r.status, 400); assert.equal(r.data.field, 'Phone');
  r = await S.post('/api/candidates', { first_name: 'Arun', last_name: 'Kumar', age: 34, phone: '+44 7700 900123', student_phone: '+44 7700 900000', time_confirmation: 'Not Confirmed', idempotency_key: 'pt03-9' });
  assert.equal(r.status, 201); assert.equal(r.data.status, 'Time Required'); assert.equal(r.data.student_phone, null);
  // Editing names keeps student_name in step
  r = await S.patch(`/api/candidates/${r.data.id}`, { first_name: 'Arun', last_name: 'K. Menon', age: 34, phone: '+44 7700 900123' });
  assert.equal(r.status, 200); assert.equal(r.data.student_name, 'Arun K. Menon');
});

test('PT-03: teacher clash check warns about overlapping pre-tests and classes (Manager only)', async () => {
  const child = await db.get(`SELECT id, pretest_at FROM candidates WHERE first_name = 'Meera' AND last_name = 'Pillai'`);
  // Another pre-test 15 minutes into Meera's 30-minute slot overlaps
  let r = await M.get(`/api/pretest-clash?teacher=${teacherA}&at=2026-11-02T17:15`);
  assert.equal(r.status, 200);
  assert.ok(r.data.busy.some(b => b.kind === 'Pre-test' && b.student_name === 'Meera Pillai'));
  // Excluding the candidate itself (when editing) removes it; a time right after the slot is free
  r = await M.get(`/api/pretest-clash?teacher=${teacherA}&at=2026-11-02T17:00&candidate=${child.id}`);
  assert.ok(!r.data.busy.some(b => b.student_name === 'Meera Pillai'));
  r = await M.get(`/api/pretest-clash?teacher=${teacherA}&at=2026-11-02T17:30`);
  assert.ok(!r.data.busy.some(b => b.student_name === 'Meera Pillai'));
  // A booked class is reported too
  const cl = await db.get(`SELECT teacher_id, scheduled_at, class_code FROM classes WHERE status NOT IN ('Cancelled','Rescheduled') ORDER BY id LIMIT 1`);
  if (cl) {
    r = await M.get(`/api/pretest-clash?teacher=${cl.teacher_id}&at=${cl.scheduled_at}`);
    assert.ok(r.data.busy.some(b => b.kind === 'Class' && b.code === cl.class_code));
  }
  assert.equal((await S.get(`/api/pretest-clash?teacher=${teacherA}&at=2026-11-02T17:15`)).status, 403);
  assert.equal((await M.get(`/api/pretest-clash?teacher=${teacherA}&at=bad`)).status, 400);
});

test('Google Meet: Manager connects Google in Settings; confirmed pre-tests get a copyable Meet link', async () => {
  const google = require('../src/google');
  const calls = []; let n = 0; let failCreate = false;
  google.setFetch(async (url, opts = {}) => {
    const u = String(url); const method = opts.method || 'GET';
    calls.push({ method, url: u, body: opts.body });
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(opts.body);
      if (p.get('grant_type') === 'authorization_code') return json(200, { access_token: 'at', refresh_token: 'rt-1', expires_in: 3600 });
      return json(200, { access_token: 'at2', expires_in: 3600 });
    }
    if (u.startsWith('https://openidconnect.googleapis.com')) return json(200, { email: 'nmlflow@gmail.com' });
    if (u.startsWith('https://oauth2.googleapis.com/revoke')) return json(200, {});
    if (u.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) {
      if (method === 'POST') {
        if (failCreate) return json(500, { error: { message: 'Backend Error' } });
        n++; return json(200, { id: 'ev' + n, hangoutLink: `https://meet.google.com/abc-defg-00${n}` });
      }
      if (method === 'PATCH') return json(200, { id: 'x' });
      if (method === 'DELETE') return { ok: true, status: 204, json: async () => null };
    }
    return json(404, { error: 'unexpected ' + u });
  });
  const child = { first_name: 'Nila', last_name: 'Varma', age: 8, parent_name: 'Gita', parent_relationship: 'Mother', phone: '+91 98470 11111' };

  // Not connected yet: the pre-test is saved without a link
  let r = await S.post('/api/candidates', { ...child, time_confirmation: 'Confirmed', pretest_at: '2026-11-05T16:00', idempotency_key: 'gm-1' });
  assert.equal(r.status, 201); assert.equal(r.data.meet_link, null); assert.equal(r.data.meet_status, 'not_connected');
  const early = r.data;
  assert.equal((await S.post(`/api/candidates/${early.id}/meet`)).status, 400);

  // Settings are Manager only
  assert.equal((await S.get('/api/settings/google')).status, 403);
  let g = (await M.get('/api/settings/google')).data;
  assert.equal(g.connected, false); assert.match(g.redirect_uri, /\/api\/google\/callback$/);
  assert.equal((await M.put('/api/settings/google', { client_id: 'nope', client_secret: 's' })).status, 400);
  assert.equal((await M.put('/api/settings/google', { client_id: '123-abc.apps.googleusercontent.com' })).status, 400); // secret needed
  assert.equal((await M.put('/api/settings/google', { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-test' })).status, 200);

  // Connect: a wrong state is refused; the right one stores the account
  r = await M.post('/api/settings/google/connect');
  const auth = new URL(r.data.url);
  assert.equal(auth.hostname, 'accounts.google.com'); assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.match(auth.searchParams.get('scope'), /calendar\.events/);
  await M.get('/api/google/callback?code=c1&state=wrong');
  assert.equal((await M.get('/api/settings/google')).data.connected, false);
  r = await M.post('/api/settings/google/connect');
  await M.get(`/api/google/callback?code=c1&state=${new URL(r.data.url).searchParams.get('state')}`);
  g = (await M.get('/api/settings/google')).data;
  assert.equal(g.connected, true); assert.equal(g.account_email, 'nmlflow@gmail.com');

  // On-demand link for the earlier candidate
  r = await S.post(`/api/candidates/${early.id}/meet`);
  assert.equal(r.status, 200); assert.match(r.data.meet_link, /^https:\/\/meet\.google\.com\//);

  // A confirmed pre-test gets a link straight away; no invitations are emailed
  r = await S.post('/api/candidates', { ...child, first_name: 'Tara', time_confirmation: 'Confirmed', pretest_at: '2026-11-06T17:00', idempotency_key: 'gm-2' });
  assert.equal(r.status, 201); assert.match(r.data.meet_link, /^https:\/\/meet\.google\.com\//);
  const cand = r.data;
  const create = calls.filter(c => c.method === 'POST' && c.url.includes('/calendar/')).at(-1);
  assert.match(create.url, /conferenceDataVersion=1/); assert.match(create.url, /sendUpdates=none/);
  const ev = JSON.parse(create.body);
  assert.equal(ev.start.dateTime, '2026-11-06T17:00:00'); assert.equal(ev.end.dateTime, '2026-11-06T17:30:00');
  assert.equal(ev.start.timeZone, 'Asia/Kolkata'); assert.equal(ev.attendees, undefined);

  // Not confirmed => no link
  r = await S.post('/api/candidates', { ...child, first_name: 'Dev', time_confirmation: 'Not Confirmed', idempotency_key: 'gm-3' });
  assert.equal(r.data.meet_link, null);

  // The assigned teacher can see the link
  await M.patch(`/api/candidates/${cand.id}`, { pretest_teacher_id: teacherA });
  assert.equal((await T1.get(`/api/candidates/${cand.id}`)).data.meet_link, cand.meet_link);

  // Moving the time moves the event; the link stays the same
  r = await S.patch(`/api/candidates/${cand.id}`, { pretest_at: '2026-11-07T18:00' });
  assert.equal(r.data.meet_link, cand.meet_link);
  assert.ok(calls.some(c => c.method === 'PATCH' && c.url.includes(cand.meet_event_id)));

  // Cancelling removes the event and the link
  r = await S.patch(`/api/candidates/${cand.id}`, { status: 'Cancelled' });
  assert.equal(r.data.meet_link, null);
  assert.ok(calls.some(c => c.method === 'DELETE' && c.url.includes(cand.meet_event_id)));

  // A Google failure never blocks saving the pre-test
  failCreate = true;
  r = await S.post('/api/candidates', { ...child, first_name: 'Kabir', time_confirmation: 'Confirmed', pretest_at: '2026-11-08T10:00', idempotency_key: 'gm-4' });
  assert.equal(r.status, 201); assert.equal(r.data.meet_link, null); assert.match(r.data.meet_error, /Backend Error/);
  failCreate = false;

  // Disconnect
  assert.equal((await M.del('/api/settings/google/connection')).status, 200);
  assert.equal((await M.get('/api/settings/google')).data.connected, false);
  assert.ok(calls.some(c => c.url.includes('/revoke')));
  google.setFetch((...a) => globalThis.fetch(...a));
});
