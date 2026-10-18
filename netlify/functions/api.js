'use strict';
// Netlify Function that serves the whole /api/* surface with the Express app.
// netlify.toml rewrites /api/* to this function, so Express still sees /api/... paths.
const serverless = require('serverless-http');
const { createApp } = require('../../src/app');
const { createDb, databasePool } = require('../../src/db');
const { explainStartupError } = require('../../src/startup-errors');
const { ensureInitialManager } = require('../../scripts/bootstrap');

let bootstrapped = null;

exports.handler = async (event, context) => {
  let pool;
  try {
    // A fresh pool per invocation (through Supabase's transaction pooler): connections never outlive the request.
    pool = databasePool();
    const db = createDb(pool);
    if (!bootstrapped) bootstrapped = ensureInitialManager(db).catch(e => { bootstrapped = null; throw e; });
    await bootstrapped;
    const handler = serverless(createApp(db));
    return await handler(event, context);
  } catch (err) {
    // Start-up failed (settings, database unreachable, tables missing). Log the detail for the
    // Netlify function log and give the browser a clear reason instead of a bare 502.
    console.error('API start-up failed:', err && err.code, err && err.message);
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: explainStartupError(err), code: 'SERVER_NOT_READY' }),
    };
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
};
