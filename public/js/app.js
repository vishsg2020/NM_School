import { state, api, get, esc, html, raw, roleName, parseHash, can, loadLookups, toast, onSubmit, stateBox, closeDrawer } from './core.js';
import * as dashboard from './pages/dashboard.js';
import * as pretests from './pages/pretests.js';
import * as admissions from './pages/admissions.js';
import * as students from './pages/students.js';
import * as classes from './pages/classes.js';
import * as teachers from './pages/teachers.js';
import * as reports from './pages/reports.js';
import * as users from './pages/users.js';
import * as settings from './pages/settings.js';
import { openNotifications, refreshBell } from './pages/notifications.js';

const app = document.getElementById('app');

const NAV = [
  { group: null, items: [{ path: 'dashboard', label: 'Dashboard', roles: ['manager', 'sales', 'teacher'] }] },
  { group: 'Pre-tests', items: [
    { path: 'pretests', label: 'Pre-Test Queue', roles: ['manager', 'sales', 'teacher'] },
  ] },
  { group: 'Students', items: [
    { path: 'admissions', label: 'Admissions', roles: ['manager'], badge: 'awaiting_setup' },
    { path: 'students', label: 'Students', roles: ['manager', 'teacher'] },
    { path: 'payments', label: 'Payments', roles: ['manager'] },
  ] },
  { group: 'Classes', items: [
    { path: 'calendar', label: 'Calendar', roles: ['manager', 'teacher'] },
    { path: 'classes', label: 'Class Activity', roles: ['manager', 'teacher'] },
  ] },
  { group: 'Manage', items: [
    { path: 'teachers', label: 'Teachers', roles: ['manager'] },
    { path: 'reports', label: 'Reports', roles: ['manager'] },
    { path: 'users', label: 'Users', roles: ['manager'] },
    { path: 'settings', label: 'Settings', roles: ['manager'] },
  ] },
];

const ROUTES = {
  dashboard: dashboard.render,
  pretests: pretests.renderQueue,
  candidate: pretests.renderCandidate,
  admissions: admissions.renderPending,
  payments: admissions.renderPayments,
  students: students.renderList,
  student: students.renderProfile,
  calendar: classes.renderCalendar,
  classes: classes.renderActivity,
  teachers: teachers.render,
  reports: reports.render,
  users: users.render,
  settings: settings.render,
  account: users.renderAccount,
};

function renderLogin(message) {
  document.title = 'Sign in · Nalla Malayalam';
  app.innerHTML = html`<div class="login-wrap">
    <div class="login-art">
      <img class="login-logo" src="img/logo-white.png" alt="" width="640" height="784">
      <h1 class="sr-only">Nalla Malayalam</h1>
      <p>Pre-tests, admissions, classes and fees for the online school, in one place.</p>
    </div>
    <main class="login-form">
      <form id="login" novalidate>
        <h2>Sign in</h2>
        <p class="muted">Use the account your Manager created for you.</p>
        ${raw(message ? `<div class="notice info">${esc(message)}</div>` : '')}
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
        <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </main></div>`;
  const form = document.getElementById('login');
  onSubmit(form, async d => {
    if (!d.email || !d.password) throw new Error('Enter your email and password');
    const r = await api('POST', '/api/login', d);
    state.me = r.user;
    await boot();
  });
}

function renderShell() {
  const me = state.me;
  const nav = NAV.map(g => {
    const items = g.items.filter(i => i.roles.includes(me.role));
    if (!items.length) return '';
    return (g.group ? `<li class="nav-group" aria-hidden="true">${esc(g.group)}</li>` : '') +
      items.map(i => `<li><a href="#/${i.path}" data-nav="${i.path}">${esc(i.label)}${i.badge ? `<span class="count hidden" data-badge="${i.badge}"></span>` : ''}</a></li>`).join('');
  }).join('');
  app.innerHTML = `
    <div class="topbar"><button type="button" id="menu-btn" aria-expanded="false" aria-controls="side">Menu</button>
      <img class="brand-mark" src="img/mark-green.png" alt="" width="160" height="164"><strong>Nalla Malayalam</strong>
      <span class="spacer"></span><button type="button" class="bell" data-bell aria-label="Notifications"><span aria-hidden="true">🔔</span><span class="bell-label">Notifications</span><span class="bell-n hidden" data-bell-count></span></button></div>
    <div class="shell">
      <nav class="side" id="side" aria-label="Main">
        <a class="brand" href="#/dashboard" aria-label="Nalla Malayalam, go to dashboard">
          <img class="brand-logo" src="img/logo-green.png" alt="" width="480" height="588">
          <span class="brand-sub">School operations</span></a>
        <div class="side-bell"><button type="button" class="bell" data-bell aria-label="Notifications"><span aria-hidden="true">🔔</span><span class="bell-label">Notifications</span><span class="bell-n hidden" data-bell-count></span></button></div>
        <ul class="nav">${nav}</ul>
        <div class="side-foot">
          <div class="who">${esc(me.name)}</div><div class="role">${esc(roleName(me.role))}</div>
          <a href="#/account">Change password</a> · <button class="linkbtn" type="button" id="logout">Sign out</button>
        </div>
      </nav>
      <main class="main" id="page" tabindex="-1"></main>
    </div>`;
  document.querySelectorAll('[data-bell]').forEach(b => b.addEventListener('click', openNotifications));
  refreshBell();
  document.getElementById('logout').addEventListener('click', async () => {
    await api('POST', '/api/logout').catch(() => {});
    state.me = null; renderLogin('You have signed out.');
  });
  const side = document.getElementById('side'); const mb = document.getElementById('menu-btn');
  mb.addEventListener('click', () => { const o = side.classList.toggle('open'); mb.setAttribute('aria-expanded', o); });
  side.addEventListener('click', e => { if (e.target.closest('a')) { side.classList.remove('open'); mb.setAttribute('aria-expanded', 'false'); } });
}

export async function refreshBadges() {
  if (!can('manager')) return;
  try {
    const d = await get('/api/dashboard');
    const n = d.metrics.awaiting_setup;
    document.querySelectorAll('[data-badge="awaiting_setup"]').forEach(b => { b.textContent = n; b.classList.toggle('hidden', !n); b.setAttribute('aria-label', `${n} awaiting setup`); });
  } catch { /* badge is optional */ }
}

let renderSeq = 0;
async function route() {
  if (!state.me) return;
  closeDrawer();
  const { parts, query } = parseHash();
  const name = parts[0] || 'dashboard';
  const page = document.getElementById('page');
  document.querySelectorAll('[data-nav]').forEach(a => a.toggleAttribute('aria-current', false));
  const navName = { candidate: 'pretests', student: 'students' }[name] || name;
  document.querySelector(`[data-nav="${navName}"]`)?.setAttribute('aria-current', 'page');
  const fn = ROUTES[name];
  const seq = ++renderSeq;
  if (!fn) { page.innerHTML = stateBox('error', 'Page not found', 'Use the menu to find what you need.'); return; }
  page.innerHTML = stateBox('loading');
  // Render into a detached container and swap it in only if this is still the latest navigation,
  // so a slow page can never overwrite the page the user moved on to.
  const view = document.createElement('div');
  try {
    await fn(view, { id: parts[1], query, isCurrent: () => seq === renderSeq });
    if (seq !== renderSeq) return;
    page.replaceChildren(view);
    page.focus({ preventScroll: true });
    refreshBadges(); refreshBell();
  } catch (err) {
    if (seq !== renderSeq) return;
    if (err.status === 403) page.innerHTML = stateBox('error', 'You do not have access to this page', 'Ask the Manager if you need it.');
    else if (err.status === 404) page.innerHTML = stateBox('error', 'Not found', err.message);
    else page.innerHTML = stateBox('error', 'Could not load this page', err.message);
  }
}

async function boot() {
  try {
    const r = await get('/api/me');
    state.me = r.user;
  } catch { state.me = null; }
  if (!state.me) return renderLogin();
  await loadLookups();
  renderShell();
  if (!location.hash || location.hash === '#/' ) history.replaceState(null, '', '#/dashboard');
  await route();
  refreshBadges();
}

window.addEventListener('hashchange', route);
// New notifications show up within a minute while the app is open (and on every page change).
setInterval(() => { if (state.me && document.visibilityState === 'visible') refreshBell(); }, 60000);
window.addEventListener('nm:signed-out', () => { if (state.me) { state.me = null; renderLogin('Your session has ended. Please sign in again.'); } });
window.addEventListener('nm:changed', () => { loadLookups().catch(() => {}); refreshBadges(); });
window.addEventListener('unhandledrejection', e => { toast(e.reason?.message || 'Something went wrong', 'error'); });
boot();
