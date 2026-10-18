'use strict';
const { hashPassword } = require('../src/auth');

/** Creates the first Manager from environment variables when the user table is empty. */
function ensureInitialManager(db) {
  const n = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (n) return;
  const email = process.env.INITIAL_MANAGER_EMAIL;
  const password = process.env.INITIAL_MANAGER_PASSWORD;
  const name = process.env.INITIAL_MANAGER_NAME || 'Manager';
  if (!email || !password) {
    console.error('No users exist. Set INITIAL_MANAGER_EMAIL and INITIAL_MANAGER_PASSWORD (min 8 chars) and restart.');
    process.exit(1);
  }
  db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,'manager')`).run(name, email, hashPassword(password));
  console.log(`Created initial Manager account for ${email}. Remove INITIAL_MANAGER_PASSWORD from the environment now.`);
}
module.exports = { ensureInitialManager };
