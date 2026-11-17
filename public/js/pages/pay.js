// Monthly teacher pay statement (Manager). Worked out from the class records; the app does not pay anyone.
import { get, esc, html, raw, inr, fmtDate, fmtDT, fmtMonth, table, drawer, setQuery, stateBox, todayLocal } from '../core.js';

export async function render(page, { query }) {
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : todayLocal().slice(0, 7);
  page.innerHTML = html`<div class="page-head"><div><h1>Teacher pay</h1>
      <div class="sub">Worked out from completed classes in the month. A statement only: the app does not pay anyone.</div></div>
    <div class="actions"><label class="sr-only" for="pay-m">Month</label><input id="pay-m" type="month" value="${month}">
      <a class="btn" id="pay-xl" href="/api/teacher-pay-export?month=${month}" download>Download Excel</a></div></div>
    <div id="pay-body">${raw(stateBox('loading'))}</div>`;
  const body = page.querySelector('#pay-body');
  let r;
  try { r = await get('/api/teacher-pay?month=' + month); } catch (e) { body.innerHTML = stateBox('error', 'Could not load teacher pay', e.message); return; }
  const n = (count, rate) => (count ? `${count} × ${esc(inr(rate))}` : '0');
  body.innerHTML = `<section class="panel">${table([
      { label: 'Teacher', cell: t => `${esc(t.name)}${t.active ? '' : '<span class="sub">inactive</span>'}` },
      { label: 'Type', cell: t => esc(t.employment_type) },
      { label: 'Salary', cls: 'num', cell: t => (t.salary ? esc(inr(t.salary)) : '—') },
      { label: '1:1 classes', cls: 'num', cell: t => n(t.classes_1to1, t.rate_1to1) },
      { label: '3:1 sessions', cls: 'num', cell: t => n(t.sessions_3to1, t.rate_3to1) },
      { label: 'Class pay / incentive', cls: 'num', cell: t => esc(inr(t.class_pay)) },
      { label: 'Absences · fine', cls: 'num', cell: t => (t.absences ? `${t.absences} · ${t.fines ? '−' + esc(inr(t.fines)) : '₹0'}` : '0') },
      { label: 'Total', cls: 'num', cell: t => `<strong>${esc(inr(t.total))}</strong>` },
      { label: '', cls: 'cell-actions', cell: t => `<button class="btn small" type="button" data-detail="${t.id}">Details</button>` },
    ], r.teachers, { empty: 'No teachers yet' })}
    <p class="pay-total">Total for ${esc(fmtMonth(month))}: <strong>${esc(inr(r.total))}</strong></p>
    <p class="small muted">A 1:1 class counts when it was Completed; a 3:1 session counts once when at least one student attended.
      “Teacher Absent” classes are emergency absences: for Regular teachers the first in the month is free if they gave at least 10 minutes' notice, and each further one is a ${esc(inr(r.rates.absence_fine))} fine.
      Rates are in Settings; a Regular teacher's own salary is set in Teachers → Edit.</p></section>`;
  page.querySelector('#pay-m').addEventListener('change', ev => {
    if (!/^\d{4}-\d{2}$/.test(ev.target.value)) return;
    setQuery({ month: ev.target.value }); render(page, { query: { month: ev.target.value } });
  });
  body.addEventListener('click', async ev => {
    const b = ev.target.closest('[data-detail]'); if (!b) return;
    const t = await get(`/api/teacher-pay/${b.dataset.detail}?month=${month}`);
    const dd = t.details;
    drawer({
      title: `${t.name} · ${fmtMonth(month)}`, wide: true,
      body: `<p>${esc(t.employment_type)} · total <strong>${esc(inr(t.total))}</strong>${t.salary ? ` = salary ${esc(inr(t.salary))} + ` : ' = '}class pay ${esc(inr(t.class_pay))}${t.fines ? ` − fines ${esc(inr(t.fines))}` : ''}</p>
        <h3>1:1 classes (${dd.classes_1to1.length} × ${esc(inr(t.rate_1to1))})</h3>
        ${table([{ label: 'When', cell: x => esc(fmtDT(x.at)) }, { label: 'Class', cell: x => esc(x.class_code) }, { label: 'Student', cell: x => esc(x.student) }], dd.classes_1to1, { empty: 'None' })}
        <h3>3:1 sessions (${dd.sessions_3to1.length} × ${esc(inr(t.rate_3to1))})</h3>
        ${table([{ label: 'When', cell: x => esc(fmtDT(x.at)) }, { label: 'Students who attended', cell: x => esc(x.students.join(', ')) }], dd.sessions_3to1, { empty: 'None' })}
        <h3>Emergency absences (${dd.absences.length})</h3>
        ${table([{ label: 'When', cell: x => esc(fmtDT(x.scheduled_at)) }, { label: 'Classes', cell: x => esc(x.classes.join(', ')) },
          { label: 'Notice', cell: x => (x.notice ? 'Given' : 'No notice') }, { label: 'Fine', cls: 'num', cell: x => (x.fine ? '−' + esc(inr(x.fine)) : '₹0') }], dd.absences, { empty: 'None' })}`,
    });
  });
}
