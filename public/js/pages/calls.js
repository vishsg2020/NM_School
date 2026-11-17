// Tele team calls: leads, queues (Call later / Reconnect / Interested / Pre-test booked / All), Log a call,
// the lead page with its call history, and the Manager's monthly summary with rep targets.
import {
  state, api, get, esc, html, raw, pill, inr, fmtDate, fmtStamp, fmtTime, fmtMonth, table, drawer, onSubmit, options, opt, setQuery,
  can, toast, uid, todayLocal, addDays, stateBox, confirmBox, ApiError,
} from '../core.js';
import { candidateForm, historyList } from './pretests.js';
import { waNumber } from './admissions.js';
import { barList } from '../charts.js';

const TABS = [['later', 'Call later'], ['reconnect', 'Reconnect'], ['interested', 'Interested'], ['pretest', 'Pre-test booked'], ['all', 'All leads']];
const KEYS = ['q', 'category', 'response', 'rep', 'from', 'to', 'status', 'due', 'created_month'];
const RESP_TONE = { 'Call Later': 'amber', 'Not Available': 'amber', 'Pre Test Booked': 'green', 'Not Interested': 'red', Interested: 'blue', 'Interested – Price Issue': 'blue', 'Sent More Info': 'blue' };
let optionsCache = null;
const loadOptions = async () => (optionsCache = await get('/api/call-options')); // fresh each time (Settings can change them)
const respPill = r => (r ? `<span class="pill ${RESP_TONE[r] || ''}">${esc(r)}</span>` : '<span class="muted">No calls yet</span>');
const statusPill = s => `<span class="pill ${s === 'Closed Won' ? 'green' : s === 'Closed Lost' ? 'red' : ''}">${esc(s)}</span>`;
function callbackText(cb, today) {
  if (!cb) return '<span class="pill amber">No time set</span>';
  const d = cb.slice(0, 10); const t = cb.length > 10 ? ' ' + fmtTime(cb.slice(11, 16)) : '';
  if (d < today) return `<span class="pill red">Overdue · ${esc(fmtDate(d).slice(0, -5))}${esc(t)}</span>`;
  if (d === today) return `<span class="pill amber">Today${esc(t)}</span>`;
  return esc(fmtDate(d) + t);
}
// The old sheet often has a date without a time (stored as midnight): show just the date for those.
function when(iso, source) {
  if (!iso) return '';
  const ist = new Date(Date.parse(iso) + 330 * 60000).toISOString();
  return source === 'import' && ist.slice(11, 16) === '00:00' ? fmtDate(ist.slice(0, 10)) : fmtStamp(iso);
}
const waLink = l => `https://wa.me/${waNumber(l.phone)}?text=${encodeURIComponent(`Hello${l.name ? ' ' + l.name : ''}! This is Nalla Malayalam. `)}`;

// ---------- Calls page ----------
export async function render(page, { query }) {
  const isMgr = can('manager');
  const tab = isMgr && query.tab === 'summary' ? 'summary' : (TABS.some(t => t[0] === query.tab) ? query.tab : 'later');
  const opts = await loadOptions();
  const f = Object.fromEntries(KEYS.map(k => [k, query[k] || '']));
  page.innerHTML = html`<div class="page-head"><div><h1>Calls</h1>
      <div class="sub">${isMgr ? 'Every enquiry and every call. Sales see their own leads and unassigned ones.' : 'Your leads and unassigned ones. Log every call so nothing is forgotten.'}</div></div>
    <div class="actions"><button class="btn primary" type="button" id="log-call">Log a call</button></div></div>
    <div class="tabs" role="tablist" id="tabs">${raw([...TABS, ...(isMgr ? [['summary', 'Summary & targets']] : [])].map(([k, l]) =>
      `<a role="tab" class="tab ${k === tab ? 'on' : ''}" aria-selected="${k === tab}" href="#/calls?tab=${k}">${esc(l)}<b class="hidden" data-count="${k}"></b></a>`).join(''))}</div>
    <div id="calls-body"></div>`;
  page.querySelector('#log-call').addEventListener('click', () => callForm(null, () => render(page, { query })));
  const body = page.querySelector('#calls-body');
  if (tab === 'summary') { await summary(body, query); return; }

  body.innerHTML = html`<form class="filters" id="cf" role="search" aria-label="Filter leads">
      <div class="field grow"><label for="l-q">Search</label><input id="l-q" name="q" type="search" value="${f.q}" placeholder="Name, phone, Lead ID"></div>
      <div class="field"><label for="l-cat">Category</label><select id="l-cat" name="category">${raw(options(opts.categories, f.category, 'All'))}</select></div>
      ${raw(tab === 'all' ? `<div class="field"><label for="l-resp">Last response</label><select id="l-resp" name="response">${options(opts.responses, f.response, 'All')}</select></div>
        <div class="field"><label for="l-st">Status</label><select id="l-st" name="status">${options(['Open', 'Closed Won', 'Closed Lost'], f.status, 'All')}</select></div>` : '')}
      ${raw(isMgr ? `<div class="field"><label for="l-rep">Sales rep</label><select id="l-rep" name="rep">${opt('', 'Everyone', f.rep)}${opt('none', 'Unassigned', f.rep)}${options(state.reps.map(r => [r.id, r.name]), f.rep)}</select></div>` : '')}
      <div class="field"><label for="l-from">Last call from</label><input id="l-from" name="from" type="date" value="${f.from}"></div>
      <div class="field"><label for="l-to">To</label><input id="l-to" name="to" type="date" value="${f.to}"></div>
      ${raw(tab === 'later' ? `<div class="field"><label class="check top-gap"><input type="checkbox" name="due" value="1" ${f.due ? 'checked' : ''}> Due now only</label></div>` : '')}
      <input type="hidden" name="created_month" value="${f.created_month}">
      <button class="btn" type="button" id="l-clear">Clear filters</button>
    </form>
    ${raw(f.created_month ? `<p class="notice info linked-note">Leads created in ${esc(fmtMonth(f.created_month))}.</p>` : '')}
    <p class="result-count" id="l-count" aria-live="polite"></p><div id="l-list">${raw(stateBox('loading'))}</div>`;
  const form = body.querySelector('#cf'); const list = body.querySelector('#l-list');
  let rows = []; let seq = 0;
  async function load() {
    const d = Object.fromEntries(new FormData(form)); setQuery({ tab, ...d });
    const my = ++seq;
    try {
      const r = await get('/api/leads?' + new URLSearchParams(Object.entries({ tab, ...d }).filter(([, v]) => v)));
      if (my !== seq) return;
      rows = r.rows;
      for (const [k, n] of [['later', r.counts.later_due], ['reconnect', r.counts.reconnect], ['interested', r.counts.interested]]) {
        const b = page.querySelector(`[data-count="${k}"]`); if (b) { b.textContent = n; b.classList.toggle('hidden', !n); }
      }
      page.querySelector('#l-count').textContent = `${rows.length} lead${rows.length === 1 ? '' : 's'}${tab === 'later' ? ` · ${r.counts.later_due} due now` : ''}`;
      list.innerHTML = table([
        { label: 'Lead', cell: l => `<a href="#/lead/${l.id}">${esc(l.name || 'No name')}</a><span class="sub">${esc(l.lead_code)}${l.location ? ' · ' + esc(l.location) : ''}${l.age ? ' · age ' + l.age : ''}</span>` },
        { label: 'Phone', cell: l => `<a href="tel:${esc(l.phone)}" class="nowrap">${esc(l.phone || '—')}</a>` },
        { label: 'Category', cell: l => esc(l.category) },
        { label: 'Last response', cell: l => respPill(l.last_response) + (l.last_notes ? `<span class="sub">“${esc(l.last_notes.slice(0, 80))}”</span>` : '') + (l.last_called_at ? `<span class="sub">${esc(when(l.last_called_at, l.last_source))}</span>` : '') },
        ...(tab === 'later' ? [{ label: 'Call back', cell: l => callbackText(l.callback_at, r.today) }] : []),
        ...(tab === 'all' || tab === 'pretest' ? [{ label: 'Status', cell: l => statusPill(l.status) + (l.candidate_code ? `<span class="sub">Candidate ${esc(l.candidate_code)}</span>` : '') }] : []),
        { label: 'Calls', cls: 'num', cell: l => esc(l.calls) },
        { label: 'Rep', cell: l => (l.rep_name ? esc(l.rep_name) : '<span class="muted">Unassigned</span>') },
        { label: 'Actions', cls: 'cell-actions', cell: l => `<button class="btn small primary" type="button" data-call="${l.id}">Log call</button> <a class="btn small" target="_blank" rel="noopener" href="${esc(waLink(l))}">WhatsApp</a>` },
      ], rows, { empty: tab === 'later' ? 'Nobody to call back' : 'No leads match', emptyHint: tab === 'later' ? ' Leads appear here when a call ends with “Call Later”.' : '' });
    } catch (e) { if (my === seq) list.innerHTML = stateBox('error', 'Could not load leads', e.message); }
  }
  let t;
  form.addEventListener('input', e => { clearTimeout(t); t = setTimeout(load, e.target.type === 'search' ? 250 : 0); });
  form.addEventListener('submit', e => { e.preventDefault(); load(); });
  body.querySelector('#l-clear').addEventListener('click', () => { form.querySelectorAll('input:not([type=checkbox]),select').forEach(x => { x.value = ''; }); form.querySelectorAll('[type=checkbox]').forEach(x => { x.checked = false; }); body.querySelector('.linked-note')?.remove(); load(); });
  list.addEventListener('click', async e => {
    const b = e.target.closest('[data-call]'); if (!b) return;
    callForm(await get('/api/leads/' + b.dataset.call), load);
  });
  await load();
}

// ---------- Log a call ----------
export async function callForm(lead, after) {
  const opts = await loadOptions();
  const key = uid(); const isMgr = can('manager');
  let current = lead;
  drawer({
    title: lead ? `Log a call: ${lead.name || lead.lead_code}` : 'Log a call',
    body: html`<form id="call-form" novalidate>
      ${raw(lead ? html`<p class="muted small">${lead.lead_code} · ${lead.phone} · ${lead.calls} earlier call${lead.calls === 1 ? '' : 's'}${raw(lead.last_response ? ` · last: ${esc(lead.last_response)}` : '')}</p>`
        : html`<div class="field"><label for="cl-phone">Phone number *</label><input id="cl-phone" name="phone" type="tel" maxlength="30" autocomplete="off" placeholder="+91 98470 00000"></div>
        <div id="cl-found" aria-live="polite"></div>`)}
      <div class="grid3">
        <div class="field"><label for="cl-name">Name</label><input id="cl-name" name="name" maxlength="100" value="${lead?.name}"></div>
        <div class="field"><label for="cl-loc">Location</label><input id="cl-loc" name="location" maxlength="100" value="${lead?.location}"></div>
        <div class="field"><label for="cl-cat">Category *</label><select id="cl-cat" name="category">${raw(options(opts.categories, lead?.category || '', 'Select'))}</select></div>
      </div>
      <div class="grid3">
        <div class="field"><label for="cl-age">Student age</label><input id="cl-age" name="age" type="number" min="1" max="120" value="${lead?.age}"></div>
        <div class="field"><label for="cl-gender">Gender</label><select id="cl-gender" name="gender">${raw(options(opts.genders, lead?.gender || '', '—'))}</select></div>
        <div class="field"><label for="cl-act">Call status *</label><select id="cl-act" name="action">${raw(options(opts.actions, 'Called'))}</select></div>
      </div>
      ${raw(isMgr && !lead ? `<div class="field" id="cl-rep-f"><label for="cl-rep">Assign to</label><select id="cl-rep" name="assigned_rep_id">${options(state.reps.filter(r => r.active).map(r => [r.id, r.name]), '', 'Unassigned')}</select><div class="hint">For a new number only.</div></div>` : '')}
      <fieldset><legend>Response *</legend><div class="resp-chips">${raw(opts.responses.map((r, i) =>
        `<label class="chip"><input type="radio" name="response" value="${esc(r)}" id="cl-r${i}"><span>${esc(r)}</span></label>`).join(''))}</div></fieldset>
      <div class="grid2 hidden" id="cl-later">
        <div class="field"><label for="cl-cbd">Call back on *</label><input id="cl-cbd" name="callback_date" type="date" value="${addDays(todayLocal(), 1)}"></div>
        <div class="field"><label for="cl-cbt">Time (IST)</label><input id="cl-cbt" name="callback_time" type="time"></div>
      </div>
      <p class="small muted hidden" id="cl-hint"></p>
      <div class="field"><label for="cl-notes">Notes</label><textarea id="cl-notes" name="notes" rows="3" maxlength="2000"></textarea></div>
    </form>`,
    foot: '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" form="call-form" id="cl-save">Save call</button>',
    onMount: (d, close) => {
      const form = d.querySelector('#call-form'); const $ = s => form.querySelector(s);
      const hints = {
        'Not Available': 'Goes to Reconnect, to try again.',
        'Not Interested': 'Closes the lead (Closed Lost). A later call reopens it.',
        'Pre Test Booked': 'After saving, the Add pre-test candidate form opens with these details.',
      };
      const syncResp = () => {
        const r = form.querySelector('[name=response]:checked')?.value;
        $('#cl-later').classList.toggle('hidden', r !== 'Call Later');
        $('#cl-hint').textContent = hints[r] || ''; $('#cl-hint').classList.toggle('hidden', !hints[r]);
        d.querySelector('#cl-save').textContent = r === 'Pre Test Booked' && !current?.candidate_id ? 'Save call & add pre-test candidate' : 'Save call';
      };
      form.querySelectorAll('[name=response]').forEach(x => x.addEventListener('change', syncResp));
      // Known number? Show the lead and fill in empty fields.
      const ph = $('#cl-phone'); let lseq = 0; let lt;
      ph?.addEventListener('input', () => {
        clearTimeout(lt);
        lt = setTimeout(async () => {
          const box = $('#cl-found'); const my = ++lseq;
          if (ph.value.replace(/\D/g, '').length < 6) { box.innerHTML = ''; current = null; return; }
          const r = await get('/api/leads/lookup?phone=' + encodeURIComponent(ph.value)).catch(() => ({ lead: null }));
          if (my !== lseq) return;
          current = r.lead;
          if (r.lead) {
            const l = r.lead;
            box.innerHTML = `<div class="found"><b>Known number · ${esc(l.lead_code)}${l.name ? ' · ' + esc(l.name) : ''}</b><br>${l.calls} earlier call${l.calls === 1 ? '' : 's'}${l.last_response ? ` · last: ${esc(l.last_response)} on ${esc(when(l.last_called_at, l.last_source))}` : ''} · ${l.rep_name ? 'assigned to ' + esc(l.rep_name) : 'unassigned'} · <a href="#/lead/${l.id}">View history</a></div>`;
            for (const [k, sel] of [['name', '#cl-name'], ['location', '#cl-loc'], ['age', '#cl-age']]) if (!$(sel).value && l[k] != null) $(sel).value = l[k];
            if (!$('#cl-cat').value) $('#cl-cat').value = l.category; if (!$('#cl-gender').value && l.gender) $('#cl-gender').value = l.gender;
            d.querySelector('#cl-rep-f')?.classList.add('hidden');
          } else {
            box.innerHTML = r.other_rep ? `<div class="notice warn">This number is a lead of <b>${esc(r.other_rep)}</b>. Ask the Manager to reassign it.</div>` : '<p class="small muted">New number: a lead is created when you save.</p>';
            d.querySelector('#cl-rep-f')?.classList.remove('hidden');
          }
          syncResp();
        }, 300);
      });
      onSubmit(form, async v => {
        if (!v.response) throw new Error('Choose the response');
        if (!lead && !current && !v.category) throw Object.assign(new Error('Choose a category'), { data: { field: 'Category *' } });
        const body = { ...v, idempotency_key: key };
        if (current) { body.lead_id = current.id; delete body.phone; }
        if (!body.age) delete body.age;
        const saved = await api('POST', '/api/calls', body);
        close(); toast('Call saved');
        if (v.response === 'Pre Test Booked' && !saved.candidate_id) {
          const [first, ...rest] = (saved.name || '').split(' ');
          candidateForm(null, () => { toast('Pre-test candidate added and linked to the lead'); after && after(); }, {
            prefill: { first_name: first, last_name: rest.join(' '), phone: saved.phone, age: saved.age, location: saved.location,
              gender: ['Male', 'Female'].includes(saved.gender) ? saved.gender : '', sales_rep_id: saved.assigned_rep_id, notes: v.notes },
            callLead: saved.id,
          });
          return;
        }
        after && after();
      });
    },
  });
}

// ---------- Lead page ----------
export async function renderLead(page, { id }) {
  const l = await get('/api/leads/' + id);
  const isMgr = can('manager');
  const reload = () => renderLead(page, { id });
  page.innerHTML = html`<div class="page-head"><div><h1>${l.name || 'No name'} · ${l.lead_code}</h1>
      <div class="sub">${l.phone} · ${l.category}${raw(l.location ? ' · ' + esc(l.location) : '')}${raw(l.age ? ' · age ' + l.age : '')} · ${l.rep_name || 'Unassigned'} · ${raw(statusPill(l.status))}</div></div>
    <div class="actions"><button class="btn primary" type="button" id="ld-call">Log call</button>
      <a class="btn" target="_blank" rel="noopener" href="${waLink(l)}">WhatsApp</a>
      ${raw(l.candidate_id ? `<a class="btn" href="#/candidate/${l.candidate_id}">Pre-test ${esc(l.candidate_code)}</a>` : '<button class="btn" type="button" id="ld-cand">Add pre-test candidate</button>')}
      ${raw(l.student_id ? `<a class="btn" href="#/student/${l.student_id}">Student</a>` : '')}
      <button class="btn" type="button" id="ld-edit">${isMgr ? 'Edit / reassign' : 'Edit details'}</button></div></div>
    <section class="panel"><h2>Call history <span class="qcount">${l.calls.length}</span></h2>
      ${raw(l.calls.length ? `<ul class="timeline">${l.calls.map(c => `<li><strong>${esc(when(c.called_at, c.source))} · ${esc(c.response || c.action)}</strong> <span class="muted">· ${esc(c.rep_name || '—')}${c.source === 'import' ? ' · from the sheet' : ''}</span>
        ${c.notes ? `<div>${esc(c.notes)}</div>` : ''}${c.callback_at ? `<div class="small">Call back ${esc(fmtDate(c.callback_at.slice(0, 10)))}${c.callback_at.length > 10 ? ' ' + esc(fmtTime(c.callback_at.slice(11))) : ''}</div>` : ''}</li>`).join('')}</ul>` : '<p class="muted">No calls yet.</p>')}
    </section>`;
  page.querySelector('#ld-call').addEventListener('click', () => callForm(l, reload));
  page.querySelector('#ld-cand')?.addEventListener('click', () => {
    const [first, ...rest] = (l.name || '').split(' ');
    candidateForm(null, reload, { prefill: { first_name: first, last_name: rest.join(' '), phone: l.phone, age: l.age, location: l.location,
      gender: ['Male', 'Female'].includes(l.gender) ? l.gender : '', sales_rep_id: l.assigned_rep_id }, callLead: l.id });
  });
  page.querySelector('#ld-edit').addEventListener('click', () => leadForm(l, reload));
}

async function leadForm(l, after) {
  const opts = await loadOptions(); const isMgr = can('manager');
  drawer({
    title: `Edit ${l.lead_code}`,
    body: html`<form id="lead-form" novalidate>
      <div class="grid2">
        <div class="field"><label for="le-phone">Phone *</label><input id="le-phone" name="phone" type="tel" maxlength="30" value="${l.phone}"></div>
        <div class="field"><label for="le-name">Name</label><input id="le-name" name="name" maxlength="100" value="${l.name}"></div>
        <div class="field"><label for="le-loc">Location</label><input id="le-loc" name="location" maxlength="100" value="${l.location}"></div>
        <div class="field"><label for="le-cat">Category *</label><select id="le-cat" name="category">${raw(options(opts.categories, l.category))}</select></div>
        <div class="field"><label for="le-age">Student age</label><input id="le-age" name="age" type="number" min="1" max="120" value="${l.age}"></div>
        <div class="field"><label for="le-g">Gender</label><select id="le-g" name="gender">${raw(options(opts.genders, l.gender || '', '—'))}</select></div>
      </div>
      ${raw(isMgr ? html`<div class="grid2"><div class="field"><label for="le-rep">Assigned rep</label><select id="le-rep" name="assigned_rep_id">${raw(options(state.reps.filter(r => r.active || r.id === l.assigned_rep_id).map(r => [r.id, r.name]), l.assigned_rep_id || '', 'Unassigned'))}</select></div>
        <div class="field"><label for="le-why">Reason (for the history)</label><input id="le-why" name="reason" maxlength="500"></div></div>` : '')}
    </form>`,
    foot: '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" form="lead-form">Save</button>',
    onMount: (d, close) => onSubmit(d.querySelector('#lead-form'), async v => {
      await api('PATCH', `/api/leads/${l.id}`, v); close(); toast('Lead saved'); after && after();
    }),
  });
}

// ---------- Summary & rep targets (Manager) ----------
async function summary(body, query) {
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : todayLocal().slice(0, 7);
  const s = await get('/api/calls/summary?month=' + month);
  const [yy, mm] = month.split('-').map(Number); const end = new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  const t = s.totals; const pct = v => (v == null ? 'n.a.' : `${v}%`);
  const narrow = window.matchMedia('(max-width: 700px)').matches;
  body.innerHTML = html`<div class="row"><label for="cs-m" class="small">Month</label><input id="cs-m" type="month" value="${month}"></div>
    <div class="kpis top-gap">
      <a class="kpi" href="#/calls?tab=all&created_month=${month}"><span class="l">New leads</span><span class="v">${t.new_leads}</span><span class="s">${s.byCategory.slice(0, 2).map(c => `${c.label} ${c.n}`).join(' · ')}</span></a>
      <div class="kpi"><span class="l">Calls logged</span><span class="v">${t.calls}</span><span class="s">by ${t.callers} ${t.callers === 1 ? 'person' : 'people'}</span></div>
      <a class="kpi" href="#/calls?tab=pretest"><span class="l">Pre-tests booked</span><span class="v">${t.pretests_booked}</span><span class="s">from calls this month</span></a>
      <a class="kpi" href="#/students?status=enrolled&admitted_from=${month}-01&admitted_to=${end}"><span class="l">Admitted</span><span class="v">${t.admissions}</span><span class="s">conversion ${pct(t.conversion)}</span></a>
    </div>
    <section class="panel"><div class="row"><h2>Sales reps · ${fmtMonth(month)}</h2><span class="spacer"></span><button class="btn small" type="button" id="cs-copy">Copy last month's targets</button></div>
      ${raw(table([
        { label: 'Sales rep', cell: r => esc(r.name) + (r.active ? '' : '<span class="sub">inactive</span>') },
        { label: 'New leads', cls: 'num', cell: r => `<a href="#/calls?tab=all&created_month=${month}&rep=${r.id}">${r.new_leads}</a>` },
        { label: 'Calls', cls: 'num', cell: r => esc(r.calls) },
        { label: 'Pre-tests', cls: 'num', cell: r => esc(r.pretests_booked) },
        { label: 'Admitted', cls: 'num', cell: r => `<a href="#/students?status=enrolled&admitted_from=${month}-01&admitted_to=${end}&sales_rep=${r.id}">${r.admissions}</a>` },
        { label: 'Conversion', cls: 'num', cell: r => esc(pct(r.conversion)) },
        { label: 'Target', cell: r => (r.target_count != null ? `${r.target_count} admissions${r.min_conversion != null ? ` · min ${r.min_conversion}%` : ''}${r.target_notes ? `<span class="sub">${esc(r.target_notes)}</span>` : ''}` : '<span class="muted">Not set</span>') },
        { label: 'Status', cell: r => (r.target_status ? `<span class="pill ${r.target_status === 'On track' ? 'green' : r.target_status === 'Needs attention' ? 'red' : 'amber'}">${esc(r.target_status)}</span>` : '—') },
        { label: 'To call', cell: r => `<a href="#/calls?tab=later&due=1&rep=${r.id}">${r.call_later_due} due</a><span class="sub">${r.reconnect} reconnect</span>` },
        { label: '', cls: 'cell-actions', cell: r => `<button class="btn small" type="button" data-target="${r.id}">Set target</button>` },
      ], s.reps, { empty: 'No sales reps yet' }))}
      <p class="small muted">Admitted = new admissions credited to the rep (renewals not included), the same figure as Reports. Conversion = admitted ÷ new leads assigned to the rep in the month (n.a. when there are none).</p>
    </section>
    <div class="chart-grid">
      <section class="panel"><h2>New leads by category</h2>${raw(barList(s.byCategory.map(c => ({ label: c.label, value: c.n })), { money: false, title: 'New leads by category', narrow }))}</section>
      <section class="panel"><h2>Calls by response</h2>${raw(barList(s.byResponse.map(c => ({ label: c.label || '—', value: c.n })), { money: false, title: 'Calls by response', narrow }))}</section>
    </div>`;
  body.querySelector('#cs-m').addEventListener('change', ev => { if (/^\d{4}-\d{2}$/.test(ev.target.value)) { setQuery({ tab: 'summary', month: ev.target.value }); summary(body, { month: ev.target.value }); } });
  body.querySelector('#cs-copy').addEventListener('click', async () => {
    const r = await api('POST', '/api/targets/copy', { month });
    toast(r.copied ? `Copied ${r.copied} target${r.copied === 1 ? '' : 's'} from ${fmtMonth(r.from)}` : `Nothing to copy from ${fmtMonth(r.from)}`);
    summary(body, { month });
  });
  body.onclick = ev => {
    const b = ev.target.closest('[data-target]'); if (!b) return;
    const r = s.reps.find(x => String(x.id) === b.dataset.target);
    drawer({
      title: `Set target · ${r.name} · ${fmtMonth(month)}`,
      body: html`<form id="tg-form" novalidate><div class="grid2">
          <div class="field"><label for="tg-c">Admissions target *</label><input id="tg-c" name="target_count" type="number" min="0" value="${r.target_count ?? ''}"></div>
          <div class="field"><label for="tg-m">Minimum conversion (%)</label><input id="tg-m" name="min_conversion" type="number" min="0" max="100" step="0.5" value="${r.min_conversion ?? ''}"></div></div>
        <div class="field"><label for="tg-n">Notes</label><input id="tg-n" name="notes" maxlength="500" value="${r.target_notes ?? ''}"></div></form>`,
      foot: '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" form="tg-form">Save target</button>',
      onMount: (d, close) => onSubmit(d.querySelector('#tg-form'), async v => {
        await api('PUT', '/api/targets', { ...v, month, user_id: r.id }); close(); toast('Target saved'); summary(body, { month });
      }),
    });
  };
}
