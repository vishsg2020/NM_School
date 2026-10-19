// Parents' feedback page (no login). The link's token identifies the class or course.
const token = location.pathname.split('/').filter(Boolean).pop();
const box = document.getElementById('fb');
const sub = document.getElementById('fb-sub');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function when(dt) {
  const [y, m, d] = dt.slice(0, 10).split('-').map(Number); const [h, mi] = dt.slice(11, 16).split(':').map(Number);
  const wd = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd} ${d} ${MONTHS[m - 1]}, ${((h + 11) % 12) + 1}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'} IST`;
}
const LABELS = ['', 'Poor', 'Not good', 'Okay', 'Good', 'Excellent'];
const stars = (name, label) => `<fieldset class="fb-stars" data-name="${name}"><legend>${esc(label)}</legend>
  <div class="stars-row">${[1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="${name}" value="${n}"><span aria-hidden="true">★</span><span class="sr-only">${n} – ${LABELS[n]}</span></label>`).join('')}</div>
  <div class="stars-say" aria-live="polite"></div></fieldset>`;
const done = (title, text) => { box.innerHTML = `<div class="fb-done"><div class="fb-big">${title}</div><p>${esc(text)}</p></div>`; };

async function api(method, body) {
  const r = await fetch(`/api/public/feedback/${encodeURIComponent(token)}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nm-app' }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { data });
  return data;
}

function wireStars(form) {
  form.querySelectorAll('.fb-stars').forEach(fs => {
    const say = fs.querySelector('.stars-say');
    const paint = () => {
      const v = Number(fs.querySelector('input:checked')?.value || 0);
      fs.querySelectorAll('label').forEach((l, i) => l.classList.toggle('on', i < v));
      say.textContent = v ? LABELS[v] : '';
    };
    fs.addEventListener('change', paint);
  });
}

(async () => {
  let f;
  try { f = await api('GET'); } catch { done('Link not found', 'Please check the link you received, or contact Nalla Malayalam.'); return; }
  if (f.state === 'submitted') { done('Thank you! 🙏', 'Your feedback has already been received.'); return; }
  if (f.state === 'expired') { done('This link has expired', 'Please ask Nalla Malayalam for a new link if you would like to share feedback.'); return; }

  if (f.kind === 'class') {
    sub.textContent = "How was today's class?";
    box.innerHTML = `<p><strong>${esc(f.student)}</strong> · ${esc(when(f.class_at))}<br><span class="muted">Teacher: ${esc(f.teacher)} · ${esc(f.course)}</span></p>
      ${f.parent_note ? `<div class="fb-note">Teacher's note: “${esc(f.parent_note)}”</div>` : ''}
      <form id="f" novalidate>
        ${stars('rating', 'Rate the class')}
        <fieldset class="fb-tags"><legend>What went well? <span class="muted">(optional)</span></legend>
          ${f.tags.map(t => `<label><input type="checkbox" name="tags" value="${esc(t)}"><span>${esc(t)}</span></label>`).join('')}</fieldset>
        <label class="fb-q" for="c">Anything to improve? <span class="muted">(optional)</span></label>
        <textarea id="c" name="comment" maxlength="1000" placeholder="Your comments"></textarea>
        <div class="fb-err" role="alert"></div>
        <button class="btn primary fb-send" type="submit">Send feedback</button>
        <p class="fb-foot">Shared only with Nalla Malayalam staff.</p>
      </form>`;
  } else {
    sub.textContent = `Course feedback · ${f.course} · ${f.total_classes} classes`;
    box.innerHTML = `<p>Thank you for learning with us! A few questions about <strong>${esc(f.student)}</strong>'s course.</p>
      <form id="f" novalidate>
        ${stars('teacher_rating', `Teacher (${f.teacher})`)}
        ${stars('content_rating', 'Course content')}
        ${stars('progress_rating', f.student ? `${f.student}'s progress` : 'Progress')}
        <fieldset class="fb-nps"><legend>How likely are you to recommend Nalla Malayalam to a friend?</legend>
          <div class="nps-row">${Array.from({ length: 11 }, (_, n) => `<label><input type="radio" name="nps" value="${n}"><span>${n}</span></label>`).join('')}</div>
          <div class="nps-ends"><span>Not likely</span><span>Very likely</span></div></fieldset>
        <fieldset class="fb-tags"><legend>Would you like to continue?</legend>
          ${[['Yes', 'Yes — next level'], ['Maybe', 'Maybe later'], ['No', 'No']].map(([v, l]) => `<label><input type="radio" name="continue_choice" value="${v}"><span>${l}</span></label>`).join('')}</fieldset>
        <label class="fb-q" for="c">Comments <span class="muted">(optional)</span></label>
        <textarea id="c" name="comment" maxlength="1000"></textarea>
        <div class="fb-err" role="alert"></div>
        <button class="btn primary fb-send" type="submit">Send feedback</button>
        <p class="fb-foot">Shared only with Nalla Malayalam staff.</p>
      </form>`;
  }
  const form = document.getElementById('f');
  wireStars(form);
  form.addEventListener('change', e => { if (e.target.name === 'nps' || e.target.name === 'continue_choice' || e.target.name === 'tags') e.target.closest('fieldset').querySelectorAll('label').forEach(l => l.classList.toggle('on', l.querySelector('input').checked)); });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(form); const err = form.querySelector('.fb-err'); err.textContent = '';
    const body = { comment: fd.get('comment') || '' };
    if (f.kind === 'class') {
      body.rating = fd.get('rating'); body.tags = fd.getAll('tags');
      if (!body.rating) { err.textContent = 'Please tap the stars to rate the class.'; return; }
    } else {
      for (const k of ['teacher_rating', 'content_rating', 'progress_rating', 'nps']) body[k] = fd.get(k);
      body.continue_choice = fd.get('continue_choice') || null;
      if (['teacher_rating', 'content_rating', 'progress_rating'].some(k => !body[k])) { err.textContent = 'Please give a star rating for each question.'; return; }
      if (body.nps === null) { err.textContent = 'Please choose a number from 0 to 10.'; return; }
    }
    const btn = form.querySelector('.fb-send'); btn.disabled = true; btn.textContent = 'Sending…';
    try { await api('POST', body); done('Thank you! 🙏', 'Your feedback helps us teach better.'); }
    catch (x) { btn.disabled = false; btn.textContent = 'Send feedback'; err.textContent = x.message; }
  });
})();
