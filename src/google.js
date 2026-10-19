'use strict';
// Google Calendar / Meet integration.
// The Manager connects ONE Google account in Settings (OAuth, offline access). Pre-test meetings are created as
// events in that account's primary calendar with a Google Meet link. No invitations are emailed: staff copy the
// link from the app and share it themselves (WhatsApp, email…).
const crypto = require('crypto');
const { addMinutes } = require('./util');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];
const TZ = process.env.APP_TZ || 'Asia/Kolkata';
const SUGGESTED_ACCOUNT = process.env.GOOGLE_ACCOUNT_HINT || 'nmlflow@gmail.com';

let fetchImpl = (...a) => globalThis.fetch(...a);
/** Tests replace Google with a fake. */
function setFetch(f) { fetchImpl = f; tokenCache = null; }

// ---------- settings ----------
const KEYS = ['google_client_id', 'google_client_secret', 'google_refresh_token', 'google_account_email',
  'google_connected_at', 'google_last_error', 'google_oauth_state'];

async function readSettings(db) {
  const rows = await db.all(`SELECT key, value FROM app_settings WHERE key IN (${KEYS.map(() => '?').join(',')})`, KEYS);
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  s.google_client_id = s.google_client_id || process.env.GOOGLE_CLIENT_ID || null;
  s.google_client_secret = s.google_client_secret || process.env.GOOGLE_CLIENT_SECRET || null;
  return s;
}
async function saveSettings(db, values, userId) {
  for (const [key, value] of Object.entries(values)) {
    await db.run(`INSERT INTO app_settings (key, value, updated_by) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now_iso()`,
    [key, value, userId ?? null]);
  }
  tokenCache = null;
}
const isConnected = s => !!(s.google_client_id && s.google_client_secret && s.google_refresh_token);

// ---------- OAuth ----------
function authUrl(s, redirectUri, state) {
  const q = new URLSearchParams({
    client_id: s.google_client_id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, login_hint: SUGGESTED_ACCOUNT,
  });
  return `${AUTH_URL}?${q}`;
}

async function postForm(url, body) {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw googleError(data, r.status);
  return data;
}
function googleError(data, status) {
  const code = data && (data.error?.status || data.error);
  const msg = (data && (data.error_description || data.error?.message || (typeof data.error === 'string' ? data.error : ''))) || `HTTP ${status}`;
  const e = new Error(`Google: ${msg}`);
  e.googleCode = code; e.status = status;
  return e;
}

async function exchangeCode(s, code, redirectUri) {
  const tok = await postForm(TOKEN_URL, { code, client_id: s.google_client_id, client_secret: s.google_client_secret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  if (!tok.refresh_token) throw new Error('Google did not return a refresh token. Remove the app\'s access in the Google account (myaccount.google.com → Security → Third-party access) and connect again.');
  const who = await fetchImpl(USERINFO_URL, { headers: { Authorization: `Bearer ${tok.access_token}` } }).then(r => r.json()).catch(() => ({}));
  return { refresh_token: tok.refresh_token, email: who.email || null };
}

let tokenCache = null; // { token, exp }
async function accessToken(db, s) {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.token;
  try {
    const tok = await postForm(TOKEN_URL, { client_id: s.google_client_id, client_secret: s.google_client_secret, refresh_token: s.google_refresh_token, grant_type: 'refresh_token' });
    tokenCache = { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3000) * 1000 };
    if (s.google_last_error) await saveSettings(db, { google_last_error: null });
    return tok.access_token;
  } catch (e) {
    const msg = e.googleCode === 'invalid_grant'
      ? 'The Google connection has expired or was removed. Connect the Google account again in Settings.'
      : e.message;
    await saveSettings(db, { google_last_error: msg }).catch(() => {});
    throw new Error(msg);
  }
}

async function revoke(s) {
  if (!s.google_refresh_token) return;
  await fetchImpl(`${REVOKE_URL}?token=${encodeURIComponent(s.google_refresh_token)}`, { method: 'POST' }).catch(() => {});
}

// ---------- Calendar events ----------
async function calendar(db, s, method, url, body) {
  const token = await accessToken(db, s);
  const r = await fetchImpl(url, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === 'DELETE' && (r.status === 404 || r.status === 410)) return null; // already gone
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw googleError(data, r.status);
  return data;
}

function eventBody(c, minutes) {
  return {
    summary: `Nalla Malayalam pre-test: ${c.student_name} (${c.lead_id})`,
    description: 'Malayalam pre-test assessment with Nalla Malayalam.',
    start: { dateTime: `${c.pretest_at}:00`, timeZone: TZ },
    end: { dateTime: `${addMinutes(c.pretest_at, minutes)}:00`, timeZone: TZ },
  };
}
const meetLinkOf = ev => ev && (ev.hangoutLink || ev.conferenceData?.entryPoints?.find(p => p.entryPointType === 'video')?.uri) || null;

async function createMeeting(db, s, c, minutes) {
  let ev = await calendar(db, s, 'POST', `${CAL}?conferenceDataVersion=1&sendUpdates=none`, {
    ...eventBody(c, minutes),
    conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
  });
  // Google sometimes finishes creating the Meet room a moment later.
  for (let i = 0; i < 3 && !meetLinkOf(ev); i++) {
    await new Promise(r => setTimeout(r, 700));
    ev = await calendar(db, s, 'GET', `${CAL}/${encodeURIComponent(ev.id)}`);
  }
  if (!meetLinkOf(ev)) throw new Error('Google created the event but no Meet link yet. Try "Create meeting link" again in a minute.');
  return { meet_link: meetLinkOf(ev), meet_event_id: ev.id };
}
const moveMeeting = (db, s, c, minutes) => calendar(db, s, 'PATCH', `${CAL}/${encodeURIComponent(c.meet_event_id)}?sendUpdates=none`, eventBody(c, minutes));
const deleteMeeting = (db, s, eventId) => calendar(db, s, 'DELETE', `${CAL}/${encodeURIComponent(eventId)}?sendUpdates=none`);

module.exports = {
  SCOPES, SUGGESTED_ACCOUNT, setFetch, readSettings, saveSettings, isConnected, authUrl, exchangeCode, revoke,
  createMeeting, moveMeeting, deleteMeeting,
};
