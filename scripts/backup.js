'use strict';
// Online, consistent SQLite backup. Usage: npm run backup  (keeps the newest BACKUP_KEEP files)
require('./load-env');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const src = process.env.DATABASE_PATH || './data/nm-school.db';
const dir = process.env.BACKUP_DIR || './backups';
const keep = Number(process.env.BACKUP_KEEP || 30);
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = path.join(dir, `nm-school-${stamp}.db`);
const db = new Database(src, { readonly: true, fileMustExist: true });
db.backup(dest).then(() => {
  db.close();
  const check = new Database(dest, { readonly: true });
  const ok = check.pragma('integrity_check', { simple: true });
  check.close();
  if (ok !== 'ok') { console.error('Backup integrity check failed:', ok); process.exit(1); }
  const files = fs.readdirSync(dir).filter(f => /^nm-school-.*\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, f));
  console.log('Backup written:', dest);
}).catch(e => { console.error(e); process.exit(1); });
