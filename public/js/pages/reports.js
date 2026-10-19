import { get, esc, html, raw, pill, inr, fmtDate, fmtMonth, table, todayLocal, starsText, drawer, stateBox, fmtStamp, fmtDT } from '../core.js';

/** Small accessible bar chart (SVG, no inline styles). series: [{key,label,alt}] */
function barChart(rows, series, { money = false } = {}) {
  const W = 560, H = 190, padL = 8, padB = 26, padT = 18;
  const max = Math.max(1, ...rows.flatMap(r => series.map(s => r[s.key])));
  const groupW = (W - padL) / rows.length;
  const barW = Math.min(28, (groupW - 12) / series.length);
  let bars = '';
  rows.forEach((r, i) => {
    const gx = padL + i * groupW + (groupW - barW * series.length) / 2;
    series.forEach((s, j) => {
      const v = r[s.key]; const h = Math.round((v / max) * (H - padB - padT));
      const x = gx + j * barW; const y = H - padB - h;
      bars += `<rect class="${s.alt ? 'bar2' : 'bar'}" x="${x}" y="${y}" width="${barW - 3}" height="${Math.max(h, v ? 2 : 0)}" rx="2"></rect>`;
      if (v) bars += `<text x="${x + (barW - 3) / 2}" y="${y - 4}" text-anchor="middle">${esc(money ? Math.round(v / 1000) + 'k' : v)}</text>`;
    });
    bars += `<text x="${padL + i * groupW + groupW / 2}" y="${H - 8}" text-anchor="middle">${esc(fmtMonth(r.month).slice(0, 3))}</text>`;
  });
  const desc = rows.map(r => `${fmtMonth(r.month)}: ${series.map(s => `${s.label} ${money ? inr(r[s.key]) : r[s.key]}`).join(', ')}`).join('; ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(desc)}">${bars}</svg>
    <div class="legend">${series.map(s => `<span><i class="${s.alt ? 'alt-t' : ''}"></i>${esc(s.label)}</span>`).join('')}</div>`;
}

export async function render(page, { query }) {
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : todayLocal().slice(0, 7);
  const r = await get('/api/reports?month=' + month);
  page.innerHTML = html`<div class="page-head"><div><h1>Reports</h1><div class="sub">${fmtMonth(month)} · every figure comes from the records linked on the other pages</div></div>
    <div class="actions"><label class="sr-only" for="rep-m">Month</label><input id="rep-m" type="month" value="${month}"></div></div>
    <div class="metric-groups">
      <section class="metric-group"><h2>${fmtMonth(month)}</h2>
        <a class="metric" href="#/students?admitted=${month}"><span class="metric-label">Admissions</span><span class="metric-value">${r.totals.admissions_in_month}</span></a>
        <a class="metric" href="#/payments?status=Paid&date_from=${month}-01&date_to=${month}-31"><span class="metric-label">Fees collected</span><span class="metric-value">${inr(r.totals.collected_in_month)}</span></a></section>
      <section class="metric-group"><h2>Outstanding now</h2>
        <a class="metric" href="#/payments?status=Pending"><span class="metric-label">Pending fees</span><span class="metric-value">${inr(r.totals.pending_total)}</span></a>
        <a class="metric alert" href="#/payments?status=Overdue"><span class="metric-label">Overdue fees</span><span class="metric-value">${inr(r.totals.overdue_total)}</span></a></section>
    </div>
    <div class="cols">
      <section class="panel"><h2>Admissions trend</h2>${raw(barChart(r.admissions_trend, [{ key: 'candidates_added', label: 'Candidates added' }, { key: 'admissions', label: 'Admissions', alt: true }]))}</section>
      <section class="panel"><h2>Class delivery</h2>${raw(barChart(r.delivery_trend, [{ key: 'completed', label: 'Completed classes' }, { key: 'cancelled', label: 'Cancelled or absent', alt: true }]))}</section>
    </div>
    <p></p>
    <section class="panel"><h2>Feedback from parents</h2>
      <p class="small muted">Class ratings come from the after-class links; course ratings and “recommend” (NPS: % 9–10 minus % 0–6) from the end-of-course form. Click a teacher to read comments.</p>
      ${raw(table([
        { label: 'Teacher', cell: t => `<button class="linkbtn" type="button" data-fb-teacher="${t.teacher_id}">${esc(t.name)}</button>` },
        { label: 'Class rating', cls: 'num', cell: t => (t.class_rating ? `${starsText(t.class_rating)} ${t.class_rating}` : '—') },
        { label: 'Responses / links', cls: 'num', cell: t => `${t.class_responses} / ${t.class_links}` },
        { label: 'Course rating', cls: 'num', cell: t => (t.course_rating ? `${starsText(t.course_rating)} ${t.course_rating}` : '—') },
        { label: 'Recommend (NPS)', cls: 'num', cell: t => (t.nps === null ? '—' : (t.nps > 0 ? '+' : '') + t.nps) },
      ], r.feedback, { empty: 'No feedback this month yet', emptyHint: ' Send the feedback link after a class is completed.' }))}
    </section>
    <p></p>
    <section class="panel"><h2>Teacher workload and utilisation</h2>
      <p class="small muted">Sessions are teacher time slots: a 3:1 group counts once. Utilisation = planned sessions ÷ monthly capacity.</p>
      ${raw(table([
        { label: 'Teacher', cell: t => `${esc(t.name)}<span class="sub">${esc(t.employment_type)}${t.active ? '' : ' · inactive'}</span>` },
        { label: 'Weekly hours', cls: 'num', cell: t => esc(t.weekly_working_hours) },
        { label: 'Planned sessions', cls: 'num', cell: t => esc(t.planned_sessions) },
        { label: 'Capacity', cls: 'num', cell: t => esc(t.monthly_capacity ?? '—') },
        { label: 'Utilisation', cls: 'num', cell: t => (t.utilization_pct == null ? '—' : t.utilization_pct > 100 ? pill(t.utilization_pct + '%', 'red').__raw : esc(t.utilization_pct + '%')) },
        { label: 'Active students', cls: 'num', cell: t => esc(t.active_enrollments) },
      ], r.teacher_workload, { empty: 'No teachers yet' }))}
    </section>
    <section class="panel"><h2>Pay inputs for ${fmtMonth(month)}</h2>
      <p class="small muted">Counts used by the Regular/Freelance teacher notices and the sales incentive policy. Pay itself is not calculated in this system.</p>
      <div class="cols">
        <div>${raw(table([
          { label: 'Teacher', cell: t => `${esc(t.name)}<span class="sub">${esc(t.employment_type)}</span>` },
          { label: 'Completed 1:1 classes', cls: 'num', cell: t => esc(t.completed_1to1_classes) },
          { label: 'Completed 3:1 sessions', cls: 'num', cell: t => esc(t.completed_3to1_sessions) },
          { label: 'Teacher absences', cls: 'num', cell: t => esc(t.teacher_absences) },
        ], r.teacher_workload, { empty: 'No teachers' }))}</div>
        <div>${raw(table([
          { label: 'Sales rep', cell: s => esc(s.name) },
          { label: 'Collected in month', cls: 'num', cell: s => esc(inr(s.collected_in_month)) },
        ], r.by_sales_rep, { empty: 'No sales activity' }))}</div>
      </div>
    </section>
    <section class="panel"><h2>Admissions by Assigned Sales Representative</h2>
      ${raw(table([
        { label: 'Sales rep', cell: s => esc(s.name) },
        { label: 'Candidates added', cls: 'num', cell: s => esc(s.candidates_added) },
        { label: 'Admissions', cls: 'num', cell: s => esc(s.admissions) },
        { label: 'Admitted fee value', cls: 'num', cell: s => esc(inr(s.admitted_fee_value)) },
        { label: 'Collected in month', cls: 'num', cell: s => esc(inr(s.collected_in_month)) },
      ], r.by_sales_rep, { empty: 'No sales activity this month' }))}
    </section>
    <div class="cols">
      <section class="panel"><h2>Course mix</h2>${raw(table([
        { label: 'Course', cell: c => esc(c.course) }, { label: 'Mode', cell: c => esc(c.class_mode) },
        { label: 'Enrollments', cls: 'num', cell: c => esc(c.enrollments) }, { label: 'Active', cls: 'num', cell: c => esc(c.active) },
      ], r.course_mix, { empty: 'No enrollments yet' }))}</section>
      <section class="panel"><h2>Remaining classes (active)</h2>${raw(table([
        { label: 'Student', cell: e => `<a href="#/student/${e.student_id}">${esc(e.student_name)}</a><span class="sub">${esc(e.course)} · ${esc(e.teacher_name)}</span>` },
        { label: 'Remaining', cls: 'num', cell: e => (e.remaining <= 3 ? pill(String(e.remaining), 'amber').__raw : esc(e.remaining)) + `<span class="sub">of ${e.total_classes}</span>` },
        { label: 'Booked ahead', cls: 'num', cell: e => esc(e.scheduled_ahead) },
      ], r.remaining_classes, { empty: 'No active enrollments' }))}</section>
    </div>
    <p></p>
    <section class="panel"><h2>Payment follow-up</h2>${raw(table([
      { label: 'Student', cell: p => `<a href="#/student/${p.student_id}">${esc(p.student_name)}</a><span class="sub">${esc(p.lead_id)}</span>` },
      { label: 'Stage', cell: p => esc(p.stage) },
      { label: 'Amount', cls: 'num', cell: p => esc(inr(p.amount)) },
      { label: 'Due', cell: p => esc(fmtDate(p.due_date)) + (p.overdue ? `<span class="sub">${pill(p.days_overdue + ' days overdue', 'red').__raw}</span>` : '') },
      { label: 'Contact', cell: p => `${esc(p.parent_name || '')}<span class="sub">${esc(p.phone)}</span>` },
      { label: 'Sales rep', cell: p => esc(p.sales_rep_name) },
    ], r.payment_followup, { empty: 'No pending payments' }))}</section>`;
  page.querySelectorAll('[data-fb-teacher]').forEach(b => b.addEventListener('click', () => feedbackDrawer(b.dataset.fbTeacher, b.textContent, month)));
  page.querySelector('#rep-m').addEventListener('change', e => { if (e.target.value) location.hash = '#/reports?month=' + e.target.value; });
}

function feedbackDrawer(teacherId, name, month) {
  drawer({
    title: `Feedback · ${name} · ${fmtMonth(month)}`,
    body: `<div id="fb-list">${stateBox('loading')}</div>`,
    onMount: async d => {
      const list = await get(`/api/feedback?teacher=${teacherId}&month=${month}`);
      d.querySelector('#fb-list').innerHTML = list.length ? list.map(f => `<div class="fb-box">
        <div class="q">${f.kind === 'class' ? `Class ${esc(f.class_code)} · ${esc(fmtDT(f.scheduled_at))}` : `Course feedback · ${esc(f.course)}`} · <a href="#/student/${f.student_id}">${esc(f.student_name)}</a> · ${esc(fmtStamp(f.submitted_at))}</div>
        ${f.kind === 'class' ? `${starsText(f.rating)}${f.tags ? ' · ' + esc(f.tags) : ''}`
          : `Teacher ${starsText(f.teacher_rating)} · Course ${starsText(f.content_rating)} · Progress ${starsText(f.progress_rating)} · Recommend ${f.nps}/10${f.continue_choice ? ' · Continue: ' + esc(f.continue_choice) : ''}`}
        ${f.comment ? `<div>“${esc(f.comment)}”</div>` : ''}</div>`).join('') : stateBox('empty', 'No answers this month');
    },
  });
}
