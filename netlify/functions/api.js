'use strict';
// Netlify Function that serves the whole /api/* surface with the Express app.
// netlify.toml rewrites /api/* to this function, so Express still sees /api/... paths.
const serverless = require('serverless-http');
const { createApp } = require('../../src/app');
const { createDb, databasePool } = require('../../src/db');
const { ensureInitialManager } = require('../../scripts/bootstrap');

let bootstrapped = null;

exports.handler = async (event, context) => {
  // A fresh pool per invocation (through Supabase's transaction pooler): connections never outlive the request.
  const pool = databasePool();
  const db = createDb(pool);
  try {
    if (!bootstrapped) bootstrapped = ensureInitialManager(db).catch(e => { bootstrapped = null; throw e; });
    await bootstrapped;
    const handler = serverless(createApp(db));
    return await handler(event, context);
  } finally {
    await pool.end().catch(() => {});
  }
};
