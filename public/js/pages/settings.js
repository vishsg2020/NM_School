import { api, get, esc, html, raw, pill, onSubmit, toast, fmtStamp, confirmBox, copyText } from '../core.js';

export async function render(page, { query }) {
  const [g, fb] = await Promise.all([get('/api/settings/google'), get('/api/settings/feedback')]);
  const account = g.account_email || g.suggested_account;
  const status = g.connected
    ? (g.last_error ? pill('Needs attention', 'red') : pill('Connected', 'green'))
    : pill('Not connected', 'amber');

  page.innerHTML = html`<div class="page-head"><div><h1>Settings</h1>
      <div class="sub">Parent feedback and the Google account used for Meet links.</div></div></div>
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

    <section class="panel"><h2>Parent feedback after classes</h2>
      <p class="small muted">When a class is completed, staff can copy a rating link for the parent (no login). Course feedback after the last class is always available.</p>
      <form id="fb-form" class="row" novalidate>
        <div class="field"><label for="fb-freq">Class feedback links</label><select id="fb-freq" name="frequency">
          ${raw(['every', 'weekly', 'off'].map(v => `<option value="${v}" ${fb.frequency === v ? 'selected' : ''}>${{ every: 'After every class', weekly: 'At most once a week per student', off: 'Off' }[v]}</option>`).join(''))}
        </select></div>
        <button class="btn" type="submit">Save</button>
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
  onSubmit(page.querySelector('#fb-form'), async v => { await api('PUT', '/api/settings/feedback', v); toast('Feedback setting saved'); });
  onSubmit(page.querySelector('#g-form'), async v => {
    await api('PUT', '/api/settings/google', v);
    toast('Google client saved'); reload();
  });
}
