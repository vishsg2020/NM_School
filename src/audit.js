'use strict';

function audit(db, user, entity, entityId, action, before, after, reason) {
  // Only keep fields that actually changed, so history stays readable.
  let b = before, a = after;
  if (before && after) {
    b = {}; a = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (k === 'updated_at') continue;
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) { b[k] = before[k]; a[k] = after[k]; }
    }
    if (!Object.keys(a).length && !reason) return;
  }
  db.prepare(`INSERT INTO audit_events (user_id, entity, entity_id, action, before_json, after_json, reason)
              VALUES (?,?,?,?,?,?,?)`)
    .run(user ? user.id : null, entity, entityId, action,
      b ? JSON.stringify(b) : null, a ? JSON.stringify(a) : null, reason || null);
}

function history(db, entity, entityId) {
  return db.prepare(`SELECT e.*, u.name AS user_name FROM audit_events e
    LEFT JOIN users u ON u.id = e.user_id WHERE e.entity = ? AND e.entity_id = ? ORDER BY e.id DESC`)
    .all(entity, entityId)
    .map(r => ({ ...r, before: r.before_json && JSON.parse(r.before_json), after: r.after_json && JSON.parse(r.after_json) }));
}

module.exports = { audit, history };
