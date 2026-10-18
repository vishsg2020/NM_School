import {
  state, api, get, esc, html, raw, pill, fmtDT, fmtStamp, table, drawer, onSubmit, options, opt, teacherOptions,
  setQuery, can, toast, uid, go, ApiError, stateBox,
} from '../core.js';
import { openAdmission } from './admissions.js';

const STATUSES = ['Scheduled', 'Time Required', 'Needs Review', 'Completed', 'Cancelled', 'Follow-up'];
const SALES_STATUSES = ['Scheduled', 'Time Required', 'Follow-up', 'Cancelled'];
const CONFIRM = ['Not Confirmed', 'Confirmed', 'Reschedule Requested'];
const COURSES = [
  ['Starter', 'Starter: does not know Malayalam letters'],
  ['Reader', 'Reader: knows letters, struggles to read words'],
  ['Writer', 'Writer: reads reasonably, cannot write'],
  ['Malayalam Master', 'Malayalam Master: reads and writes, needs vocabulary/comprehension'],
];
const FILTER_KEYS = ['q', 'date', 'teacher', 'status', 'confirmation', 'sales_rep', 'result', 'review'];

export async function renderQueue(page, { query }) {
  const f = Object.fromEntries(FILTER_KEYS.map(k => [k, query[k] || '']));
  const isTeacher = can('teacher');
  page.innerHTML = html`
    <div class="page-head"><div><h1>Pre-Test Queue</h1>
      <div class="sub">${isTeacher ? 'Pre-tests assigned to you.' : 'Every candidate from first contact to assessment.'}</div></div>
      <div class="actions">${raw(can('manager', 'sales') ? '<button class="btn primary" id="add-cand" type="button">Add candidate</button>' : '')}</div>
    </div>
    <form class="filters" id="filters" role="search" aria-label="Filter pre-tests">
      <div class="field grow"><label for="f-q">Search</label><input id="f-q" name="q" type="search" placeholder="Name, Lead ID${raw(isTeacher ? '' : ', phone')}" value="${f.q}"></div>
      <div class="field"><label for="f-date">Test date</label><input id="f-date" name="date" type="date" value="${f.date === 'none' ? '' : f.date}"></div>
      ${raw(isTeacher ? '' : `<div class="field"><label for="f-teacher">Teacher</label><select id="f-teacher" name="teacher">${opt('', 'All teachers', f.teacher)}${opt('unassigned', 'Unassigned', f.teacher)}${teacherOptions(f.teacher, { activeOnly: false, blank: null })}</select></div>`)}
      <div class="field"><label for="f-status">Status</label><select id="f-status" name="status">${raw(options(STATUSES, f.status, 'All statuses'))}</select></div>
      <div class="field"><label for="f-conf">Time confirmation</label><select id="f-conf" name="confirmation">${raw(options(CONFIRM, f.confirmation, 'Any'))}</select></div>
      ${raw(isTeacher ? '' : `<div class="field"><label for="f-rep">Sales rep</label><select id="f-rep" name="sales_rep">${options(state.reps.map(r => [r.id, r.name]), f.sales_rep, 'All reps')}</select></div>`)}
      <input type="hidden" name="result" value="${f.result}"><input type="hidden" name="review" value="${f.review}">
      <button class="btn" type="button" id="clear">Clear filters</button>
    </form>
    <p class="result-count" id="count" aria-live="polite"></p>
    <div id="list">${raw(stateBox('loading'))}</div>`;

  const form = page.querySelector('#filters');
  const list = page.querySelector('#list');
  let seq = 0;
  async function load() {
    const d = Object.fromEntries(new FormData(form));
    if (f.date === 'none' && !d.date) d.date = 'none';
    setQuery({ ...d });
    const my = ++seq;
    list.setAttribute('aria-busy', 'true');
    try {
      const params = new URLSearchParams(Object.entries(d).filter(([, v]) => v)).toString();
      const rows = await get('/api/candidates' + (params ? '?' + params : ''));
      if (my !== seq) return;
      const active = Object.entries(d).filter(([, v]) => v).length;
      page.querySelector('#count').textContent = `${rows.length} candidate${rows.length === 1 ? '' : 's'}${active ? ' match the filters' : ''}`;
      list.innerHTML = renderTable(rows, active);
    } catch (e) {
      if (my === seq) list.innerHTML = stateBox('error', 'Could not load the queue', e.message);
    } finally { list.removeAttribute('aria-busy'); }
  }
  let t;
  form.addEventListener('input', e => { clearTimeout(t); t = setTimeout(load, e.target.type === 'search' ? 250 : 0); });
  form.addEventListener('submit', e => { e.preventDefault(); load(); });
  page.querySelector('#clear').addEventListener('click', () => {
    form.querySelectorAll('input, select').forEach(el => { el.value = ''; });
    f.date = '';
    load();
  });
  page.querySelector('#add-cand')?.addEventListener('click', () => candidateForm(null, load));
  list.addEventListener('click', async e => {
    const b = e.target.closest('[data-edit]');
    if (b) { const c = await get('/api/candidates/' + b.dataset.edit); candidateForm(c, load); }
  });
  await load();
  if (query.new && can('manager', 'sales')) candidateForm(null, load);
}

function renderTable(rows, filtered) {
  const isTeacher = can('teacher');
  return table([
    { label: 'Lead ID', cell: r => `<span class="nowrap">${esc(r.lead_id)}</span>` },
    { label: 'Student', cell: r => `<a href="#/candidate/${r.id}">${esc(r.student_name)}</a><span class="sub">${esc([r.parent_name, r.age ? `age ${r.age}` : '', r.location].filter(Boolean).join(' · '))}</span>` },
    { label: 'Pre-test', cell: r => (r.pretest_at ? `<span class="nowrap">${esc(fmtDT(r.pretest_at))}</span>` : '<span class="muted">No time set</span>') + `<span class="sub">${pill(r.time_confirmation).__raw}</span>` },
    { label: 'Teacher', cell: r => (r.teacher_name ? esc(r.teacher_name) + (r.teacher_active ? '' : ' <span class="muted">(inactive)</span>') : pill('Unassigned', 'amber').__raw) },
    { label: 'Status', cell: r => pill(r.status).__raw + (r.admission_status ? `<span class="sub">Result: ${esc(r.admission_status)}</span>` : '') },
    ...(isTeacher ? [] : [{ label: 'Sales rep', cell: r => esc(r.sales_rep_name) }]),
    { label: 'Actions', cls: 'cell-actions', cell: r => isTeacher
      ? `<a class="btn small ${r.result_id ? '' : 'primary'}" href="#/candidate/${r.id}">${r.result_id ? 'View result' : 'Record result'}</a>`
      : `<button class="btn small" type="button" data-edit="${r.id}">Edit</button> <a class="btn small" href="#/candidate/${r.id}">Open</a>` },
  ], rows, filtered
    ? { empty: 'No candidates match these filters', emptyHint: ' Try clearing a filter.' }
    : { empty: isTeacher ? 'No pre-tests assigned to you yet' : 'No candidates yet', emptyHint: isTeacher ? '' : ' Add the first candidate to start the queue.' });
}

/** Add or edit a candidate. */
export function candidateForm(c, after) {
  const isMgr = can('manager');
  const editing = !!c;
  const key = uid();
  const date = c?.pretest_at ? c.pretest_at.slice(0, 10) : '';
  const time = c?.pretest_at ? c.pretest_at.slice(11, 16) : '';
  const statusList = isMgr ? STATUSES : (editing && ['Completed', 'Needs Review'].includes(c.status) ? [c.status] : SALES_STATUSES);
  const repDefault = c?.sales_rep_id ?? (can('sales') ? state.me.id : '');
  drawer({
    title: editing ? `Edit ${c.student_name}` : 'Add pre-test candidate',
    body: html`<form id="cand-form" novalidate>
      <div class="grid2">
        <div class="field"><label for="c-name">Student name *</label><input id="c-name" name="student_name" required maxlength="100" value="${c?.student_name}"></div>
        <div class="field"><label for="c-parent">Parent name</label><input id="c-parent" name="parent_name" maxlength="100" value="${c?.parent_name}"></div>
        <div class="field"><label for="c-phone">Phone *</label><input id="c-phone" name="phone" type="tel" required maxlength="30" value="${c?.phone}" placeholder="+91 98470 00000"></div>
        <div class="field"><label for="c-loc">Location</label><input id="c-loc" name="location" maxlength="100" value="${c?.location}"></div>
        <div class="field"><label for="c-age">Age</label><input id="c-age" name="age" type="number" min="2" max="99" inputmode="numeric" value="${c?.age}"></div>
        ${raw(editing ? `<div class="field"><label>Lead ID</label><input value="${esc(c.lead_id)}" disabled></div>`
          : `<div class="field"><label for="c-lead">Lead ID</label><input id="c-lead" name="lead_id" maxlength="30" placeholder="Leave blank to generate"><div class="hint">Use the existing ID if the lead already has one.</div></div>`)}
      </div>
      <div class="field"><label for="c-rep">Assigned Sales Representative *</label>
        <select id="c-rep" name="sales_rep_id" required>${raw(options(state.reps.filter(r => r.active || r.id === repDefault).map(r => [r.id, r.name]), repDefault, 'Select'))}</select></div>
      <fieldset><legend>Pre-test timing</legend>
        <div class="grid3">
          <div class="field"><label for="c-date">Date</label><input id="c-date" name="date" type="date" value="${date}"></div>
          <div class="field"><label for="c-time">Time (IST)</label><input id="c-time" name="time" type="time" value="${time}"></div>
          <div class="field"><label for="c-conf">Time confirmation</label><select id="c-conf" name="time_confirmation">${raw(options(CONFIRM, c?.time_confirmation || 'Not Confirmed'))}</select></div>
        </div>
      </fieldset>
      <div class="grid2">
        <div class="field"><label for="c-status">Status</label><select id="c-status" name="status">${raw(editing ? options(statusList, c.status) : options(['Scheduled', 'Time Required', 'Follow-up'], '', 'Automatic (Scheduled if a time is set)'))}</select></div>
        ${raw(isMgr ? `<div class="field"><label for="c-teacher">Pre-test teacher</label><select id="c-teacher" name="pretest_teacher_id" ${c?.result_id ? 'disabled' : ''}>${teacherOptions(c?.pretest_teacher_id ?? '', { blank: 'Not assigned yet' })}</select>${c?.result_id ? '<div class="hint">Locked: the assessment is recorded.</div>' : ''}</div>` : '')}
      </div>
      <div class="field"><label for="c-notes">Notes</label><textarea id="c-notes" name="notes" maxlength="2000">${c?.notes}</textarea></div>
      <div id="dup-box"></div>
    </form>`,
    foot: `<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" form="cand-form">${editing ? 'Save changes' : 'Add candidate'}</button>`,
    onMount: (d, close) => {
      const form = d.querySelector('#cand-form');
      let confirmDup = false;
      onSubmit(form, async v => {
        if (!v.student_name.trim()) throw Object.assign(new Error('Student name is required'), { data: { field: 'Student name' } });
        if (!v.phone.trim()) throw Object.assign(new Error('Phone is required'), { data: { field: 'Phone' } });
        if ((v.date && !v.time) || (!v.date && v.time)) throw new Error('Enter both the pre-test date and time, or leave both empty');
        const body = {
          student_name: v.student_name, parent_name: v.parent_name, phone: v.phone, location: v.location, age: v.age,
          sales_rep_id: v.sales_rep_id, pretest_at: v.date ? `${v.date}T${v.time}` : '', time_confirmation: v.time_confirmation,
          notes: v.notes, confirm_duplicate: confirmDup,
        };
        if (v.status) body.status = v.status;
        if (isMgr && v.pretest_teacher_id !== undefined) body.pretest_teacher_id = v.pretest_teacher_id || null;
        if (!editing) { body.lead_id = v.lead_id; body.idempotency_key = key; }
        try {
          const r = editing ? await api('PATCH', `/api/candidates/${c.id}`, body) : await api('POST', '/api/candidates', body);
          close();
          toast(editing ? 'Candidate updated' : `Candidate added as ${r.lead_id}`);
          after && after();
        } catch (e) {
          if (e instanceof ApiError && e.data.code === 'POSSIBLE_DUPLICATE') {
            const box = d.querySelector('#dup-box');
            box.innerHTML = `<div class="notice warn" role="alert">${esc(e.message)} If this is a different child, save again to add them anyway.
              <ul>${e.data.duplicates.map(x => `<li><a href="#/candidate/${x.id}">${esc(x.lead_id)} · ${esc(x.student_name)}</a></li>`).join('')}</ul></div>`;
            confirmDup = true;
            d.querySelector('button[form="cand-form"]').dataset.label = 'Add anyway';
            return;
          }
          throw e;
        }
      });
    },
  });
}

export async function renderCandidate(page, { id }) {
  const c = await get('/api/candidates/' + id);
  const isMgr = can('manager');
  const r = c.result;
  const canEditResult = (isMgr || (can('teacher') && c.pretest_teacher_id === state.me.teacher_id)) && (!r || !r.reviewed_at || isMgr);
  const canSetup = isMgr && r && r.admission_status === 'Confirmed' && c.student_id && !c.enrollment_count;
  page.innerHTML = html`
    <div class="page-head"><div><h1>${c.student_name}</h1>
      <div class="sub">${c.lead_id} · ${raw(pill(c.status).__raw)}</div></div>
      <div class="actions">
        ${raw(can('manager', 'sales') ? '<button class="btn" type="button" id="edit">Edit candidate</button>' : '')}
        ${raw(c.student_id && can('manager') && c.enrollment_count ? `<a class="btn" href="#/student/${c.student_id}">Student profile</a>` : '')}
        ${raw(canSetup ? '<button class="btn primary" type="button" id="setup">Set up admission</button>' : '')}
      </div></div>
    <div class="cols-3">
      <div class="stack">
        <section class="panel" id="result-panel"></section>
        ${raw(c.history ? `<section class="panel"><h2>Change history</h2>${historyList(c.history)}</section>` : '')}
      </div>
      <section class="panel"><h2>Candidate</h2><dl class="facts">
        <dt>Parent</dt><dd>${c.parent_name || '—'}</dd>
        ${raw(c.phone ? `<dt>Phone</dt><dd><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></dd>` : '')}
        <dt>Age</dt><dd>${c.age ?? '—'}</dd>
        <dt>Location</dt><dd>${c.location || '—'}</dd>
        <dt>Sales rep</dt><dd>${c.sales_rep_name}</dd>
        <dt>Pre-test</dt><dd>${c.pretest_at ? fmtDT(c.pretest_at) : 'Not set'}</dd>
        <dt>Time</dt><dd>${raw(pill(c.time_confirmation).__raw)}</dd>
        <dt>Teacher</dt><dd>${c.teacher_name || 'Not assigned'}</dd>
        <dt>Notes</dt><dd>${c.notes || '—'}</dd>
      </dl></section>
    </div>`;
  const reload = () => renderCandidate(page, { id });
  page.querySelector('#edit')?.addEventListener('click', () => candidateForm(c, reload));
  page.querySelector('#setup')?.addEventListener('click', () => openAdmission({ student_id: c.student_id, student_name: c.student_name, lead_id: c.lead_id, sales_rep_name: c.sales_rep_name, recommended_course: r.recommended_course }, () => go('/student/' + c.student_id)));

  const panel = page.querySelector('#result-panel');
  const showForm = () => resultForm(panel, c, reload);
  if (!r) {
    if (!c.pretest_teacher_id) panel.innerHTML = '<h2>Pre-test result</h2><div class="notice info">Assign a pre-test teacher before the assessment can be recorded.</div>';
    else if (canEditResult) showForm();
    else panel.innerHTML = `<h2>Pre-test result</h2>${stateBox('empty', 'Not recorded yet', ` ${c.teacher_name} will record the assessment after the pre-test.`)}`;
    return;
  }
  panel.innerHTML = html`<div class="row"><h2>Pre-test result</h2><span class="spacer"></span>
      ${raw(r.reviewed_at ? pill('Reviewed', 'green').__raw : pill('Awaiting review', 'amber').__raw)}</div>
    <dl class="facts">
      <dt>Recommended course</dt><dd><strong>${r.recommended_course}</strong></dd>
      <dt>Admission status</dt><dd>${raw(pill(r.admission_status).__raw)}</dd>
      <dt>Assessment</dt><dd>${r.assessment}</dd>
      <dt>Recommendation</dt><dd>${r.recommendation || '—'}</dd>
      <dt>Objection</dt><dd>${r.objection || '—'}</dd>
      <dt>Notes</dt><dd>${r.notes || '—'}</dd>
      <dt>Recorded</dt><dd>${r.teacher_name} · ${fmtStamp(r.submitted_at)}</dd>
      ${raw(r.reviewed_at ? `<dt>Reviewed</dt><dd>${esc(r.reviewed_by_name)} · ${esc(fmtStamp(r.reviewed_at))}</dd>` : '')}
    </dl>
    <div class="row">
      ${raw(canEditResult ? '<button class="btn" type="button" id="edit-result">Edit result</button>' : '')}
      ${raw(isMgr ? `<button class="btn" type="button" id="review">${r.reviewed_at ? 'Mark as not reviewed' : 'Mark as reviewed'}</button>` : '')}
    </div>
    ${raw(r.admission_status === 'Confirmed' ? `<p class="small muted">Confirmed: a Student record exists. The enrollment is created only when the Manager completes admission setup.</p>` : '')}`;
  panel.querySelector('#edit-result')?.addEventListener('click', showForm);
  panel.querySelector('#review')?.addEventListener('click', async () => {
    await api('POST', `/api/candidates/${c.id}/result/review`, { reviewed: !r.reviewed_at });
    toast(r.reviewed_at ? 'Review cleared' : 'Marked as reviewed'); reload();
  });
}

function resultForm(panel, c, after) {
  const r = c.result || {};
  panel.innerHTML = html`<h2>${c.result ? 'Edit pre-test result' : 'Record pre-test result'}</h2>
    <p class="muted small">Lead ${c.lead_id} · Sales rep ${c.sales_rep_name} · Pre-test teacher ${c.teacher_name}</p>
    <form id="res-form" novalidate>
      <fieldset><legend>Recommended course *</legend>
        ${raw(COURSES.map(([v, l]) => `<label class="check"><input type="radio" name="recommended_course" value="${esc(v)}" ${r.recommended_course === v ? 'checked' : ''}> ${esc(l)}</label>`).join(''))}
        <div class="field"></div>
      </fieldset>
      <div class="field"><label for="r-assess">Assessment *</label><textarea id="r-assess" name="assessment" required maxlength="4000" placeholder="What the child could and could not do">${r.assessment}</textarea></div>
      <div class="grid2">
        <div class="field"><label for="r-adm">Admission status *</label><select id="r-adm" name="admission_status" required>${raw(options(['Confirmed', 'Follow-up', 'Not Interested'], r.admission_status, 'Select'))}</select>
          <div class="hint">Confirmed creates the Student record. Admission setup is a separate Manager step.</div></div>
        <div class="field"><label for="r-obj">Objection</label><input id="r-obj" name="objection" maxlength="2000" value="${r.objection}" placeholder="e.g. timing, fee"></div>
      </div>
      <div class="field"><label for="r-rec">Recommendation</label><textarea id="r-rec" name="recommendation" maxlength="2000">${r.recommendation}</textarea></div>
      <div class="field"><label for="r-notes">Notes</label><textarea id="r-notes" name="notes" maxlength="4000">${r.notes}</textarea></div>
      <div class="row"><button class="btn primary" type="submit">Save result</button>${raw(c.result ? '<button class="btn" type="button" id="cancel-res">Cancel</button>' : '')}</div>
    </form>`;
  const form = panel.querySelector('#res-form');
  panel.querySelector('#cancel-res')?.addEventListener('click', after);
  onSubmit(form, async v => {
    if (!v.recommended_course) throw new Error('Choose the recommended course');
    if (!v.assessment.trim()) throw Object.assign(new Error('Assessment is required'), { data: { field: 'Assessment *' } });
    if (!v.admission_status) throw new Error('Choose the admission status');
    await api('PUT', `/api/candidates/${c.id}/result`, v);
    toast('Result saved');
    window.dispatchEvent(new Event('nm:changed'));
    after();
  });
}

export function historyList(items) {
  if (!items.length) return '<p class="muted">No changes recorded.</p>';
  const show = v => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return `<ul class="timeline">${items.map(h => {
    const keys = h.after ? Object.keys(h.after) : [];
    const diffs = keys.filter(k => !['phone_norm', 'idempotency_key', 'id'].includes(k)).slice(0, 8)
      .map(k => `<div class="diff">${esc(k.replace(/_/g, ' '))}: ${h.before ? `${esc(show(h.before[k]))} → ` : ''}<b>${esc(show(h.after[k]))}</b></div>`).join('');
    return `<li><strong>${esc(h.action.replace(/_/g, ' '))}</strong> <span class="muted">· ${esc(h.user_name || 'System')} · ${esc(fmtStamp(h.at))}</span>
      ${h.reason ? `<div>Reason: ${esc(h.reason)}</div>` : ''}${diffs}</li>`;
  }).join('')}</ul>`;
}
