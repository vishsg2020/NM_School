import { api, get, esc, html, raw, pill, onSubmit, toast, fmtStamp, confirmBox, copyText } from '../core.js';

export async function render(page, { query }) {
  const [g, fb, terms, rem, pay, co] = await Promise.all([get('/api/settings/google'), get('/api/settings/feedback'), get('/api/settings/terms'), get('/api/settings/reminders'), get('/api/settings/pay-rates'), get('/api/call-options')]);
  const rate = (k, label) => html`<div class="field"><label for="pr-${k}">${label} (₹)</label><input id="pr-${k}" name="${k}" type="number" min="0" value="${pay.rates[k]}"></div>`;
  const account = g.account_email || g.suggested_account;
  const status = g.connected
    ? (g.last_error ? pill('Needs attention', 'red') : pill('Connected', 'green'))
    : pill('Not connected', 'amber');

  page.innerHTML = html`<div class="page-head"><div><h1>Settings</h1>
      <div class="sub">Fee reminders, teacher pay rates, parent feedback, student page terms and the Google account used for Meet links.</div></div></div>
    ${raw(query.google === 'connected' ? '<div class="notice info" role="status">Google account connected. New confirmed pre-tests will get a Meet link.</div>' : '')}
    ${raw(query.google === 'error' ? `<div class="notice error" role="alert">Could not connect Google: ${esc(query.msg || 'unknown error')}</div>` : '')}

    <section class="panel"><h2>Google Meet</h2>
      <div class="status-line">${raw(status.__raw)}
        ${raw(g.connected ? `<span>Meetings are created in <strong>${esc(g.account_email || 'the connected account')}</strong> · connected ${esc(fmtStamp(g.connected_at))}</span>` : '<span class="muted">Pre-tests are saved without a Meet link until an account is connected.</span>')}</div>
      ${raw(g.last_error ? `<div class="notice error">${esc(g.last_error)}</div>` : '')}
      <p class="small muted">When a pre-test time is confirmed, the app creates a 30-minute event with a Google Meet link in this account's Google Calendar. No email invitations are sent; staff copy the link or the invite message and share it on WhatsApp or email.</p>
      <div class="row">
        ${raw(g.client_id && g.has_client_secret ? `<button class="btn primary" type="button" id="connect">${g.connected ? 'Reconnect Google account' : 'Connect Google account'}</button>` : '')}
        ${raw(g.connected ? '<button class="btn danger" type="button" id="disconnect">Disconnect</button>' : '')}
      </div>
    </section>

    <section class="panel"><h2>Fee reminders (WhatsApp)</h2>
      <p class="small muted">Used by “WhatsApp reminder” on the Payments page. You press Send in WhatsApp; the app only records that a reminder went out.
        Words in braces are filled in: {parent} {student} {course} {stage} {amount} {due} {payment_details}.</p>
      <form id="rem-form" novalidate>
        <div class="field"><label for="rem-pd">Payment details shown to parents</label><textarea id="rem-pd" name="payment_details" rows="3" maxlength="500" placeholder="e.g. UPI: yourname@bank · A/c 1234… IFSC …">${rem.payment_details}</textarea>
          <div class="hint">${raw(rem.payment_details ? '' : '<b>Not set yet.</b> Add your UPI ID or bank details so parents know where to pay.')}</div></div>
        <div class="field"><label for="rem-t">Message</label><textarea id="rem-t" name="template" rows="5" maxlength="2000">${rem.template}</textarea></div>
        <div class="row"><button class="btn" type="submit">Save reminder settings</button><button class="btn" type="button" id="rem-default">Use the default message</button></div>
      </form>
    </section>

    <section class="panel"><h2>Call options (tele team)</h2>
      <p class="small muted">The choices in “Log a call”, one per line. Not Available, Call Later, Pre Test Booked and Not Interested are always kept because they drive the call queues.</p>
      <form id="co-form" novalidate><div class="grid2">
        <div class="field"><label for="co-c">Categories</label><textarea id="co-c" name="categories" rows="6">${co.categories.join('\n')}</textarea></div>
        <div class="field"><label for="co-r">Responses</label><textarea id="co-r" name="responses" rows="9">${co.responses.join('\n')}</textarea></div>
      </div><button class="btn" type="submit">Save call options</button></form>
    </section>

    <section class="panel"><h2>Teacher pay rates</h2>
      <p class="small muted">Used by Teacher pay. A Regular teacher's own salary (Teachers → Edit) replaces the default salary.</p>
      <form id="pay-rates" novalidate>
        <h3 class="small">Regular teachers</h3>
        <div class="grid3">${raw(rate('regular_salary', 'Default monthly salary'))}${raw(rate('regular_1to1', 'Per 1:1 class'))}${raw(rate('regular_3to1', 'Per 3:1 session'))}</div>
        <div class="grid3">${raw(rate('absence_fine', 'Fine per emergency absence (after the first with notice)'))}</div>
        <h3 class="small">Freelance teachers</h3>
        <div class="grid3">${raw(rate('freelance_1to1', 'Per 1:1 class'))}${raw(rate('freelance_3to1', 'Per 3:1 session'))}</div>
        <div class="row"><button class="btn" type="submit">Save pay rates</button></div>
      </form>
    </section>

    <section class="panel"><h2>Parent feedback after classes</h2>
      <p class="small muted">When a class is completed, staff can copy a rating link for the parent (no login). Course feedback after the last class is always available.</p>
      <form id="fb-form" class="row" novalidate>
        <div class="field"><label for="fb-freq">Class feedback links</label><select id="fb-freq" name="frequency">
          ${raw(['every', 'weekly', 'off'].map(v => `<option value="${v}" ${fb.frequency === v ? 'selected' : ''}>${{ every: 'After every class', weekly: 'At most once a week per student', off: 'Off' }[v]}</option>`).join(''))}
        </select></div>
        <button class="btn" type="submit">Save</button>
      </form>
    </section>

    <section class="panel"><h2>Terms on the student page</h2>
      <p class="small muted">Shown to parents on the student page link (one rule per line, numbered automatically).</p>
      <form id="terms-form" novalidate>
        <div class="field"><label for="terms-t">Terms</label><textarea id="terms-t" name="terms" rows="7" maxlength="3000">${terms.terms}</textarea></div>
        <div class="row"><button class="btn" type="submit">Save terms</button><button class="btn" type="button" id="terms-default">Use the default text</button></div>
      </form>
    </section>

    <section class="panel"><h2>One-time setup in Google Cloud</h2>
      <p class="small muted">Do this once, signed in to Google as <strong>${account}</strong>. It is free.</p>
      <ol class="steps">
        <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud Console → New project</a>. Name it, e.g. <code>Nalla Malayalam app</code>, and create it.</li>
        <li>Open <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener">Google Calendar API</a> for that project and click <b>Enable</b>.</li>
        <li>Open <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">Google Auth Platform</a> → <b>Get started</b>. App name <code>Nalla Malayalam</code>, support email <code>${account}</code>, audience <b>External</b>, contact email <code>${account}</code>. Agree and create.</li>
        <li>In <b>Data access</b> → <b>Add or remove scopes</b>, add <code>.../auth/calendar.events</code>, <code>openid</code> and <code>email</code>. Save.</li>
        <li>In <b>Audience</b>, click <b>Publish app</b> so the status is <b>In production</b>. (In “Testing” the connection stops working after 7 days.) Google does not need to review it for this use.</li>
        <li>In <b>Clients</b> → <b>Create client</b>: type <b>Web application</b>. Under <b>Authorized redirect URIs</b> add this address exactly:
          <div class="row"><span class="codeline" id="redir">${g.redirect_uri}</span><button class="btn small" type="button" id="copy-redir">Copy</button></div>
          <span class="small muted">Add the same path for every address the app is opened from (stage and production) so each can connect.</span></li>
        <li>Click <b>Create</b>, then copy the <b>Client ID</b> and <b>Client secret</b> into the form below and save.</li>
        <li>Click <b>Connect Google account</b> above and sign in as <strong>${account}</strong>. Google will say the app is unverified: click <b>Advanced</b> → <b>Go to Nalla Malayalam</b>, then allow calendar access.</li>
      </ol>
      <form id="g-form" novalidate>
        <div class="grid2">
          <div class="field"><label for="g-id">Client ID *</label><input id="g-id" name="client_id" value="${g.client_id}" placeholder="…apps.googleusercontent.com" autocomplete="off"></div>
          <div class="field"><label for="g-secret">Client secret ${raw(g.has_client_secret ? '' : '*')}</label><input id="g-secret" name="client_secret" type="password" autocomplete="off" placeholder="${g.has_client_secret ? 'Saved. Leave blank to keep it' : ''}"></div>
        </div>
        <button class="btn" type="submit">Save Google client</button>
      </form>
    </section>`;

  const reload = () => { location.hash = '#/settings'; render(page, { query: {} }); };
  page.querySelector('#copy-redir').addEventListener('click', () => copyText(g.redirect_uri, 'Redirect URI copied'));
  page.querySelector('#connect')?.addEventListener('click', async ev => {
    ev.target.disabled = true;
    try { const r = await api('POST', '/api/settings/google/connect'); location.href = r.url; }
    catch (e) { ev.target.disabled = false; toast(e.message, 'error'); }
  });
  page.querySelector('#disconnect')?.addEventListener('click', async () => {
    const ok = await confirmBox({ title: 'Disconnect Google?', message: 'New pre-tests will not get Meet links until an account is connected again. Existing links keep working.', confirmLabel: 'Disconnect', danger: true });
    if (!ok) return;
    await api('DELETE', '/api/settings/google/connection'); toast('Google disconnected'); reload();
  });
  onSubmit(page.querySelector('#terms-form'), async v => { await api('PUT', '/api/settings/terms', v); toast('Terms saved'); });
  page.querySelector('#terms-default').addEventListener('click', () => { page.querySelector('#terms-t').value = terms.default; });
  onSubmit(page.querySelector('#rem-form'), async v => { await api('PUT', '/api/settings/reminders', v); toast('Reminder settings saved'); });
  page.querySelector('#rem-default').addEventListener('click', () => { page.querySelector('#rem-t').value = rem.default_template; });
  onSubmit(page.querySelector('#co-form'), async v => { await api('PUT', '/api/settings/call-options', v); toast('Call options saved'); });
  onSubmit(page.querySelector('#pay-rates'), async v => { await api('PUT', '/api/settings/pay-rates', v); toast('Pay rates saved'); });
  onSubmit(page.querySelector('#fb-form'), async v => { await api('PUT', '/api/settings/feedback', v); toast('Feedback setting saved'); });
  onSubmit(page.querySelector('#g-form'), async v => {
    await api('PUT', '/api/settings/google', v);
    toast('Google client saved'); reload();
  });
}
