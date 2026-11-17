import { get, esc, inr, fmtDT, fmtDate, fmtTime, fmtMonth, pill, state, table, html, raw, options, opt, teacherOptions, parseHash, setQuery, qs, addDays, stateBox } from '../core.js';
import { columnChart, barList } from '../charts.js';

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
      <div id="trends"></div>
      <section class="panel top-gap"><h2>Upcoming pre-tests</h2>${pretestTable(d.upcoming_pretests)}</section>`;
    await renderTrends(page.querySelector('#trends'), today);
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
        metric(`My parent rating in ${fmtMonth(d.month)}`, m.my_rating_month ? `★ ${m.my_rating_month} (${m.my_ratings_month})` : '—', '#/classes?status=Completed'),
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

// ---------- Trends (Manager only; the API checks the role too) ----------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RANGES = [['month', 'This month'], ['last_month', 'Last month'], ['3m', 'Last 3 months'], ['12m', 'Last 12 months'], ['all', 'All time'], ['custom', 'Custom dates']];
const DEFAULT_RANGE = '12m';
const monthStart = (date, back = 0) => { let [y, m] = date.split('-').map(Number); m -= back; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return `${y}-${String(m).padStart(2, '0')}-01`; };
const monthEnd = (date, back = 0) => addDays(monthStart(date, back - 1), -1);
/** Whole months, so "This month" matches the Payments page's This month (1st to last day). */
function rangeDates(range, today, f) {
  if (range === 'month') return [monthStart(today), monthEnd(today)];
  if (range === 'last_month') return [monthStart(today, 1), monthEnd(today, 1)];
  if (range === '3m') return [monthStart(today, 2), monthEnd(today)];
  if (range === '12m') return [monthStart(today, 11), monthEnd(today)];
  if (range === 'custom') return [f.date_from || '', f.date_to || ''];
  return ['', ''];
}
const plural = (n, one, many = one + 's') => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
const narrowMq = window.matchMedia('(max-width: 700px)');

async function renderTrends(box, today) {
  const q = parseHash().query; const range = RANGES.some(r => r[0] === q.range) ? q.range : DEFAULT_RANGE;
  box.innerHTML = html`<div class="trend-title"><h2>Trends</h2><span class="muted small">Worked out from the records each time. Click a bar or figure to open the matching list.</span></div>
    <form class="filters" id="t-filters" aria-label="Chart filters">
      <div class="field"><label for="t-range">Period</label><select id="t-range" name="range">${raw(options(RANGES, range))}</select></div>
      <div class="field ${range === 'custom' ? '' : 'hidden'}" data-custom><label for="t-from">From</label><input id="t-from" name="date_from" type="date" value="${q.date_from || ''}"></div>
      <div class="field ${range === 'custom' ? '' : 'hidden'}" data-custom><label for="t-to">To</label><input id="t-to" name="date_to" type="date" value="${q.date_to || ''}"></div>
      <div class="field"><label for="t-group">Show by</label><select id="t-group" name="group">${raw(options([['day', 'Day'], ['week', 'Week'], ['month', 'Month']], q.group || '', 'Automatic'))}</select></div>
      <div class="field"><label for="t-teacher">Teacher</label><select id="t-teacher" name="teacher">${raw(opt('', 'All teachers', q.teacher || '') + teacherOptions(q.teacher || '', { activeOnly: false, blank: null }))}</select></div>
      <div class="field"><label for="t-rep">Sales rep</label><select id="t-rep" name="sales_rep">${raw(options(state.reps.map(r => [r.id, r.name]), q.sales_rep || '', 'Everyone'))}</select></div>
      <div class="field"><label for="t-format">Format</label><select id="t-format" name="format">${raw(options([['1:1', '1:1'], ['3:1', '3:1']], q.format || '', '1:1 and 3:1'))}</select></div>
    </form><div id="t-body" aria-live="polite">${raw(stateBox('loading'))}</div>`;
  const form = box.querySelector('#t-filters'); const body = box.querySelector('#t-body');
  let seq = 0; let last = null;

  const draw = () => {
    if (!last) return;
    const { t, f, from, to } = last; const tt = t.totals; const narrow = narrowMq.matches;
    const filt = { teacher: f.teacher, sales_rep: f.sales_rep, format: f.format };
    const span = { date_from: from, date_to: to };
    const link = (path, extra) => `#/${path}` + qs({ ...filt, ...extra });
    const pay = extra => link('payments', { status: 'Paid', ...span, ...extra });
    const studs = extra => link('students', { status: 'enrolled', admitted_from: from, admitted_to: to, ...extra });
    const classes = extra => link('classes', { view: 'list', status: 'Completed', ...span, ...extra });
    const day = d => fmtDate(d).slice(4); // without the weekday
    const rangeText = from || to ? `${from ? day(from) : 'start'} – ${to ? day(to) : 'today'}` : 'all time';

    // One bar per day / week / month; its link covers exactly that bucket, clipped to the period.
    const feeRow = r => {
      let label, sub = '', a, b;
      if (t.group === 'month') { const [y, m] = r.period.split('-').map(Number); label = MON[m - 1]; sub = String(y); a = r.period + '-01'; b = monthEnd(a); }
      else if (t.group === 'week') { const [, m, dd] = r.period.split('-').map(Number); label = `${dd} ${MON[m - 1]}`; a = r.period; b = addDays(r.period, 6); }
      else { const [, m, dd] = r.period.split('-').map(Number); label = String(dd); sub = MON[m - 1]; a = b = r.period; }
      if (from && a < from) a = from; if (to && b > to) b = to;
      const when = t.group === 'week' ? `Week of ${label}` : `${label} ${sub}`;
      return { label, sub, value: r.amount, tip: `${when}: ${inr(r.amount)} · ${plural(r.payments, 'payment')}`, href: r.payments ? link('payments', { status: 'Paid', date_from: a, date_to: b }) : '' };
    };
    const admRow = r => { const [y, m] = r.period.split('-').map(Number); const a = r.period + '-01';
      return { label: MON[m - 1], sub: narrow ? '' : String(y), value: r.admissions, tip: `${MON[m - 1]} ${y}: ${plural(r.admissions, 'admission')}`,
        href: r.admissions ? studs({ admitted_from: from && a < from ? from : a, admitted_to: to && monthEnd(a) > to ? to : monthEnd(a) }) : '' }; };
    const unit = { day: 'day', week: 'week', month: 'month' }[t.group];
    const kpi = (l, v, s2, href, cls = '') => `<a class="kpi ${cls}" href="${esc(href)}"><span class="l">${esc(l)}</span><span class="v">${esc(v)}</span><span class="s">${esc(s2)}</span></a>`;
    const resultCls = { Confirmed: '', 'Follow-up': 'amber', 'Not Interested': 'grey' };

    body.innerHTML = `
      <div class="kpis">
        ${kpi('Fees collected', inr(tt.fees), `${plural(tt.fees_count, 'payment')} · ${rangeText}`, pay())}
        ${kpi('New admissions', tt.admissions.toLocaleString('en-IN'), `${tt.admissions_1to1} × 1:1 · ${tt.admissions_3to1} × 3:1`, studs())}
        ${kpi('Classes completed', tt.sessions.toLocaleString('en-IN'), tt.class_records > tt.sessions ? `sessions · ${tt.class_records} student records (3:1 counts once)` : 'sessions', classes())}
        ${kpi('Pending fees', inr(tt.pending), tt.overdue ? `all still open · ${inr(tt.overdue)} overdue` : 'all still open · none overdue', link('payments', { status: 'Pending' }), tt.overdue ? 'bad' : '')}
      </div>
      <section class="panel"><div class="trend-head"><h2>Fees collected by ${unit}</h2><span class="muted small">Paid payments by the date received.</span></div>
        ${tt.fees ? columnChart(t.fees.map(feeRow), { title: `Fees collected by ${unit}`, narrow }) : '<p class="state small">No fees collected in this period.</p>'}</section>
      <div class="chart-grid">
        <section class="panel"><h2>Admissions by month</h2>
          ${tt.admissions ? columnChart(t.admissions.map(admRow), { money: false, title: 'Admissions by month', narrow, half: true }) : '<p class="state small">No admissions in this period.</p>'}</section>
        <section class="panel"><h2>Fees collected by sales rep</h2>
          ${barList(t.byRep.map(r => ({ label: r.label, value: r.amount, note: plural(r.payments, 'payment'), href: pay({ sales_rep: r.id }) })), { title: 'Fees collected by sales rep', narrow })}</section>
        <section class="panel"><h2>Classes completed by teacher</h2><p class="muted small">Sessions, credited to the teacher who took the class.</p>
          ${barList(t.byTeacher.map(r => ({ label: r.label, value: r.sessions, note: r.class_records > r.sessions ? `${r.class_records} student records` : '', href: classes({ teacher: r.id }) })), { money: false, title: 'Classes completed by teacher', narrow })}</section>
        <section class="panel"><h2>Pre-tests by result</h2><p class="muted small">By the day the result was entered.${t.format_ignored_for_pretests ? ' The format filter does not apply to pre-tests.' : ''}</p>
          ${t.totals.pretest_results ? barList(t.byResult.map(r => ({ label: r.label, value: r.n, cls: resultCls[r.label], href: r.n ? link('pretests', { result: r.label, result_from: from, result_to: to, format: '' }) : '' })), { money: false, title: 'Pre-tests by result', narrow }) : '<p class="state small">No results entered in this period.</p>'}</section>
        <section class="panel"><h2>Pending and overdue fees</h2><p class="muted small">Everything still unpaid, whatever the period.</p>
          ${tt.pending ? barList(t.open.map(o => ({ label: o.label, value: o.amount, note: plural(o.payments, 'payment'), cls: o.key === 'overdue' ? 'red' : 'amber',
            href: o.key === 'overdue' ? link('payments', { status: 'Overdue' }) : link('payments', { status: 'Pending', date_from: t.today }) })), { title: 'Pending and overdue fees', narrow }) : '<p class="state small">Nothing is pending.</p>'}</section>
      </div>`;
  };

  const load = async () => {
    const f = Object.fromEntries(new FormData(form)); const mine = ++seq;
    box.querySelectorAll('[data-custom]').forEach(el => el.classList.toggle('hidden', f.range !== 'custom'));
    const [from, to] = rangeDates(f.range, today, f);
    // Keep the choices in the address so Back and refresh keep them.
    setQuery({ ...f, range: f.range === DEFAULT_RANGE ? '' : f.range, date_from: f.range === 'custom' ? f.date_from : '', date_to: f.range === 'custom' ? f.date_to : '' });
    if (f.range === 'custom' && from && to && from > to) { body.innerHTML = '<div class="notice error">The From date is after the To date.</div>'; return; }
    let t;
    try { t = await get('/api/dashboard/trends' + qs({ date_from: from, date_to: to, group: f.group, teacher: f.teacher, sales_rep: f.sales_rep, format: f.format })); }
    catch (e) { if (mine === seq) body.innerHTML = `<div class="notice error">${esc(e.message)}</div>`; return; }
    if (mine !== seq) return; // a newer choice was made while this was loading
    last = { t, f, from, to }; draw();
  };
  form.addEventListener('change', load);
  form.addEventListener('submit', e => e.preventDefault());
  // Phone and desktop use different chart sizes; redraw when the width crosses the line.
  const onWidth = () => { if (box.isConnected) draw(); else narrowMq.removeEventListener('change', onWidth); };
  narrowMq.addEventListener('change', onWidth);
  await load();
}
