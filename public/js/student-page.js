// Parents' student page (no login): teacher, weekly slot, progress, class calendar, end date and terms.
const token = location.pathname.split('/').filter(Boolean).pop();
const box = document.getElementById('sp');
const sub = document.getElementById('sp-sub');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const time12 = t => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const dateText = d => { const [y, m, dd] = d.split('-').map(Number); return `${DAYS[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]} ${dd} ${MONTHS[m - 1].slice(0, 3)} ${y}`; };
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const addMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

function calendar(ym, classes) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDay = new Map();
  for (const c of classes) if (c.at.startsWith(ym)) byDay.set(Number(c.at.slice(8, 10)), c);
  const today = todayIST();
  let cells = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => `<div class="sp-h">${d}</div>`).join('') + '<div></div>'.repeat(lead);
  for (let d = 1; d <= days; d++) {
    const c = byDay.get(d); const iso = `${ym}-${String(d).padStart(2, '0')}`;
    const label = c ? `${dateText(iso)}: ${{ done: 'class done', upcoming: 'class at ' + time12(c.at.slice(11, 16)), missed: 'missed', cancelled: 'cancelled' }[c.kind]}` : dateText(iso);
    cells += `<div class="sp-d ${c ? c.kind : ''} ${iso === today ? 'today' : ''}" aria-label="${esc(label)}" title="${esc(label)}">${d}</div>`;
  }
  return `<div class="sp-cal">${cells}</div>`;
}

(async () => {
  let s;
  try {
    const r = await fetch(`/api/public/student/${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error();
    s = await r.json();
  } catch {
    box.innerHTML = '<div class="fb-done"><div class="fb-big">Page not found</div><p>Please check the link, or ask Nalla Malayalam for a new one.</p></div>';
    return;
  }
  sub.textContent = `${s.student} · ${s.course} · ${s.class_mode}`;
  const months = [...new Set(s.classes.map(c => c.at.slice(0, 7)))].sort();
  let ym = months.includes(todayIST().slice(0, 7)) ? todayIST().slice(0, 7) : (months.find(x => x >= todayIST().slice(0, 7)) || months.at(-1) || todayIST().slice(0, 7));
  const slot = s.slot_days ? `${s.slot_days.split(',').map(d => DAYS[d]).join(' · ')}` : '—';
  const next = s.classes.find(c => c.kind === 'upcoming' && c.at.slice(0, 10) >= todayIST());

  const draw = () => {
    box.innerHTML = `
      <div class="sp-teacher">${s.teacher.photo ? `<img src="/api/public/student/${encodeURIComponent(token)}/teacher-photo" alt="">` : '<span class="sp-av" aria-hidden="true"></span>'}
        <div><b>Teacher: ${esc(s.teacher.name)}</b>${s.teacher.about ? `<div class="small">${esc(s.teacher.about)}</div>` : ''}</div></div>
      <div class="sp-stats">
        <div><b>${esc(slot)}</b><span>${s.slot_time ? esc(time12(s.slot_time)) + ' IST' : 'time to be fixed'}</span></div>
        <div><b>${s.completed_classes} / ${s.total_classes}</b><span>classes done</span></div>
        <div><b>${s.end_date ? esc(dateText(s.end_date).slice(4)) : '—'}</b><span>end date</span></div>
      </div>
      ${next ? `<p class="sp-next">Next class: <b>${esc(dateText(next.at.slice(0, 10)))}, ${esc(time12(next.at.slice(11, 16)))} IST</b>${next.substitute ? ` · with ${esc(next.substitute)}` : ''}</p>` : ''}
      ${s.missed ? `<p class="sp-missed">Missed classes so far: <b>${s.missed}</b></p>` : ''}
      <div class="sp-mhead"><button type="button" id="prev" aria-label="Previous month">‹</button><b>${MONTHS[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}</b><button type="button" id="next" aria-label="Next month">›</button></div>
      ${calendar(ym, s.classes)}
      <div class="sp-legend"><span><i class="done"></i>Done</span><span><i class="upcoming"></i>Upcoming</span><span><i class="missed"></i>Missed</span><span><i class="cancelled"></i>Cancelled</span></div>
      <h2 class="sp-terms-h">Terms</h2>
      <ol class="sp-terms">${s.terms.map(t => `<li>${esc(t)}</li>`).join('')}</ol>
      <p class="fb-foot">Times are India time (IST). Questions? Reply on WhatsApp.</p>`;
    box.querySelector('#prev').addEventListener('click', () => { ym = addMonth(ym, -1); draw(); });
    box.querySelector('#next').addEventListener('click', () => { ym = addMonth(ym, 1); draw(); });
  };
  draw();
})();
