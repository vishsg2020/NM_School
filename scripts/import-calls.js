'use strict';
// Imports the tele team's "Sales Management" Google Sheet (downloaded as .xlsx) into Calls:
// the Leads tab becomes leads and the Activity History tab becomes their call history.
//
//   DATABASE_URL="<supabase uri>" npm run import:calls -- "/path/Sales_Management.xlsx" --dry-run   (summary only)
//   DATABASE_URL="<supabase uri>" npm run import:calls -- "/path/Sales_Management.xlsx"             (import)
//   Local database instead: LOCAL_DB_DIR=./data/pg npm run import:calls -- file.xlsx   (stop the app first)
//
// Safe to run again: leads already imported (same Lead ID) and calls already imported (same Activity ID) are skipped.
// Sales reps named in the sheet who have no login are added as INACTIVE Sales Team users (no password) so their
// history keeps their name; give them a login later under Users if they need one.
require('./load-env');
const path = require('path');
const crypto = require('crypto');
const pg = require('pg');
const ExcelJS = require('exceljs');
const { createDb, databasePool } = require('../src/db');
const { applyMigrations } = require('../src/migrate');
const { hashPassword } = require('../src/auth');
const { normPhone } = require('../src/util');

const file = process.argv.slice(2).find(a => !a.startsWith('--'));
const dry = process.argv.includes('--dry-run');
if (!file) { console.error('Usage: npm run import:calls -- "/path/Sales_Management.xlsx" [--dry-run]'); process.exit(1); }

const GENDERS = ['Male', 'Female', 'Other'];
const ACTIONS = ['Called', 'No Action'];
const blank = v => v === null || v === undefined || String(v).trim() === '' || /^nil$/i.test(String(v).trim());
const text = v => (blank(v) ? null : String(v).trim().replace(/\s+/g, ' '));
// The sheet's Name column sometimes holds placeholders like 1, 2 or NIL.
const nameOf = v => (blank(v) || /^\d+(\.0)?$/.test(String(v).trim()) ? null : text(v));
const phoneOf = v => (blank(v) ? null : typeof v === 'number' ? String(Math.round(v)) : String(v).trim());
/** Sheet times are India time without a zone; Excel stores them as if UTC. Returns a UTC ISO string. */
function istToUtc(v) {
  if (blank(v)) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (isNaN(d)) return null;
  return new Date(d.getTime() - 330 * 60000).toISOString();
}
function readSheet(ws) {
  // Header row is the first row whose first cell is "Lead ID" / "Activity ID".
  let headerRow = null;
  ws.eachRow((row, n) => { if (!headerRow && /^(Lead ID|Activity ID)$/.test(String(row.getCell(1).value || '').trim())) headerRow = n; });
  if (!headerRow) return [];
  const heads = ws.getRow(headerRow).values.map(h => (h == null ? '' : String(h).trim()));
  const out = [];
  ws.eachRow((row, n) => {
    if (n <= headerRow) return;
    const o = {}; heads.forEach((h, i) => { if (h) { let v = row.getCell(i).value; if (v && typeof v === 'object' && !(v instanceof Date)) v = v.result ?? v.text ?? null; o[h] = v; } });
    if (!blank(o['Lead ID']) || !blank(o['Activity ID'])) out.push(o);
  });
  return out;
}

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(file));
  const leadsWs = wb.getWorksheet('Leads'); const histWs = wb.getWorksheet('Activity History');
  if (!leadsWs || !histWs) throw new Error('The workbook needs the "Leads" and "Activity History" tabs.');
  const leads = readSheet(leadsWs).filter(r => /^NM-/.test(String(r['Lead ID'])));
  const hist = readSheet(histWs).filter(r => /^ACT-/.test(String(r['Activity ID'])));

  let pool; let devDb = null;
  if (process.env.DATABASE_URL) pool = databasePool({ max: 2 });
  else {
    const { NetlifyDB } = await import('@netlify/database-dev');
    devDb = new NetlifyDB({ directory: path.resolve(process.env.LOCAL_DB_DIR || './data/pg'), logger: () => {} });
    pool = new pg.Pool({ connectionString: await devDb.start(), max: 1 });
  }
  await applyMigrations(pool);
  const db = createDb(pool);
  const stats = { leads_in_sheet: leads.length, calls_in_sheet: hist.length, leads_new: 0, leads_skipped: 0, calls_new: 0, calls_skipped: 0,
    calls_from_lead_row: 0, calls_without_lead: 0, reps_created: [] };
  try {
    await db.tx(async t => {
      // Reps by name (case-insensitive) among Sales Team and Manager logins.
      const users = await t.all(`SELECT id, name FROM users WHERE role IN ('sales','manager')`);
      const repIds = new Map(users.map(u => [u.name.trim().toLowerCase(), u.id]));
      const repOf = async name => {
        const n = text(name); if (!n) return null;
        if (repIds.has(n.toLowerCase())) return repIds.get(n.toLowerCase());
        const email = `${n.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') || 'rep'}.imported@nallamalayalam.local`;
        const r = await t.get(`INSERT INTO users (name, email, password_hash, role, active) VALUES (?, ?, ?, 'sales', 0) RETURNING id`,
          [n, email, hashPassword(crypto.randomBytes(24).toString('hex'))]);
        repIds.set(n.toLowerCase(), r.id); stats.reps_created.push(n);
        return r.id;
      };
      const leadIds = new Map((await t.all('SELECT id, lead_code FROM leads')).map(l => [l.lead_code, l.id]));
      for (const r of leads) {
        const code = String(r['Lead ID']).trim();
        if (leadIds.has(code)) { stats.leads_skipped++; continue; }
        const phone = phoneOf(r['Phone Number']);
        const age = Number(r.Age); const gender = text(r.Gender);
        const row = await t.get(`INSERT INTO leads (lead_code, phone, phone_norm, name, location, gender, age, category, assigned_rep_id, source, created_at, updated_at)
          VALUES (@code, @phone, @pn, @name, @loc, @gender, @age, @cat, @rep, 'import', @at, @at) RETURNING id`, {
          code, phone, pn: phone ? normPhone(phone) : null, name: nameOf(r.Name), loc: text(r.Location),
          gender: GENDERS.includes(gender) ? gender : null, age: Number.isInteger(age) && age >= 1 && age <= 120 ? age : null,
          cat: text(r.Category) || 'Other', rep: await repOf(r['Assigned Rep']), at: istToUtc(r['Created Date/Time']) || new Date().toISOString(),
        });
        leadIds.set(code, row.id); stats.leads_new++;
      }
      const seen = new Set((await t.all(`SELECT ext_id FROM lead_calls WHERE ext_id IS NOT NULL`)).map(c => c.ext_id));
      const leadsWithCalls = new Set();
      for (const h of hist) {
        const ext = String(h['Activity ID']).trim(); const code = text(h['Lead ID']);
        if (code) leadsWithCalls.add(code);
        if (seen.has(ext)) { stats.calls_skipped++; continue; }
        const lid = leadIds.get(code);
        if (!lid) { stats.calls_without_lead++; continue; }
        const action = text(h.Action);
        await t.run(`INSERT INTO lead_calls (lead_id, called_at, action, response, notes, rep_id, source, ext_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'import', ?, now_iso())`, [lid, istToUtc(h['Date/Time']) || new Date().toISOString(),
          ACTIONS.includes(action) ? action : 'Called', text(h.Response), text(h.Notes), await repOf(h['Assigned Rep']), ext]);
        seen.add(ext); stats.calls_new++;
      }
      // Leads with a latest response but no history row: keep that response as one call so the lead lands in the right list.
      for (const r of leads) {
        const code = String(r['Lead ID']).trim(); const ext = `LEAD-${code}`;
        if (leadsWithCalls.has(code) || blank(r['Latest Response']) || seen.has(ext)) continue;
        const action = text(r['Latest Action']);
        await t.run(`INSERT INTO lead_calls (lead_id, called_at, action, response, rep_id, source, ext_id)
          VALUES (?, ?, ?, ?, ?, 'import', ?)`, [leadIds.get(code), istToUtc(r['Last Called Date/Time']) || istToUtc(r['Created Date/Time']) || new Date().toISOString(),
          ACTIONS.includes(action) ? action : 'Called', text(r['Latest Response']), await repOf(r['Assigned Rep']), ext]);
        seen.add(ext); stats.calls_from_lead_row++;
      }
      if (dry) throw Object.assign(new Error('dry run'), { dry: true });
    });
    console.log('Imported.', stats);
  } catch (e) {
    if (!e.dry) throw e;
    console.log('Dry run: nothing was saved. This is what the import would do:', stats);
  } finally {
    await pool.end(); if (devDb) await devDb.stop();
  }
})().catch(e => { console.error(e.message); process.exit(1); });
