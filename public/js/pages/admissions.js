import {
  api, get, esc, html, raw, pill, inr, fmtDate, fmtStamp, table, drawer, onSubmit, options, teacherOptions,
  setQuery, toast, uid, todayLocal, stateBox, addDays,
} from '../core.js';
import { historyList, shrinkImage, guessType, toBase64 } from './pretests.js';

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
    { label: 'Lead / Student ID', cell: r => `${esc(r.lead_id)}<span class="sub">${esc(r.student_code)}</span>` },
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

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const METHOD_LABEL = { 'Bank Transfer': 'Bank' };

/** Payment card (AD-05): amount, Paid/Pending switch, date, method buttons, reference. */
const payCard = (stage, d) => html`
  <div class="pay" data-pay-card="${stage}">
    <div class="pay-h">${stage}<span class="st">${raw(pill(d.status, d.status === 'Paid' ? 'green' : 'amber').__raw)}</span></div>
    <div class="pay-b">
      <div class="field"><label for="${stage}-amt">${stage} amount (₹) *</label><div class="money"><span aria-hidden="true">₹</span><input id="${stage}-amt" name="${stage}_amount" type="number" min="0" step="1" inputmode="numeric" value="${d.amount}"></div></div>
      <div class="seg" role="radiogroup" aria-label="${stage} status">
        <label><input type="radio" name="${stage}_status" value="Paid" ${d.status === 'Paid' ? 'checked' : ''}><span>Paid</span></label>
        <label><input type="radio" name="${stage}_status" value="Pending" ${d.status === 'Pending' ? 'checked' : ''}><span>Pending</span></label>
      </div>
      <div class="field"><label for="${stage}-date" data-date-label>${d.status === 'Paid' ? 'Received on *' : 'Due on *'}</label><input id="${stage}-date" name="${stage}_date" type="date" value="${d.date}"></div>
      <div class="paid-only">
        <div class="field"><span class="label">Method *</span><div class="methods" role="radiogroup" aria-label="${stage} method">
          ${raw(METHODS.map(m => `<label class="m"><input type="radio" name="${stage}_method" value="${esc(m)}" ${d.method === m ? 'checked' : ''}><span>${esc(METHOD_LABEL[m] || m)}</span></label>`).join(''))}
        </div></div>
        <div class="field"><label for="${stage}-ref">Reference</label><input id="${stage}-ref" name="${stage}_reference" maxlength="100" value="${d.reference}" placeholder="UPI / transaction ID"></div>
      </div>
      <p class="small muted pending-only">Method and reference are added when it is paid.</p>
      ${raw(stage === 'Final' ? '<button class="btn small" type="button" id="a-balance">Fill remaining balance</button>' : '')}
    </div>
  </div>`;

/** Admission setup drawer. s: { student_id, student_code, candidate_id, student_name, lead_id, sales_rep_name, recommended_course } */
export function openAdmission(s, after) {
  const key = uid();
  const t = todayLocal();
  drawer({
    title: `Admission: ${s.student_name}`,
    wide: true,
    body: html`<form id="adm-form" novalidate>
      <p class="muted small">Lead ${s.lead_id} · Sales rep ${s.sales_rep_name} (kept for attribution)</p>
      <fieldset><legend>Student identity</legend>
        <div class="ident">
          <div><label class="avatar" for="a-photo" id="a-avatar"><span>Student photo<br>(optional)</span></label>
            <input id="a-photo" class="sr-only" type="file" accept="image/*"><div class="small muted center">Tap to add</div></div>
          <div>
            <div class="grid2">
              <div class="field"><label for="a-code">Student ID *</label><input id="a-code" name="student_code" maxlength="30" value="${s.student_code}"><div class="hint">Generated; you can type your own.</div></div>
              <div class="field"><label for="a-aadhaar">Aadhaar number</label><input id="a-aadhaar" name="aadhaar" inputmode="numeric" maxlength="14" autocomplete="off" placeholder="12 digits (optional)"><div class="hint">Only the last 4 digits are saved.</div></div>
            </div>
            <div class="field"><label for="a-idproof">ID proof photo (optional)</label>
              <input id="a-idproof" type="file" accept="image/*,application/pdf">
              <div id="a-idproof-info" class="small muted"></div></div>
          </div>
        </div>
      </fieldset>
      <fieldset><legend>Course</legend>
        <div class="grid3">
          <div class="field"><label for="a-course">Course *</label><select id="a-course" name="course">${raw(options(COURSES, s.recommended_course, 'Select'))}</select>
            <div class="hint">Pre-test recommended: ${s.recommended_course}</div></div>
          <div class="field"><label for="a-mode">Class mode *</label><select id="a-mode" name="class_mode">${raw(options([['1:1', '1:1 (one student)'], ['3:1', '3:1 (group of up to 3)']], '1:1'))}</select></div>
          <div class="field"><label for="a-teacher">Teaching teacher *</label><select id="a-teacher" name="teacher_id">${raw(teacherOptions('', { mode: '1:1' }))}</select>
            <div class="hint">Can differ from the pre-test teacher.</div></div>
        </div>
      </fieldset>
      <fieldset><legend>Preferred time slot &amp; dates</legend>
        <div class="field"><span class="label">Days *</span><div class="chips" role="group" aria-label="Preferred days">
          ${raw(DAYS.map((d, i) => `<label class="chip"><input type="checkbox" name="d${i}" ${[1, 3, 5].includes(i) ? 'checked' : ''}><span>${d}</span></label>`).join(''))}
        </div></div>
        <div class="grid3">
          <div class="field"><label for="a-time">Time (IST) *</label><input id="a-time" name="slot_time" type="time" value="17:00"></div>
          <div class="field"><label for="a-start">Start date *</label><input id="a-start" name="start_date" type="date" value="${t}"></div>
          <div class="field"><label for="a-classes">Total classes *</label><input id="a-classes" name="total_classes" type="number" min="1" max="1000" inputmode="numeric" value="30"></div>
        </div>
        <div class="end" id="a-end" aria-live="polite"></div>
        <div id="a-slot"></div>
      </fieldset>
      <fieldset><legend>Course fee</legend>
        <div class="grid2">
          <div class="field"><label for="a-rate">Rate card</label><select id="a-rate" name="rate">${raw(options(RATES.map(r => [r[0], r[1]]), '250'))}</select></div>
          <div class="field"><label class="check top-gap"><input type="checkbox" name="outside" id="a-out"> Outside 9 AM–9 PM (+₹50 per class, 1:1 only)</label></div>
        </div>
        <div class="calc"><span id="a-suggest"></span><button class="btn small" type="button" id="a-use">Use this fee</button></div>
        <div class="field"><label for="a-fee">Total course fee (₹) *</label><div class="money"><span aria-hidden="true">₹</span><input id="a-fee" name="total_fee" type="number" min="0" step="1" inputmode="numeric"></div></div>
      </fieldset>
      <fieldset><legend>Payments</legend>
        <div class="pays">${raw(payCard('Advance', { status: 'Paid', date: t, method: 'UPI' }))}${raw(payCard('Final', { status: 'Pending', date: addDays(t, 30) }))}</div>
        <div class="sum" id="a-sum"></div>
      </fieldset>
      <div class="field"><label for="a-notes">Notes</label><textarea id="a-notes" name="notes" maxlength="2000"></textarea></div>
    </form>`,
    foot: '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" form="adm-form">Save admission</button>',
    onMount: (d, close) => {
      const form = d.querySelector('#adm-form');
      const $ = sel => form.querySelector(sel);
      const files = { student_photo: null, id_proof: null };

      // --- photos (uploaded after the admission is saved)
      $('#a-photo').addEventListener('change', async ev => {
        const f = ev.target.files[0]; if (!f) return;
        const p = await shrinkImage(f, guessType(f));
        if (!/^image\//.test(p.type) || p.blob.size > 4 * 1024 * 1024) { toast('Choose an image under 4 MB', 'error'); return; }
        files.student_photo = p;
        $('#a-avatar').innerHTML = `<img src="data:${p.type};base64,${await toBase64(p.blob)}" alt="Student photo">`;
      });
      $('#a-idproof').addEventListener('change', async ev => {
        const f = ev.target.files[0]; if (!f) { files.id_proof = null; $('#a-idproof-info').textContent = ''; return; }
        const p = await shrinkImage(f, guessType(f));
        if (p.blob.size > 4 * 1024 * 1024) { toast('ID proof must be under 4 MB', 'error'); ev.target.value = ''; return; }
        files.id_proof = p; $('#a-idproof-info').textContent = `${p.name} · ${Math.max(1, Math.round(p.blob.size / 1024))} KB · uploads when you save`;
      });
      $('#a-aadhaar').addEventListener('input', ev => { // group as 1234 5678 9012
        const v = ev.target.value.replace(/\D/g, '').slice(0, 12);
        ev.target.value = v.replace(/(\d{4})(?=\d)/g, '$1 ');
      });

      // --- slot, end date, teacher clash warning
      const slotDays = () => DAYS.map((_, i) => ($(`[name=d${i}]`).checked ? i : -1)).filter(i => i >= 0);
      const endDate = () => {
        const days = slotDays(); const n = Number($('#a-classes').value) || 0; const start = $('#a-start').value;
        if (!days.length || !n || !start) return null;
        let dt = start; let c = 0;
        for (let i = 0; i < 7 * 1100; i++) {
          if (days.includes(new Date(dt + 'T00:00:00Z').getUTCDay())) { c++; if (c === n) return dt; }
          dt = addDays(dt, 1);
        }
        return null;
      };
      const drawEnd = () => {
        const e = endDate(); const days = slotDays(); const n = Number($('#a-classes').value) || 0;
        $('#a-end').innerHTML = e ? `End date (automatic): <strong>${esc(fmtDate(e))}</strong><span class="muted small">· ${n} classes · ${days.length} per week · about ${Math.ceil(n / days.length)} weeks</span>`
          : '<span class="muted">Choose days, a start date and total classes to see the end date.</span>';
      };
      let slotSeq = 0; let slotTimer;
      const checkSlot = () => {
        clearTimeout(slotTimer);
        slotTimer = setTimeout(async () => {
          const box = $('#a-slot'); const days = slotDays();
          if (!$('#a-teacher').value || !days.length || !$('#a-time').value || !$('#a-start').value || !$('#a-classes').value) { box.innerHTML = ''; return; }
          const my = ++slotSeq;
          try {
            const r = await api('POST', '/api/admissions/slot-check', { teacher_id: $('#a-teacher').value, class_mode: $('#a-mode').value,
              slot_days: days, slot_time: $('#a-time').value, start_date: $('#a-start').value, total_classes: $('#a-classes').value });
            if (my !== slotSeq) return;
            box.innerHTML = r.warnings.length
              ? `<div class="notice warn" role="alert"><strong>${esc(r.teacher)}'s slot is already booked:</strong><ul>${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>You can still save, or choose another time, day or teacher.</div>`
              : `<p class="small ok-line">✓ ${esc(r.teacher)} is free at this slot${r.info.length ? ' · ' + esc(r.info.join(' · ')) : ''}.</p>`;
          } catch { if (my === slotSeq) box.innerHTML = ''; }
        }, 250);
      };
      ['#a-time', '#a-start', '#a-classes'].forEach(sel => $(sel).addEventListener('input', () => { drawEnd(); checkSlot(); suggest(); }));
      form.querySelectorAll('.chip input').forEach(x => x.addEventListener('change', () => { drawEnd(); checkSlot(); }));
      $('#a-teacher').addEventListener('change', checkSlot);

      // --- fee
      const suggest = () => {
        const n = Number($('#a-classes').value) || 0;
        const rate = Number($('#a-rate').value);
        const surcharge = $('#a-out').checked && rate !== 150 ? 50 : 0;
        const fee = n * (rate + surcharge);
        $('#a-suggest').innerHTML = `${n} classes × ${esc(inr(rate + surcharge))} = <b>${esc(inr(fee))}</b>`;
        return fee;
      };
      const syncMode = () => {
        const mode = $('#a-mode').value;
        const cur = $('#a-teacher').value;
        $('#a-teacher').innerHTML = teacherOptions(cur, { mode });
        if (mode === '3:1') $('#a-rate').value = '150';
        else if ($('#a-rate').value === '150') $('#a-rate').value = '250';
        suggest(); checkSlot();
      };
      $('#a-mode').addEventListener('change', syncMode);
      ['#a-rate', '#a-out'].forEach(x => $(x).addEventListener('input', suggest));
      $('#a-use').addEventListener('click', () => { $('#a-fee').value = suggest(); drawSum(); });

      // --- payments
      const status = st => form.querySelector(`[name=${st}_status]:checked`)?.value;
      const syncCard = st => {
        const card = form.querySelector(`[data-pay-card=${st}]`); const paid = status(st) === 'Paid';
        card.querySelector('.pay-h .st').innerHTML = pill(paid ? 'Paid' : 'Pending', paid ? 'green' : 'amber').__raw;
        card.querySelector('[data-date-label]').textContent = paid ? 'Received on *' : 'Due on *';
        card.querySelector('.paid-only').classList.toggle('hidden', !paid);
        card.querySelector('.pending-only').classList.toggle('hidden', paid);
        card.classList.toggle('is-paid', paid);
      };
      const drawSum = () => {
        const fee = Number($('#a-fee').value || 0); const adv = Number($('#Advance-amt').value || 0); const fin = Number($('#Final-amt').value || 0);
        const box = d.querySelector('#a-sum'); const ok = fee > 0 && adv + fin === fee; const diff = fee - adv - fin;
        const pct = fee ? Math.min(100, Math.round((adv / fee) * 100)) : 0;
        box.className = 'sum ' + (ok ? 'good' : fee ? 'bad' : '');
        box.innerHTML = `<div class="sum-line">Total ${esc(inr(fee))} = Advance ${esc(inr(adv))} + Final ${esc(inr(fin))}
          <span class="sum-state">${ok ? '✓ Adds up' : fee ? `${esc(inr(Math.abs(diff)))} ${diff > 0 ? 'still to assign' : 'too much'}` : 'Enter the total course fee'}</span></div>
          <div class="bar" aria-hidden="true"><span class="a"></span><span class="f"></span></div>`;
        // Widths set through the DOM (the Content-Security-Policy blocks inline style attributes).
        box.querySelector('.bar .a').style.width = pct + '%'; box.querySelector('.bar .f').style.width = (100 - pct) + '%';
      };
      ['Advance', 'Final'].forEach(st => form.querySelectorAll(`[name=${st}_status]`).forEach(r => r.addEventListener('change', () => {
        syncCard(st);
        if (status(st) === 'Paid') form.querySelector(`#${st}-date`).value = t;
      })));
      ['#a-fee', '#Advance-amt', '#Final-amt'].forEach(x => form.querySelector(x).addEventListener('input', drawSum));
      d.querySelector('#a-balance').addEventListener('click', () => {
        $('#Final-amt').value = Math.max(0, Number($('#a-fee').value || 0) - Number($('#Advance-amt').value || 0)); drawSum();
      });
      syncCard('Advance'); syncCard('Final'); suggest(); drawEnd(); drawSum(); checkSlot();

      onSubmit(form, async v => {
        const missing = [['student_code', 'Student ID'], ['course', 'Course'], ['teacher_id', 'Teaching teacher'], ['slot_time', 'Time (IST)'], ['start_date', 'Start date'], ['total_classes', 'Total classes'], ['total_fee', 'Total course fee'], ['Advance_amount', 'Advance amount'], ['Final_amount', 'Final amount']]
          .filter(([k]) => v[k] === '' || v[k] === undefined).map(([, l]) => l);
        if (!slotDays().length) missing.push('Days');
        for (const st of ['Advance', 'Final']) if (v[st + '_status'] === 'Paid' && !v[st + '_method']) missing.push(`${st} method`);
        if (missing.length) throw new Error('Please fill in: ' + missing.join(', '));
        const fee = Number(v.total_fee), adv = Number(v.Advance_amount), fin = Number(v.Final_amount);
        if (adv + fin !== fee) {
          const diff = Math.abs(fee - adv - fin);
          throw new Error(`Advance ${inr(adv)} + Final ${inr(fin)} = ${inr(adv + fin)}, which is ${inr(diff)} ${adv + fin < fee ? 'less' : 'more'} than the Total Course Fee of ${inr(fee)}. Adjust the amounts so they add up exactly.`);
        }
        const pay = st => ({ amount: v[st + '_amount'], status: v[st + '_status'], date: v[st + '_date'], method: v[st + '_status'] === 'Paid' ? (v[st + '_method'] || null) : null, reference: v[st + '_status'] === 'Paid' ? v[st + '_reference'] : '' });
        await api('POST', '/api/admissions', {
          student_id: s.student_id, student_code: v.student_code, aadhaar: v.aadhaar,
          course: v.course, class_mode: v.class_mode, teacher_id: v.teacher_id, start_date: v.start_date,
          slot_days: slotDays(), slot_time: v.slot_time,
          total_classes: v.total_classes, total_fee: v.total_fee, notes: v.notes, advance: pay('Advance'), final: pay('Final'), idempotency_key: key,
        });
        // Photos after the admission is saved; a failed photo does not undo the admission.
        for (const [kind, p] of Object.entries(files)) {
          if (!p) continue;
          try { await api('POST', `/api/candidates/${s.candidate_id}/files`, { kind, filename: p.name, mime: p.type, data: await toBase64(p.blob) }); }
          catch (e) { toast(`${kind === 'id_proof' ? 'ID proof' : 'Photo'} not uploaded: ${e.message}. Add it from the student profile.`, 'error'); }
        }
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
      <div class="field"><span class="label">Preferred days</span><div class="chips">
        ${raw(DAYS.map((d, i) => `<label class="chip"><input type="checkbox" name="d${i}" ${(e.slot_days || '').split(',').includes(String(i)) ? 'checked' : ''}><span>${d}</span></label>`).join(''))}
      </div></div>
      <div class="field"><label for="ef-time">Preferred time (IST)</label><input id="ef-time" name="slot_time" type="time" value="${e.slot_time}"><div class="hint">The end date is recalculated from start date, total classes and days.</div></div>
      <div class="field"><label for="ef-n">Notes</label><textarea id="ef-n" name="notes">${e.notes}</textarea></div>
      <div class="field"><label for="ef-r">Reason for change</label><input id="ef-r" name="reason" maxlength="500"></div>
    </form>`,
    foot: '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" form="enr-form">Save enrollment</button>',
    onMount: (d, close) => onSubmit(d.querySelector('#enr-form'), async v => {
      const days = DAYS.map((_, i) => (v['d' + i] ? i : -1)).filter(i => i >= 0);
      DAYS.forEach((_, i) => delete v['d' + i]);
      if (days.length && !v.slot_time) throw new Error('Choose the preferred time');
      await api('PATCH', `/api/enrollments/${e.id}`, { ...v, slot_days: days.join(','), slot_time: v.slot_time || null });
      close(); toast('Enrollment saved'); after && after();
    }),
  });
}
