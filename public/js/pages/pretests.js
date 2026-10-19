import {
  state, api, get, esc, html, raw, pill, fmtDT, fmtStamp, fmtTime, table, drawer, onSubmit, options, opt, teacherOptions,
  setQuery, can, toast, uid, go, ApiError, stateBox, copyText, todayLocal, fmtDate, confirmBox,
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
const FILTER_KEYS = ['q', 'date', 'teacher', 'status', 'confirmation', 'sales_rep', 'result', 'review', 'followup'];

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
      <input type="hidden" name="result" value="${f.result}"><input type="hidden" name="review" value="${f.review}"><input type="hidden" name="followup" value="${f.followup}">
      <button class="btn" type="button" id="clear">Clear filters</button>
    </form>
    ${raw(f.followup === 'due' ? '<p class="notice info">Showing follow-ups that are due today or overdue. Clear filters to see everyone.</p>' : '')}
    <p class="result-count" id="count" aria-live="polite"></p>
    <div id="list">${raw(stateBox('loading'))}</div>`;

  const form = page.querySelector('#filters');
  const list = page.querySelector('#list');
  let seq = 0;
  let lastRows = [];
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
      lastRows = rows;
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
    f.date = ''; page.querySelector('.notice.info')?.remove();
    load();
  });
  page.querySelector('#add-cand')?.addEventListener('click', () => candidateForm(null, load));
  list.addEventListener('click', async e => {
    const cp = e.target.closest('[data-copy-row]');
    if (cp) { const row = lastRows.find(x => String(x.id) === cp.dataset.copyRow); if (row) copyText(row.meet_link, 'Meeting link copied'); return; }
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
    { label: 'Status', cell: r => pill(r.status).__raw + (r.admission_status ? `<span class="sub">Result: ${esc(r.admission_status)}</span>` : '')
      + (r.status === 'Follow-up' && r.followup_date ? `<span class="sub ${r.followup_date <= todayLocal() ? 'due' : ''}">Follow up ${esc(fmtFollowup(r))}</span>` : '') },
    ...(isTeacher ? [] : [{ label: 'Sales rep', cell: r => esc(r.sales_rep_name) }]),
    { label: 'Actions', cls: 'cell-actions', cell: r => (r.meet_link ? `<button class="btn small" type="button" data-copy-row="${r.id}" title="Copy Google Meet link">Copy link</button> ` : '') + (isTeacher
      ? `<a class="btn small ${r.result_id ? '' : 'primary'}" href="#/candidate/${r.id}">${r.result_id ? 'View result' : 'Record result'}</a>`
      : `<button class="btn small" type="button" data-edit="${r.id}">Edit</button> <a class="btn small" href="#/candidate/${r.id}">Open</a>`) },
  ], rows, filtered
    ? { empty: 'No candidates match these filters', emptyHint: ' Try clearing a filter.' }
    : { empty: isTeacher ? 'No pre-tests assigned to you yet' : 'No candidates yet', emptyHint: isTeacher ? '' : ' Add the first candidate to start the queue.' });
}

const PRETEST_MINUTES = 30;

/** Text staff paste into WhatsApp or email. */
export function meetMessage(c) {
  return `Nalla Malayalam – Malayalam pre-test\nStudent: ${c.student_name}\nWhen: ${fmtDT(c.pretest_at)} IST (${PRETEST_MINUTES} minutes)\nJoin on Google Meet: ${c.meet_link}`;
}
function meetButtons(c) {
  return `<button class="btn small" type="button" data-copy-link="${esc(c.meet_link)}">Copy meeting link</button>
    <button class="btn small" type="button" data-copy-msg>Copy invite message</button>`;
}
function wireMeetButtons(root, c) {
  root.querySelectorAll('[data-copy-link]').forEach(b => b.addEventListener('click', () => copyText(c.meet_link, 'Meeting link copied')));
  root.querySelectorAll('[data-copy-msg]').forEach(b => b.addEventListener('click', () => copyText(meetMessage(c), 'Invite message copied')));
}
/** After saving: show the Meet link, or say why there is none. */
function reportMeet(r, isNew) {
  if (r.meet_error) { toast(r.meet_error, 'error'); return; }
  if (r.meet_status === 'not_connected') { toast(can('manager') ? 'No Meet link: connect Google in Settings first.' : 'No Meet link yet: Google is not connected (Manager → Settings).', 'error'); return; }
  if (isNew && r.meet_link) {
    drawer({
      title: 'Pre-test added',
      body: html`<p><strong>${r.student_name}</strong> · ${r.lead_id}</p>
        <p>${fmtDT(r.pretest_at)} IST · ${PRETEST_MINUTES} minutes</p>
        <div class="meet-box"><span class="meet-label">Google Meet</span><a href="${r.meet_link}" target="_blank" rel="noopener">${r.meet_link}</a></div>
        <div class="row">${raw(meetButtons(r))}</div>
        <p class="small muted">Share the link or the message over WhatsApp or email. It is also on the candidate's page.</p>`,
      foot: `<a class="btn" href="#/candidate/${r.id}">Open candidate</a><button class="btn primary" type="button" data-close>Done</button>`,
      onMount: d => { wireMeetButtons(d, r); d.querySelectorAll('a.btn').forEach(a => a.addEventListener('click', () => d.querySelector('[data-close]').click())); },
    });
  }
}

const GENDERS = ['Male', 'Female', 'Prefer not to say'];
const RELATIONSHIPS = ['Mother', 'Father', 'Guardian', 'Other'];
const ADULT_AGE = 18;

/** Add or edit a candidate. */
export function candidateForm(c, after) {
  const isMgr = can('manager');
  const editing = !!c;
  const key = uid();
  const date = c?.pretest_at ? c.pretest_at.slice(0, 10) : '';
  const time = c?.pretest_at ? c.pretest_at.slice(11, 16) : '';
  const statusList = isMgr ? STATUSES : (editing && ['Completed', 'Needs Review'].includes(c.status) ? [c.status] : SALES_STATUSES);
  const repDefault = c?.sales_rep_id ?? (can('sales') ? state.me.id : '');
  const minor0 = c?.age != null && c.age < ADULT_AGE;
  const teacherLocked = !!c?.result_id;
  const teacherField = isMgr ? `<div class="field"><label for="c-teacher">Pre-test teacher</label><select id="c-teacher" name="pretest_teacher_id" ${teacherLocked ? 'disabled' : ''}>${teacherOptions(c?.pretest_teacher_id ?? '', { blank: 'Not assigned yet' })}</select>${teacherLocked ? '<div class="hint">Locked: the assessment is recorded.</div>' : ''}</div>` : '';

  // Timing: a new candidate picks Confirmed / Not confirmed; editing keeps the full set of fields.
  const timing = editing ? html`
      <fieldset><legend>Pre-test timing</legend>
        <div class="grid3">
          <div class="field"><label for="c-date">Date</label><input id="c-date" name="date" type="date" value="${date}"></div>
          <div class="field"><label for="c-time">Time (IST)</label><input id="c-time" name="time" type="time" value="${time}"></div>
          <div class="field"><label for="c-conf">Time confirmation</label><select id="c-conf" name="time_confirmation">${raw(options(CONFIRM, c.time_confirmation))}</select></div>
        </div>
        <div class="grid2">
          <div class="field"><label for="c-status">Status</label><select id="c-status" name="status">${raw(options(statusList, c.status))}</select></div>
          ${raw(teacherField)}
        </div>
        <div id="clash-box"></div>
      </fieldset>` : html`
      <fieldset><legend>Pre-test timing</legend>
        <div class="seg" role="radiogroup" aria-label="Pre-test time">
          <label><input type="radio" name="timing" value="confirmed" checked><span>Time confirmed</span></label>
          <label><input type="radio" name="timing" value="pending"><span>Not confirmed yet</span></label>
        </div>
        <div class="grid3">
          <div class="field" data-when="confirmed"><label for="c-date">Date *</label><input id="c-date" name="date" type="date"></div>
          <div class="field" data-when="confirmed"><label for="c-time">Time (IST) *</label><input id="c-time" name="time" type="time"></div>
          ${raw(teacherField)}
        </div>
        <p class="small muted hidden" data-when="pending">Status will be <b>Time Required</b>. Add the date and time later with Edit.</p>
        ${raw(isMgr ? '' : '<p class="small muted">The Manager assigns the pre-test teacher.</p>')}
        <div id="clash-box"></div>
      </fieldset>`;

  drawer({
    title: editing ? `Edit ${c.student_name}` : 'Add pre-test candidate',
    body: html`<form id="cand-form" novalidate>
      <fieldset><legend>Student</legend>
        <div class="grid2">
          <div class="field"><label for="c-first">First name *</label><input id="c-first" name="first_name" required maxlength="60" autocomplete="off" value="${c?.first_name ?? c?.student_name}"></div>
          <div class="field"><label for="c-last">Last name *</label><input id="c-last" name="last_name" required maxlength="60" autocomplete="off" value="${c?.last_name}"></div>
        </div>
        <div class="grid3">
          <div class="field"><label for="c-age">Age *</label><input id="c-age" name="age" type="number" min="2" max="99" inputmode="numeric" required value="${c?.age}"></div>
          <div class="field"><label for="c-gender">Gender</label><select id="c-gender" name="gender">${raw(options(GENDERS, c?.gender, 'Select'))}</select></div>
          <div class="field"><label for="c-loc">Location</label><input id="c-loc" name="location" maxlength="100" value="${c?.location}"></div>
        </div>
        <div class="field" id="adult-phone"><label for="c-phone">Phone *</label><input id="c-phone" name="phone" type="tel" maxlength="30" value="${minor0 ? '' : c?.phone}" placeholder="+91 98470 00000">
          <div class="hint">Required for students aged 18 and over.</div></div>
      </fieldset>
      <fieldset id="minor"><legend>Parent / guardian</legend>
        <div class="grid2">
          <div class="field"><label for="c-parent">Parent name *</label><input id="c-parent" name="parent_name" maxlength="100" value="${c?.parent_name}"></div>
          <div class="field"><label for="c-rel">Relationship *</label><select id="c-rel" name="parent_relationship">${raw(options(RELATIONSHIPS, c?.parent_relationship, 'Select'))}</select></div>
          <div class="field"><label for="c-pphone">Parent phone *</label><input id="c-pphone" name="phone" type="tel" maxlength="30" value="${minor0 ? c?.phone : ''}" placeholder="+91 98470 00000"></div>
          <div class="field"><label for="c-sphone">Student phone</label><input id="c-sphone" name="student_phone" type="tel" maxlength="30" value="${c?.student_phone}" placeholder="Optional for under 18"></div>
        </div>
      </fieldset>
      <div class="grid2">
        ${raw(editing ? `<div class="field"><label>Lead ID</label><input value="${esc(c.lead_id)}" disabled></div>`
          : '<div class="field"><label for="c-lead">Lead ID</label><input id="c-lead" name="lead_id" maxlength="30" placeholder="Leave blank to generate"></div>')}
        <div class="field"><label for="c-rep">Assigned Sales Representative *</label>
          <select id="c-rep" name="sales_rep_id" required>${raw(options(state.reps.filter(r => r.active || r.id === repDefault).map(r => [r.id, r.name]), repDefault, 'Select'))}</select></div>
      </div>
      ${raw(timing)}
      <div class="field"><label for="c-notes">Notes</label><textarea id="c-notes" name="notes" maxlength="2000">${c?.notes}</textarea></div>
      <div id="dup-box"></div>
    </form>`,
    foot: `<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" form="cand-form">${editing ? 'Save changes' : 'Add pre-test candidate'}</button>`,
    onMount: (d, close) => {
      const form = d.querySelector('#cand-form');
      const $ = sel => form.querySelector(sel);
      const show = (el, on) => { el.classList.toggle('hidden', !on); el.querySelectorAll('input, select, textarea').forEach(x => { x.disabled = !on; }); };

      // Age < 18 shows the parent section; its phone field becomes the main contact number.
      const isMinor = () => $('#c-age').value !== '' && Number($('#c-age').value) < ADULT_AGE;
      const syncAge = () => {
        const minor = isMinor();
        const from = minor ? $('#c-phone') : $('#c-pphone'); const to = minor ? $('#c-pphone') : $('#c-phone');
        if (!from.disabled && from.value && !to.value) to.value = from.value;
        show($('#minor'), minor); show($('#adult-phone'), !minor);
      };
      $('#c-age').addEventListener('input', syncAge);
      syncAge();

      const timingMode = () => (editing ? 'edit' : form.querySelector('[name=timing]:checked').value);
      const syncTiming = () => {
        if (editing) return;
        const confirmed = timingMode() === 'confirmed';
        form.querySelectorAll('[data-when="confirmed"]').forEach(el => show(el, confirmed));
        form.querySelectorAll('[data-when="pending"]').forEach(el => el.classList.toggle('hidden', confirmed));
      };
      form.querySelectorAll('[name=timing]').forEach(r => r.addEventListener('change', () => { syncTiming(); checkClash(); }));
      syncTiming();

      // Manager: warn (never block) when the chosen teacher is already busy at that time.
      let clashSeq = 0;
      async function checkClash() {
        const box = d.querySelector('#clash-box'); const teacher = $('#c-teacher');
        if (!box || !teacher) return;
        const at = $('#c-date')?.value && $('#c-time')?.value && !$('#c-date').disabled ? `${$('#c-date').value}T${$('#c-time').value}` : '';
        if (!teacher.value || teacher.disabled || !at) { box.innerHTML = ''; return; }
        const my = ++clashSeq;
        try {
          const r = await get(`/api/pretest-clash?teacher=${teacher.value}&at=${encodeURIComponent(at)}${editing ? '&candidate=' + c.id : ''}`);
          if (my !== clashSeq) return;
          const items = [
            ...r.busy.map(b => `${b.kind} ${b.code} with ${b.student_name}, ${fmtTime(b.start.slice(11))}–${fmtTime(b.end.slice(11))}`),
            ...r.warnings.map(w => `This time is ${w}`),
          ];
          box.innerHTML = items.length ? `<div class="notice warn" role="alert"><strong>${esc(r.teacher)} ${r.busy.length ? 'is busy at this time' : 'may not be available'}:</strong>
            <ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>You can still save, or pick another time or teacher.</div>` : '';
        } catch { if (my === clashSeq) box.innerHTML = ''; }
      }
      ['#c-teacher', '#c-date', '#c-time'].forEach(sel => $(sel)?.addEventListener('change', checkClash));
      checkClash();

      let confirmDup = false;
      onSubmit(form, async v => {
        const need = (val, label) => { if (!String(val ?? '').trim()) throw Object.assign(new Error(`${label} is required`), { data: { field: label } }); };
        need(v.first_name, 'First name'); need(v.last_name, 'Last name'); need(v.age, 'Age');
        const minor = isMinor();
        if (minor) { need(v.parent_name, 'Parent name'); need(v.parent_relationship, 'Relationship'); need(v.phone, 'Parent phone'); }
        else need(v.phone, 'Phone');
        const mode = timingMode();
        if (mode === 'confirmed') { need(v.date, 'Date'); need(v.time, 'Time (IST)'); }
        if (mode === 'edit' && ((v.date && !v.time) || (!v.date && v.time))) throw new Error('Enter both the pre-test date and time, or leave both empty');
        const body = {
          first_name: v.first_name, last_name: v.last_name, age: v.age, gender: v.gender, location: v.location, phone: v.phone,
          parent_name: minor ? v.parent_name : '', parent_relationship: minor ? v.parent_relationship : '', student_phone: minor ? v.student_phone : '',
          sales_rep_id: v.sales_rep_id, notes: v.notes, confirm_duplicate: confirmDup,
        };
        if (mode === 'edit') {
          Object.assign(body, { pretest_at: v.date ? `${v.date}T${v.time}` : '', time_confirmation: v.time_confirmation, status: v.status });
        } else if (mode === 'confirmed') {
          Object.assign(body, { pretest_at: `${v.date}T${v.time}`, time_confirmation: 'Confirmed' });
        } else {
          Object.assign(body, { pretest_at: '', time_confirmation: 'Not Confirmed' });
        }
        if (isMgr && v.pretest_teacher_id !== undefined) body.pretest_teacher_id = v.pretest_teacher_id || null;
        if (!editing) { body.lead_id = v.lead_id; body.idempotency_key = key; }
        try {
          const r = editing ? await api('PATCH', `/api/candidates/${c.id}`, body) : await api('POST', '/api/candidates', body);
          close();
          toast(editing ? 'Candidate updated' : `Candidate added as ${r.lead_id}`);
          after && after();
          reportMeet(r, !editing);
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

function meetPanel(c) {
  if (c.meet_link) {
    return `<section class="panel"><h2>Google Meet</h2>
      <div class="meet-box"><a href="${esc(c.meet_link)}" target="_blank" rel="noopener">${esc(c.meet_link)}</a></div>
      <div class="row">${meetButtons(c)}</div></section>`;
  }
  if (c.status === 'Cancelled') return '';
  const canMake = can('manager', 'sales') && c.pretest_at;
  return `<section class="panel"><h2>Google Meet</h2>
    <p class="muted small">${c.pretest_at ? 'No meeting link yet.' : 'A meeting link is created when the pre-test time is confirmed.'}</p>
    ${canMake ? '<button class="btn small" type="button" id="make-meet">Create meeting link</button>' : ''}</section>`;
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
        ${raw(meetPanel(c))}
        <section class="panel" id="result-panel"></section>
        ${raw(c.history ? `<section class="panel"><h2>Change history</h2>${historyList(c.history)}</section>` : '')}
      </div>
      <section class="panel"><h2>Candidate</h2><dl class="facts">
        <dt>Age</dt><dd>${c.age ?? '—'}</dd>
        <dt>Gender</dt><dd>${c.gender || '—'}</dd>
        <dt>Parent</dt><dd>${c.parent_name || '—'}${c.parent_relationship ? ` (${c.parent_relationship})` : ''}</dd>
        ${raw(c.phone ? `<dt>${c.age != null && c.age < ADULT_AGE ? 'Parent phone' : 'Phone'}</dt><dd><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></dd>` : '')}
        ${raw(c.student_phone ? `<dt>Student phone</dt><dd><a href="tel:${esc(c.student_phone)}">${esc(c.student_phone)}</a></dd>` : '')}
        <dt>Location</dt><dd>${c.location || '—'}</dd>
        <dt>Sales rep</dt><dd>${c.sales_rep_name}</dd>
        <dt>Pre-test</dt><dd>${c.pretest_at ? fmtDT(c.pretest_at) : 'Not set'}</dd>
        <dt>Time</dt><dd>${raw(pill(c.time_confirmation).__raw)}</dd>
        <dt>Teacher</dt><dd>${c.teacher_name || 'Not assigned'}</dd>
        <dt>Notes</dt><dd>${c.notes || '—'}</dd>
      </dl></section>
    </div>`;
  const reload = () => renderCandidate(page, { id });
  wireMeetButtons(page, c);
  page.querySelector('#make-meet')?.addEventListener('click', async ev => {
    ev.target.disabled = true; ev.target.textContent = 'Creating…';
    try { await api('POST', `/api/candidates/${c.id}/meet`); toast('Meeting link created'); reload(); }
    catch (e) { toast(e.message, 'error'); ev.target.disabled = false; ev.target.textContent = 'Create meeting link'; }
  });
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
      ${raw(r.admission_status === 'Follow-up' && r.followup_date ? `<dt>Follow up</dt><dd><strong>${esc(fmtFollowup(r))}</strong>${r.followup_note ? `<div class="small">${esc(r.followup_note)}</div>` : ''}</dd>` : '')}
      <dt>Recorded</dt><dd>${r.teacher_name} · ${fmtStamp(r.submitted_at)}</dd>
      ${raw(r.reviewed_at ? `<dt>Reviewed</dt><dd>${esc(r.reviewed_by_name)} · ${esc(fmtStamp(r.reviewed_at))}</dd>` : '')}
    </dl>
    <div id="result-files"></div>
    <div class="row">
      ${raw(canEditResult ? '<button class="btn" type="button" id="edit-result">Edit result</button>' : '')}
      ${raw(isMgr ? `<button class="btn" type="button" id="review">${r.reviewed_at ? 'Mark as not reviewed' : 'Mark as reviewed'}</button>` : '')}
    </div>
    ${raw(r.admission_status === 'Confirmed' ? `<p class="small muted">Confirmed: a Student record exists. The enrollment is created only when the Manager completes admission setup.</p>` : '')}`;
  panel.querySelector('#edit-result')?.addEventListener('click', showForm);
  if (c.file_count) {
    const files = await get(`/api/candidates/${c.id}/files`);
    panel.querySelector('#result-files').innerHTML = `<h3>Test paper</h3>${filesHtml(files)}`;
  }
  panel.querySelector('#review')?.addEventListener('click', async () => {
    await api('POST', `/api/candidates/${c.id}/result/review`, { reviewed: !r.reviewed_at });
    toast(r.reviewed_at ? 'Review cleared' : 'Marked as reviewed'); reload();
  });
}

const CHANNELS = ['WhatsApp', 'Call', 'Email'];
const MAX_FILES = 5;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export const fmtFollowup = r => `${fmtDate(r.followup_date)}${r.followup_time ? ', ' + fmtTime(r.followup_time) : ''}${r.followup_channel ? ' via ' + r.followup_channel : ''}`;
const kb = n => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const isImage = m => /^image\/(jpeg|png|webp)$/.test(m);

function guessType(file) {
  if (file.type) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' }[ext] || '';
}

/** Phone photos are often 3–8 MB: resize to 1600 px and save as JPEG (~200–400 KB). */
async function shrinkImage(file, type) {
  if (!isImage(type)) return { blob: file, type, name: file.name };
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 600 * 1024) return { blob: file, type, name: file.name };
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.82));
    return { blob, type: 'image/jpeg', name: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
  } catch { return { blob: file, type, name: file.name }; }
}
const toBase64 = blob => new Promise((res, rej) => {
  const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob);
});

/** Thumbnails / links for saved files. */
export function filesHtml(files, { removable = false } = {}) {
  if (!files.length) return '';
  return `<ul class="file-list">${files.map(f => `<li>
    ${isImage(f.mime) ? `<a href="/api/files/${f.id}" target="_blank" rel="noopener"><img class="thumb" src="/api/files/${f.id}" alt="" loading="lazy"></a>` : `<span class="thumb doc">${f.mime === 'application/pdf' ? 'PDF' : 'IMG'}</span>`}
    <div><a href="/api/files/${f.id}" target="_blank" rel="noopener">${esc(f.filename)}</a><div class="sz">${kb(f.size_bytes)}${f.uploaded_by_name ? ' · ' + esc(f.uploaded_by_name) : ''}</div></div>
    <a class="btn small" href="/api/files/${f.id}?download=1">Download</a>
    ${removable ? `<button class="btn small danger" type="button" data-del-file="${f.id}">Remove</button>` : ''}</li>`).join('')}</ul>`;
}

async function resultForm(panel, c, after) {
  const r = c.result || {};
  const saved = c.file_count ? await get(`/api/candidates/${c.id}/files`) : [];
  let pending = []; // files picked but not uploaded yet
  panel.innerHTML = html`<h2>${c.result ? 'Edit pre-test result' : 'Record pre-test result'}</h2>
    <p class="muted small">Lead ${c.lead_id} · Sales rep ${c.sales_rep_name} · Pre-test teacher ${c.teacher_name}</p>
    <form id="res-form" novalidate>
      <fieldset><legend>Recommended course *</legend>
        ${raw(COURSES.map(([v, l]) => `<label class="check"><input type="radio" name="recommended_course" value="${esc(v)}" ${r.recommended_course === v ? 'checked' : ''}> ${esc(l)}</label>`).join(''))}
        <div class="field"></div>
      </fieldset>
      <fieldset><legend>Test paper / worksheet</legend>
        <label class="drop" for="r-files">Choose files or take a photo<br><span class="small">Images or PDF · up to ${MAX_FILES} files · photos are shrunk automatically</span></label>
        <input id="r-files" class="sr-only" type="file" multiple accept="image/*,application/pdf">
        <div id="saved-files">${raw(filesHtml(saved, { removable: true }))}</div>
        <ul class="file-list" id="pending-files"></ul>
        <div class="field"></div>
      </fieldset>
      <div class="field"><label for="r-assess">Assessment *</label><textarea id="r-assess" name="assessment" required maxlength="4000" placeholder="What the child could and could not do">${r.assessment}</textarea></div>
      <div class="grid2">
        <div class="field"><label for="r-adm">Admission status *</label><select id="r-adm" name="admission_status" required>${raw(options(['Confirmed', 'Follow-up', 'Not Interested'], r.admission_status, 'Select'))}</select>
          <div class="hint">Confirmed creates the Student record. Admission setup is a separate Manager step.</div></div>
        <div class="field"><label for="r-obj">Objection</label><input id="r-obj" name="objection" maxlength="2000" value="${r.objection}" placeholder="e.g. timing, fee"></div>
      </div>
      <fieldset id="fu-box" class="hidden"><legend>Preferred follow-up time</legend>
        <div class="grid3">
          <div class="field"><label for="r-fud">Follow-up date *</label><input id="r-fud" name="followup_date" type="date" value="${r.followup_date}"></div>
          <div class="field"><label for="r-fut">Time (IST)</label><input id="r-fut" name="followup_time" type="time" value="${r.followup_time}"></div>
          <div class="field"><label for="r-fuc">Contact by</label><select id="r-fuc" name="followup_channel">${raw(options(CHANNELS, r.followup_channel, 'Select'))}</select></div>
        </div>
        <div class="field"><label for="r-fun">Follow-up note</label><input id="r-fun" name="followup_note" maxlength="500" value="${r.followup_note}" placeholder="e.g. parent wants weekend batch options"></div>
      </fieldset>
      <div class="field"><label for="r-rec">Recommendation</label><textarea id="r-rec" name="recommendation" maxlength="2000">${r.recommendation}</textarea></div>
      <div class="field"><label for="r-notes">Notes</label><textarea id="r-notes" name="notes" maxlength="4000">${r.notes}</textarea></div>
      <div class="row"><button class="btn primary" type="submit">Save result</button>${raw(c.result ? '<button class="btn" type="button" id="cancel-res">Cancel</button>' : '')}</div>
    </form>`;
  const form = panel.querySelector('#res-form');
  panel.querySelector('#cancel-res')?.addEventListener('click', after);

  const adm = panel.querySelector('#r-adm'); const fu = panel.querySelector('#fu-box');
  const syncFu = () => { const on = adm.value === 'Follow-up'; fu.classList.toggle('hidden', !on); fu.querySelectorAll('input,select').forEach(x => { x.disabled = !on; }); };
  adm.addEventListener('change', syncFu); syncFu();

  const savedCount = () => panel.querySelectorAll('#saved-files [data-del-file]').length;
  const drawPending = () => {
    panel.querySelector('#pending-files').innerHTML = pending.map((p, i) => `<li><span class="thumb doc">${p.type === 'application/pdf' ? 'PDF' : 'IMG'}</span>
      <div>${esc(p.name)}<div class="sz">${kb(p.blob.size)} · uploads when you save</div></div>
      <button class="btn small" type="button" data-unpick="${i}">Remove</button></li>`).join('');
  };
  panel.querySelector('#r-files').addEventListener('change', async ev => {
    for (const file of [...ev.target.files]) {
      const type = guessType(file);
      if (!/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(type)) { toast(`${file.name}: only images or PDF`, 'error'); continue; }
      if (savedCount() + pending.length >= MAX_FILES) { toast(`At most ${MAX_FILES} files`, 'error'); break; }
      const p = await shrinkImage(file, type);
      if (p.blob.size > MAX_FILE_BYTES) { toast(`${file.name} is larger than 4 MB`, 'error'); continue; }
      pending.push(p);
    }
    ev.target.value = ''; drawPending();
  });
  panel.addEventListener('click', async ev => {
    const un = ev.target.closest('[data-unpick]');
    if (un) { pending.splice(Number(un.dataset.unpick), 1); drawPending(); return; }
    const del = ev.target.closest('[data-del-file]');
    if (del) {
      if (!(await confirmBox({ title: 'Remove this file?', message: 'The uploaded file will be deleted.', confirmLabel: 'Remove', danger: true }))) return;
      try { await api('DELETE', `/api/files/${del.dataset.delFile}`); del.closest('li').remove(); toast('File removed'); }
      catch (e) { toast(e.message, 'error'); }
    }
  });

  onSubmit(form, async v => {
    if (!v.recommended_course) throw new Error('Choose the recommended course');
    if (!v.assessment.trim()) throw Object.assign(new Error('Assessment is required'), { data: { field: 'Assessment *' } });
    if (!v.admission_status) throw new Error('Choose the admission status');
    if (v.admission_status === 'Follow-up' && !v.followup_date) throw Object.assign(new Error('Choose the follow-up date'), { data: { field: 'Follow-up date' } });
    await api('PUT', `/api/candidates/${c.id}/result`, v);
    let failed = 0;
    for (const p of [...pending]) {
      try {
        await api('POST', `/api/candidates/${c.id}/files`, { filename: p.name, mime: p.type, data: await toBase64(p.blob) });
        pending.splice(pending.indexOf(p), 1);
      } catch (e) { failed++; toast(`${p.name}: ${e.message}`, 'error'); }
    }
    if (failed) { drawPending(); throw new Error(`The result was saved, but ${failed} file(s) did not upload. Try saving again.`); }
    toast('Result saved · Manager and Sales rep notified');
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
