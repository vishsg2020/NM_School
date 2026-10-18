import { get, esc, html, raw, pill, inr, fmtDate, fmtDT, table, can, setQuery, options, stateBox, todayLocal, drawer } from '../core.js';
import { paymentForm, feePlanForm, enrollmentForm } from './admissions.js';
import { scheduleForm } from './classes.js';
import { historyList } from './pretests.js';

export async function renderList(page, { query }) {
  const f = { q: query.q || '', status: query.status || '', admitted: query.admitted || '' };
  page.innerHTML = html`<div class="page-head"><div><h1>Students</h1>
    <div class="sub">${can('teacher') ? 'Students you teach.' : 'Every child with a Confirmed pre-test.'}</div></div></div>
    <form class="filters" id="sf" role="search" aria-label="Filter students">
      <div class="field grow"><label for="s-q">Search</label><input id="s-q" name="q" type="search" value="${f.q}" placeholder="Student, parent, Lead ID"></div>
      ${raw(can('manager') ? `<div class="field"><label for="s-st">Enrollment</label><select id="s-st" name="status">${options([['active', 'Active enrollment'], ['awaiting', 'Awaiting admission setup']], f.status, 'All')}</select></div>` : '')}
      <input type="hidden" name="admitted" value="${f.admitted}">
      <button class="btn" type="button" id="s-clear">Clear filters</button>
    </form>
    ${raw(f.admitted ? `<p class="notice info">Showing students admitted in ${esc(f.admitted)}.</p>` : '')}
    <p class="result-count" id="s-count" aria-live="polite"></p>
    <div id="s-list">${raw(stateBox('loading'))}</div>`;
  const form = page.querySelector('#sf'); const list = page.querySelector('#s-list');
  let seq = 0;
  async function load() {
    const d = Object.fromEntries(new FormData(form)); setQuery(d);
    const my = ++seq;
    try {
      const rows = await get('/api/students?' + new URLSearchParams(Object.entries(d).filter(([, v]) => v)));
      if (my !== seq) return;
      page.querySelector('#s-count').textContent = `${rows.length} student${rows.length === 1 ? '' : 's'}`;
      list.innerHTML = table([
        { label: 'Student', cell: r => `<a href="#/student/${r.id}">${esc(r.student_name)}</a><span class="sub">${esc(r.lead_id)}${r.age ? ' · age ' + r.age : ''}</span>` },
        { label: 'Parent', cell: r => esc(r.parent_name || '—') + (r.phone ? `<span class="sub">${esc(r.phone)}</span>` : '') },
        { label: 'Course', cell: r => (r.course ? `${esc(r.course)}<span class="sub">${esc(r.class_mode)} · ${esc(r.teacher_name)}</span>` : pill('Awaiting setup', 'amber').__raw) },
        { label: 'Progress', cls: 'progress-cell', cell: r => (r.course ? `<progress max="${r.total_classes}" value="${r.completed_classes}" aria-label="Classes completed"></progress><span class="sub">${r.completed_classes} of ${r.total_classes} done · ${r.remaining_classes} left</span>` : '—') },
        { label: 'Status', cell: r => (r.enrollment_status ? pill(r.enrollment_status).__raw : '—') },
      ], rows, { empty: 'No students found', emptyHint: can('teacher') ? ' Students appear when the Manager assigns them to you.' : '' });
    } catch (e) { if (my === seq) list.innerHTML = stateBox('error', 'Could not load students', e.message); }
  }
  let t;
  form.addEventListener('input', e => { clearTimeout(t); t = setTimeout(load, e.target.type === 'search' ? 250 : 0); });
  form.addEventListener('submit', e => { e.preventDefault(); load(); });
  page.querySelector('#s-clear').addEventListener('click', () => { form.querySelectorAll('input,select').forEach(x => { x.value = ''; }); page.querySelector('.notice.info')?.remove(); load(); });
  await load();
}

export async function renderProfile(page, { id }) {
  const s = await get('/api/students/' + id);
  const isMgr = can('manager');
  const reload = () => renderProfile(page, { id });
  const today = todayLocal();
  page.innerHTML = html`
    <div class="page-head"><div><h1>${s.student_name}</h1>
      <div class="sub">${s.lead_id} · Sales rep ${s.sales_rep_name}</div></div>
      <div class="actions"><a class="btn" href="#/classes?student=${s.id}">Class activity</a><a class="btn" href="#/candidate/${s.candidate_id}">Pre-test record</a></div></div>
    <div class="cols-3">
      <div class="stack" id="enrollments"></div>
      <div class="stack">
        <section class="panel"><h2>Details</h2><dl class="facts">
          <dt>Parent</dt><dd>${s.parent_name || '—'}</dd>
          ${raw(s.phone ? `<dt>Phone</dt><dd><a href="tel:${esc(s.phone)}">${esc(s.phone)}</a></dd>` : '')}
          <dt>Age</dt><dd>${s.age ?? '—'}</dd><dt>Location</dt><dd>${s.location || '—'}</dd>
        </dl></section>
        ${raw(s.result ? html`<section class="panel"><h2>Pre-test</h2><dl class="facts">
          <dt>Recommended</dt><dd>${s.result.recommended_course}</dd><dt>Teacher</dt><dd>${s.result.teacher_name}</dd>
          <dt>Assessment</dt><dd>${s.result.assessment}</dd></dl></section>` : '')}
      </div>
    </div>`;
  const wrap = page.querySelector('#enrollments');
  if (!s.enrollments.length) {
    wrap.innerHTML = `<section class="panel">${stateBox('empty', 'No enrollment yet', isMgr ? ' Set up the admission from the Admissions page.' : '')}${isMgr ? '<p><a class="btn primary" href="#/admissions">Go to Admissions</a></p>' : ''}</section>`;
    return;
  }
  wrap.innerHTML = s.enrollments.map(e => html`<section class="panel" data-enr="${e.id}">
      <div class="row"><h2>${e.course} · ${e.class_mode}</h2>${raw(pill(e.status).__raw)}<span class="spacer"></span>
        ${raw(e.status === 'Active' ? '<button class="btn small primary" type="button" data-act="schedule">Schedule classes</button>' : '')}
        ${raw(isMgr ? '<button class="btn small" type="button" data-act="edit">Edit</button>' : '')}</div>
      <dl class="facts">
        <dt>Teacher</dt><dd>${e.teacher_name}</dd>
        <dt>Start date</dt><dd>${fmtDate(e.start_date)}</dd>
        <dt>Admitted</dt><dd>${fmtDate(e.admission_date)}</dd>
        <dt>Classes</dt><dd><progress max="${e.total_classes}" value="${e.completed_classes}" aria-label="Classes completed"></progress>
          <div class="small">${e.completed_classes} completed · <strong>${e.remaining_classes} remaining</strong> of ${e.total_classes}</div></dd>
      </dl>
      ${raw(e.money ? html`<h3>Fees</h3>
        <p>Total ${inr(e.money.total_fee)} · Paid ${inr(e.money.total_paid)} · Outstanding <strong>${inr(e.money.outstanding)}</strong>
        ${raw(e.money.overdue_amount ? ` · ${pill('Overdue ' + inr(e.money.overdue_amount), 'red').__raw}` : '')}</p>
        ${raw(table([
          { label: 'Stage', cell: p => esc(p.stage) },
          { label: 'Amount', cls: 'num', cell: p => esc(inr(p.amount)) },
          { label: 'Status', cell: p => (p.status === 'Pending' && p.date < today ? pill('Overdue') : pill(p.status)).__raw },
          { label: 'Date', cell: p => `${esc(fmtDate(p.date))}<span class="sub">${p.status === 'Paid' ? 'received' : 'due'}</span>` },
          { label: 'Method', cell: p => esc([p.method, p.reference].filter(Boolean).join(' · ') || '—') },
          { label: '', cls: 'cell-actions', cell: p => `<button class="btn small" type="button" data-pay="${p.id}">Update</button>` },
        ], e.payments))}
        <p></p><div class="row"><button class="btn small" type="button" data-act="fee">Edit fee plan</button><button class="btn small" type="button" data-act="hist">Enrollment history</button></div>` : '')}
    </section>`).join('') + html`<section class="panel"><h2>Recent classes</h2>${raw(table([
      { label: 'Class', cell: c => `<a href="#/classes?student=${s.id}&open=${c.id}">${esc(c.class_code)}</a>` },
      { label: 'When', cell: c => esc(fmtDT(c.scheduled_at)) },
      { label: 'Status', cell: c => pill(c.status).__raw + (c.attendance ? ' ' + pill(c.attendance).__raw : '') },
      { label: 'Topics', cell: c => esc(c.topics || '—') },
    ], s.classes.slice(0, 12), { empty: 'No classes scheduled yet' }))}</section>`;

  wrap.addEventListener('click', ev => {
    const panel = ev.target.closest('[data-enr]'); if (!panel) return;
    const e = s.enrollments.find(x => String(x.id) === panel.dataset.enr);
    const act = ev.target.closest('[data-act]')?.dataset.act;
    const pay = ev.target.closest('[data-pay]');
    if (pay) paymentForm({ ...e.payments.find(p => String(p.id) === pay.dataset.pay), student_name: s.student_name }, reload);
    if (act === 'edit') enrollmentForm(e, reload);
    if (act === 'fee') feePlanForm(e, reload);
    if (act === 'schedule') scheduleForm({ ...e, student_name: s.student_name }, reload);
    if (act === 'hist') get(`/api/enrollments/${e.id}`).then(full => drawer({ title: 'Enrollment history', body: historyList(full.history) }));
  });
}
