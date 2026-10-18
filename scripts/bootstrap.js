'use strict';
const { hashPassword } = require('../src/auth');
const { isUniqueViolation } = require('../src/db');

/**
 * Creates the first Manager from environment variables when the users table is empty.
 * Safe to call on every cold start; does nothing once any user exists.
 */
async function ensureInitialManager(db, log = console) {
  const { n } = await db.get('SELECT COUNT(*) n FROM users');
  if (n) return false;
  const email = process.env.INITIAL_MANAGER_EMAIL;
  const password = process.env.INITIAL_MANAGER_PASSWORD;
  const name = process.env.INITIAL_MANAGER_NAME || 'Manager';
  if (!email || !password) {
    log.warn('No users exist yet. Set INITIAL_MANAGER_EMAIL and INITIAL_MANAGER_PASSWORD (min 8 characters) to create the first Manager.');
    return false;
  }
  try {
    await db.run(`INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,'manager')`, [name, email, hashPassword(password)]);
    log.log(`Created the first Manager account for ${email}. Remove INITIAL_MANAGER_PASSWORD from the environment now.`);
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false; // another instance created it first
    throw e;
  }
}
module.exports = { ensureInitialManager };
