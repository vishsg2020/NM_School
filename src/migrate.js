'use strict';
// Applies db/migrations/<number>_<slug>.sql files in name order, once each, recording them in schema_migrations.
// Each file runs in its own transaction; a failing file is rolled back and stops the run.
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'db', 'migrations');

async function applyMigrations(pool, dir = DEFAULT_DIR, log = () => {}) {
  const files = fs.readdirSync(dir).filter(f => /^\d+_[a-z0-9_-]+\.sql$/.test(f)).sort();
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = [];
  for (const file of files) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise concurrent runs (e.g. two deploys at once): the second waits, then sees the file as applied.
      await client.query('LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE');
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) { await client.query('COMMIT'); continue; }
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
      log(`Applied ${file}`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${file} failed: ${e.message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

module.exports = { applyMigrations, DEFAULT_DIR };
