'use strict';
// Fee follow-up: WhatsApp reminder log and follow-up notes per payment, plus the reminder message settings.
const { requireRole } = require('../auth');
const { audit } = require('../audit');
const { bad, notFound, str, idParam, isValidDate } = require('../util');

// {parent} {student} {course} {stage} {amount} {due} {payment_details} are filled in for each payment.
const DEFAULT_TEMPLATE = [
  'Hello {parent}! This is a gentle reminder from Nalla Malayalam 🙏',
  'The {stage} fee of {amount} for {student}\'s {course} course {due}.',
  '{payment_details}',
  'Please share the payment screenshot once paid. Thank you!',
].join('\n');

async function setting(db, key) {
  const r = await db.get('SELECT value FROM app_settings WHERE key = ?', [key]);
  return r && r.value != null ? r.value : '';
}
const save = (db, key, value, by) => db.run(`INSERT INTO app_settings (key, value, updated_by) VALUES (?, ?, ?)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now_iso()`, [key, value, by]);

module.exports = (app, { db }) => {
  const reminderSettings = async () => ({
    template: (await setting(db, 'reminder_template')).trim() || DEFAULT_TEMPLATE,
    payment_details: await setting(db, 'payment_details'),
    default_template: DEFAULT_TEMPLATE,
  });
  app.get('/api/settings/reminders', requireRole('manager'), async (_req, res) => res.json(await reminderSettings()));
  app.put('/api/settings/reminders', requireRole('manager'), async (req, res) => {
    await save(db, 'reminder_template', str(req.body.template, { name: 'Message', max: 2000 }) || '', req.user.id);
    await save(db, 'payment_details', str(req.body.payment_details, { name: 'Payment details', max: 500 }) || '', req.user.id);
    res.json(await reminderSettings());
  });

  const payment = async id => {
    const p = await db.get('SELECT id, status FROM payments WHERE id = ?', [idParam(id)]);
    if (!p) throw notFound('Payment');
    return p;
  };
  const summary = id => db.get(`SELECT
      (SELECT COUNT(*) FROM payment_followups WHERE payment_id = @id AND kind = 'reminder') AS reminders,
      (SELECT MAX(created_at) FROM payment_followups WHERE payment_id = @id AND kind = 'reminder') AS last_reminder_at,
      (SELECT note FROM payment_followups WHERE payment_id = @id AND kind = 'note' ORDER BY id DESC LIMIT 1) AS last_note,
      (SELECT next_date FROM payment_followups WHERE payment_id = @id AND next_date IS NOT NULL ORDER BY id DESC LIMIT 1) AS next_date`, { id });

  // Logged when the Manager opens WhatsApp with the reminder (the person presses Send in WhatsApp).
  app.post('/api/payments/:id/reminders', requireRole('manager'), async (req, res) => {
    const p = await payment(req.params.id);
    if (p.status !== 'Pending') throw bad('This payment is already Paid');
    await db.tx(async t => {
      await t.run(`INSERT INTO payment_followups (payment_id, kind, created_by) VALUES (?, 'reminder', ?)`, [p.id, req.user.id]);
      await audit(t, req.user, 'payment', p.id, 'reminder_sent', null, { channel: 'WhatsApp' });
    });
    res.status(201).json(await summary(p.id));
  });

  app.post('/api/payments/:id/notes', requireRole('manager'), async (req, res) => {
    const p = await payment(req.params.id);
    const note = str(req.body.note, { name: 'Note', max: 1000 });
    const next = str(req.body.next_date, { name: 'Next follow-up date', max: 10 });
    if (next && !isValidDate(next)) throw bad('Next follow-up date is not valid', { field: 'Next follow-up date' });
    if (!note && !next) throw bad('Write a note or choose a follow-up date', { field: 'Note' });
    await db.tx(async t => {
      await t.run(`INSERT INTO payment_followups (payment_id, kind, note, next_date, created_by) VALUES (?, 'note', ?, ?, ?)`, [p.id, note, next, req.user.id]);
      await audit(t, req.user, 'payment', p.id, 'follow_up_note', null, { note, next_date: next });
    });
    res.status(201).json(await summary(p.id));
  });
};
module.exports.DEFAULT_TEMPLATE = DEFAULT_TEMPLATE;
