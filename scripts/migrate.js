'use strict';
// Applies pending database migrations to DATABASE_URL.
// Usage: DATABASE_URL="postgresql://..." npm run migrate
// On Netlify this runs automatically on production deploys (see netlify.toml).
require('./load-env');
const { databasePool } = require('../src/db');
const { applyMigrations } = require('../src/migrate');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set, so migrations were not applied.');
    process.exit(1);
  }
  const pool = databasePool({ max: 1 });
  try {
    const applied = await applyMigrations(pool, undefined, console.log);
    console.log(applied.length ? `Database is up to date (${applied.length} migration(s) applied).` : 'Database is already up to date.');
  } finally {
    await pool.end();
  }
})().catch(e => { console.error(e.message); process.exit(1); });
