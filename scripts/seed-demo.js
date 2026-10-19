'use strict';
// Creates a SAMPLE database for trying the app. Never point this at the real database.
// Usage: node scripts/seed-demo.js ./data/demo.db   (all names below are fictional)
const path = require('path');
const fs = require('fs');
const pg = require('pg');
const { createDb } = require('../src/db');
const { applyMigrations } = require('../src/migrate');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { today, addMinutes } = require('../src/util');

// Usage: node scripts/seed-demo.js [directory]   (default ./data/demo-pg; a separate local database)
//    or: DEMO_DATABASE_URL=postgres://... node scripts/seed-demo.js   (an EMPTY database you created for demos)
const dir = path.resolve(process.argv[2] || './data/demo-pg');
const PW = 'demo-password';

(async () => {
let devDb = null;
let cs = process.env.DEMO_DATABASE_URL;
if (!cs) {
  fs.rmSync(dir, { recursive: true, force: true });
  const { NetlifyDB } = await import('@netlify/database-dev');
  devDb = new NetlifyDB({ directory: dir, logger: () => {} });
  cs = await devDb.start();
}
const pool = new pg.Pool({ connectionString: cs, max: 4 });
await applyMigrations(pool);
const db = createDb(pool);
if ((await db.get('SELECT COUNT(*) n FROM users')).n) { console.error('Refusing to seed: this database already has users.'); process.exit(1); }
const h = hashPassword(PW);
await db.run(`INSERT INTO users (name,email,password_hash,role) VALUES ('Demo Manager','manager@demo.local',?,'manager')`, [h]);
await db.run(`INSERT INTO users (name,email,password_hash,role) VALUES ('Demo Sales One','sales1@demo.local',?,'sales')`, [h]);
await db.run(`INSERT INTO users (name,email,password_hash,role) VALUES ('Demo Sales Two','sales2@demo.local',?,'sales')`, [h]);

const server = createApp(db).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const jar = {};
async function call(who, method, url, body) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nm-app', Cookie: jar[who] || '' }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  const d = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(d)}`);
  return d;
}
const day = n => addMinutes(`${today()}T00:00`, n * 1440).slice(0, 10);

  await call('m', 'POST', '/api/login', { email: 'manager@demo.local', password: PW });
  await call('s', 'POST', '/api/login', { email: 'sales1@demo.local', password: PW });
  const wk = [1, 2, 3, 4, 5, 6];
  const T = [];
  const tdefs = [
    { name: 'Demo Teacher Asha', supports_1to1: true, supports_3to1: true, monthly_capacity: 120, hours: wk.map(d => ({ weekday: d, start_time: '09:00', end_time: '15:00' })), slots: wk.map(d => ({ weekday: d, start_time: '10:00', end_time: '14:00', format: 'Any' })) },
    { name: 'Demo Teacher Bindu', supports_1to1: true, supports_3to1: false, monthly_capacity: 80, employment_type: 'Freelance', hours: wk.map(d => ({ weekday: d, start_time: '16:00', end_time: '21:00' })) },
    { name: 'Demo Teacher Chitra', supports_1to1: true, supports_3to1: true, monthly_capacity: 100, hours: wk.map(d => ({ weekday: d, start_time: '12:00', end_time: '18:00' })) },
    { name: 'Demo Teacher Deepa', supports_1to1: true, supports_3to1: true, monthly_capacity: 60, employment_type: 'Freelance', hours: [0, 6].map(d => ({ weekday: d, start_time: '08:00', end_time: '20:00' })) },
  ];
  for (const t of tdefs) T.push((await call('m', 'POST', '/api/teachers', t)).id);
  await call('m', 'POST', '/api/users', { name: 'Demo Teacher Asha', email: 'teacher@demo.local', password: PW, role: 'teacher', teacher_id: T[0] });

  const kids = ['Aadhya', 'Ishaan', 'Nila', 'Vihaan', 'Meera', 'Arnav', 'Diya', 'Kabir', 'Tara', 'Rohan', 'Anika', 'Dev'];
  const places = ['Dubai', 'Texas', 'London', 'Toronto', 'Sydney', 'Doha'];
  const C = [];
  for (let i = 0; i < kids.length; i++) {
    const who = i % 3 === 0 ? 'm' : 's';
    const c = await call(who, 'POST', '/api/candidates', {
      first_name: kids[i], last_name: 'Demo', gender: i % 2 ? 'Male' : 'Female',
      parent_name: `Parent of ${kids[i]}`, parent_relationship: i % 2 ? 'Father' : 'Mother', phone: `+97150000${String(100 + i)}`, location: places[i % places.length], age: 5 + (i % 7),
      pretest_at: i % 4 === 3 ? '' : `${day((i % 6) - 2)}T${String(10 + (i % 5)).padStart(2, '0')}:00`,
      time_confirmation: i % 3 === 0 && i % 4 !== 3 ? 'Confirmed' : 'Not Confirmed', idempotency_key: 'demo-' + i,
    });
    C.push(c);
    if (i < 9) await call('m', 'PATCH', `/api/candidates/${c.id}`, { pretest_teacher_id: T[i % 3] });
  }
  const courses = ['Starter', 'Reader', 'Writer', 'Malayalam Master'];
  for (let i = 0; i < 6; i++) {
    await call('m', 'PUT', `/api/candidates/${C[i].id}/result`, { recommended_course: courses[i % 4], assessment: 'Demo assessment notes.', admission_status: i === 5 ? 'Follow-up' : 'Confirmed', recommendation: '1:1 three times a week' });
  }
  // Admissions for the first four (one left awaiting setup).
  for (let i = 0; i < 4; i++) {
    const cand = await call('m', 'GET', `/api/candidates/${C[i].id}`);
    const mode = i === 2 ? '3:1' : '1:1';
    const classes = 30; const fee = classes * (mode === '1:1' ? 250 : 150);
    const e = await call('m', 'POST', '/api/admissions', {
      student_id: cand.student_id, course: courses[i % 4], class_mode: mode, total_classes: classes, teacher_id: T[i === 1 ? 1 : 0], start_date: day(-10),
      total_fee: fee, idempotency_key: 'adm-demo-' + i,
      advance: { amount: fee / 2, status: 'Paid', date: day(-10), method: 'UPI', reference: 'DEMO' + i },
      final: { amount: fee / 2, status: 'Pending', date: day(i === 0 ? -3 : 20) },
    });
    const time = i === 1 ? '17:00' : `1${i}:00`;
    const r = await call('m', 'POST', '/api/classes', { enrollment_id: e.id, start_date: day(-9), time, weekdays: [1, 3, 5], count: 9, acknowledge_warnings: true });
    for (const cl of r.filter(c => c.scheduled_at.slice(0, 10) < today()).slice(0, 4)) {
      await call('m', 'PATCH', `/api/classes/${cl.id}`, { status: 'Completed', attendance: 'Present', topics: 'Letters അ–ഈ', homework: 'Practice sheet' });
    }
  }
  console.log(`Demo data written${devDb ? ' to ' + dir : ''}. Start it with: LOCAL_DB_DIR=${devDb ? dir : '<dir>'} npm start`);
  console.log(`Sign in with manager@demo.local / sales1@demo.local / teacher@demo.local, password "${PW}".`);
  server.close(); await pool.end(); if (devDb) await devDb.stop();
})().catch(e => { console.error(e); process.exit(1); });
