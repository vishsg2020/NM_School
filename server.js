'use strict';
// Local server. In production on Netlify, netlify/functions/api.js is used instead.
//   npm start                  -> a local Postgres stored in ./data/pg (no install needed)
//   DATABASE_URL=postgresql://... npm start -> any Postgres (e.g. your Supabase project); pending migrations are applied
require('./scripts/load-env');
const path = require('path');
const pg = require('pg');
const { createDb, databasePool } = require('./src/db');
const { applyMigrations } = require('./src/migrate');
const { createApp } = require('./src/app');
const { ensureInitialManager } = require('./scripts/bootstrap');

async function main() {
  let devDb = null;
  let connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    const { NetlifyDB } = await import('@netlify/database-dev');
    devDb = new NetlifyDB({ directory: process.env.LOCAL_DB_DIR || path.join(__dirname, 'data', 'pg'), logger: () => {} });
    connectionString = await devDb.start();
  }
  const pool = devDb ? new pg.Pool({ connectionString, max: 5 }) : databasePool({ max: 5 });
  const applied = await applyMigrations(pool);
  if (applied.length) console.log('Applied migrations:', applied.join(', '));
  const db = createDb(pool);
  await ensureInitialManager(db);
  const port = Number(process.env.PORT || 3000);
  const server = createApp(db).listen(port, () => console.log(`Nalla Malayalam school app on http://localhost:${port}`));
  const shutdown = () => server.close(async () => { await pool.end(); if (devDb) await devDb.stop(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(e => { console.error(e); process.exit(1); });
