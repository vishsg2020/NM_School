'use strict';
// Thin async adapter over a pg pool (Supabase Postgres in production; a local Postgres in development and tests).
//
// SQL may use positional `?` placeholders with an array, or `@name` placeholders with an object.
// Both are converted to Postgres `$n` parameters, so values are never interpolated into SQL.

const INT8 = 20, NUMERIC = 1700;

function toPg(sql, params) {
  if (params === undefined || params === null) return { text: sql, values: [] };
  if (Array.isArray(params)) {
    let i = 0;
    const text = sql.replace(/\?/g, () => '$' + (++i));
    if (i !== params.length) throw new Error(`SQL expects ${i} parameters, got ${params.length}`);
    return { text, values: params.map(v => (v === undefined ? null : v)) };
  }
  const names = [];
  const text = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    if (!(name in params)) throw new Error(`Missing SQL parameter @${name}`);
    let idx = names.indexOf(name);
    if (idx === -1) { names.push(name); idx = names.length - 1; }
    return '$' + (idx + 1);
  });
  return { text, values: names.map(n => (params[n] === undefined ? null : params[n])) };
}

// COUNT/SUM come back from Postgres as strings (bigint/numeric); the app's figures fit safely in a JS number.
function normalize(result) {
  const numeric = (result.fields || []).filter(f => f.dataTypeID === INT8 || f.dataTypeID === NUMERIC).map(f => f.name);
  if (!numeric.length) return result.rows;
  for (const row of result.rows) for (const k of numeric) if (row[k] !== null && row[k] !== undefined) row[k] = Number(row[k]);
  return result.rows;
}

function wrap(runner) {
  const exec = async (sql, params) => runner.query(toPg(sql, params));
  return {
    all: async (sql, params) => normalize(await exec(sql, params)),
    get: async (sql, params) => normalize(await exec(sql, params))[0],
    run: async (sql, params) => { const r = await exec(sql, params); return { rowCount: r.rowCount, rows: normalize(r) }; },
  };
}

function createDb(pool) {
  const db = wrap({ query: q => pool.query(q) });
  /** Runs fn(t) inside a transaction on one connection; rolls back if fn throws. */
  db.tx = async fn => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(wrap({ query: q => client.query(q) }));
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
      throw e;
    } finally {
      client.release();
    }
  };
  db.pool = pool;
  return db;
}

/**
 * Production pool from DATABASE_URL (e.g. Supabase's transaction pooler, port 6543).
 * TLS: verified against a CA certificate when one is supplied (DATABASE_CA_CERT env var with the PEM text,
 * or the file db/ca.crt); otherwise encrypted without certificate verification (libpq "sslmode=require").
 * Local hosts connect without TLS unless the URL asks for it.
 */
function databasePool({ max = 3 } = {}) {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set. Add your Supabase connection string to the environment.');
  const url = new URL(raw);
  const sslmode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode'); // configure TLS explicitly below instead of via the URL
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  let ssl = false;
  if (!(local && !sslmode) && sslmode !== 'disable') {
    const ca = readCaCert();
    ssl = ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
  }
  const pg = require('pg');
  return new pg.Pool({ connectionString: url.toString(), ssl, max, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000 });
}

function readCaCert() {
  if (process.env.DATABASE_CA_CERT) return process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n');
  const fs = require('fs');
  const path = require('path');
  // Source layout (src/../db), bundled function layout (api.js next to db/), and the working directory.
  for (const f of [path.join(__dirname, '..', 'db', 'ca.crt'), path.join(__dirname, 'db', 'ca.crt'), path.join(process.cwd(), 'db', 'ca.crt')]) {
    try { return fs.readFileSync(f, 'utf8'); } catch { /* not present */ }
  }
  return null;
}

const isUniqueViolation = e => e && e.code === '23505';

module.exports = { createDb, databasePool, toPg, isUniqueViolation, readCaCert };
