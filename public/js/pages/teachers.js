import { api, get, esc, html, raw, pill, table, drawer, onSubmit, options, toast, fmtTime, WEEKDAYS, confirmBox, ApiError } from '../core.js';

const summarize = list => {
  if (!list.length) return '<span class="muted">Not set</span>';
  const byDay = new Map();
  for (const w of list) {
    const k = `${w.start_time}-${w.end_time}${w.format && w.format !== 'Any' ? ' (' + w.format + ')' : ''}`;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(WEEKDAYS[w.weekday]);
  }
  return [...byDay].map(([k, days]) => {
    const [range, fmt] = k.split(' ');
    const [s, e] = range.split('-');
    return `${esc(days.join(', '))}: ${esc(fmtTime(s))}–${esc(fmtTime(e))}${fmt ? ' ' + esc(fmt) : ''}`;
  }).join('<br>');
};

export async function render(page) {
  const rows = await get('/api/teachers');
  page.innerHTML = `<div class="page-head"><div><h1>Teachers</h1>
    <div class="sub">Working hours say when a teacher is on duty. Availability slots are the windows open for booking. Monthly capacity is the planning limit for teaching sessions.</div></div>
    <div class="actions"><button class="btn primary" type="button" id="add-t">Add teacher</button></div></div>
    <div class="notice info">Capacity is counted as teaching sessions per month (a 3:1 group with three students is one session). This definition still needs product confirmation, so going over capacity shows a warning and does not block scheduling.</div>
    <div id="t-list"></div>`;
  page.querySelector('#t-list').innerHTML = table([
    { label: 'Teacher', cell: t => `<strong>${esc(t.name)}</strong><span class="sub">${esc(t.employment_type)}${t.phone ? ' · ' + esc(t.phone) : ''}</span>` },
    { label: 'Formats', cell: t => [t.supports_1to1 && '1:1', t.supports_3to1 && '3:1'].filter(Boolean).join(', ') },
    { label: 'Working hours', cell: t => summarize(t.hours) },
    { label: 'Availability slots', cell: t => summarize(t.slots) },
    { label: 'This month', cell: t => `${t.sessions_this_month} sessions${t.monthly_capacity != null ? ` of ${t.monthly_capacity}` : ''}<span class="sub">${t.active_enrollments} active students</span>` },
    { label: 'Login', cell: t => (t.login_email ? esc(t.login_email) : '<span class="muted">No login</span>') },
    { label: 'Status', cell: t => pill(t.active ? 'Active' : 'Inactive').__raw },
    { label: 'Actions', cls: 'cell-actions', cell: t => `<button class="btn small" type="button" data-edit="${t.id}">Edit</button>` },
  ], rows, { empty: 'No teachers yet', emptyHint: ' Add teachers before assigning pre-tests or classes.' });
  const reload = () => { window.dispatchEvent(new Event('nm:changed')); render(page); };
  page.querySelector('#add-t').addEventListener('click', () => teacherForm(null, reload));
  page.querySelector('#t-list').addEventListener('click', e => {
    const b = e.target.closest('[data-edit]');
    if (b) teacherForm(rows.find(t => String(t.id) === b.dataset.edit), reload);
  });
}

const windowRow = (w = {}, withFormat) => `<div class="windows-row ${withFormat ? '' : 'no-format'}">
  <div class="field"><label>Day</label><select data-k="weekday">${options(WEEKDAYS.map((d, i) => [i, d]), w.weekday ?? 1)}</select></div>
  <div class="field"><label>From</label><input type="time" data-k="start_time" value="${esc(w.start_time || '09:00')}"></div>
  <div class="field"><label>To</label><input type="time" data-k="end_time" value="${esc(w.end_time || '15:00')}"></div>
  ${withFormat ? `<div class="field"><label>Format</label><select data-k="format">${options(['Any', '1:1', '3:1'], w.format || 'Any')}</select></div>` : ''}
  <div class="field"><button class="btn small danger" type="button" data-remove aria-label="Remove row">Remove</button></div></div>`;

function teacherForm(t, after) {
  const editing = !!t;
  drawer({
    title: editing ? `Edit ${t.name}` : 'Add teacher',
    body: html`<form id="t-form" novalidate>
      <div class="grid2">
        <div class="field"><label for="t-name">Name *</label><input id="t-name" name="name" required maxlength="100" value="${t?.name}"></div>
        <div class="field"><label for="t-type">Employment</label><select id="t-type" name="employment_type">${raw(options(['Regular', 'Freelance'], t?.employment_type || 'Regular'))}</select></div>
        <div class="field"><label for="t-phone">Phone</label><input id="t-phone" name="phone" type="tel" maxlength="30" value="${t?.phone}"></div>
        <div class="field"><label for="t-email">Email</label><input id="t-email" name="email" type="email" maxlength="200" value="${t?.email}"></div>
      </div>
      <fieldset><legend>Class formats</legend>
        <label class="check"><input type="checkbox" name="supports_1to1" ${!t || t.supports_1to1 ? 'checked' : ''}> 1:1 (one student per class)</label>
        <label class="check"><input type="checkbox" name="supports_3to1" ${t?.supports_3to1 ? 'checked' : ''}> 3:1 (up to three students per class)</label>
        <div class="field"></div>
      </fieldset>
      <div class="field"><label for="t-cap">Monthly class capacity (sessions)</label><input id="t-cap" name="monthly_capacity" type="number" min="0" max="2000" value="${t?.monthly_capacity}">
        <div class="hint">Leave blank for no limit.</div></div>
      <fieldset><legend>Working hours</legend><div id="hours">${raw((t?.hours || []).map(h => windowRow(h, false)).join(''))}</div>
        <div class="row"><button class="btn small" type="button" data-add="hours">Add hours</button><button class="btn small" type="button" id="std-week">Fill Mon–Sat, 9 AM–3 PM</button></div><div class="field"></div></fieldset>
      <fieldset><legend>Availability slots</legend><p class="small muted">Must sit inside working hours. Leave empty to allow any time within working hours.</p>
        <div id="slots">${raw((t?.slots || []).map(s => windowRow(s, true)).join(''))}</div>
        <button class="btn small" type="button" data-add="slots">Add slot</button><div class="field"></div></fieldset>
      <div class="field"><label for="t-notes">Notes</label><textarea id="t-notes" name="notes">${t?.notes}</textarea></div>
      ${raw(editing ? `<fieldset><legend>Status</legend><label class="check"><input type="checkbox" name="active" ${t.active ? 'checked' : ''}> Active (can be assigned work and sign in)</label><div class="field"></div></fieldset>` : '')}
      ${raw(editing && !t.login_email ? '<p class="small muted">To let this teacher sign in, create a login on the Users page.</p>' : '')}
    </form>`,
    foot: `<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" form="t-form">${editing ? 'Save teacher' : 'Add teacher'}</button>`,
    onMount: (d, close) => {
      const form = d.querySelector('#t-form');
      form.addEventListener('click', e => {
        const add = e.target.closest('[data-add]');
        if (add) d.querySelector('#' + add.dataset.add).insertAdjacentHTML('beforeend', windowRow({}, add.dataset.add === 'slots'));
        if (e.target.closest('[data-remove]')) e.target.closest('.windows-row').remove();
      });
      d.querySelector('#std-week').addEventListener('click', () => {
        d.querySelector('#hours').innerHTML = [1, 2, 3, 4, 5, 6].map(w => windowRow({ weekday: w, start_time: '09:00', end_time: '15:00' }, false)).join('');
      });
      const collect = sel => [...d.querySelectorAll(sel + ' .windows-row')].map(r => Object.fromEntries([...r.querySelectorAll('[data-k]')].map(i => [i.dataset.k, i.value])));
      onSubmit(form, async v => {
        if (!v.name.trim()) throw Object.assign(new Error('Name is required'), { data: { field: 'Name *' } });
        const body = { ...v, hours: collect('#hours'), slots: collect('#slots') };
        if (editing) {
          if (t.active && !v.active) {
            const impact = await get(`/api/teachers/${t.id}/impact`);
            const busy = impact.active_enrollments + impact.upcoming_classes + impact.open_pretests;
            const ok = await confirmBox({
              title: `Deactivate ${t.name}?`,
              message: busy
                ? `${esc(t.name)} still has ${impact.active_enrollments} active enrollment(s), ${impact.upcoming_classes} upcoming class(es) and ${impact.open_pretests} open pre-test(s). Reassign them afterwards. The teacher will not be able to sign in.`
                : `${esc(t.name)} will no longer be offered for new work and will not be able to sign in.`,
              confirmLabel: 'Deactivate', danger: true,
            });
            if (!ok) return teacherForm(t, after);
            body.confirm = true;
          }
          try { await api('PATCH', `/api/teachers/${t.id}`, body); }
          catch (e) { if (e instanceof ApiError && e.data.code === 'NEEDS_CONFIRM') { body.confirm = true; await api('PATCH', `/api/teachers/${t.id}`, body); } else throw e; }
        } else {
          await api('POST', '/api/teachers', body);
        }
        close(); toast(editing ? 'Teacher saved' : 'Teacher added'); after();
      });
    },
  });
}
