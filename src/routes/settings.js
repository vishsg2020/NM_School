'use strict';
// Manager settings: the Google account used to create Meet links for pre-tests.
const crypto = require('crypto');
const { requireRole } = require('../auth');
const { audit } = require('../audit');
const { bad, str } = require('../util');
const google = require('../google');

const STATE_MINUTES = 15;
const redirectUriFor = req => `${req.protocol}://${req.get('host')}/api/google/callback`;

module.exports = (app, { db }) => {
  app.get('/api/settings/google', requireRole('manager'), async (req, res) => {
    const s = await google.readSettings(db);
    res.json({
      client_id: s.google_client_id,
      has_client_secret: !!s.google_client_secret,
      connected: google.isConnected(s),
      account_email: s.google_refresh_token ? s.google_account_email : null,
      connected_at: s.google_refresh_token ? s.google_connected_at : null,
      last_error: s.google_last_error || null,
      redirect_uri: redirectUriFor(req),
      suggested_account: google.SUGGESTED_ACCOUNT,
      scopes: google.SCOPES,
    });
  });

  // Step 1: save the OAuth client created in Google Cloud.
  app.put('/api/settings/google', requireRole('manager'), async (req, res) => {
    const b = req.body;
    const id = str(b.client_id, { required: true, name: 'Client ID', max: 300 });
    if (!/\.apps\.googleusercontent\.com$/.test(id)) throw bad('The Client ID should end with .apps.googleusercontent.com', { field: 'Client ID' });
    const values = { google_client_id: id };
    const secret = str(b.client_secret, { name: 'Client secret', max: 300 });
    if (secret) values.google_client_secret = secret;
    const before = await google.readSettings(db);
    if (!secret && !before.google_client_secret) throw bad('Client secret is required', { field: 'Client secret' });
    // A different OAuth client cannot use the old connection.
    if (before.google_client_id && before.google_client_id !== id) Object.assign(values, { google_refresh_token: null, google_account_email: null });
    await google.saveSettings(db, values, req.user.id);
    await audit(db, req.user, 'setting', 0, 'google_client_saved', null, { client_id: id, client_secret_changed: !!secret });
    res.json({ ok: true });
  });

  // Step 2: send the Manager to Google to sign in with the account that will own the meetings.
  app.post('/api/settings/google/connect', requireRole('manager'), async (req, res) => {
    const s = await google.readSettings(db);
    if (!s.google_client_id || !s.google_client_secret) throw bad('Save the Client ID and Client secret first');
    const state = crypto.randomBytes(24).toString('hex');
    const redirectUri = redirectUriFor(req);
    await google.saveSettings(db, { google_oauth_state: JSON.stringify({ state, user: req.user.id, redirectUri, exp: Date.now() + STATE_MINUTES * 60000 }) }, req.user.id);
    res.json({ url: google.authUrl(s, redirectUri, state) });
  });

  // Google sends the browser back here after the Manager approves.
  app.get('/api/google/callback', requireRole('manager'), async (req, res) => {
    const back = (status, msg) => res.redirect(`/#/settings?google=${status}${msg ? '&msg=' + encodeURIComponent(msg) : ''}`);
    const s = await google.readSettings(db);
    let pending = null;
    try { pending = JSON.parse(s.google_oauth_state || 'null'); } catch { /* ignore */ }
    if (!pending || pending.state !== req.query.state || pending.user !== req.user.id || pending.exp < Date.now())
      return back('error', 'The sign-in link expired or was already used. Click "Connect Google account" again.');
    await google.saveSettings(db, { google_oauth_state: null });
    if (req.query.error) return back('error', req.query.error === 'access_denied' ? 'Access was not granted in Google.' : `Google said: ${req.query.error}`);
    try {
      const { refresh_token, email } = await google.exchangeCode(s, String(req.query.code || ''), pending.redirectUri);
      await google.saveSettings(db, { google_refresh_token: refresh_token, google_account_email: email, google_connected_at: new Date().toISOString(), google_last_error: null }, req.user.id);
      await audit(db, req.user, 'setting', 0, 'google_connected', null, { account: email });
      back('connected');
    } catch (e) {
      back('error', e.message);
    }
  });

  app.delete('/api/settings/google/connection', requireRole('manager'), async (req, res) => {
    const s = await google.readSettings(db);
    await google.revoke(s);
    await google.saveSettings(db, { google_refresh_token: null, google_account_email: null, google_connected_at: null, google_last_error: null }, req.user.id);
    await audit(db, req.user, 'setting', 0, 'google_disconnected', { account: s.google_account_email }, null);
    res.json({ ok: true });
  });
};
