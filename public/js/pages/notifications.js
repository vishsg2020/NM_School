import { api, get, esc, drawer, stateBox } from '../core.js';

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) { const m = Math.round(s / 60); return `${m} minute${m === 1 ? '' : 's'} ago`; }
  if (s < 86400) { const h = Math.round(s / 3600); return `${h} hour${h === 1 ? '' : 's'} ago`; }
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** Updates every bell badge on the page. */
export function setBellCount(n) {
  document.querySelectorAll('[data-bell-count]').forEach(b => {
    b.textContent = n > 99 ? '99+' : n; b.classList.toggle('hidden', !n);
  });
  document.querySelectorAll('[data-bell]').forEach(b => b.setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications'));
}

export async function refreshBell() {
  try { setBellCount((await get('/api/notifications/count')).unread); } catch { /* optional */ }
}

export function openNotifications() {
  drawer({
    title: 'Notifications',
    body: `<div id="n-list">${stateBox('loading')}</div>`,
    foot: '<button class="btn" type="button" id="n-all">Mark all read</button><button class="btn primary" type="button" data-close>Close</button>',
    onMount: async (d, close) => {
      const list = d.querySelector('#n-list');
      const draw = data => {
        setBellCount(data.unread);
        list.innerHTML = data.items.length ? `<ul class="notes">${data.items.map(n => `<li>
            <a class="note ${n.read_at ? '' : 'unread'}" href="${esc(n.link || '#/dashboard')}" data-note="${n.id}">
              <span class="t">${esc(n.title)}</span>${n.body ? `<span class="b">${esc(n.body)}</span>` : ''}
              <span class="when">${esc(ago(n.created_at))}${n.read_at ? '' : ' · new'}</span></a></li>`).join('')}</ul>`
          : stateBox('empty', 'No notifications yet', ' Pre-test results for your candidates will appear here.');
      };
      try { draw(await get('/api/notifications?limit=40')); } catch (e) { list.innerHTML = stateBox('error', 'Could not load notifications', e.message); }
      list.addEventListener('click', ev => {
        const a = ev.target.closest('[data-note]');
        if (!a) return;
        api('POST', '/api/notifications/read', { ids: [Number(a.dataset.note)] }).then(r => setBellCount(r.unread)).catch(() => {});
        close();
      });
      d.querySelector('#n-all').addEventListener('click', async () => {
        await api('POST', '/api/notifications/read', { all: true });
        draw(await get('/api/notifications?limit=40'));
      });
    },
  });
}
