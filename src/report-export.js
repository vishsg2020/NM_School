'use strict';
// Monthly report workbook (Excel) — a record the Manager downloads and keeps.
const ExcelJS = require('exceljs');

const GREEN = 'FF2E6A1C';
const SOFT = 'FFEAF5E3';
const MONEY = '"₹"#,##0';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = m => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/** Adds a sheet with a styled header row, frozen header and filters. cols: [{ header, key, width, money?, num? }] */
function sheet(wb, name, cols, rows, note) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: note ? 2 : 1 }] });
  if (note) {
    ws.addRow([note]).font = { italic: true, color: { argb: 'FF5F6B65' } };
    ws.mergeCells(1, 1, 1, cols.length);
  }
  ws.columns = cols.map(c => ({ key: c.key, width: c.width || 16 }));
  const head = ws.addRow(cols.map(c => c.header));
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } }; cell.alignment = { vertical: 'middle', wrapText: true }; });
  for (const r of rows) ws.addRow(cols.map(c => r[c.key] ?? ''));
  cols.forEach((c, i) => { if (c.money) ws.getColumn(i + 1).numFmt = MONEY; });
  if (rows.length) ws.autoFilter = { from: { row: head.number, column: 1 }, to: { row: head.number + rows.length, column: cols.length } };
  else ws.addRow(['Nothing for this month']).font = { italic: true, color: { argb: 'FF5F6B65' } };
  return ws;
}

async function buildWorkbook(db, data, month, user) {
  const p = { month, t: data.today };
  const q = (sql, extra = {}) => db.all(sql, { ...p, ...extra });

  const [pretests, admissions, collected, classes, answers, counts] = await Promise.all([
    q(`SELECT c.lead_id, c.student_name, c.age, c.location, substr(c.created_at,1,10) AS added_on, c.pretest_at, c.time_confirmation, c.status,
         t.name AS teacher, r.name AS sales_rep, pr.recommended_course, pr.admission_status, pr.followup_date
       FROM candidates c JOIN users r ON r.id = c.sales_rep_id LEFT JOIN teachers t ON t.id = c.pretest_teacher_id
       LEFT JOIN pretest_results pr ON pr.candidate_id = c.id
       WHERE substr(c.created_at,1,7) = @month OR substr(c.pretest_at,1,7) = @month ORDER BY c.pretest_at NULLS LAST, c.id`),
    q(`SELECT e.admission_date, s.student_code, e.lead_id, c.student_name, e.course, e.class_mode, t.name AS teacher, r.name AS sales_rep,
         e.start_date, e.end_date, e.total_classes, e.total_fee,
         (SELECT amount FROM payments WHERE enrollment_id = e.id AND stage = 'Advance') AS advance,
         (SELECT amount FROM payments WHERE enrollment_id = e.id AND stage = 'Final') AS final, e.status
       FROM enrollments e JOIN students s ON s.id = e.student_id JOIN candidates c ON c.id = s.candidate_id
       JOIN teachers t ON t.id = e.teacher_id JOIN users r ON r.id = e.sales_rep_id
       WHERE substr(e.admission_date,1,7) = @month ORDER BY e.admission_date, e.id`),
    q(`SELECT p.date, s.student_code, c.student_name, p.stage, p.amount, p.method, p.reference, r.name AS sales_rep
       FROM payments p JOIN enrollments e ON e.id = p.enrollment_id JOIN students s ON s.id = e.student_id
       JOIN candidates c ON c.id = s.candidate_id JOIN users r ON r.id = e.sales_rep_id
       WHERE p.status = 'Paid' AND substr(p.date,1,7) = @month ORDER BY p.date, p.id`),
    q(`SELECT substr(cl.scheduled_at,1,10) AS day, substr(cl.scheduled_at,12,5) AS time, cl.class_code, c.student_name, t.name AS teacher,
         cl.format, cl.duration_min, cl.status, cl.attendance, cl.topics,
         cl.rating_participation, cl.rating_homework, cl.rating_progress, fb.rating AS parent_rating
       FROM classes cl JOIN enrollments e ON e.id = cl.enrollment_id JOIN students s ON s.id = e.student_id
       JOIN candidates c ON c.id = s.candidate_id JOIN teachers t ON t.id = cl.teacher_id
       LEFT JOIN feedback fb ON fb.class_id = cl.id AND fb.kind = 'class'
       WHERE substr(cl.scheduled_at,1,7) = @month ORDER BY cl.scheduled_at, cl.id`),
    q(`SELECT substr(f.submitted_at,1,10) AS day, f.kind, t.name AS teacher, c.student_name, e.course, cl.class_code,
         f.rating, f.teacher_rating, f.content_rating, f.progress_rating, f.nps, f.continue_choice, f.tags, f.comment
       FROM feedback f JOIN teachers t ON t.id = f.teacher_id JOIN enrollments e ON e.id = f.enrollment_id
       JOIN students s ON s.id = e.student_id JOIN candidates c ON c.id = s.candidate_id LEFT JOIN classes cl ON cl.id = f.class_id
       WHERE substr(f.submitted_at,1,7) = @month ORDER BY f.submitted_at`),
    db.get(`SELECT
       (SELECT COUNT(*) FROM candidates WHERE substr(created_at,1,7) = @month) AS candidates_added,
       (SELECT COUNT(*) FROM pretest_results WHERE substr(submitted_at,1,7) = @month) AS results,
       (SELECT COUNT(*) FROM pretest_results WHERE substr(submitted_at,1,7) = @month AND admission_status = 'Confirmed') AS confirmed,
       (SELECT COALESCE(SUM(total_fee),0) FROM enrollments WHERE substr(admission_date,1,7) = @month) AS admitted_value,
       (SELECT COUNT(*) FROM classes WHERE counted = 1 AND substr(scheduled_at,1,7) = @month) AS classes_done,
       (SELECT COUNT(*) FROM classes WHERE status IN ('Cancelled','Teacher Absent','Student Absent') AND substr(scheduled_at,1,7) = @month) AS classes_missed,
       (SELECT ROUND(AVG(rating)::numeric, 1) FROM feedback WHERE kind = 'class' AND substr(submitted_at,1,7) = @month) AS class_rating,
       (SELECT COUNT(*) FROM feedback WHERE kind = 'course' AND substr(submitted_at,1,7) = @month) AS course_answers`, p),
  ]);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Nalla Malayalam school app';
  wb.created = new Date();
  wb.title = `Monthly report ${monthName(month)}`;

  // 1. Summary
  const ws = wb.addWorksheet('Summary');
  ws.columns = [{ width: 40 }, { width: 22 }];
  ws.addRow(['Nalla Malayalam — Monthly report']).font = { bold: true, size: 16, color: { argb: GREEN } };
  ws.addRow([monthName(month)]).font = { bold: true, size: 13 };
  const ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  ws.addRow([`Downloaded ${ist} IST by ${user.name}. "Now" figures are as of ${data.today}.`]).font = { italic: true, color: { argb: 'FF5F6B65' } };
  ws.addRow([]);
  const rows = [
    ['Pre-tests', null],
    ['Candidates added', counts.candidates_added], ['Pre-test results recorded', counts.results], ['Results Confirmed', counts.confirmed],
    ['Admissions', null],
    ['New admissions', data.totals.admissions_in_month], ['Admitted fee value', counts.admitted_value, true],
    ['Fees', null],
    ['Fees collected in the month', data.totals.collected_in_month, true], ['Pending fees (now)', data.totals.pending_total, true], ['Overdue fees (now)', data.totals.overdue_total, true],
    ['Classes', null],
    ['Classes completed', counts.classes_done], ['Cancelled / absent', counts.classes_missed],
    ['Feedback', null],
    ['Average parent class rating (1–5)', counts.class_rating ?? '—'], ['Course feedback answers', counts.course_answers],
  ];
  for (const [label, value, money] of rows) {
    const r = ws.addRow(value === null ? [label] : [label, value]);
    if (value === null) { r.font = { bold: true, color: { argb: 'FFFFFFFF' } }; r.getCell(1).fill = r.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } }; }
    else { if (money) r.getCell(2).numFmt = MONEY; r.getCell(2).alignment = { horizontal: 'right' }; }
  }
  ws.addRow([]);
  ws.addRow(['Each tab has the detail behind these figures.']).font = { italic: true, color: { argb: 'FF5F6B65' } };

  // 2–9. Detail sheets
  sheet(wb, 'Pre-tests', [
    { header: 'Lead ID', key: 'lead_id', width: 12 }, { header: 'Student', key: 'student_name', width: 22 }, { header: 'Age', key: 'age', width: 6 },
    { header: 'Location', key: 'location', width: 16 }, { header: 'Added on', key: 'added_on', width: 12 }, { header: 'Pre-test (IST)', key: 'pretest_at', width: 17 },
    { header: 'Time', key: 'time_confirmation', width: 14 }, { header: 'Status', key: 'status', width: 14 }, { header: 'Teacher', key: 'teacher', width: 18 },
    { header: 'Sales rep', key: 'sales_rep', width: 18 }, { header: 'Recommended', key: 'recommended_course', width: 16 }, { header: 'Result', key: 'admission_status', width: 14 },
    { header: 'Follow up on', key: 'followup_date', width: 12 },
  ], pretests.map(r => ({ ...r, pretest_at: r.pretest_at ? r.pretest_at.replace('T', ' ') : '' })), 'Candidates added this month or with a pre-test this month.');
  sheet(wb, 'Admissions', [
    { header: 'Admitted', key: 'admission_date', width: 12 }, { header: 'Student ID', key: 'student_code', width: 12 }, { header: 'Lead ID', key: 'lead_id', width: 12 },
    { header: 'Student', key: 'student_name', width: 22 }, { header: 'Course', key: 'course', width: 16 }, { header: 'Mode', key: 'class_mode', width: 7 },
    { header: 'Teacher', key: 'teacher', width: 18 }, { header: 'Sales rep', key: 'sales_rep', width: 18 }, { header: 'Start', key: 'start_date', width: 12 },
    { header: 'End (planned)', key: 'end_date', width: 13 }, { header: 'Classes', key: 'total_classes', width: 9 }, { header: 'Course fee', key: 'total_fee', width: 12, money: true },
    { header: 'Advance', key: 'advance', width: 11, money: true }, { header: 'Final', key: 'final', width: 11, money: true }, { header: 'Status', key: 'status', width: 11 },
  ], admissions);
  sheet(wb, 'Fees collected', [
    { header: 'Received', key: 'date', width: 12 }, { header: 'Student ID', key: 'student_code', width: 12 }, { header: 'Student', key: 'student_name', width: 22 },
    { header: 'Stage', key: 'stage', width: 9 }, { header: 'Amount', key: 'amount', width: 12, money: true }, { header: 'Method', key: 'method', width: 14 },
    { header: 'Reference', key: 'reference', width: 22 }, { header: 'Sales rep', key: 'sales_rep', width: 18 },
  ], collected, 'Payments marked Paid with a received date in this month.');
  sheet(wb, 'Outstanding', [
    { header: 'Due', key: 'due_date', width: 12 }, { header: 'Days overdue', key: 'days_overdue', width: 12 }, { header: 'Lead ID', key: 'lead_id', width: 12 },
    { header: 'Student', key: 'student_name', width: 22 }, { header: 'Stage', key: 'stage', width: 9 }, { header: 'Amount', key: 'amount', width: 12, money: true },
    { header: 'Parent', key: 'parent_name', width: 18 }, { header: 'Phone', key: 'phone', width: 18 }, { header: 'Sales rep', key: 'sales_rep_name', width: 18 },
  ], data.payment_followup.map(r => ({ ...r, days_overdue: r.overdue ? r.days_overdue : '' })), `Pending payments as of ${data.today}.`);
  sheet(wb, 'Classes', [
    { header: 'Date', key: 'day', width: 12 }, { header: 'Time', key: 'time', width: 7 }, { header: 'Class ID', key: 'class_code', width: 11 },
    { header: 'Student', key: 'student_name', width: 22 }, { header: 'Teacher', key: 'teacher', width: 18 }, { header: 'Format', key: 'format', width: 7 },
    { header: 'Minutes', key: 'duration_min', width: 8 }, { header: 'Status', key: 'status', width: 15 }, { header: 'Attendance', key: 'attendance', width: 11 },
    { header: 'Topics', key: 'topics', width: 30 }, { header: 'Participation ★', key: 'rating_participation', width: 13 },
    { header: 'Homework ★', key: 'rating_homework', width: 11 }, { header: 'Progress ★', key: 'rating_progress', width: 11 }, { header: 'Parent rating ★', key: 'parent_rating', width: 13 },
  ], classes);
  sheet(wb, 'Teachers', [
    { header: 'Teacher', key: 'name', width: 20 }, { header: 'Type', key: 'employment_type', width: 11 }, { header: 'Weekly hours', key: 'weekly_working_hours', width: 12 },
    { header: 'Planned sessions', key: 'planned_sessions', width: 14 }, { header: 'Capacity', key: 'monthly_capacity', width: 10 }, { header: 'Utilisation %', key: 'utilization_pct', width: 12 },
    { header: 'Completed 1:1 classes', key: 'completed_1to1_classes', width: 16 }, { header: 'Completed 3:1 sessions', key: 'completed_3to1_sessions', width: 16 },
    { header: 'Teacher absences', key: 'teacher_absences', width: 13 }, { header: 'Active students', key: 'active_enrollments', width: 13 },
    { header: 'Parent class rating', key: 'class_rating', width: 14 }, { header: 'Course rating', key: 'course_rating', width: 12 }, { header: 'NPS', key: 'nps', width: 7 },
  ], data.teacher_workload.map(t => { const f = data.feedback.find(x => x.teacher_id === t.id) || {}; return { ...t, class_rating: f.class_rating, course_rating: f.course_rating, nps: f.nps }; }),
  'Counts used for the Regular / Freelance pay notices. Pay itself is not calculated in the app.');
  sheet(wb, 'Sales reps', [
    { header: 'Sales rep', key: 'name', width: 20 }, { header: 'Candidates added', key: 'candidates_added', width: 15 }, { header: 'Admissions', key: 'admissions', width: 11 },
    { header: 'Admitted fee value', key: 'admitted_fee_value', width: 16, money: true }, { header: 'Collected in month', key: 'collected_in_month', width: 16, money: true },
  ], data.by_sales_rep, 'Inputs for the sales incentive policy.');
  sheet(wb, 'Feedback', [
    { header: 'Date', key: 'day', width: 12 }, { header: 'Type', key: 'kind', width: 8 }, { header: 'Teacher', key: 'teacher', width: 18 },
    { header: 'Student', key: 'student_name', width: 22 }, { header: 'Course', key: 'course', width: 14 }, { header: 'Class ID', key: 'class_code', width: 11 },
    { header: 'Class ★', key: 'rating', width: 8 }, { header: 'Teacher ★', key: 'teacher_rating', width: 9 }, { header: 'Content ★', key: 'content_rating', width: 9 },
    { header: 'Progress ★', key: 'progress_rating', width: 9 }, { header: 'Recommend 0–10', key: 'nps', width: 13 }, { header: 'Continue', key: 'continue_choice', width: 9 },
    { header: 'Went well', key: 'tags', width: 26 }, { header: 'Comment', key: 'comment', width: 40 },
  ], answers);

  wb.eachSheet(s => { s.properties.tabColor = { argb: s.name === 'Summary' ? GREEN : SOFT }; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildWorkbook };
