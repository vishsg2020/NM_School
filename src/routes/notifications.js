'use strict';
const { idParam, int } = require('../util');

module.exports = (app, { db }) => {
  app.get('/api/notifications', async (req, res) => {
    const limit = int(req.query.limit, { min: 1, max: 100 }) || 30;
    const items = await db.all(`SELECT id, kind, title, body, link, read_at, created_at FROM notifications
      WHERE user_id = ? ORDER BY id DESC LIMIT ${limit}`, [req.user.id]);
    const { n } = await db.get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
    res.json({ unread: n, items });
  });
  app.get('/api/notifications/count', async (req, res) => {
    const { n } = await db.get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
    res.json({ unread: n });
  });
  app.post('/api/notifications/read', async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(idParam).filter(i => i > 0).slice(0, 200) : null;
    if (ids && ids.length) {
      await db.run(`UPDATE notifications SET read_at = now_iso() WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, [req.user.id, ...ids]);
    } else if (req.body.all) {
      await db.run('UPDATE notifications SET read_at = now_iso() WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
    }
    const { n } = await db.get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
    res.json({ unread: n });
  });
};
