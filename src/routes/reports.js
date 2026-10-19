'use strict';
const { requireRole } = require('../auth');
const { today, thisMonth } = require('../util');

function monthsBack(n, from = thisMonth()) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  for (let i = 0; i < n; i++) {
    out.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m--; if (m === 0) { m = 12; y--; }
  }
  return out;
}

module.exports = (app, { db }) => {
  const one = (sql, p = {}) => db.get(sql, p);
  /** Runs several single-value queries in one round trip. Each SQL selects one value aliased n. */
  const many = async (map, p = {}) => {
    const cols = Object.entries(map).map(([k, sql]) => `(${sql.replace(/\s+n\s+FROM/, ' FROM')}) AS "${k}"`);
    return db.get(`SELECT ${cols.join(',\n')}`, p);
  };

  app.get('/api/dashboard', async (req, res) => {
    const t = today(); const month = thisMonth();
    const role = req.user.role;

    if (role === 'manager') {
      const m = await many({
        total_students: 'SELECT COUNT(*) n FROM students',
        active_enrollments: `SELECT COUNT(*) n FROM enrollments WHERE status='Active'`,
        new_admissions_month: `SELECT COUNT(*) n FROM enrollments WHERE substr(admission_date,1,7) = @month`,
        awaiting_setup: `SELECT COUNT(*) n FROM students s JOIN pretest_results pr ON pr.candidate_id = s.candidate_id
          AND pr.admission_status='Confirmed' WHERE NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id)`,
        scheduled_pretests: `SELECT COUNT(*) n FROM candidates WHERE status = 'Scheduled'`,
        time_required_pretests: `SELECT COUNT(*) n FROM candidates WHERE status = 'Time Required'`,
        unassigned_pretests: `SELECT COUNT(*) n FROM candidates WHERE pretest_teacher_id IS NULL AND status IN ('Scheduled','Time Required','Follow-up','Needs Review')`,
        unreviewed_results: `SELECT COUNT(*) n FROM pretest_results WHERE reviewed_at IS NULL`,
        classes_today: `SELECT COUNT(*) n FROM classes WHERE substr(scheduled_at,1,10) = @t AND status NOT IN ('Cancelled','Rescheduled')`,
        classes_needing_update: `SELECT COUNT(*) n FROM classes WHERE status='Scheduled' AND substr(scheduled_at,1,10) < @t`,
        fees_collected_month: `SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status='Paid' AND substr(date,1,7) = @month`,
        fees_collected_total: `SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status='Paid'`,
        pending_fees: `SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status='Pending'`,
        overdue_fees: `SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status='Pending' AND date < @t`,
        students_pending_payments: `SELECT COUNT(DISTINCT e.student_id) n FROM payments p JOIN enrollments e ON e.id = p.enrollment_id WHERE p.status='Pending'`,
        overdue_students: `SELECT COUNT(DISTINCT e.student_id) n FROM payments p JOIN enrollments e ON e.id = p.enrollment_id WHERE p.status='Pending' AND p.date < @t`,
      }, { month, t });
      const upcoming_pretests = (await db.all(`SELECT c.id, c.lead_id, c.student_name, c.pretest_at, c.status, c.time_confirmation, t.name teacher_name
        FROM candidates c LEFT JOIN teachers t ON t.id = c.pretest_teacher_id
        WHERE c.status IN ('Scheduled','Follow-up') AND c.pretest_at >= @t ORDER BY c.pretest_at LIMIT 8`, { t }));
      return res.json({ role, today: t, month, metrics: m, upcoming_pretests });
    }

    if (role === 'sales') {
      const me = req.user.id;
      const metrics = await many({
        my_candidates: `SELECT COUNT(*) n FROM candidates WHERE sales_rep_id = @me`,
        my_added_month: `SELECT COUNT(*) n FROM candidates WHERE sales_rep_id = @me AND substr(created_at,1,7) = @month`,
        scheduled_pretests: `SELECT COUNT(*) n FROM candidates WHERE status = 'Scheduled'`,
        time_required_pretests: `SELECT COUNT(*) n FROM candidates WHERE status = 'Time Required'`,
        not_confirmed: `SELECT COUNT(*) n FROM candidates WHERE status IN ('Scheduled','Follow-up') AND time_confirmation <> 'Confirmed'`,
        follow_up: `SELECT COUNT(*) n FROM candidates WHERE status = 'Follow-up'`,
        my_admissions_month: `SELECT COUNT(*) n FROM enrollments WHERE sales_rep_id = @me AND substr(admission_date,1,7) = @month`,
      }, { me, month });
      const upcoming_pretests = (await db.all(`SELECT c.id, c.lead_id, c.student_name, c.pretest_at, c.status, c.time_confirmation, t.name teacher_name
        FROM candidates c LEFT JOIN teachers t ON t.id = c.pretest_teacher_id
        WHERE c.status IN ('Scheduled','Follow-up') AND c.pretest_at >= @t ORDER BY c.pretest_at LIMIT 10`, { t }));
      return res.json({ role, today: t, month, metrics, upcoming_pretests });
    }

    // Teacher: assigned work only.
    const tid = req.user.teacher_id;
    const metrics = await many({
      classes_today: `SELECT COUNT(*) n FROM classes WHERE teacher_id=@tid AND substr(scheduled_at,1,10)=@t AND status NOT IN ('Cancelled','Rescheduled')`,
      classes_needing_update: `SELECT COUNT(*) n FROM classes WHERE teacher_id=@tid AND status='Scheduled' AND substr(scheduled_at,1,10) < @t`,
      assigned_pretests: `SELECT COUNT(*) n FROM candidates c WHERE pretest_teacher_id=@tid AND status IN ('Scheduled','Time Required','Follow-up','Needs Review')
        AND NOT EXISTS (SELECT 1 FROM pretest_results r WHERE r.candidate_id = c.id)`,
      active_students: `SELECT COUNT(*) n FROM enrollments WHERE teacher_id=@tid AND status='Active'`,
      completed_month: `SELECT COUNT(*) n FROM classes WHERE teacher_id=@tid AND counted=1 AND substr(scheduled_at,1,7)=@month`,
    }, { tid, t, month });
    const today_classes = (await db.all(`SELECT cl.id, cl.class_code, cl.scheduled_at, cl.duration_min, cl.format, cl.status, c.student_name, e.course
      FROM classes cl JOIN enrollments e ON e.id = cl.enrollment_id JOIN students s ON s.id = e.student_id JOIN candidates c ON c.id = s.candidate_id
      WHERE cl.teacher_id=@tid AND substr(cl.scheduled_at,1,10)=@t AND cl.status NOT IN ('Rescheduled') ORDER BY cl.scheduled_at`, { tid, t }));
    const upcoming_pretests = (await db.all(`SELECT c.id, c.lead_id, c.student_name, c.pretest_at, c.status, c.time_confirmation
      FROM candidates c WHERE pretest_teacher_id=@tid AND status IN ('Scheduled','Follow-up','Time Required')
      AND NOT EXISTS (SELECT 1 FROM pretest_results r WHERE r.candidate_id = c.id) ORDER BY c.pretest_at LIMIT 10`, { tid }));
    res.json({ role, today: t, month, metrics, today_classes, upcoming_pretests });
  });

  app.get('/api/reports', requireRole('manager'), async (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : thisMonth();
    const t = today();
    const months = monthsBack(6, month);

    const byMonth = async sql => {
      const rows = await db.all(sql, { months });
      return Object.fromEntries(rows.map(r => [r.m, r.n]));
    };
    const MONTH_IN = col => `substr(${col},1,7) = ANY(CAST(@months AS text[]))`;
    const [adm, cand, done, canc, coll] = [
      await byMonth(`SELECT substr(admission_date,1,7) m, COUNT(*) n FROM enrollments WHERE ${MONTH_IN('admission_date')} GROUP BY 1`),
      await byMonth(`SELECT substr(created_at,1,7) m, COUNT(*) n FROM candidates WHERE ${MONTH_IN('created_at')} GROUP BY 1`),
      await byMonth(`SELECT substr(scheduled_at,1,7) m, COUNT(*) n FROM classes WHERE counted=1 AND ${MONTH_IN('scheduled_at')} GROUP BY 1`),
      await byMonth(`SELECT substr(scheduled_at,1,7) m, COUNT(*) n FROM classes WHERE status IN ('Cancelled','Teacher Absent','Student Absent') AND ${MONTH_IN('scheduled_at')} GROUP BY 1`),
      await byMonth(`SELECT substr(date,1,7) m, COALESCE(SUM(amount),0) n FROM payments WHERE status='Paid' AND ${MONTH_IN('date')} GROUP BY 1`),
    ];
    const admissions_trend = months.map(m => ({ month: m, admissions: adm[m] || 0, candidates_added: cand[m] || 0 }));
    const delivery_trend = months.map(m => ({ month: m, completed: done[m] || 0, cancelled: canc[m] || 0, collected: coll[m] || 0 }));

    // Workload: a "session" = one teacher time slot (a 3:1 group with 3 students = 1 session).
    let teacher_workload = (await db.all(`
      SELECT t.id, t.name, t.active, t.employment_type, t.monthly_capacity,
        (SELECT COUNT(DISTINCT scheduled_at) FROM classes WHERE teacher_id=t.id AND substr(scheduled_at,1,7)=@month AND status NOT IN ('Cancelled','Rescheduled')) AS planned_sessions,
        (SELECT COUNT(*) FROM classes WHERE teacher_id=t.id AND format='1:1' AND counted=1 AND substr(scheduled_at,1,7)=@month) AS completed_1to1_classes,
        (SELECT COUNT(DISTINCT scheduled_at) FROM classes WHERE teacher_id=t.id AND format='3:1' AND counted=1 AND substr(scheduled_at,1,7)=@month) AS completed_3to1_sessions,
        (SELECT COUNT(*) FROM classes WHERE teacher_id=t.id AND status='Teacher Absent' AND substr(scheduled_at,1,7)=@month) AS teacher_absences,
        (SELECT COUNT(*) FROM enrollments WHERE teacher_id=t.id AND status='Active') AS active_enrollments
      FROM teachers t ORDER BY t.active DESC, t.name`, { month }));
    const allHours = await db.all('SELECT teacher_id, start_time, end_time FROM teacher_hours');
    teacher_workload = teacher_workload.map(r => {
        const hours = allHours.filter(h => h.teacher_id === r.id);
        const weeklyMinutes = hours.reduce((s, h) => s + (toMin(h.end_time) - toMin(h.start_time)), 0);
        return {
          ...r,
          weekly_working_hours: Math.round(weeklyMinutes / 6) / 10,
          utilization_pct: r.monthly_capacity ? Math.round((r.planned_sessions / r.monthly_capacity) * 100) : null,
        };
      });

    const course_mix = (await db.all(`SELECT course, class_mode, COUNT(*) AS enrollments,
        SUM(CASE WHEN status='Active' THEN 1 ELSE 0 END) AS active
      FROM enrollments GROUP BY course, class_mode ORDER BY course, class_mode`));

    const payment_followup = (await db.all(`
      SELECT p.id, p.stage, p.amount, p.date AS due_date, (p.date < @t) AS overdue, (CAST(@t AS date) - CAST(p.date AS date)) AS days_overdue,
             e.id AS enrollment_id, e.student_id, c.student_name, c.parent_name, c.phone, c.lead_id, r.name AS sales_rep_name
      FROM payments p JOIN enrollments e ON e.id = p.enrollment_id JOIN students s ON s.id = e.student_id
      JOIN candidates c ON c.id = s.candidate_id JOIN users r ON r.id = e.sales_rep_id
      WHERE p.status = 'Pending' ORDER BY p.date`, { t }));

    const remaining_classes = (await db.all(`
      SELECT e.id, e.student_id, c.student_name, e.course, e.class_mode, tt.name AS teacher_name, e.total_classes, e.completed_classes,
             (e.total_classes - e.completed_classes) AS remaining,
             (SELECT COUNT(*) FROM classes x WHERE x.enrollment_id = e.id AND x.status='Scheduled') AS scheduled_ahead
      FROM enrollments e JOIN students s ON s.id = e.student_id JOIN candidates c ON c.id = s.candidate_id
      JOIN teachers tt ON tt.id = e.teacher_id WHERE e.status = 'Active' ORDER BY remaining ASC`));

    // Attribution: admissions in the month by Assigned Sales Representative, plus collections in the month
    // (collected = Paid payments whose received date falls in the month, for that rep's admissions).
    const by_sales_rep = (await db.all(`
      SELECT u.id, u.name, u.role,
        (SELECT COUNT(*) FROM candidates c WHERE c.sales_rep_id=u.id AND substr(c.created_at,1,7)=@month) AS candidates_added,
        (SELECT COUNT(*) FROM enrollments e WHERE e.sales_rep_id=u.id AND substr(e.admission_date,1,7)=@month) AS admissions,
        (SELECT COALESCE(SUM(e.total_fee),0) FROM enrollments e WHERE e.sales_rep_id=u.id AND substr(e.admission_date,1,7)=@month) AS admitted_fee_value,
        (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN enrollments e ON e.id=p.enrollment_id
           WHERE e.sales_rep_id=u.id AND p.status='Paid' AND substr(p.date,1,7)=@month) AS collected_in_month
      FROM users u WHERE u.role IN ('sales','manager') ORDER BY collected_in_month DESC, u.name`, { month }))
      .filter(r => r.candidates_added || r.admissions || r.collected_in_month || r.role === 'sales');

    const totals = await many({
      collected_in_month: `SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status='Paid' AND substr(date,1,7)=@month`,
      admissions_in_month: `SELECT COUNT(*) n FROM enrollments WHERE substr(admission_date,1,7)=@month`,
      pending_total: `SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status='Pending'`,
      overdue_total: `SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status='Pending' AND date < @t`,
    }, { month, t });
    res.json({ month, today: t, totals, admissions_trend, delivery_trend, teacher_workload, course_mix, payment_followup, remaining_classes, by_sales_rep });
  });
};

function toMin(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); }
module.exports.monthsBack = monthsBack;
