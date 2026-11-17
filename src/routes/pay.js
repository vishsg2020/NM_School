'use strict';
// Monthly teacher pay statement, worked out from the class records (the app does not pay anyone).
// Rules from the teacher notices:
//  Regular   – monthly salary + ₹10 per completed 1:1 class + ₹45 per conducted 3:1 session;
//              emergency absences ("Teacher Absent"): the first in the month is free with at least 10 minutes'
//              notice, every further one is a ₹200 fine.
//  Freelance – ₹100 per completed 1:1 class + ₹150 per conducted 3:1 session; no salary, no fines.
// A 3:1 session counts once when at least one student attended (one of its class rows is Completed).
const { requireRole } = require('../auth');
const { bad, int, idParam, thisMonth } = require('../util');

const DEFAULT_RATES = { regular_salary: 14000, regular_1to1: 10, regular_3to1: 45, absence_fine: 200, freelance_1to1: 100, freelance_3to1: 150 };

async function payRates(db) {
  const r = await db.get(`SELECT value FROM app_settings WHERE key = 'pay_rates'`);
  let saved = {}; try { saved = r && r.value ? JSON.parse(r.value) : {}; } catch { saved = {}; }
  return { ...DEFAULT_RATES, ...saved };
}
const pickMonth = m => { if (m === undefined || m === '') return thisMonth(); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw bad('Month is not valid'); return m; };

/** Pay lines for every teacher who is active or had a class in the month. */
async function statement(db, month) {
  const rates = await payRates(db);
  const teachers = await db.all(`SELECT t.id, t.name, t.employment_type, t.monthly_salary, t.active FROM teachers t
    WHERE t.active = 1 OR EXISTS (SELECT 1 FROM classes cl WHERE cl.teacher_id = t.id AND substr(cl.scheduled_at,1,7) = @m)
    ORDER BY t.active DESC, t.name`, { m: month });
  const rows = await db.all(`SELECT cl.id, cl.class_code, cl.teacher_id, cl.format, cl.scheduled_at, cl.status, cl.absence_notice, c.student_name
    FROM classes cl JOIN enrollments e ON e.id = cl.enrollment_id JOIN students s ON s.id = e.student_id JOIN candidates c ON c.id = s.candidate_id
    WHERE substr(cl.scheduled_at,1,7) = @m AND cl.status IN ('Completed','Teacher Absent') ORDER BY cl.scheduled_at, cl.id`, { m: month });
  const lines = teachers.map(t => {
    const mine = rows.filter(r => r.teacher_id === t.id);
    const one = mine.filter(r => r.format === '1:1' && r.status === 'Completed');
    // Sessions: one per 3:1 time slot with a Completed row; absences: one per 1:1 class or 3:1 time slot.
    const groupKeys = [...new Set(mine.filter(r => r.format === '3:1' && r.status === 'Completed').map(r => r.scheduled_at))];
    const absMap = new Map();
    for (const r of mine.filter(x => x.status === 'Teacher Absent')) {
      const k = r.format === '3:1' ? 'g' + r.scheduled_at : 'c' + r.id;
      const a = absMap.get(k) || { scheduled_at: r.scheduled_at, format: r.format, notice: false, classes: [] };
      if (r.absence_notice === 'Yes') a.notice = true;
      a.classes.push(r.class_code); absMap.set(k, a);
    }
    const absences = [...absMap.values()].sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
    const regular = t.employment_type === 'Regular';
    // First absence of the month is free only with notice; every further one is fined (Regular teachers only).
    absences.forEach((a, i) => { a.fine = regular ? (i === 0 && a.notice ? 0 : rates.absence_fine) : 0; });
    const rate1 = regular ? rates.regular_1to1 : rates.freelance_1to1;
    const rate3 = regular ? rates.regular_3to1 : rates.freelance_3to1;
    const salary = regular ? (t.monthly_salary ?? rates.regular_salary) : 0;
    const classPay = one.length * rate1 + groupKeys.length * rate3;
    const fines = absences.reduce((s, a) => s + a.fine, 0);
    return {
      id: t.id, name: t.name, employment_type: t.employment_type, active: Boolean(t.active), salary,
      classes_1to1: one.length, rate_1to1: rate1, sessions_3to1: groupKeys.length, rate_3to1: rate3, class_pay: classPay,
      absences: absences.length, fines, total: salary + classPay - fines,
      details: {
        classes_1to1: one.map(r => ({ class_code: r.class_code, at: r.scheduled_at, student: r.student_name })),
        sessions_3to1: groupKeys.map(k => ({ at: k, students: mine.filter(r => r.format === '3:1' && r.scheduled_at === k && r.status === 'Completed').map(r => r.student_name) })),
        absences,
      },
    };
  });
  return { month, rates, teachers: lines, total: lines.reduce((s, l) => s + l.total, 0) };
}

module.exports = (app, { db }) => {
  app.get('/api/teacher-pay', requireRole('manager'), async (req, res) => {
    const s = await statement(db, pickMonth(req.query.month));
    res.json({ ...s, teachers: s.teachers.map(({ details, ...rest }) => rest) });
  });
  app.get('/api/teacher-pay/:id', requireRole('manager'), async (req, res) => {
    const s = await statement(db, pickMonth(req.query.month));
    const t = s.teachers.find(x => x.id === idParam(req.params.id));
    if (!t) throw bad('No pay lines for this teacher in that month');
    res.json({ month: s.month, ...t });
  });
  app.get('/api/teacher-pay-export', requireRole('manager'), async (req, res) => {
    const month = pickMonth(req.query.month);
    const s = await statement(db, month);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); wb.creator = 'Nalla Malayalam';
    const money = '"₹"#,##0';
    const sum = wb.addWorksheet('Summary');
    sum.columns = [
      { header: 'Teacher', key: 'name', width: 24 }, { header: 'Type', key: 'employment_type', width: 11 },
      { header: 'Salary', key: 'salary', width: 11 }, { header: '1:1 classes', key: 'classes_1to1', width: 11 }, { header: '1:1 rate', key: 'rate_1to1', width: 9 },
      { header: '3:1 sessions', key: 'sessions_3to1', width: 12 }, { header: '3:1 rate', key: 'rate_3to1', width: 9 }, { header: 'Class pay', key: 'class_pay', width: 11 },
      { header: 'Absences', key: 'absences', width: 10 }, { header: 'Fines', key: 'fines', width: 9 }, { header: 'Total', key: 'total', width: 12 },
    ];
    s.teachers.forEach(t => sum.addRow(t));
    sum.addRow({ name: 'Total', total: s.total }).font = { bold: true };
    sum.getRow(1).font = { bold: true };
    ['salary', 'rate_1to1', 'rate_3to1', 'class_pay', 'fines', 'total'].forEach(k => { sum.getColumn(k).numFmt = money; });
    sum.addRow([]);
    sum.addRow([`Teacher pay for ${month}, worked out from completed classes. Statement only; nothing is paid by the app.`]).font = { italic: true };
    for (const t of s.teachers) {
      const ws = wb.addWorksheet(t.name.replace(/[*?:\\/[\]]/g, ' ').slice(0, 31) || `Teacher ${t.id}`);
      ws.columns = [{ header: 'Date & time (IST)', key: 'at', width: 20 }, { header: 'What', key: 'what', width: 16 }, { header: 'Class / students', key: 'who', width: 44 }, { header: 'Amount', key: 'amount', width: 11 }];
      ws.getRow(1).font = { bold: true };
      t.details.classes_1to1.forEach(c => ws.addRow({ at: c.at.replace('T', ' '), what: '1:1 class', who: `${c.class_code} · ${c.student}`, amount: t.rate_1to1 }));
      t.details.sessions_3to1.forEach(g => ws.addRow({ at: g.at.replace('T', ' '), what: '3:1 session', who: g.students.join(', '), amount: t.rate_3to1 }));
      t.details.absences.forEach(a => ws.addRow({ at: a.scheduled_at.replace('T', ' '), what: 'Teacher absent', who: `${a.classes.join(', ')}${a.notice ? ' · notice given' : ' · no notice'}`, amount: -a.fine }));
      if (t.salary) ws.addRow({ what: 'Monthly salary', amount: t.salary });
      ws.addRow({ what: 'Total', amount: t.total }).font = { bold: true };
      ws.getColumn('amount').numFmt = money;
    }
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Nalla-Malayalam-teacher-pay-${month}.xlsx"`,
      'Cache-Control': 'no-store',
    });
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  app.get('/api/settings/pay-rates', requireRole('manager'), async (_req, res) => res.json({ rates: await payRates(db), defaults: DEFAULT_RATES }));
  app.put('/api/settings/pay-rates', requireRole('manager'), async (req, res) => {
    const out = {};
    for (const k of Object.keys(DEFAULT_RATES)) out[k] = int(req.body[k], { min: 0, max: 1_000_000, required: true, name: k.replace(/_/g, ' ') });
    await db.run(`INSERT INTO app_settings (key, value, updated_by) VALUES ('pay_rates', ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now_iso()`, [JSON.stringify(out), req.user.id]);
    res.json({ rates: await payRates(db), defaults: DEFAULT_RATES });
  });
};
module.exports.statement = statement;
module.exports.DEFAULT_RATES = DEFAULT_RATES;
