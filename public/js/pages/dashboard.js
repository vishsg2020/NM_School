import { get, esc, inr, fmtDT, fmtDate, fmtTime, fmtMonth, pill, state, table } from '../core.js';

const metric = (label, value, href, tone = '') =>
  `<a class="metric ${tone}" href="${href}"><span class="metric-label">${esc(label)}</span><span class="metric-value">${esc(value)}</span></a>`;
const group = (title, items) => `<section class="metric-group" aria-label="${esc(title)}"><h2>${esc(title)}</h2>${items.join('')}</section>`;

function pretestTable(rows, showTeacher = true) {
  return table([
    { label: 'Lead', cell: r => esc(r.lead_id) },
    { label: 'Student', cell: r => `<a href="#/candidate/${r.id}">${esc(r.student_name)}</a>` },
    { label: 'Pre-test', cell: r => r.pretest_at ? esc(fmtDT(r.pretest_at)) : '<span class="muted">Not set</span>' },
    { label: 'Time', cell: r => pill(r.time_confirmation).__raw },
    ...(showTeacher ? [{ label: 'Teacher', cell: r => r.teacher_name ? esc(r.teacher_name) : pill('Unassigned', 'amber').__raw }] : []),
  ], rows, { empty: 'No upcoming pre-tests' });
}

export async function render(page) {
  const d = await get('/api/dashboard');
  const m = d.metrics;
  const today = d.today;
  const head = (sub) => `<div class="page-head"><div><h1>Good to see you, ${esc(state.me.name.split(' ')[0])}</h1><div class="sub">${esc(sub)}</div></div></div>`;

  if (d.role === 'manager') {
    page.innerHTML = head(`${fmtDate(today)} · figures for ${fmtMonth(d.month)} where marked`) + `
      <div class="metric-groups">
        ${group('Pre-tests', [
          metric('Scheduled', m.scheduled_pretests, '#/pretests?status=Scheduled'),
          metric('Time required', m.time_required_pretests, '#/pretests?status=Time%20Required', m.time_required_pretests ? 'attention' : ''),
          metric('No teacher assigned', m.unassigned_pretests, '#/pretests?teacher=unassigned', m.unassigned_pretests ? 'attention' : ''),
          metric('Results to review', m.unreviewed_results, '#/pretests?review=pending'),
          metric('Follow-ups due', m.followups_due, '#/pretests?followup=due', m.followups_due ? 'attention' : ''),
        ])}
        ${group('Admissions & students', [
          metric('Total students', m.total_students, '#/students'),
          metric('Active enrollments', m.active_enrollments, '#/students?status=active'),
          metric('New admissions this month', m.new_admissions_month, `#/students?admitted=${d.month}`),
          metric('Confirmed, awaiting setup', m.awaiting_setup, '#/admissions', m.awaiting_setup ? 'attention' : ''),
        ])}
        ${group('Fees', [
          metric('Collected this month', inr(m.fees_collected_month), `#/payments?status=Paid&date_from=${d.month}-01`),
          metric('Pending fees', inr(m.pending_fees), '#/payments?status=Pending'),
          metric('Students with pending payments', m.students_pending_payments, '#/payments?status=Pending'),
          metric('Overdue students', m.overdue_students, '#/payments?status=Overdue', m.overdue_students ? 'alert' : ''),
        ])}
        ${group('Classes', [
          metric('Classes today', m.classes_today, `#/classes?date=${today}`),
          metric('Past classes not yet updated', m.classes_needing_update, '#/classes?status=needs_update', m.classes_needing_update ? 'attention' : ''),
        ])}
      </div>
      <section class="panel"><h2>Upcoming pre-tests</h2>${pretestTable(d.upcoming_pretests)}</section>`;
    return;
  }

  if (d.role === 'sales') {
    page.innerHTML = head(fmtDate(today)) + `
      <div class="page-head"><div class="actions"><a class="btn primary" href="#/pretests?new=1">Add candidate</a></div></div>
      <div class="metric-groups">
        ${group('My leads', [
          metric('Candidates I own', m.my_candidates, `#/pretests?sales_rep=${state.me.id}`),
          metric(`Added in ${fmtMonth(d.month)}`, m.my_added_month, `#/pretests?sales_rep=${state.me.id}`),
          metric(`My admissions in ${fmtMonth(d.month)}`, m.my_admissions_month, `#/pretests?sales_rep=${state.me.id}&result=Confirmed`),
          metric('My follow-ups due', m.my_followups_due, `#/pretests?sales_rep=${state.me.id}&followup=due`, m.my_followups_due ? 'attention' : ''),
        ])}
        ${group('Pre-test queue', [
          metric('Scheduled', m.scheduled_pretests, '#/pretests?status=Scheduled'),
          metric('Time required', m.time_required_pretests, '#/pretests?status=Time%20Required', m.time_required_pretests ? 'attention' : ''),
          metric('Time not yet confirmed', m.not_confirmed, '#/pretests?confirmation=Not%20Confirmed', m.not_confirmed ? 'attention' : ''),
          metric('Follow-up', m.follow_up, '#/pretests?status=Follow-up'),
        ])}
      </div>
      <section class="panel"><h2>Upcoming pre-tests</h2>${pretestTable(d.upcoming_pretests)}</section>`;
    return;
  }

  // Teacher
  page.innerHTML = head(fmtDate(today)) + `
    <div class="metric-groups">
      ${group('My work', [
        metric('Classes today', m.classes_today, `#/classes?date=${today}`),
        metric('Past classes to update', m.classes_needing_update, '#/classes?status=needs_update', m.classes_needing_update ? 'attention' : ''),
        metric('Pre-tests awaiting my result', m.assigned_pretests, '#/pretests?result=none', m.assigned_pretests ? 'attention' : ''),
        metric('Active students', m.active_students, '#/students'),
        metric(`Classes completed in ${fmtMonth(d.month)}`, m.completed_month, `#/classes?status=Completed&date_from=${d.month}-01`),
      ])}
    </div>
    <div class="cols">
      <section class="panel"><h2>Today's classes</h2>
        ${table([
          { label: 'Time', cell: r => esc(fmtTime(r.scheduled_at.slice(11))) },
          { label: 'Student', cell: r => `<a href="#/classes?open=${r.id}">${esc(r.student_name)}</a><span class="sub">${esc(r.course)} · ${esc(r.format)}</span>` },
          { label: 'Status', cell: r => pill(r.status).__raw },
        ], d.today_classes, { empty: 'No classes today' })}
      </section>
      <section class="panel"><h2>My pre-tests</h2>${pretestTable(d.upcoming_pretests, false)}</section>
    </div>`;
}
