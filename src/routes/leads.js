'use strict';
// Tele team call tracking (from the Sales Management sheet): leads, every call logged against a lead,
// queues worked out from each lead's latest call, a monthly summary and rep targets.
// Visibility: the Manager sees every lead; a Sales Team member sees leads assigned to them and unassigned ones.
const { requireRole } = require('../auth');
const { audit } = require('../audit');
const { isUniqueViolation } = require('../db');
const {
  bad, notFound, forbidden, conflict, str, int, oneOf, idParam, isValidDate, isValidTime, normPhone, today, thisMonth, istDay,
} = require('../util');

// Options from the sheet's Config tab. The four responses with special handling are always kept.
const DEFAULT_OPTIONS = {
  categories: ['NM', 'KVS', 'Online Course', 'Other'],
  responses: ['Connected', 'Not Available', 'Call Later', 'Interested', 'Interested – Price Issue', 'Pre Test Booked', 'Sent More Info', 'Not Interested'],
};
const SPECIAL = ['Not Available', 'Call Later', 'Pre Test Booked', 'Not Interested'];
const INTERESTED = ['Interested', 'Interested – Price Issue', 'Sent More Info'];
const ACTIONS = ['Called', 'No Action'];
const GENDERS = ['Male', 'Female', 'Other'];
const TABS = ['later', 'reconnect', 'interested', 'pretest', 'all'];

async function callOptions(db) {
  const r = await db.get(`SELECT value FROM app_settings WHERE key = 'call_options'`);
  let saved = {}; try { saved = r && r.value ? JSON.parse(r.value) : {}; } catch { saved = {}; }
  const categories = Array.isArray(saved.categories) && saved.categories.length ? saved.categories : DEFAULT_OPTIONS.categories;
  const responses = Array.isArray(saved.responses) && saved.responses.length ? saved.responses : DEFAULT_OPTIONS.responses;
  for (const s of SPECIAL) if (!responses.includes(s)) responses.push(s);
  return { categories, responses, actions: ACTIONS, genders: GENDERS, special: SPECIAL };
}

// Derived per lead: latest call, number of calls and status (Closed Won when the linked student is admitted).
const LEAD_SELECT = `
  SELECT l.*, u.name AS rep_name, lc.response AS last_response, lc.action AS last_action, lc.called_at AS last_called_at,
         lc.notes AS last_notes, lc.callback_at, lc.source AS last_source,
         (SELECT COUNT(*) FROM lead_calls x WHERE x.lead_id = l.id) AS calls,
         CASE WHEN EXISTS (SELECT 1 FROM students s JOIN enrollments e ON e.student_id = s.id WHERE s.candidate_id = l.candidate_id) THEN 'Closed Won'
              WHEN lc.response = 'Not Interested' THEN 'Closed Lost' ELSE 'Open' END AS status,
         cd.lead_id AS candidate_code, cd.status AS candidate_status, cd.student_name AS candidate_name
  FROM leads l
  LEFT JOIN users u ON u.id = l.assigned_rep_id
  LEFT JOIN candidates cd ON cd.id = l.candidate_id
  LEFT JOIN LATERAL (SELECT response, action, called_at, notes, callback_at, source FROM lead_calls WHERE lead_id = l.id
                     ORDER BY called_at DESC, id DESC LIMIT 1) lc ON true`;
const WRAP = sql => `SELECT * FROM (${sql}) v`;
const OPEN = `v.status = 'Open'`;
const TAB_WHERE = {
  later: `${OPEN} AND v.last_response = 'Call Later'`,
  reconnect: `${OPEN} AND v.last_response = 'Not Available'`,
  interested: `${OPEN} AND v.last_response IN ('Interested', 'Interested – Price Issue', 'Sent More Info')`,
  pretest: `(v.last_response = 'Pre Test Booked' OR v.candidate_id IS NOT NULL)`,
  all: 'TRUE',
};
const TAB_ORDER = {
  later: `COALESCE(v.callback_at, '0000') ASC, v.last_called_at ASC`,
  reconnect: 'v.last_called_at ASC',
  interested: 'v.last_called_at DESC',
  pretest: 'v.last_called_at DESC NULLS LAST, v.id DESC',
  all: 'COALESCE(v.last_called_at, v.created_at) DESC, v.id DESC',
};
const phoneTail = p => { const d = normPhone(p); return d.length >= 6 ? d.slice(-10) : ''; };
const monthOf = m => { if (!m) return thisMonth(); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw bad('Month is not valid'); return m; };
const prevMonth = m => { let [y, mm] = m.split('-').map(Number); mm -= 1; if (!mm) { mm = 12; y -= 1; } return `${y}-${String(mm).padStart(2, '0')}`; };

module.exports = (app, { db }) => {
  const sales = requireRole('manager', 'sales');
  const isMgr = u => u.role === 'manager';
  const visible = (u, l) => isMgr(u) || !l.assigned_rep_id || l.assigned_rep_id === u.id;
  const visSql = u => (isMgr(u) ? 'TRUE' : '(v.assigned_rep_id = @me OR v.assigned_rep_id IS NULL)');
  const leadById = id => db.get(`${WRAP(LEAD_SELECT)} WHERE v.id = ?`, [id]);
  async function validRep(id) {
    const u = await db.get(`SELECT id FROM users WHERE id = ? AND role IN ('sales','manager')`, [id]);
    if (!u) throw bad('Choose a Sales Team member or the Manager', { field: 'Assigned rep' });
  }

  app.get('/api/call-options', sales, async (_req, res) => res.json(await callOptions(db)));
  app.put('/api/settings/call-options', requireRole('manager'), async (req, res) => {
    const list = (v, name) => {
      const items = [...new Set(String(v ?? '').split('\n').map(x => x.trim()).filter(Boolean))];
      if (!items.length) throw bad(`${name}: add at least one`, { field: name });
      if (items.some(x => x.length > 60)) throw bad(`${name}: keep each option under 60 characters`, { field: name });
      return items.slice(0, 40);
    };
    const value = { categories: list(req.body.categories, 'Categories'), responses: list(req.body.responses, 'Responses') };
    await db.run(`INSERT INTO app_settings (key, value, updated_by) VALUES ('call_options', ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now_iso()`, [JSON.stringify(value), req.user.id]);
    res.json(await callOptions(db));
  });

  // ---------- Lists ----------
  app.get('/api/leads', sales, async (req, res) => {
    const q = req.query; const tab = TABS.includes(q.tab) ? q.tab : 'later';
    const p = { me: req.user.id, t: today() };
    const where = [visSql(req.user)];
    if (q.q) {
      const d = normPhone(q.q);
      where.push(`(v.name ILIKE @q OR v.lead_code ILIKE @q OR v.location ILIKE @q${d.length >= 3 ? ' OR v.phone_norm LIKE @qp' : ''})`);
      p.q = `%${String(q.q).trim()}%`; if (d.length >= 3) p.qp = `%${d}%`;
    }
    if (q.category) { where.push('v.category = @cat'); p.cat = q.category; }
    if (q.response) { where.push('v.last_response = @resp'); p.resp = q.response; }
    if (q.status && ['Open', 'Closed Won', 'Closed Lost'].includes(q.status)) { where.push('v.status = @st'); p.st = q.status; }
    if (q.rep && isMgr(req.user)) {
      if (q.rep === 'none') where.push('v.assigned_rep_id IS NULL');
      else { where.push('v.assigned_rep_id = @rep'); p.rep = idParam(q.rep); }
    }
    if (q.from && isValidDate(q.from)) { where.push(`${istDay('v.last_called_at')} >= @from`); p.from = q.from; }
    if (q.to && isValidDate(q.to)) { where.push(`${istDay('v.last_called_at')} <= @to`); p.to = q.to; }
    if (q.created_month && /^\d{4}-\d{2}$/.test(q.created_month)) { where.push(`substr(${istDay('v.created_at')},1,7) = @cm`); p.cm = q.created_month; }
    if (q.due === '1') where.push(`(v.callback_at IS NULL OR substr(v.callback_at,1,10) <= @t)`);
    const rows = await db.all(`${WRAP(LEAD_SELECT)} WHERE ${TAB_WHERE[tab]} AND ${where.join(' AND ')} ORDER BY ${TAB_ORDER[tab]} LIMIT 1000`, p);
    // Tab badges: what needs a call (visibility only, no other filters).
    const counts = await db.get(`SELECT
        COUNT(*) FILTER (WHERE ${TAB_WHERE.later} AND (v.callback_at IS NULL OR substr(v.callback_at,1,10) <= @t)) AS later_due,
        COUNT(*) FILTER (WHERE ${TAB_WHERE.later}) AS later,
        COUNT(*) FILTER (WHERE ${TAB_WHERE.reconnect}) AS reconnect,
        COUNT(*) FILTER (WHERE ${TAB_WHERE.interested}) AS interested
      FROM (${LEAD_SELECT}) v WHERE ${visSql(req.user)}`, p);
    res.json({ tab, today: p.t, rows, counts });
  });

  // Is this number known? Used by "Log a call" as the phone is typed.
  app.get('/api/leads/lookup', sales, async (req, res) => {
    const tail = phoneTail(req.query.phone);
    if (!tail) return res.json({ lead: null });
    const l = await db.get(`${WRAP(LEAD_SELECT)} WHERE right(v.phone_norm, 10) = @tail ORDER BY v.id DESC LIMIT 1`, { tail });
    if (!l) return res.json({ lead: null });
    if (!visible(req.user, l)) return res.json({ lead: null, other_rep: l.rep_name });
    res.json({ lead: l });
  });

  app.get('/api/leads/:id', sales, async (req, res) => {
    const l = await leadById(idParam(req.params.id));
    if (!l || !visible(req.user, l)) throw notFound('Lead');
    const calls = await db.all(`SELECT c.*, u.name AS rep_name FROM lead_calls c LEFT JOIN users u ON u.id = c.rep_id
      WHERE c.lead_id = ? ORDER BY c.called_at DESC, c.id DESC`, [l.id]);
    const student = l.candidate_id ? await db.get('SELECT id FROM students WHERE candidate_id = ?', [l.candidate_id]) : null;
    res.json({ ...l, calls, student_id: student ? student.id : null });
  });

  // ---------- Log a call (creates the lead for a new number) ----------
  app.post('/api/calls', sales, async (req, res) => {
    const b = req.body; const opts = await callOptions(db);
    const key = str(b.idempotency_key, { max: 80, name: 'Request key' });
    if (key) {
      const prior = await db.get('SELECT lead_id FROM lead_calls WHERE idempotency_key = ?', [key]);
      if (prior) return res.status(200).json({ ...(await leadById(prior.lead_id)), replayed: true });
    }
    const call = {
      action: oneOf(b.action || 'Called', ACTIONS, { name: 'Call status' }),
      response: oneOf(b.response, opts.responses, { required: true, name: 'Response' }),
      notes: str(b.notes, { name: 'Notes', max: 2000 }),
      callback_at: null,
    };
    if (call.response === 'Call Later') {
      const d = str(b.callback_date, { required: true, name: 'Call back on', max: 10 });
      if (!isValidDate(d)) throw bad('Call-back date is not valid', { field: 'Call back on' });
      const tm = str(b.callback_time, { name: 'Time', max: 5 });
      if (tm && !isValidTime(tm)) throw bad('Call-back time is not valid', { field: 'Time (IST)' });
      call.callback_at = tm ? `${d}T${tm}` : d;
    }
    const details = {};
    if (b.name !== undefined) details.name = str(b.name, { name: 'Name', max: 100 });
    if (b.location !== undefined) details.location = str(b.location, { name: 'Location', max: 100 });
    if (b.gender !== undefined) details.gender = oneOf(b.gender || null, GENDERS, { name: 'Gender' });
    if (b.age !== undefined && b.age !== '' && b.age !== null) details.age = int(b.age, { min: 1, max: 120, name: 'Age' });
    if (b.category !== undefined && b.category !== '') details.category = oneOf(b.category, opts.categories, { name: 'Category' });

    let lead;
    if (b.lead_id) {
      lead = await db.get('SELECT * FROM leads WHERE id = ?', [idParam(b.lead_id)]);
      if (!lead || !visible(req.user, lead)) throw notFound('Lead');
    } else {
      const phone = str(b.phone, { required: true, name: 'Phone number', max: 30 });
      const tail = phoneTail(phone);
      if (!tail) throw bad('Enter a valid phone number', { field: 'Phone number' });
      lead = await db.get('SELECT * FROM leads WHERE right(phone_norm, 10) = ? ORDER BY id DESC LIMIT 1', [tail]);
      if (lead && !visible(req.user, lead)) {
        const rep = await db.get('SELECT name FROM users WHERE id = ?', [lead.assigned_rep_id]);
        throw conflict(`This number is already a lead of ${rep ? rep.name : 'another rep'}. Ask the Manager to reassign it.`, { field: 'Phone number' });
      }
      if (!lead) {
        if (!details.category) throw bad('Choose a category', { field: 'Category' });
        let rep = isMgr(req.user) ? (b.assigned_rep_id ? int(b.assigned_rep_id, { min: 1, name: 'Assigned rep' }) : null) : req.user.id;
        if (rep) await validRep(rep);
        lead = { phone, phone_norm: normPhone(phone), assigned_rep_id: rep, ...details, isNew: true };
      }
    }
    let leadId;
    try {
      leadId = await db.tx(async t => {
        let id = lead.id;
        if (lead.isNew) {
          const r = await t.get(`INSERT INTO leads (phone, phone_norm, name, location, gender, age, category, assigned_rep_id, created_by)
            VALUES (@phone, @phone_norm, @name, @location, @gender, @age, @category, @assigned_rep_id, @by) RETURNING id`,
          { name: null, location: null, gender: null, age: null, ...lead, by: req.user.id });
          id = r.id;
          await audit(t, req.user, 'lead', id, 'created', null, { phone: lead.phone, ...details, assigned_rep_id: lead.assigned_rep_id });
        } else {
          const changes = Object.fromEntries(Object.entries(details).filter(([k, v]) => v !== null && v !== undefined && v !== lead[k]));
          // A Sales Team member who calls an unassigned lead takes it.
          if (!lead.assigned_rep_id && !isMgr(req.user)) changes.assigned_rep_id = req.user.id;
          if (Object.keys(changes).length) {
            await t.run(`UPDATE leads SET ${Object.keys(changes).map(k => `${k} = @${k}`).join(', ')}, updated_at = now_iso() WHERE id = @id`, { ...changes, id });
            await audit(t, req.user, 'lead', id, 'updated', Object.fromEntries(Object.keys(changes).map(k => [k, lead[k]])), changes);
          }
        }
        await t.run(`INSERT INTO lead_calls (lead_id, action, response, notes, callback_at, rep_id, idempotency_key)
          VALUES (@lead, @action, @response, @notes, @callback_at, @rep, @key)`, { ...call, lead: id, rep: req.user.id, key });
        return id;
      });
    } catch (e) {
      if (isUniqueViolation(e) && key) {
        const prior = await db.get('SELECT lead_id FROM lead_calls WHERE idempotency_key = ?', [key]);
        if (prior) return res.status(200).json({ ...(await leadById(prior.lead_id)), replayed: true });
      }
      throw e;
    }
    res.status(201).json(await leadById(leadId));
  });

  app.patch('/api/leads/:id', sales, async (req, res) => {
    const before = await db.get('SELECT * FROM leads WHERE id = ?', [idParam(req.params.id)]);
    if (!before || !visible(req.user, before)) throw notFound('Lead');
    const b = req.body; const opts = await callOptions(db); const l = { ...before };
    if (b.name !== undefined) l.name = str(b.name, { name: 'Name', max: 100 });
    if (b.location !== undefined) l.location = str(b.location, { name: 'Location', max: 100 });
    if (b.gender !== undefined) l.gender = oneOf(b.gender || null, GENDERS, { name: 'Gender' });
    if (b.age !== undefined) l.age = b.age === '' || b.age === null ? null : int(b.age, { min: 1, max: 120, name: 'Age' });
    if (b.category !== undefined) l.category = oneOf(b.category, opts.categories, { required: true, name: 'Category' });
    if (b.phone !== undefined) {
      l.phone = str(b.phone, { required: true, name: 'Phone number', max: 30 }); l.phone_norm = normPhone(l.phone);
      if (!phoneTail(l.phone)) throw bad('Enter a valid phone number', { field: 'Phone number' });
    }
    if (b.assigned_rep_id !== undefined) {
      if (!isMgr(req.user)) throw forbidden();
      l.assigned_rep_id = b.assigned_rep_id ? int(b.assigned_rep_id, { min: 1, name: 'Assigned rep' }) : null;
      if (l.assigned_rep_id) await validRep(l.assigned_rep_id);
    }
    await db.tx(async t => {
      await t.run(`UPDATE leads SET name=@name, location=@location, gender=@gender, age=@age, category=@category, phone=@phone,
        phone_norm=@phone_norm, assigned_rep_id=@assigned_rep_id, updated_at=now_iso() WHERE id=@id`, l);
      await audit(t, req.user, 'lead', l.id, before.assigned_rep_id !== l.assigned_rep_id ? 'reassigned' : 'updated', before, l, str(b.reason, { max: 500 }));
    });
    res.json(await leadById(l.id));
  });

  // ---------- Monthly summary and rep targets ----------
  // Admissions use the existing attribution (first enrollments by Assigned Sales Representative, renewals excluded),
  // so they equal the Reports and dashboard figures. Conversion = admissions ÷ new leads assigned to the rep that month.
  async function repRows(month, onlyUser) {
    const p = { m: month, t: today(), only: onlyUser || null };
    const rows = await db.all(`SELECT u.id, u.name, u.role, u.active,
        (SELECT COUNT(*) FROM leads l WHERE l.assigned_rep_id = u.id AND substr(${istDay('l.created_at')},1,7) = @m) AS new_leads,
        (SELECT COUNT(*) FROM lead_calls c WHERE c.rep_id = u.id AND substr(${istDay('c.called_at')},1,7) = @m) AS calls,
        (SELECT COUNT(*) FROM lead_calls c WHERE c.rep_id = u.id AND c.response = 'Pre Test Booked' AND substr(${istDay('c.called_at')},1,7) = @m) AS pretests_booked,
        (SELECT COUNT(*) FROM enrollments e WHERE e.sales_rep_id = u.id AND e.renewal_of IS NULL AND substr(e.admission_date,1,7) = @m) AS admissions,
        (SELECT COUNT(*) FROM (${LEAD_SELECT}) v WHERE v.assigned_rep_id = u.id AND ${TAB_WHERE.later}
           AND (v.callback_at IS NULL OR substr(v.callback_at,1,10) <= @t)) AS call_later_due,
        (SELECT COUNT(*) FROM (${LEAD_SELECT}) v WHERE v.assigned_rep_id = u.id AND ${TAB_WHERE.reconnect}) AS reconnect,
        rt.target_count, rt.min_conversion, rt.notes AS target_notes
      FROM users u LEFT JOIN rep_targets rt ON rt.user_id = u.id AND rt.month = @m
      WHERE u.role IN ('sales','manager') AND (@only::int IS NULL OR u.id = @only)
      ORDER BY u.role DESC, u.name`, p);
    return rows.map(r => {
      const conversion = r.new_leads ? Math.round((r.admissions / r.new_leads) * 1000) / 10 : null;
      let target_status = null;
      if (r.target_count != null) {
        const countOk = r.admissions >= r.target_count;
        // No new leads that month: conversion is n.a., so only the count is checked.
        const convOk = r.min_conversion == null || conversion == null || conversion >= Number(r.min_conversion);
        target_status = countOk && convOk ? 'On track' : !countOk && !convOk ? 'Needs attention' : !countOk ? 'Behind on count' : 'Low conversion';
      }
      return { ...r, min_conversion: r.min_conversion == null ? null : Number(r.min_conversion), conversion, target_status };
    }).filter(r => onlyUser || r.active || r.new_leads || r.calls || r.admissions || r.target_count != null);
  }

  app.get('/api/calls/summary', sales, async (req, res) => {
    const month = monthOf(req.query.month);
    const reps = await repRows(month, isMgr(req.user) ? null : req.user.id);
    if (!isMgr(req.user)) return res.json({ month, reps });
    const p = { m: month };
    const totals = await db.get(`SELECT
        (SELECT COUNT(*) FROM leads l WHERE substr(${istDay('l.created_at')},1,7) = @m) AS new_leads,
        (SELECT COUNT(*) FROM lead_calls c WHERE substr(${istDay('c.called_at')},1,7) = @m) AS calls,
        (SELECT COUNT(DISTINCT c.rep_id) FROM lead_calls c WHERE substr(${istDay('c.called_at')},1,7) = @m) AS callers,
        (SELECT COUNT(*) FROM lead_calls c WHERE c.response = 'Pre Test Booked' AND substr(${istDay('c.called_at')},1,7) = @m) AS pretests_booked,
        (SELECT COUNT(*) FROM enrollments e WHERE e.renewal_of IS NULL AND substr(e.admission_date,1,7) = @m) AS admissions`, p);
    totals.conversion = totals.new_leads ? Math.round((totals.admissions / totals.new_leads) * 1000) / 10 : null;
    const byCategory = await db.all(`SELECT l.category AS label, COUNT(*) AS n FROM leads l WHERE substr(${istDay('l.created_at')},1,7) = @m GROUP BY 1 ORDER BY n DESC`, p);
    const byResponse = await db.all(`SELECT c.response AS label, COUNT(*) AS n FROM lead_calls c WHERE substr(${istDay('c.called_at')},1,7) = @m GROUP BY 1 ORDER BY n DESC`, p);
    res.json({ month, totals, byCategory, byResponse, reps });
  });

  app.put('/api/targets', requireRole('manager'), async (req, res) => {
    const b = req.body; const month = monthOf(b.month);
    const userId = int(b.user_id, { min: 1, required: true, name: 'Sales rep' }); await validRep(userId);
    const target = int(b.target_count, { min: 0, max: 100000, required: true, name: 'Admissions target' });
    const minConv = b.min_conversion === '' || b.min_conversion === null || b.min_conversion === undefined ? null : Number(b.min_conversion);
    if (minConv !== null && (!Number.isFinite(minConv) || minConv < 0 || minConv > 100)) throw bad('Minimum conversion must be 0–100%', { field: 'Minimum conversion (%)' });
    const notes = str(b.notes, { name: 'Notes', max: 500 });
    await db.tx(async t => {
      const before = await t.get('SELECT * FROM rep_targets WHERE month = ? AND user_id = ?', [month, userId]);
      await t.run(`INSERT INTO rep_targets (month, user_id, target_count, min_conversion, notes, updated_by) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (month, user_id) DO UPDATE SET target_count = EXCLUDED.target_count, min_conversion = EXCLUDED.min_conversion,
        notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now_iso()`, [month, userId, target, minConv, notes, req.user.id]);
      await audit(t, req.user, 'rep_target', userId, before ? 'target_changed' : 'target_set', before, { month, target_count: target, min_conversion: minConv, notes });
    });
    res.json({ month, reps: await repRows(month) });
  });

  app.post('/api/targets/copy', requireRole('manager'), async (req, res) => {
    const month = monthOf(req.body.month); const from = prevMonth(month);
    const r = await db.run(`INSERT INTO rep_targets (month, user_id, target_count, min_conversion, notes, updated_by)
      SELECT @m, user_id, target_count, min_conversion, notes, @by FROM rep_targets WHERE month = @from
      ON CONFLICT (month, user_id) DO NOTHING`, { m: month, from, by: req.user.id });
    res.json({ month, copied: r.rowCount, from, reps: await repRows(month) });
  });
};

module.exports.callOptions = callOptions;
module.exports.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
