'use strict';
// Rules shared by admissions, classes and the student page: end dates with make-up classes, and missed-class charges.
const { projectDates } = require('./util');

// Missed classes that need a make-up at the end of the course (the package class was not used).
const MAKEUP_STATUSES = ['Student Absent', 'Teacher Absent'];
// Terms on the parent page: up to 2 misses without notice are free per course; each further one is chargeable.
const FREE_MISSES = 2;

/** End date of the course: the weekly slot projected for the package plus one make-up per missed class. */
function endDateFor(e, makeups = 0) {
  if (!e.slot_days || !e.start_date) return null;
  return projectDates(e.start_date, e.slot_days.split(',').map(Number), e.total_classes + makeups).at(-1) || null;
}

/** Recalculates and saves an enrollment's end date (call inside the transaction that changed its classes). */
async function refreshEndDate(t, enrollmentId) {
  const e = await t.get('SELECT id, slot_days, start_date, total_classes, end_date FROM enrollments WHERE id = ?', [enrollmentId]);
  if (!e) return null;
  const n = (await t.get(`SELECT COUNT(*) AS n FROM classes WHERE enrollment_id = ? AND status IN ('Student Absent','Teacher Absent')`, [e.id])).n;
  const end = endDateFor(e, n);
  if (end !== e.end_date) await t.run('UPDATE enrollments SET end_date = ?, updated_at = now_iso() WHERE id = ?', [end, e.id]);
  return end;
}

/** Per-class rate for extra-class charges: total fee ÷ classes, whole rupees. */
const perClassRate = e => (e.total_classes ? Math.round(e.total_fee / e.total_classes) : 0);

/**
 * Missed-class summary for one enrollment.
 * classes: that enrollment's class rows; extras: its 'Extra' payments (with class_id).
 */
function missedSummary(e, classes, extras = []) {
  const absent = classes.filter(c => c.status === 'Student Absent').sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at) || a.id - b.id);
  let free = 0;
  const rows = absent.map(c => {
    let kind;
    if (c.absence_notice === 'Yes' || c.absence_notice === null || c.absence_notice === undefined) kind = c.absence_notice === 'Yes' ? 'notice' : 'unrecorded';
    else if (free < FREE_MISSES) { free++; kind = 'free'; }
    else kind = 'chargeable';
    const charge = extras.find(p => p.class_id === c.id) || null;
    return { class_id: c.id, class_code: c.class_code, scheduled_at: c.scheduled_at, kind, free_number: kind === 'free' ? free : null,
      charge: charge && { id: charge.id, amount: charge.amount, status: charge.status, date: charge.date } };
  });
  const chargeable = rows.filter(r => r.kind === 'chargeable');
  return {
    student_absent: absent.length,
    with_notice: rows.filter(r => r.kind === 'notice').length,
    without_notice: rows.filter(r => r.kind === 'free' || r.kind === 'chargeable').length,
    not_recorded: rows.filter(r => r.kind === 'unrecorded').length,
    free_allowed: FREE_MISSES, free_used: free,
    chargeable: chargeable.length,
    unbilled: chargeable.filter(r => !r.charge).map(r => r.class_id),
    teacher_absent: classes.filter(c => c.status === 'Teacher Absent').length,
    rate: perClassRate(e),
    rows,
  };
}

module.exports = { MAKEUP_STATUSES, FREE_MISSES, endDateFor, refreshEndDate, perClassRate, missedSummary };

/**
 * When a course's last class is completed and a renewal is waiting ('Upcoming'), the finished course becomes
 * Completed and the renewal becomes Active. Runs inside the class-completion transaction.
 */
async function activateRenewal(t, prevId, user, audit) {
  const prev = await t.get('SELECT * FROM enrollments WHERE id = ? FOR UPDATE', [prevId]);
  if (!prev || prev.completed_classes < prev.total_classes) return null;
  const next = await t.get(`SELECT * FROM enrollments WHERE renewal_of = ? AND status = 'Upcoming' FOR UPDATE`, [prevId]);
  if (!next) return null;
  if (prev.status === 'Active') {
    await t.run(`UPDATE enrollments SET status = 'Completed', updated_at = now_iso() WHERE id = ?`, [prev.id]);
    await audit(t, user, 'enrollment', prev.id, 'completed', { status: prev.status }, { status: 'Completed' }, 'Last class completed; renewal started');
  }
  await t.run(`UPDATE enrollments SET status = 'Active', updated_at = now_iso() WHERE id = ?`, [next.id]);
  await audit(t, user, 'enrollment', next.id, 'started', { status: 'Upcoming' }, { status: 'Active' }, 'Previous course finished');
  return next.id;
}
module.exports.activateRenewal = activateRenewal;
