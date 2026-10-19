import {
  state, api, get, esc, html, raw, pill, fmtDate, fmtTime, fmtDT, table, drawer, onSubmit, options, opt, teacherOptions,
  setQuery, can, toast, todayLocal, addDays, stateBox, ApiError, WEEKDAYS,
} from '../core.js';

const STATUSES = ['Scheduled', 'Completed', 'Cancelled', 'Student Absent', 'Teacher Absent', 'Rescheduled'];
const KEYS = ['q', 'student', 'teacher', 'status', 'date', 'date_from', 'date_to'];
const VIEW_KEY = 'nm.classes.view';
const savedView = () => { try { return localStorage.getItem(VIEW_KEY); } catch { return null; } };
const saveView = v => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export async function renderActivity(page, { query }) {
  const f = Object.fromEntries(KEYS.map(k => [k, query[k] || '']));
  const isMgr = can('manager');
  const view = (query.view || savedView() || 'list') === 'month' ? 'month' : 'list';
  saveView(view);
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : (f.date || todayLocal()).slice(0, 7);
  const students = await get('/api/students');
  page.innerHTML = html`<div class="page-head"><div><h1>Class Activity</h1>
    <div class="sub">Record attendance, topics, homework and progress. Completing a class counts it once against the package.</div></div>
    <div class="actions"><div class="seg" role="radiogroup" aria-label="View">
      <label><input type="radio" name="view" value="list" ${view === 'list' ? 'checked' : ''}><span>List</span></label>
      <label><input type="radio" name="view" value="month" ${view === 'month' ? 'checked' : ''}><span>Month</span></label>
    </div></div></div>
    <form class="filters" id="cf" role="search" aria-label="Filter classes">
      <div class="field"><label for="c-student">Student</label><select id="c-student" name="student">${raw(options(students.map(s => [s.id, s.student_name + ' (' + s.lead_id + ')']), f.student, 'All students'))}</select></div>
      ${raw(isMgr ? `<div class="field"><label for="c-teacher">Teacher</label><select id="c-teacher" name="teacher">${opt('', 'All teachers', f.teacher)}${teacherOptions(f.teacher, { activeOnly: false, blank: null })}</select></div>` : '')}
      <div class="field"><label for="c-status">Status</label><select id="c-status" name="status">${raw(opt('', 'All statuses', f.status) + opt('needs_update', 'Past, not yet updated', f.status) + options(STATUSES, f.status))}</select></div>
      ${raw(view === 'list' ? html`<div class="field"><label for="c-date">Date</label><input id="c-date" name="date" type="date" value="${f.date}"></div>
      <div class="field"><label for="c-from">From</label><input id="c-from" name="date_from" type="date" value="${f.date_from}"></div>
      <div class="field"><label for="c-to">To</label><input id="c-to" name="date_to" type="date" value="${f.date_to}"></div>` : '')}
      <div class="field grow"><label for="c-q">Search</label><input id="c-q" name="q" type="search" value="${f.q}" placeholder="Class ID, student, Lead ID"></div>
      <button class="btn" type="button" id="c-clear">Clear filters</button>
    </form>
    <p class="result-count" id="c-count" aria-live="polite"></p>
    <div id="c-list">${raw(stateBox('loading'))}</div>`;
  const form = page.querySelector('#cf'); const list = page.querySelector('#c-list');
  let rows = []; let seq = 0;
  page.querySelectorAll('[name=view]').forEach(r => r.addEventListener('change', () => {
    saveView(r.value);
    const d = Object.fromEntries(new FormData(form));
    const keep = Object.entries(d).filter(([k, v]) => v && !['date', 'date_from', 'date_to'].includes(k));
    location.hash = '#/classes?' + new URLSearchParams([...keep, ['view', r.value], ...(r.value === 'month' ? [['month', month]] : [])]);
  }));
  if (view === 'month') {
    const loadMonth = () => monthView(page, list, form, month, isMgr);
    form.addEventListener('input', () => loadMonth());
    form.addEventListener('submit', e => { e.preventDefault(); loadMonth(); });
    page.querySelector('#c-clear').addEventListener('click', () => { form.querySelectorAll('input,select').forEach(x => { x.value = ''; }); loadMonth(); });
    list.addEventListener('click', e => {
      const b = e.target.closest('[data-open]'); if (b) activityForm(b.dataset.open, loadMonth);
    });
    await loadMonth();
    return;
  }
  async function load() {
    const d = Object.fromEntries(new FormData(form)); setQuery({ ...d, view: 'list' });
    const my = ++seq;
    try {
      rows = await get('/api/classes?' + new URLSearchParams(Object.entries(d).filter(([, v]) => v)));
      if (my !== seq) return;
      const n = Object.values(d).filter(Boolean).length;
      page.querySelector('#c-count').textContent = `${rows.length} class${rows.length === 1 ? '' : 'es'}${n ? ' match the filters' : ''}`;
      list.innerHTML = table([
        { label: 'Class ID', cell: r => `<button class="linkbtn" type="button" data-open="${r.id}">${esc(r.class_code)}</button>` },
        { label: 'When', cell: r => `<span class="nowrap">${esc(fmtDate(r.scheduled_at))}</span><span class="sub">${esc(fmtTime(r.scheduled_at.slice(11)))} · ${r.duration_min} min</span>` },
        { label: 'Student', cell: r => `${isMgr ? `<a href="#/student/${r.student_id}">${esc(r.student_name)}</a>` : esc(r.student_name)}<span class="sub">${esc(r.course)} · ${esc(r.format)}</span>` },
        ...(isMgr ? [{ label: 'Teacher', cell: r => esc(r.teacher_name) }] : []),
        { label: 'Status', cell: r => pill(r.status).__raw + (r.attendance ? ' ' + pill(r.attendance).__raw : '') },
        { label: 'Topics', cell: r => esc(r.topics || '—') },
        { label: 'Remaining', cls: 'num', cell: r => `${r.remaining_classes} <span class="sub">of ${r.total_classes}</span>` },
        { label: 'Actions', cls: 'cell-actions', cell: r => `<button class="btn small ${r.status === 'Scheduled' ? 'primary' : ''}" type="button" data-open="${r.id}">${r.status === 'Scheduled' ? 'Record' : 'View'}</button>` },
      ], rows, n ? { empty: 'No classes match these filters', emptyHint: ' Try clearing a filter.' } : { empty: 'No classes yet', emptyHint: ' Schedule classes from a student profile.' });
    } catch (e) { if (my === seq) list.innerHTML = stateBox('error', 'Could not load classes', e.message); }
  }
  let t;
  form.addEventListener('input', e => { clearTimeout(t); t = setTimeout(load, e.target.type === 'search' ? 250 : 0); });
  form.addEventListener('submit', e => { e.preventDefault(); load(); });
  page.querySelector('#c-clear').addEventListener('click', () => { form.querySelectorAll('input,select').forEach(x => { x.value = ''; }); load(); });
  list.addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (b) activityForm(b.dataset.open, load); });
  await load();
  if (query.open) activityForm(query.open, load);
}

/** Month grid (Mon–Sun) of classes, plus pre-tests when no student/status filter is set. */
async function monthView(page, list, form, month, isMgr) {
  const d = Object.fromEntries(new FormData(form));
  setQuery({ ...d, view: 'month', month });
  const first = `${month}-01`;
  const lead = (new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7; // days before the 1st back to Monday
  const gridStart = addDays(first, -lead);
  const [y, m] = month.split('-').map(Number);
  const last = addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1);
  const tail = (7 - ((lead + Number(last.slice(8))) % 7)) % 7;
  const gridEnd = addDays(last, tail);
  const prev = addDays(first, -1).slice(0, 7); const next = addDays(last, 1).slice(0, 7);
  list.innerHTML = stateBox('loading');
  const qs = new URLSearchParams(Object.entries({ ...d, date_from: gridStart, date_to: gridEnd, order: 'asc' }).filter(([, v]) => v));
  const [classes, pretests] = await Promise.all([
    get('/api/classes?' + qs),
    d.student || d.status ? Promise.resolve([]) : get(`/api/candidates?date_from=${gridStart}&date_to=${gridEnd}${isMgr && d.teacher ? '&teacher=' + d.teacher : ''}`).catch(() => []),
  ]);
  page.querySelector('#c-count').textContent = `${classes.filter(c => c.scheduled_at.startsWith(month)).length} classes in ${MONTHS[m - 1]} ${y}`;
  const today = todayLocal();
  const byDay = new Map();
  const add = (day, ev) => { if (!byDay.has(day)) byDay.set(day, []); byDay.get(day).push(ev); };
  for (const c of classes) {
    const late = c.status === 'Scheduled' && c.scheduled_at.slice(0, 10) < today;
    const cls = c.status === 'Completed' ? 'done' : ['Cancelled', 'Student Absent', 'Teacher Absent', 'Rescheduled'].includes(c.status) ? 'cancel' : late ? 'late' : 'sched';
    add(c.scheduled_at.slice(0, 10), { at: c.scheduled_at, html: `<button type="button" class="mev ${cls}" data-open="${c.id}" title="${esc(`${c.class_code} · ${c.student_name} · ${c.status}${isMgr ? ' · ' + c.teacher_name : ''}`)}">${esc(fmtTime(c.scheduled_at.slice(11)))} ${esc(c.student_name.split(' ')[0])}${isMgr && !d.teacher ? ' · ' + esc(c.teacher_name.replace(/^Demo Teacher /, '').split(' ')[0]) : ''}${late ? ' · not updated' : ''}</button>` });
  }
  for (const p of pretests) {
    if (!p.pretest_at || p.status === 'Cancelled') continue;
    add(p.pretest_at.slice(0, 10), { at: p.pretest_at, html: `<a class="mev pre" href="#/candidate/${p.id}">${esc(fmtTime(p.pretest_at.slice(11)))} Pre-test ${esc(p.student_name.split(' ')[0])}</a>` });
  }
  const MAX = 3;
  let cells = '';
  for (let day = gridStart; day <= gridEnd; day = addDays(day, 1)) {
    const evs = (byDay.get(day) || []).sort((a, b) => a.at.localeCompare(b.at));
    const out = !day.startsWith(month);
    cells += `<div class="mday ${out ? 'out' : ''} ${day === today ? 'today' : ''}" aria-label="${esc(fmtDate(day))}"><div class="mnum">${Number(day.slice(8))}</div>
      ${evs.slice(0, MAX).map(e => e.html).join('')}
      ${evs.length ? `<a class="mcount" href="#/classes?view=list&date=${day}${d.teacher ? '&teacher=' + d.teacher : ''}" aria-label="${evs.length} on ${esc(fmtDate(day))}">${evs.length}</a>` : ''}
      ${evs.length > MAX ? `<a class="mmore" href="#/classes?view=list&date=${day}${d.teacher ? '&teacher=' + d.teacher : ''}">+${evs.length - MAX} more</a>` : ''}</div>`;
  }
  list.innerHTML = `<div class="mhead"><a class="btn small" href="#/classes?view=month&month=${prev}" aria-label="Previous month">‹</a>
      <h2>${MONTHS[m - 1]} ${y}</h2><a class="btn small" href="#/classes?view=month&month=${next}" aria-label="Next month">›</a>
      <a class="btn small" href="#/classes?view=month&month=${today.slice(0, 7)}">Today</a></div>
    <div class="month-grid">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(w => `<div class="mdn">${w}</div>`).join('')}${cells}</div>
    <div class="mlegend"><span><i class="sched"></i>Scheduled</span><span><i class="done"></i>Completed</span><span><i class="late"></i>Past, not updated</span><span><i class="cancel"></i>Cancelled / absent</span><span><i class="pre"></i>Pre-test</span></div>`;
  // keep current filters on the month arrows
  const extra = Object.entries(d).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
  list.querySelectorAll('.mhead a').forEach(a => { a.href += extra; });
}

export async function activityForm(id, after) {
  const c = await get('/api/classes/' + id);
  const isMgr = can('manager');
  const lockedStatus = c.status === 'Completed' && !isMgr;
  const statusOpts = lockedStatus ? ['Completed'] : STATUSES;
  drawer({
    title: `${c.class_code} · ${c.student_name}`,
    body: html`<form id="act-form" novalidate>
      <dl class="facts">
        <dt>Scheduled</dt><dd>${fmtDT(c.scheduled_at)} · ${c.duration_min} min · ${c.format}</dd>
        <dt>Teacher</dt><dd>${c.teacher_name}</dd>
        <dt>Course</dt><dd>${c.course} · Lead ${c.lead_id}</dd>
        <dt>Package</dt><dd>${c.completed_classes} completed · <strong>${c.remaining_classes} remaining</strong> of ${c.total_classes}</dd>
        ${raw(c.recorded_at ? `<dt>Last recorded</dt><dd>${esc(c.recorded_by_name)} · ${esc(new Date(c.recorded_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}</dd>` : '')}
      </dl>
      <p></p>
      <div class="grid2">
        <div class="field"><label for="a-st">Class status</label><select id="a-st" name="status" ${lockedStatus ? 'disabled' : ''}>${raw(options(statusOpts, c.status))}</select>
          ${raw(lockedStatus ? '<div class="hint">Completed classes can only be changed by the Manager.</div>' : '')}</div>
        <div class="field"><label for="a-att">Attendance</label><select id="a-att" name="attendance">${raw(options(['Present', 'Late', 'Absent'], c.attendance, 'Not recorded'))}</select></div>
      </div>
      <div class="field"><label for="a-top">Topics covered</label><textarea id="a-top" name="topics">${c.topics}</textarea></div>
      <div class="field"><label for="a-hw">Homework</label><textarea id="a-hw" name="homework">${c.homework}</textarea></div>
      <div class="field"><label for="a-prog">Learning progress</label><textarea id="a-prog" name="progress" placeholder="What the student can now do">${c.progress}</textarea></div>
      <div class="grid2">
        <div class="field"><label for="a-next">Next class date</label><input id="a-next" name="next_class_date" type="date" value="${c.next_class_date}"></div>
      </div>
      <div class="field"><label for="a-notes">Notes</label><textarea id="a-notes" name="notes">${c.notes}</textarea></div>
      ${raw(c.status === 'Scheduled' ? html`<fieldset><legend>Move this class</legend>
        <div class="grid3">
          <div class="field"><label for="a-d">Date</label><input id="a-d" name="new_date" type="date" value="${c.scheduled_at.slice(0, 10)}"></div>
          <div class="field"><label for="a-t">Time</label><input id="a-t" name="new_time" type="time" value="${c.scheduled_at.slice(11, 16)}"></div>
          <div class="field"><label for="a-dur">Minutes</label><input id="a-dur" name="duration_min" type="number" min="5" max="240" value="${c.duration_min}"></div>
        </div></fieldset>` : '')}
      ${raw(isMgr && c.status === 'Completed' ? '<div class="field"><label for="a-reason">Reason for correction</label><input id="a-reason" name="reason" maxlength="500"></div>' : '')}
      <div id="ack-box"></div>
    </form>`,
    foot: '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" form="act-form">Save class</button>',
    onMount: (d, close) => {
      const form = d.querySelector('#act-form');
      const st = form.querySelector('#a-st'); const att = form.querySelector('#a-att');
      st.addEventListener('change', () => {
        if (st.value === 'Completed' && !att.value) att.value = 'Present';
        if (st.value === 'Student Absent') att.value = 'Absent';
      });
      let ack = false;
      onSubmit(form, async v => {
        const body = { attendance: v.attendance || null, topics: v.topics, homework: v.homework, progress: v.progress, notes: v.notes, next_class_date: v.next_class_date, reason: v.reason };
        if (!lockedStatus) body.status = v.status;
        if (v.new_date && (`${v.new_date}T${v.new_time}` !== c.scheduled_at || Number(v.duration_min) !== c.duration_min)) {
          if (v.status !== 'Scheduled') throw new Error('Move the class or change its status, not both at once');
          body.scheduled_at = `${v.new_date}T${v.new_time}`; body.duration_min = v.duration_min;
        }
        if (body.status === 'Completed' && !['Present', 'Late'].includes(body.attendance)) throw new Error('A Completed class needs attendance Present or Late');
        body.acknowledge_warnings = ack;
        try {
          const r = await api('PATCH', `/api/classes/${c.id}`, body);
          close();
          toast(r.status === 'Completed' && c.status !== 'Completed' ? `Class completed · ${r.remaining_classes} remaining` : 'Class saved');
          after && after();
        } catch (e) {
          if (e instanceof ApiError && e.data.code === 'NEEDS_ACK') {
            ack = true;
            d.querySelector('#ack-box').innerHTML = warnBox(e.data, 'Save again to move the class anyway.');
            return;
          }
          throw e;
        }
      });
    },
  });
}

function warnBox(data, tail) {
  const items = [...(data.general || []), ...(data.results || []).flatMap(r => r.warnings.map(w => `${fmtDT(r.scheduled_at)}: ${w}`))];
  return `<div class="notice warn" role="alert"><strong>Please review:</strong><ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>${esc(tail)}</div>`;
}

/** Schedule one or a series of classes for an enrollment. */
export function scheduleForm(e, after) {
  const isMgr = can('manager');
  const remaining = e.total_classes - e.completed_classes;
  const start = e.start_date > todayLocal() ? e.start_date : todayLocal();
  drawer({
    title: `Schedule classes: ${e.student_name}`,
    body: html`<form id="sch-form" novalidate>
      <p class="muted">${e.course} · ${e.class_mode} · ${remaining} classes remaining in the package</p>
      <fieldset><legend>How many</legend>
        <label class="check"><input type="radio" name="kind" value="series" checked> Repeating weekly</label>
        <label class="check"><input type="radio" name="kind" value="single"> One class</label><div class="field"></div>
      </fieldset>
      <div class="grid3">
        <div class="field"><label for="s-date">First date</label><input id="s-date" name="start_date" type="date" value="${start}"></div>
        <div class="field"><label for="s-time">Time (IST)</label><input id="s-time" name="time" type="time" value="${e.slot_time || '17:00'}"></div>
        <div class="field"><label for="s-dur">Minutes</label><input id="s-dur" name="duration_min" type="number" min="5" max="240" value="${e.class_mode === '3:1' ? 40 : 30}"></div>
      </div>
      <div id="series-fields">
        <fieldset><legend>Weekdays</legend><div class="row">
          ${raw(WEEKDAYS.map((w, i) => `<label class="check"><input type="checkbox" name="wd${i}" ${(e.slot_days ? e.slot_days.split(',').map(Number) : [1, 3, 5]).includes(i) ? 'checked' : ''}> ${w}</label>`).join(''))}
        </div><div class="field"></div></fieldset>
        <div class="field"><label for="s-count">Number of classes</label><input id="s-count" name="count" type="number" min="1" max="200" value="${Math.max(1, Math.min(remaining, 12))}"></div>
      </div>
      ${raw(isMgr ? `<div class="field"><label for="s-teacher">Teacher</label><select id="s-teacher" name="teacher_id">${teacherOptions(e.teacher_id, { mode: e.class_mode, blank: null })}</select><div class="hint">Change only to book a substitute for these classes.</div></div>` : '')}
      <div id="sch-result"></div>
    </form>`,
    foot: '<button class="btn" type="button" id="sch-check">Check availability</button><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" form="sch-form">Schedule</button>',
    onMount: (d, close) => {
      const form = d.querySelector('#sch-form');
      const res = d.querySelector('#sch-result');
      form.querySelectorAll('[name=kind]').forEach(r => r.addEventListener('change', () => {
        d.querySelector('#series-fields').classList.toggle('hidden', form.kind.value === 'single');
      }));
      let ack = false;
      form.addEventListener('input', () => { ack = false; });
      const body = () => {
        const v = Object.fromEntries(new FormData(form));
        const b = { enrollment_id: e.id, duration_min: v.duration_min, teacher_id: v.teacher_id };
        if (v.kind === 'single') b.scheduled_at = `${v.start_date}T${v.time}`;
        else Object.assign(b, { start_date: v.start_date, time: v.time, count: v.count, weekdays: WEEKDAYS.map((_, i) => (v['wd' + i] ? i : -1)).filter(i => i >= 0) });
        return b;
      };
      const showResults = (data, ok) => {
        const rows = data.results || [];
        const errs = rows.filter(r => r.errors.length); const warns = rows.filter(r => r.warnings.length);
        res.innerHTML = (data.general?.length ? `<div class="notice warn">${data.general.map(esc).join('<br>')}</div>` : '') +
          (errs.length ? `<div class="notice error" role="alert"><strong>${errs.length} of ${rows.length} cannot be booked:</strong><ul>${errs.map(r => `<li>${esc(fmtDT(r.scheduled_at))}: ${esc(r.errors.join('; '))}</li>`).join('')}</ul></div>` : '') +
          (warns.length ? `<div class="notice warn"><strong>Warnings:</strong><ul>${warns.map(r => `<li>${esc(fmtDT(r.scheduled_at))}: ${esc(r.warnings.join('; '))}</li>`).join('')}</ul>${ok ? '' : 'Press Schedule again to book anyway.'}</div>` : '') +
          (!errs.length && !warns.length && !data.general?.length ? `<div class="notice info">All ${rows.length} class time${rows.length === 1 ? '' : 's'} are free: ${esc(rows.slice(0, 6).map(r => fmtDT(r.scheduled_at)).join(', '))}${rows.length > 6 ? '…' : ''}</div>` : '');
      };
      d.querySelector('#sch-check').addEventListener('click', async () => {
        try { showResults(await api('POST', '/api/classes/check', body()), true); } catch (err) { res.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
      });
      onSubmit(form, async () => {
        try {
          const r = await api('POST', '/api/classes', { ...body(), acknowledge_warnings: ack });
          close(); toast(`${r.length} class${r.length === 1 ? '' : 'es'} scheduled`); after && after();
        } catch (err) {
          if (err instanceof ApiError && (err.data.code === 'NEEDS_ACK' || err.data.code === 'SCHEDULE_CONFLICT')) {
            showResults(err.data, false);
            ack = err.data.code === 'NEEDS_ACK';
            return;
          }
          throw err;
        }
      });
    },
  });
}

// ---------- Calendar ----------
export async function renderCalendar(page, { query }) {
  const isMgr = can('manager');
  const today = todayLocal();
  // Start weeks on Monday.
  const base = query.week || today;
  const wd = new Date(base + 'T00:00:00Z').getUTCDay();
  const monday = addDays(base, -((wd + 6) % 7));
  const teacher = isMgr ? (query.teacher || '') : String(state.me.teacher_id);
  const data = await get(`/api/calendar?from=${monday}&to=${addDays(monday, 6)}${teacher ? '&teacher=' + teacher : ''}`);
  page.innerHTML = html`<div class="page-head"><div><h1>${isMgr ? 'Teacher calendar' : 'My calendar'}</h1>
      <div class="sub">Week of ${fmtDate(monday)}</div></div>
      <div class="actions">
        ${raw(isMgr ? `<label class="sr-only" for="cal-t">Teacher</label><select id="cal-t">${opt('', 'All teachers', teacher)}${teacherOptions(teacher, { activeOnly: false, blank: null })}</select>` : '')}
        <a class="btn" href="#/calendar?week=${addDays(monday, -7)}${teacher && isMgr ? '&teacher=' + teacher : ''}">Previous week</a>
        <a class="btn" href="#/calendar${teacher && isMgr ? '?teacher=' + teacher : ''}">This week</a>
        <a class="btn" href="#/calendar?week=${addDays(monday, 7)}${teacher && isMgr ? '&teacher=' + teacher : ''}">Next week</a>
      </div></div>
    <div class="legend"><span><i></i>Class</span><span><i class="alt"></i>Pre-test</span></div><p></p>
    <div class="week">${raw([0, 1, 2, 3, 4, 5, 6].map(i => dayCell(addDays(monday, i), data, today, !!teacher)).join(''))}</div>`;
  page.querySelector('#cal-t')?.addEventListener('change', ev => { location.hash = `#/calendar?week=${monday}${ev.target.value ? '&teacher=' + ev.target.value : ''}`; });
}

function dayCell(date, data, today, oneTeacher) {
  const wd = new Date(date + 'T00:00:00Z').getUTCDay();
  const hours = data.hours.filter(h => h.weekday === wd);
  // Group 3:1 students who share a teacher and start time into one session.
  const sessions = new Map();
  for (const c of data.classes.filter(c => c.scheduled_at.startsWith(date))) {
    const k = `${c.teacher_id}|${c.scheduled_at}|${c.format}`;
    if (!sessions.has(k)) sessions.set(k, []);
    sessions.get(k).push(c);
  }
  const events = [
    ...[...sessions.values()].map(g => ({ at: g[0].scheduled_at, html: sessionEv(g, oneTeacher) })),
    ...data.pretests.filter(p => p.pretest_at.startsWith(date)).map(p => ({ at: p.pretest_at, html:
      `<a class="ev pretest" href="#/candidate/${p.id}"><b>${esc(fmtTime(p.pretest_at.slice(11)))} Pre-test</b>${esc(p.student_name)}${oneTeacher ? '' : ` · ${esc(p.teacher_name || 'Unassigned')}`}${p.time_confirmation !== 'Confirmed' ? ' · time not confirmed' : ''}</a>` })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return `<section class="day ${date === today ? 'today' : ''}" aria-label="${esc(fmtDate(date))}">
    <div class="day-head"><span>${esc(fmtDate(date).replace(/ \d{4}$/, ''))}</span>${date === today ? '<span>Today</span>' : ''}</div>
    ${oneTeacher ? `<div class="day-hours">${hours.length ? 'Working ' + hours.map(h => `${fmtTime(h.start_time)}–${fmtTime(h.end_time)}`).join(', ') : 'Not a working day'}</div>` : ''}
    ${events.map(e => e.html).join('') || '<div class="muted small">Nothing booked</div>'}</section>`;
}

function sessionEv(g, oneTeacher) {
  const c = g[0];
  const allDone = g.every(x => x.status === 'Completed');
  const allCancelled = g.every(x => ['Cancelled', 'Teacher Absent', 'Student Absent'].includes(x.status));
  const names = g.map(x => esc(x.student_name)).join(', ');
  const href = g.length === 1 ? `#/classes?open=${c.id}` : `#/classes?date=${c.scheduled_at.slice(0, 10)}`;
  return `<a class="ev ${allDone ? 'done' : ''} ${allCancelled ? 'cancel' : ''}" href="${href}"><b>${esc(fmtTime(c.scheduled_at.slice(11)))} · ${esc(c.format)}${c.format === '3:1' ? ` (${g.length}/3)` : ''}</b>${names}${oneTeacher ? '' : ` · ${esc(c.teacher_name)}`}${allDone ? ' · done' : ''}</a>`;
}
