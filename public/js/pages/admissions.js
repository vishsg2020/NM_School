import {
  api, get, esc, html, raw, pill, inr, fmtDate, fmtStamp, table, drawer, onSubmit, options, teacherOptions,
  setQuery, toast, uid, todayLocal, stateBox, addDays,
} from '../core.js';
import { historyList } from './pretests.js';

const METHODS = ['UPI', 'Bank Transfer', 'Cash', 'Card', 'Other'];
const COURSES = ['Starter', 'Reader', 'Writer', 'Malayalam Master'];
// From the Nalla Malayalam course fee structure (per class).
const RATES = [
  ['250', 'Premium 1:1 — ₹250 per class', '1:1'],
  ['350', 'Weekend special 1:1 — ₹350 per class', '1:1'],
  ['150', '3:1 small group — ₹150 per student per class', '3:1'],
];

export async function renderPending(page) {
  const rows = await get('/api/admissions/pending');
  page.innerHTML = `<div class="page-head"><div><h1>Admissions</h1>
    <div class="sub">Students with a Confirmed pre-test who still need admission setup. Setup creates the enrollment and the Advance and Final payments.</div></div></div>
    <div id="list"></div>`;
  page.querySelector('#list').innerHTML = table([
    { label: 'Lead ID', cell: r => esc(r.lead_id) },
    { label: 'Student', cell: r => `<a href="#/candidate/${r.candidate_id}">${esc(r.student_name)}</a><span class="sub">${esc([r.parent_name, r.age ? 'age ' + r.age : '', r.location].filter(Boolean).join(' · '))}</span>` },
    { label: 'Recommended', cell: r => esc(r.recommended_course) + (r.recommendation ? `<span class="sub">${esc(r.recommendation)}</span>` : '') },
    { label: 'Pre-test teacher', cell: r => esc(r.pretest_teacher_name) },
    { label: 'Sales rep', cell: r => esc(r.sales_rep_name) },
    { label: 'Confirmed', cell: r => esc(fmtStamp(r.submitted_at)) },
    { label: 'Actions', cls: 'cell-actions', cell: r => `<button class="btn small primary" type="button" data-setup="${r.student_id}">Set up admission</button>` },
  ], rows, { empty: 'No students are waiting for admission setup', emptyHint: ' Confirmed pre-test results appear here.' });
  page.querySelector('#list').addEventListener('click', e => {
    const b = e.target.closest('[data-setup]');
    if (!b) return;
    const r = rows.find(x => String(x.student_id) === b.dataset.setup);
    openAdmission(r, () => { window.dispatchEvent(new Event('nm:changed')); location.hash = '#/student/' + r.student_id; });
  });
}

const payFields = (stage, d) => html`
  <fieldset><legend>${stage} payment</legend>
    <div class="grid2">
      <div class="field"><label for="${stage}-amt">${stage} amount (₹) *</label><input id="${stage}-amt" name="${stage}_amount" type="number" min="0" step="1" inputmode="numeric" value="${d.amount}"></div>
      <div class="field"><label for="${stage}-st">${stage} status *</label><select id="${stage}-st" name="${stage}_status" data-stage="${stage}">${raw(options(['Pending', 'Paid'], d.status))}</select></div>
      <div class="field"><label for="${stage}-date" data-date-label="${stage}">${d.status === 'Paid' ? 'Received date' : 'Due date'} *</label><input id="${stage}-date" name="${stage}_date" type="date" value="${d.date}"></div>
      <div class="field"><label for="${stage}-m">Method${d.status === 'Paid' ? ' *' : ''}</label><select id="${stage}-m" name="${stage}_method">${raw(options(METHODS, d.method, '—'))}</select></div>
    </div>
    <div class="field"><label for="${stage}-ref">Reference</label><input id="${stage}-ref" name="${stage}_reference" maxlength="100" value="${d.reference}" placeholder="UPI / transaction ID"></div>
  </fieldset>`;

/** Admission setup drawer. s: { student_id, student_name, lead_id, sales_rep_name, recommended_course } */
export function openAdmission(s, after) {
  const key = uid();
  const t = todayLocal();
  drawer({
    title: `Admission: ${s.student_name}`,
    body: html`<form id="adm-form" novalidate>
      <p class="muted small">Lead ${s.lead_id} · Sales rep ${s.sales_rep_name} (kept for attribution)</p>
      <div class="grid2">
        <div class="field"><label for="a-course">Course *</label><select id="a-course" name="course">${raw(options(COURSES, s.recommended_course, 'Select'))}</select>
          <div class="hint">Pre-test recommended: ${s.recommended_course}</div></div>
        <div class="field"><label for="a-mode">Class mode *</label><select id="a-mode" name="class_mode">${raw(options([['1:1', '1:1 (one student)'], ['3:1', '3:1 (group of up to 3)']], '1:1'))}</select></div>
        <div class="field"><label for="a-teacher">Teaching teacher *</label><select id="a-teacher" name="teacher_id">${raw(teacherOptions('', { mode: '1:1' }))}</select>
          <div class="hint">Can differ from the pre-test teacher.</div></div>
        <div class="field"><label for="a-start">Start date *</label><input id="a-start" name="start_date" type="date" value="${t}"></div>
        <div class="field"><label for="a-classes">Total classes *</label><input id="a-classes" name="total_classes" type="number" min="1" max="1000" inputmode="numeric" value="30"></div>
        <div class="field"><label for="a-fee">Total course fee (₹) *</label><input id="a-fee" name="total_fee" type="number" min="0" step="1" inputmode="numeric"></div>
      </div>
      <fieldset><legend>Fee helper</legend>
        <div class="grid2">
          <div class="field"><label for="a-rate">Rate card</label><select id="a-rate" name="rate">${raw(options(RATES.map(r => [r[0], r[1]]), '250'))}</select></div>
          <div class="field"><label class="check"><input type="checkbox" name="outside" id="a-out"> Outside 9 AM–9 PM (+₹50 per class, 1:1 only)</label></div>
        </div>
        <div class="row"><span id="a-suggest" class="muted"></span><button class="btn small" type="button" id="a-use">Use this fee</button></div>
        <div class="field"></div>
      </fieldset>
      ${raw(payFields('Advance', { status: 'Paid', date: t }))}
      ${raw(payFields('Final', { status: 'Pending', date: addDays(t, 30) }))}
      <div class="row"><button class="btn small" type="button" id="a-balance">Fill Final with the remaining balance</button></div>
      <div class="field"></div>
      <div class="field"><label for="a-notes">Notes</label><textarea id="a-notes" name="notes" maxlength="2000"></textarea></div>
    </form>`,
    foot: '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" form="adm-form">Save admission</button>',
    onMount: (d, close) => {
      const form = d.querySelector('#adm-form');
      const $ = sel => form.querySelector(sel);
      const suggest = () => {
        const n = Number($('#a-classes').value) || 0;
        const rate = Number($('#a-rate').value);
        const surcharge = $('#a-out').checked && rate !== 150 ? 50 : 0;
        const fee = n * (rate + surcharge);
        $('#a-suggest').textContent = `${n} classes × ${inr(rate + surcharge)} = ${inr(fee)}`;
        return fee;
      };
      const syncMode = () => {
        const mode = $('#a-mode').value;
        const cur = $('#a-teacher').value;
        $('#a-teacher').innerHTML = teacherOptions(cur, { mode });
        if (mode === '3:1') $('#a-rate').value = '150';
        else if ($('#a-rate').value === '150') $('#a-rate').value = '250';
        suggest();
      };
      $('#a-mode').addEventListener('change', syncMode);
      ['#a-classes', '#a-rate', '#a-out'].forEach(s => $(s).addEventListener('input', suggest));
      $('#a-use').addEventListener('click', () => { $('#a-fee').value = suggest(); });
      $('#a-balance').addEventListener('click', () => {
        const fee = Number($('#a-fee').value || 0); const adv = Number($('#Advance-amt').value || 0);
        $('#Final-amt').value = Math.max(0, fee - adv);
      });
      form.querySelectorAll('[data-stage]').forEach(sel => sel.addEventListener('change', () => {
        const st = sel.dataset.stage;
        form.querySelector(`[data-date-label="${st}"]`).textContent = (sel.value === 'Paid' ? 'Received date' : 'Due date') + ' *';
      }));
      suggest();

      onSubmit(form, async v => {
        const missing = [['course', 'Course'], ['teacher_id', 'Teaching teacher'], ['start_date', 'Start date'], ['total_classes', 'Total classes'], ['total_fee', 'Total course fee'], ['Advance_amount', 'Advance amount'], ['Final_amount', 'Final amount']]
          .filter(([k]) => v[k] === '' || v[k] === undefined).map(([, l]) => l);
        if (missing.length) throw new Error('Please fill in: ' + missing.join(', '));
        // Fee split is checked only now, on save.
        const fee = Number(v.total_fee), adv = Number(v.Advance_amount), fin = Number(v.Final_amount);
        if (adv + fin !== fee) {
          const diff = Math.abs(fee - adv - fin);
          throw new Error(`Advance ${inr(adv)} + Final ${inr(fin)} = ${inr(adv + fin)}, which is ${inr(diff)} ${adv + fin < fee ? 'less' : 'more'} than the Total Course Fee of ${inr(fee)}. Adjust the amounts so they add up exactly.`);
        }
        const pay = st => ({ amount: v[st + '_amount'], status: v[st + '_status'], date: v[st + '_date'], method: v[st + '_method'] || null, reference: v[st + '_reference'] });
        await api('POST', '/api/admissions', {
          student_id: s.student_id, course: v.course, class_mode: v.class_mode, teacher_id: v.teacher_id, start_date: v.start_date,
          total_classes: v.total_classes, total_fee: v.total_fee, notes: v.notes, advance: pay('Advance'), final: pay('Final'), idempotency_key: key,
        });
        close();
        toast('Admission saved: enrollment and payments created');
        after && after();
      });
    },
  });
}

// ---------- Payments ----------
const PAY_KEYS = ['q', 'status', 'stage', 'date_from', 'date_to'];
export async function renderPayments(page, { query }) {
  const f = Object.fromEntries(PAY_KEYS.map(k => [k, query[k] || '']));
  page.innerHTML = html`<div class="page-head"><div><h1>Payments</h1>
    <div class="sub">Paid counts as collected. Pending is outstanding; it becomes overdue only after its due date.</div></div></div>
    <form class="filters" id="pf" role="search" aria-label="Filter payments">
      <div class="field grow"><label for="p-q">Search</label><input id="p-q" name="q" type="search" value="${f.q}" placeholder="Student, Lead ID, reference"></div>
      <div class="field"><label for="p-st">Status</label><select id="p-st" name="status">${raw(options(['Paid', 'Pending', 'Overdue'], f.status, 'All'))}</select></div>
      <div class="field"><label for="p-stage">Stage</label><select id="p-stage" name="stage">${raw(options(['Advance', 'Final'], f.stage, 'Both'))}</select></div>
      <div class="field"><label for="p-from">Date from</label><input id="p-from" name="date_from" type="date" value="${f.date_from}"></div>
      <div class="field"><label for="p-to">Date to</label><input id="p-to" name="date_to" type="date" value="${f.date_to}"></div>
      <button class="btn" type="button" id="p-clear">Clear filters</button>
    </form>
    <p class="result-count" id="p-tot" aria-live="polite"></p>
    <div id="p-list">${raw(stateBox('loading'))}</div>`;
  const form = page.querySelector('#pf'); const list = page.querySelector('#p-list');
  let rows = [];
  let seq = 0;
  async function load() {
    const d = Object.fromEntries(new FormData(form)); setQuery(d);
    const my = ++seq;
    try {
      const r = await get('/api/payments' + '?' + new URLSearchParams(Object.entries(d).filter(([, v]) => v)));
      if (my !== seq) return;
      rows = r.rows;
      page.querySelector('#p-tot').textContent = `${r.totals.count} payment${r.totals.count === 1 ? '' : 's'} · Paid ${inr(r.totals.paid)} · Pending ${inr(r.totals.pending)} · Overdue ${inr(r.totals.overdue)}`;
      list.innerHTML = table([
        { label: 'Student', cell: x => `<a href="#/student/${x.student_id}">${esc(x.student_name)}</a><span class="sub">${esc(x.lead_id)} · ${esc(x.course)}</span>` },
        { label: 'Stage', cell: x => esc(x.stage) },
        { label: 'Amount', cls: 'num', cell: x => esc(inr(x.amount)) },
        { label: 'Status', cell: x => (x.overdue ? pill('Overdue').__raw : pill(x.status).__raw) },
        { label: 'Date', cell: x => `${esc(fmtDate(x.date))}<span class="sub">${x.status === 'Paid' ? 'received' : 'due'}</span>` },
        { label: 'Method / ref', cell: x => esc([x.method, x.reference].filter(Boolean).join(' · ') || '—') },
        { label: 'Contact', cell: x => `${esc(x.parent_name || '')}<span class="sub">${esc(x.phone)}</span>` },
        { label: 'Actions', cls: 'cell-actions', cell: x => `<button class="btn small" type="button" data-pay="${x.id}">Update</button> <button class="btn small" type="button" data-hist="${x.id}">History</button>` },
      ], rows, { empty: 'No payments match these filters' });
    } catch (e) { if (my === seq) list.innerHTML = stateBox('error', 'Could not load payments', e.message); }
  }
  let t;
  form.addEventListener('input', e => { clearTimeout(t); t = setTimeout(load, e.target.type === 'search' ? 250 : 0); });
  form.addEventListener('submit', e => { e.preventDefault(); load(); });
  page.querySelector('#p-clear').addEventListener('click', () => { form.reset(); form.querySelectorAll('input,select').forEach(x => { x.value = ''; }); load(); });
  list.addEventListener('click', async e => {
    const p = e.target.closest('[data-pay]'); const h = e.target.closest('[data-hist]');
    if (p) paymentForm(rows.find(x => String(x.id) === p.dataset.pay), load);
    if (h) {
      const items = await get(`/api/payments/${h.dataset.hist}/history`);
      drawer({ title: 'Payment history', body: historyList(items) });
    }
  });
  await load();
}

export function paymentForm(p, after) {
  drawer({
    title: `${p.stage} payment${p.student_name ? ': ' + p.student_name : ''}`,
    body: html`<form id="pay-form" novalidate>
      <p class="muted">Amount ${inr(p.amount)}. To change amounts, use “Edit fee plan” on the student profile.</p>
      <div class="grid2">
        <div class="field"><label for="pf-st">Status</label><select id="pf-st" name="status">${raw(options(['Pending', 'Paid'], p.status))}</select></div>
        <div class="field"><label for="pf-date" id="pf-date-l">${p.status === 'Paid' ? 'Received date' : 'Due date'}</label><input id="pf-date" name="date" type="date" value="${p.date}"></div>
        <div class="field"><label for="pf-m">Method</label><select id="pf-m" name="method">${raw(options(METHODS, p.method, '—'))}</select></div>
        <div class="field"><label for="pf-ref">Reference</label><input id="pf-ref" name="reference" maxlength="100" value="${p.reference}"></div>
      </div>
      <div class="field"><label for="pf-reason">Reason / note for the audit history</label><input id="pf-reason" name="reason" maxlength="500" placeholder="Required when reverting Paid to Pending"></div>
    </form>`,
    foot: '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" form="pay-form">Save payment</button>',
    onMount: (d, close) => {
      const form = d.querySelector('#pay-form');
      const st = form.querySelector('#pf-st');
      st.addEventListener('change', () => {
        form.querySelector('#pf-date-l').textContent = st.value === 'Paid' ? 'Received date' : 'Due date';
        if (st.value === 'Paid' && p.status === 'Pending') form.querySelector('#pf-date').value = todayLocal();
      });
      onSubmit(form, async v => {
        await api('PATCH', `/api/payments/${p.id}`, { ...v, method: v.method || null });
        close(); toast('Payment saved'); after && after();
      });
    },
  });
}

export function feePlanForm(e, after) {
  const adv = e.payments.find(p => p.stage === 'Advance'); const fin = e.payments.find(p => p.stage === 'Final');
  drawer({
    title: 'Edit fee plan',
    body: html`<form id="fee-form" novalidate>
      <p class="muted">Advance + Final must equal the total fee. A payment already marked Paid keeps its amount.</p>
      <div class="grid3">
        <div class="field"><label for="fp-t">Total course fee (₹)</label><input id="fp-t" name="total_fee" type="number" min="0" value="${e.total_fee}"></div>
        <div class="field"><label for="fp-a">Advance (₹)</label><input id="fp-a" name="advance_amount" type="number" min="0" value="${adv.amount}" ${adv.status === 'Paid' ? 'readonly' : ''}></div>
        <div class="field"><label for="fp-f">Final (₹)</label><input id="fp-f" name="final_amount" type="number" min="0" value="${fin.amount}" ${fin.status === 'Paid' ? 'readonly' : ''}></div>
      </div>
      <div class="field"><label for="fp-r">Reason for change *</label><input id="fp-r" name="reason" maxlength="500" required></div>
    </form>`,
    foot: '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" form="fee-form">Save fee plan</button>',
    onMount: (d, close) => onSubmit(d.querySelector('#fee-form'), async v => {
      if (!v.reason.trim()) throw new Error('Give a reason for the change');
      const t = Number(v.total_fee), a = Number(v.advance_amount), f = Number(v.final_amount);
      if (a + f !== t) throw new Error(`Advance ${inr(a)} + Final ${inr(f)} = ${inr(a + f)}, which is ${inr(Math.abs(t - a - f))} ${a + f < t ? 'less' : 'more'} than the Total Course Fee of ${inr(t)}.`);
      await api('PUT', `/api/enrollments/${e.id}/fee-plan`, v);
      close(); toast('Fee plan saved'); after && after();
    }),
  });
}

export function enrollmentForm(e, after) {
  drawer({
    title: 'Edit enrollment',
    body: html`<form id="enr-form" novalidate>
      <div class="grid2">
        <div class="field"><label for="ef-t">Teaching teacher</label><select id="ef-t" name="teacher_id">${raw(teacherOptions(e.teacher_id, { mode: e.class_mode }))}</select></div>
        <div class="field"><label for="ef-s">Status</label><select id="ef-s" name="status">${raw(options(['Active', 'Paused', 'Completed', 'Cancelled'], e.status))}</select></div>
        <div class="field"><label for="ef-c">Total classes</label><input id="ef-c" name="total_classes" type="number" min="${e.completed_classes || 1}" value="${e.total_classes}">
          <div class="hint">${e.completed_classes} completed so far.</div></div>
        <div class="field"><label for="ef-d">Start date</label><input id="ef-d" name="start_date" type="date" value="${e.start_date}"></div>
      </div>
      <div class="field"><label for="ef-n">Notes</label><textarea id="ef-n" name="notes">${e.notes}</textarea></div>
      <div class="field"><label for="ef-r">Reason for change</label><input id="ef-r" name="reason" maxlength="500"></div>
    </form>`,
    foot: '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" form="enr-form">Save enrollment</button>',
    onMount: (d, close) => onSubmit(d.querySelector('#enr-form'), async v => {
      await api('PATCH', `/api/enrollments/${e.id}`, v);
      close(); toast('Enrollment saved'); after && after();
    }),
  });
}
