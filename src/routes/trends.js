'use strict';
// Manager dashboard charts: fees, admissions, classes, pre-test results and open fees for a period.
// Every figure is worked out from the records each time; no totals are stored. The rules match the lists the
// bars link to (Payments, Students, Class Activity, Pre-Test Queue), and the tests check that they agree.
const { requireRole } = require('../auth');
const { bad, oneOf, idParam, isValidDate, today, istDay } = require('../util');

const RESULTS = ['Confirmed', 'Follow-up', 'Not Interested'];
const RESULT_DAY = istDay('pr.submitted_at');
// A 3:1 group is stored as one class row per student; it counts as one session (same teacher, same start time).
const SESSION_KEY = `CASE WHEN cl.format = '3:1' THEN 'g' || cl.teacher_id || '@' || cl.scheduled_at ELSE 'c' || cl.id END`;
const BUCKET = {
  day: col => col,
  week: col => `to_char(date_trunc('week', (${col})::date), 'YYYY-MM-DD')`, // the Monday that starts the week
  month: col => `substr(${col}, 1, 7)`,
};

const addDaysUTC = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const mondayOf = d => addDaysUTC(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));

/** Every bucket from `from` to `to`, so days/weeks/months with nothing still show as 0. */
function buckets(group, from, to) {
  const out = [];
  if (group === 'month') {
    let [y, m] = from.slice(0, 7).split('-').map(Number); const end = to.slice(0, 7);
    for (;;) { const k = `${y}-${String(m).padStart(2, '0')}`; if (k > end) break; out.push(k); if (++m > 12) { m = 1; y++; } }
  } else {
    const step = group === 'week' ? 7 : 1;
    for (let d = group === 'week' ? mondayOf(from) : from; d <= to; d = addDaysUTC(d, step)) {
      out.push(d);
      if (out.length > 1000) throw bad('That is too many bars to show. Choose Week or Month.');
    }
  }
  return out;
}
const fill = (keys, rows, pick) => { const m = new Map(rows.map(r => [r.period, r])); return keys.map(k => ({ period: k, ...pick(m.get(k) || {}) })); };

module.exports = (app, { db }) => {
  app.get('/api/dashboard/trends', requireRole('manager'), async (req, res) => {
    const q = req.query; const t = today();
    const from = q.date_from || ''; const to = q.date_to || '';
    if (from && !isValidDate(from)) throw bad('From date is not valid');
    if (to && !isValidDate(to)) throw bad('To date is not valid');
    if (from && to && from > to) throw bad('From date is after To date');
    const teacher = q.teacher ? idParam(q.teacher) : null;
    const rep = q.sales_rep ? idParam(q.sales_rep) : null;
    const format = q.format ? oneOf(q.format, ['1:1', '3:1'], { name: 'Format' }) : null;
    const p = { from: from || null, to: to || null, teacher, rep, format, t };

    // Filters for each kind of record. Fees and admissions belong to the student's regular teacher;
    // classes to the teacher who took the class; pre-tests to the pre-test teacher. Format does not apply to pre-tests.
    const enr = ['(@teacher::int IS NULL OR e.teacher_id = @teacher)', '(@rep::int IS NULL OR e.sales_rep_id = @rep)', '(@format::text IS NULL OR e.class_mode = @format)'];
    const range = col => [`(@from::text IS NULL OR ${col} >= @from)`, `(@to::text IS NULL OR ${col} <= @to)`];
    const W = {
      paid: ['p.status = \'Paid\'', ...range('p.date'), ...enr].join(' AND '),
      open: ['p.status = \'Pending\'', ...enr].join(' AND '),
      adm: [...range('e.admission_date'), ...enr].join(' AND '),
      cls: ['cl.status = \'Completed\'', ...range('substr(cl.scheduled_at,1,10)'), '(@teacher::int IS NULL OR cl.teacher_id = @teacher)',
        '(@rep::int IS NULL OR e.sales_rep_id = @rep)', '(@format::text IS NULL OR cl.format = @format)'].join(' AND '),
      pre: [...range(RESULT_DAY), '(@teacher::int IS NULL OR c.pretest_teacher_id = @teacher)', '(@rep::int IS NULL OR c.sales_rep_id = @rep)'].join(' AND '),
    };
    const PAY = 'FROM payments p JOIN enrollments e ON e.id = p.enrollment_id';
    const CLS = 'FROM classes cl JOIN enrollments e ON e.id = cl.enrollment_id';

    const totals = await db.get(`SELECT
        (SELECT COALESCE(SUM(p.amount),0) ${PAY} WHERE ${W.paid}) AS fees,
        (SELECT COUNT(*) ${PAY} WHERE ${W.paid}) AS fees_count,
        (SELECT MIN(p.date) ${PAY} WHERE ${W.paid}) AS first_fee,
        (SELECT COUNT(*) FROM enrollments e WHERE ${W.adm}) AS admissions,
        (SELECT COUNT(*) FROM enrollments e WHERE ${W.adm} AND e.class_mode = '1:1') AS admissions_1to1,
        (SELECT COUNT(*) FROM enrollments e WHERE ${W.adm} AND e.class_mode = '3:1') AS admissions_3to1,
        (SELECT MIN(e.admission_date) FROM enrollments e WHERE ${W.adm}) AS first_admission,
        (SELECT COUNT(DISTINCT ${SESSION_KEY}) ${CLS} WHERE ${W.cls}) AS sessions,
        (SELECT COUNT(*) ${CLS} WHERE ${W.cls}) AS class_records,
        (SELECT COALESCE(SUM(p.amount),0) ${PAY} WHERE ${W.open}) AS pending,
        (SELECT COUNT(*) ${PAY} WHERE ${W.open}) AS pending_count,
        (SELECT COALESCE(SUM(p.amount),0) ${PAY} WHERE ${W.open} AND p.date < @t) AS overdue,
        (SELECT COUNT(*) ${PAY} WHERE ${W.open} AND p.date < @t) AS overdue_count`, p);

    // Day, week or month. "auto" picks the one that gives a readable number of bars.
    let group = oneOf(q.group || 'auto', ['auto', 'day', 'week', 'month'], { name: 'Show by' });
    const start = from || totals.first_fee; const end = to || t;
    if (group === 'auto') {
      const days = start ? (Date.parse(end) - Date.parse(start)) / 864e5 + 1 : 0;
      group = days <= 45 ? 'day' : days <= 190 ? 'week' : 'month';
    }
    const feeRows = await db.all(`SELECT ${BUCKET[group]('p.date')} AS period, SUM(p.amount) AS amount, COUNT(*) AS payments
      ${PAY} WHERE ${W.paid} GROUP BY 1`, p);
    const fees = start && start <= end ? fill(buckets(group, start, end), feeRows, r => ({ amount: r.amount || 0, payments: r.payments || 0 })) : [];

    const admStart = from || totals.first_admission;
    const admRows = await db.all(`SELECT substr(e.admission_date,1,7) AS period, COUNT(*) AS admissions FROM enrollments e WHERE ${W.adm} GROUP BY 1`, p);
    const admissions = admStart && admStart <= end ? fill(buckets('month', admStart, end), admRows, r => ({ admissions: r.admissions || 0 })) : [];

    const byRep = await db.all(`SELECT u.id, u.name AS label, SUM(p.amount) AS amount, COUNT(*) AS payments
      ${PAY} JOIN users u ON u.id = e.sales_rep_id WHERE ${W.paid} GROUP BY u.id, u.name ORDER BY amount DESC, u.name LIMIT 15`, p);
    const byTeacher = await db.all(`SELECT tc.id, tc.name AS label, COUNT(DISTINCT ${SESSION_KEY}) AS sessions, COUNT(*) AS class_records
      ${CLS} JOIN teachers tc ON tc.id = cl.teacher_id WHERE ${W.cls} GROUP BY tc.id, tc.name ORDER BY sessions DESC, tc.name LIMIT 15`, p);
    const resRows = await db.all(`SELECT pr.admission_status AS label, COUNT(*) AS n
      FROM pretest_results pr JOIN candidates c ON c.id = pr.candidate_id WHERE ${W.pre} GROUP BY 1`, p);
    const byResult = RESULTS.map(label => ({ label, n: resRows.find(r => r.label === label)?.n || 0 }));
    const open = [
      { key: 'overdue', label: 'Overdue', amount: totals.overdue, payments: totals.overdue_count },
      { key: 'not_due', label: 'Not yet due', amount: totals.pending - totals.overdue, payments: totals.pending_count - totals.overdue_count },
    ];
    res.json({
      today: t, date_from: from, date_to: to, group, totals: { ...totals, pretest_results: byResult.reduce((s, r) => s + r.n, 0) },
      fees, admissions, byRep, byTeacher, byResult, open, format_ignored_for_pretests: Boolean(format),
    });
  });
};
