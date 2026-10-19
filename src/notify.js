'use strict';
// In-app notifications (the bell). Written inside the caller's transaction.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-25' [+ '18:30'] -> '25 Oct 2026, 6:30 PM' */
function fmtWhen(date, time) {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  let s = `${d} ${MONTHS[m - 1]} ${y}`;
  if (time) {
    const [h, mi] = time.split(':').map(Number);
    s += `, ${((h + 11) % 12) + 1}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }
  return s;
}

/** Sends one notification to each user id (duplicates and the actor removed). */
async function notify(t, userIds, { kind, title, body, link }, actorId) {
  const ids = [...new Set(userIds)].filter(id => id && id !== actorId);
  for (const id of ids) {
    await t.run('INSERT INTO notifications (user_id, kind, title, body, link) VALUES (?, ?, ?, ?, ?)', [id, kind, title, body || null, link || null]);
  }
  return ids.length;
}

module.exports = { notify, fmtWhen };
