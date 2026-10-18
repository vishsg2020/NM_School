'use strict';
// Off-site safety copy: exports every table to one JSON file.
// Supabase's Free plan has no automatic backups, so run this regularly (a weekly GitHub Action is included).
//
// Usage: DATABASE_URL="postgresql://..." npm run backup     (the same Supabase connection string the app uses)
// Writes ./backups/nm-school-<timestamp>.json and keeps the newest BACKUP_KEEP files.
require('./load-env');
const fs = require('fs');
const path = require('path');
const { databasePool } = require('../src/db');

const TABLES = ['users', 'teachers', 'teacher_hours', 'teacher_slots', 'candidates', 'pretest_results', 'students',
  'enrollments', 'payments', 'classes', 'audit_events'];

(async () => {
  const cs = process.env.DATABASE_URL;
  if (!cs) { console.error('Set DATABASE_URL to the database connection string.'); process.exit(1); }
  const dir = process.env.BACKUP_DIR || './backups';
  const keep = Number(process.env.BACKUP_KEEP || 30);
  fs.mkdirSync(dir, { recursive: true });
  const pool = databasePool({ max: 1 });
  const client = await pool.connect();
  const out = { exported_at: new Date().toISOString(), tables: {} };
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); // one consistent view
    for (const t of TABLES) out.tables[t] = (await client.query(`SELECT * FROM ${t} ORDER BY id`)).rows;
    await client.query('COMMIT');
  } finally { client.release(); await pool.end(); }
  const file = path.join(dir, `nm-school-${out.exported_at.replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  const files = fs.readdirSync(dir).filter(f => /^nm-school-.*\.json$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, f));
  console.log(`Backup written: ${file} (${TABLES.map(t => `${t} ${out.tables[t].length}`).join(', ')})`);
})().catch(e => { console.error(e.message); process.exit(1); });
