'use strict';
const { requireRole } = require('../auth');
const { audit, history } = require('../audit');
const {
  bad, notFound, forbidden, conflict, str, int, oneOf, bool, isValidDate, isValidDateTime, isValidTime,
  weekdayOf, addMinutes, today,
} = require('../util');

const STATUSES = ['Scheduled', 'Completed', 'Cancelled', 'Student Absent', 'Teacher Absent', 'Rescheduled'];
const INACTIVE = `('Cancelled','Rescheduled')`;
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_DURATION = { '1:1': 30, '3:1': 40 };

const SELECT = `
  SELECT cl.*, t.name AS teacher_name, e.course, e.student_id, e.total_classes, e.completed_classes,
         (e.total_classes - e.completed_classes) AS remaining_classes, e.status AS enrollment_status,
         c.student_name, c.lead_id, rb.name AS recorded_by_name
  FROM classes cl
  JOIN teachers t ON t.id = cl.teacher_id
  JOIN enrollments e ON e.id = cl.enrollment_id
  JOIN students s ON s.id = e.student_id
  JOIN candidates c ON c.id = s.candidate_id
  LEFT JOIN users rb ON rb.id = cl.recorded_by`;

/**
 * Checks one proposed class. Returns { errors: [], warnings: [] }.
 * errors block saving; warnings need explicit acknowledgement.
 * `pending` lets a batch check against classes proposed earlier in the same batch.
 */
function checkSlot(db, { enrollment, teacher, start, duration, excludeId = 0, pending = [] }) {
  const errors = []; const warnings = [];
  const end = addMinutes(start, duration);
  const fmt = enrollment.class_mode;
  if (!teacher.active) errors.push(`${teacher.name} is inactive`);
  if (fmt === '1:1' && !teacher.supports_1to1) errors.push(`${teacher.name} is not configured for 1:1 classes`);
  if (fmt === '3:1' && !teacher.supports_3to1) errors.push(`${teacher.name} is not configured for 3:1 classes`);

  const rows = db.prepare(`SELECT cl.id, cl.enrollment_id, cl.teacher_id, cl.scheduled_at, cl.duration_min, cl.format, e.student_id
    FROM classes cl JOIN enrollments e ON e.id = cl.enrollment_id
    WHERE substr(cl.scheduled_at,1,10) = ? AND cl.status NOT IN ${INACTIVE} AND cl.id <> ?
      AND (cl.teacher_id = ? OR e.student_id = ?)`)
    .all(start.slice(0, 10), excludeId, teacher.id, enrollment.student_id);
  for (const p of pending) rows.push(p);

  const overlaps = r => r.scheduled_at < end && start < addMinutes(r.scheduled_at, r.duration_min);
  for (const r of rows.filter(overlaps)) {
    if (r.student_id === enrollment.student_id) { errors.push(`Student already has a class at ${r.scheduled_at.slice(11)} on ${r.scheduled_at.slice(0, 10)}`); break; }
  }
  const teacherOverlaps = rows.filter(r => r.teacher_id === teacher.id && overlaps(r) && r.student_id !== enrollment.student_id);
  if (teacherOverlaps.length) {
    if (fmt === '1:1') errors.push(`${teacher.name} already has a class overlapping ${start.slice(11)} on ${start.slice(0, 10)} (1:1 allows one student)`);
    else {
      const sameGroup = teacherOverlaps.every(r => r.format === '3:1' && r.scheduled_at === start && r.duration_min === duration);
      if (!sameGroup) errors.push(`${teacher.name} has a different class overlapping ${start.slice(11)} on ${start.slice(0, 10)}`);
      else if (teacherOverlaps.length >= 3) errors.push(`The 3:1 group at ${start.slice(11)} on ${start.slice(0, 10)} already has 3 students`);
    }
  }

  // Soft checks (configuration-based).
  const wd = weekdayOf(start); const st = start.slice(11); const et = end.slice(11);
  const crossesMidnight = end.slice(0, 10) !== start.slice(0, 10);
  const hours = db.prepare('SELECT * FROM teacher_hours WHERE teacher_id = ? AND weekday = ?').all(teacher.id, wd);
  if (crossesMidnight || !hours.some(h => h.start_time <= st && et <= h.end_time))
    warnings.push(`${DAY[wd]} ${st}–${et} is outside ${teacher.name}'s working hours`);
  const allSlots = db.prepare('SELECT COUNT(*) n FROM teacher_slots WHERE teacher_id = ?').get(teacher.id).n;
  if (allSlots) {
    const slots = db.prepare('SELECT * FROM teacher_slots WHERE teacher_id = ? AND weekday = ?').all(teacher.id, wd);
    if (!slots.some(s => s.start_time <= st && et <= s.end_time && (s.format === 'Any' || s.format === fmt)))
      warnings.push(`${DAY[wd]} ${st}–${et} is not inside one of ${teacher.name}'s ${fmt} availability slots`);
  }
  if (teacher.monthly_capacity != null) {
    const month = start.slice(0, 7);
    const joinsExistingGroup = fmt === '3:1' && teacherOverlaps.length > 0;
    const existing = db.prepare(`SELECT COUNT(*) n FROM (SELECT DISTINCT scheduled_at FROM classes
      WHERE teacher_id = ? AND substr(scheduled_at,1,7) = ? AND status NOT IN ${INACTIVE} AND id <> ?)`).get(teacher.id, month, excludeId).n;
    const pendingSessions = new Set(pending.filter(p => p.teacher_id === teacher.id && p.scheduled_at.slice(0, 7) === month).map(p => p.scheduled_at)).size;
    const total = existing + pendingSessions + (joinsExistingGroup ? 0 : 1);
    if (total > teacher.monthly_capacity)
      warnings.push(`${teacher.name} would have ${total} sessions in ${month}, above the configured monthly capacity of ${teacher.monthly_capacity}`);
  }
  if (start.slice(0, 10) < enrollment.start_date) warnings.push(`${start.slice(0, 10)} is before the enrollment start date (${enrollment.start_date})`);
  return { errors, warnings };
}

module.exports = (app, { db }) => {
  const getClass = id => db.prepare(`${SELECT} WHERE cl.id = ?`).get(id);
  const own = (user, cl) => user.role === 'manager' || (user.role === 'teacher' && cl.teacher_id === user.teacher_id);

  app.get('/api/classes', requireRole('manager', 'teacher'), (req, res) => {
    const q = req.query; const where = []; const p = {};
    if (req.user.role === 'teacher') { where.push('cl.teacher_id = @me'); p.me = req.user.teacher_id; }
    if (q.student) { where.push('e.student_id = @sid'); p.sid = Number(q.student); }
    if (q.teacher && req.user.role === 'manager') { where.push('cl.teacher_id = @tid'); p.tid = Number(q.teacher); }
    if (q.enrollment) { where.push('cl.enrollment_id = @eid'); p.eid = Number(q.enrollment); }
    if (q.status) {
      if (q.status === 'needs_update') { where.push(`cl.status = 'Scheduled' AND substr(cl.scheduled_at,1,10) < @today`); p.today = today(); }
      else if (STATUSES.includes(q.status)) { where.push('cl.status = @status'); p.status = q.status; }
    }
    if (q.date && isValidDate(q.date)) { where.push('substr(cl.scheduled_at,1,10) = @date'); p.date = q.date; }
    if (q.date_from && isValidDate(q.date_from)) { where.push('substr(cl.scheduled_at,1,10) >= @df'); p.df = q.date_from; }
    if (q.date_to && isValidDate(q.date_to)) { where.push('substr(cl.scheduled_at,1,10) <= @dt'); p.dt = q.date_to; }
    if (q.q) { where.push('(c.student_name LIKE @q OR cl.class_code LIKE @q OR c.lead_id LIKE @q)'); p.q = `%${q.q}%`; }
    const order = q.order === 'asc' ? 'ASC' : 'DESC';
    res.json(db.prepare(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY cl.scheduled_at ${order}, cl.id LIMIT 2000`).all(p));
  });

  app.get('/api/classes/:id', requireRole('manager', 'teacher'), (req, res) => {
    const cl = getClass(req.params.id);
    if (!cl || !own(req.user, cl)) throw notFound('Class');
    res.json({ ...cl, history: history(db, 'class', cl.id) });
  });

  function planFromBody(req) {
    const b = req.body;
    const enrollmentId = int(b.enrollment_id, { min: 1, required: true, name: 'Enrollment' });
    const enrollment = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(enrollmentId);
    if (!enrollment) throw notFound('Enrollment');
    if (req.user.role === 'teacher' && enrollment.teacher_id !== req.user.teacher_id) throw notFound('Enrollment');
    if (enrollment.status !== 'Active') throw bad(`Enrollment is ${enrollment.status}; classes can only be scheduled for Active enrollments`);
    let teacherId = enrollment.teacher_id;
    if (b.teacher_id && Number(b.teacher_id) !== enrollment.teacher_id) {
      if (req.user.role !== 'manager') throw forbidden();
      teacherId = int(b.teacher_id, { min: 1, name: 'Teacher' });
    }
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacherId);
    if (!teacher) throw bad('Teacher not found');
    const duration = int(b.duration_min ?? DEFAULT_DURATION[enrollment.class_mode], { min: 5, max: 240, name: 'Duration (minutes)' });

    let starts = [];
    if (b.scheduled_at) {
      if (!isValidDateTime(b.scheduled_at)) throw bad('Class date/time is not valid');
      starts = [b.scheduled_at];
    } else {
      if (!isValidDate(b.start_date)) throw bad('Choose a valid first date');
      if (!isValidTime(b.time)) throw bad('Choose a valid class time (HH:MM)');
      const days = Array.isArray(b.weekdays) ? b.weekdays.map(Number).filter(d => d >= 0 && d <= 6) : [];
      if (!days.length) throw bad('Choose at least one weekday');
      const count = int(b.count, { min: 1, max: 200, required: true, name: 'Number of classes' });
      let d = b.start_date;
      for (let guard = 0; starts.length < count && guard < 1500; guard++) {
        if (days.includes(weekdayOf(d))) starts.push(`${d}T${b.time}`);
        d = addMinutes(`${d}T00:00`, 1440).slice(0, 10);
      }
    }
    const upcoming = db.prepare(`SELECT COUNT(*) n FROM classes WHERE enrollment_id = ? AND status = 'Scheduled'`).get(enrollment.id).n;
    const results = []; const pending = [];
    for (const s of starts) {
      const r = checkSlot(db, { enrollment, teacher, start: s, duration, pending });
      results.push({ scheduled_at: s, ...r });
      pending.push({ id: -1, enrollment_id: enrollment.id, scheduled_at: s, duration_min: duration, format: enrollment.class_mode, student_id: enrollment.student_id, teacher_id: teacher.id });
    }
    const remaining = enrollment.total_classes - enrollment.completed_classes;
    const general = [];
    if (upcoming + starts.length > remaining)
      general.push(`This makes ${upcoming + starts.length} scheduled classes but only ${remaining} classes remain in the package`);
    return { enrollment, teacher, duration, results, general };
  }

  app.post('/api/classes/check', requireRole('manager', 'teacher'), (req, res) => {
    const { results, general } = planFromBody(req);
    res.json({ results, general });
  });

  app.post('/api/classes', requireRole('manager', 'teacher'), (req, res) => {
    const { enrollment, teacher, duration, results, general } = planFromBody(req);
    const errs = results.filter(r => r.errors.length);
    if (errs.length) throw conflict(`${errs.length} of ${results.length} class(es) cannot be scheduled`, { code: 'SCHEDULE_CONFLICT', results, general });
    const warns = results.some(r => r.warnings.length) || general.length;
    if (warns && !bool(req.body.acknowledge_warnings))
      throw conflict('Please review the scheduling warnings', { code: 'NEEDS_ACK', results, general });
    const ids = db.transaction(() => {
      const out = [];
      const ins = db.prepare(`INSERT INTO classes (class_code, enrollment_id, teacher_id, format, scheduled_at, duration_min, created_by)
        VALUES (?,?,?,?,?,?,?)`);
      for (const r of results) {
        const n = db.prepare('SELECT COALESCE(MAX(id),0)+1 n FROM classes').get().n;
        const x = ins.run('CL-' + String(n).padStart(6, '0'), enrollment.id, teacher.id, enrollment.class_mode, r.scheduled_at, duration, req.user.id);
        audit(db, req.user, 'class', x.lastInsertRowid, 'scheduled', null, { scheduled_at: r.scheduled_at, teacher_id: teacher.id, duration_min: duration },
          r.warnings.length ? 'Warnings acknowledged: ' + r.warnings.join('; ') : null);
        out.push(x.lastInsertRowid);
      }
      return out;
    })();
    res.status(201).json(ids.map(getClass));
  });

  // Update schedule and/or record class activity.
  app.patch('/api/classes/:id', requireRole('manager', 'teacher'), (req, res) => {
    const before = db.prepare('SELECT * FROM classes WHERE id = ?').get(req.params.id);
    if (!before || !own(req.user, before)) throw notFound('Class');
    const isMgr = req.user.role === 'manager';
    const b = req.body; const c = { ...before };
    const enrollment = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(before.enrollment_id);

    if (b.scheduled_at !== undefined || b.duration_min !== undefined) {
      if (before.status !== 'Scheduled') throw bad('Only Scheduled classes can be moved');
      if (b.scheduled_at !== undefined) {
        if (!isValidDateTime(b.scheduled_at)) throw bad('Class date/time is not valid');
        c.scheduled_at = b.scheduled_at;
      }
      if (b.duration_min !== undefined) c.duration_min = int(b.duration_min, { min: 5, max: 240, required: true, name: 'Duration' });
      const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(c.teacher_id);
      const r = checkSlot(db, { enrollment, teacher, start: c.scheduled_at, duration: c.duration_min, excludeId: before.id });
      if (r.errors.length) throw conflict(r.errors.join('; '), { code: 'SCHEDULE_CONFLICT', results: [{ scheduled_at: c.scheduled_at, ...r }] });
      if (r.warnings.length && !bool(b.acknowledge_warnings)) throw conflict('Please review the scheduling warnings', { code: 'NEEDS_ACK', results: [{ scheduled_at: c.scheduled_at, ...r }], general: [] });
    }
    for (const f of ['topics', 'homework', 'notes', 'progress']) if (b[f] !== undefined) c[f] = str(b[f], { name: f, max: 4000 });
    if (b.next_class_date !== undefined) {
      c.next_class_date = str(b.next_class_date, { name: 'Next class date', max: 10 });
      if (c.next_class_date && !isValidDate(c.next_class_date)) throw bad('Next class date is not valid');
    }
    if (b.attendance !== undefined) c.attendance = oneOf(b.attendance || null, ['Present', 'Late', 'Absent'], { name: 'Attendance' });
    if (b.status !== undefined) {
      c.status = oneOf(b.status, STATUSES, { required: true, name: 'Class status' });
      if (before.status === 'Completed' && c.status !== 'Completed' && !isMgr)
        throw bad('This class is already completed. Ask the Manager to correct its status.');
    }
    if (c.status === 'Completed') {
      if (!['Present', 'Late'].includes(c.attendance)) throw bad('A Completed class needs attendance Present or Late', { field: 'Attendance' });
      if (c.scheduled_at.slice(0, 10) > today()) throw bad('A class cannot be marked Completed before its date');
    }
    if (c.status === 'Student Absent' && !c.attendance) c.attendance = 'Absent';
    if (c.status === 'Student Absent' && c.attendance !== 'Absent') throw bad('Student Absent requires attendance Absent');
    if (c.status !== before.status || c.attendance !== before.attendance || c.topics !== before.topics) {
      c.recorded_by = req.user.id; c.recorded_at = new Date().toISOString();
    }

    db.transaction(() => {
      db.prepare(`UPDATE classes SET scheduled_at=@scheduled_at, duration_min=@duration_min, status=@status, attendance=@attendance,
        topics=@topics, homework=@homework, notes=@notes, progress=@progress, next_class_date=@next_class_date,
        recorded_by=@recorded_by, recorded_at=@recorded_at, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`).run(c);
      // Exactly-once accounting, guarded by the `counted` flag in the same transaction.
      if (c.status === 'Completed') {
        const flip = db.prepare('UPDATE classes SET counted = 1 WHERE id = ? AND counted = 0').run(c.id);
        if (flip.changes) {
          const inc = db.prepare(`UPDATE enrollments SET completed_classes = completed_classes + 1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND completed_classes < total_classes`).run(c.enrollment_id);
          if (!inc.changes) throw bad('All classes in this enrollment are already completed. Increase total classes first.');
        }
      } else {
        const flip = db.prepare('UPDATE classes SET counted = 0 WHERE id = ? AND counted = 1').run(c.id);
        if (flip.changes) db.prepare(`UPDATE enrollments SET completed_classes = completed_classes - 1,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(c.enrollment_id);
      }
      audit(db, req.user, 'class', c.id, before.status !== c.status ? `status_${c.status}` : 'updated', before, c, str(b.reason, { max: 500 }));
    })();
    res.json(getClass(c.id));
  });

  // Calendar: classes grouped into sessions, plus pre-tests and working hours.
  app.get('/api/calendar', requireRole('manager', 'teacher'), (req, res) => {
    const q = req.query;
    const from = isValidDate(q.from) ? q.from : today();
    const to = isValidDate(q.to) ? q.to : addMinutes(`${from}T00:00`, 6 * 1440).slice(0, 10);
    let teacherId = q.teacher ? Number(q.teacher) : null;
    if (req.user.role === 'teacher') teacherId = req.user.teacher_id;
    const tw = teacherId ? 'AND cl.teacher_id = @tid' : '';
    const classes = db.prepare(`${SELECT} WHERE substr(cl.scheduled_at,1,10) BETWEEN @from AND @to ${tw}
      AND cl.status <> 'Rescheduled' ORDER BY cl.scheduled_at, cl.teacher_id`).all({ from, to, tid: teacherId });
    const pretests = db.prepare(`SELECT c.id, c.lead_id, c.student_name, c.pretest_at, c.status, c.time_confirmation,
        c.pretest_teacher_id, t.name AS teacher_name
      FROM candidates c LEFT JOIN teachers t ON t.id = c.pretest_teacher_id
      WHERE c.pretest_at IS NOT NULL AND substr(c.pretest_at,1,10) BETWEEN @from AND @to AND c.status <> 'Cancelled'
      ${teacherId ? 'AND c.pretest_teacher_id = @tid' : ''} ORDER BY c.pretest_at`).all({ from, to, tid: teacherId });
    const hours = teacherId ? db.prepare('SELECT weekday, start_time, end_time FROM teacher_hours WHERE teacher_id = ? ORDER BY weekday, start_time').all(teacherId) : [];
    res.json({ from, to, classes, pretests, hours });
  });
};

module.exports.checkSlot = checkSlot;
