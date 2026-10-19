'use strict';
// Turns start-up failures (database settings, unreachable database, missing tables) into a
// plain-language message for the person signing in. Never includes connection strings or passwords.

function explainStartupError(err) {
  const msg = String((err && err.message) || '');
  const code = err && err.code;
  if (/DATABASE_URL is not set/.test(msg))
    return 'The server has no database setting. In Netlify, add DATABASE_URL (Project configuration → Environment variables) for this deploy context, then redeploy.';
  if (code === 'ERR_INVALID_URL' || /Invalid URL/.test(msg))
    return 'DATABASE_URL in Netlify is not a valid connection string. Copy it again from Supabase → Connect → Transaction pooler, and percent-encode special characters in the password.';
  if (code === '42P01')
    return 'The database tables have not been created yet. Run the migrations (redeploy, or run "npm run migrate" with DATABASE_URL set).';
  if (code === '28P01' || /password authentication failed/i.test(msg))
    return 'Supabase rejected the database password in DATABASE_URL. Check the password (and reset it in Supabase if needed), then update DATABASE_URL in Netlify and redeploy.';
  if (/Tenant or user not found/i.test(msg))
    return 'Supabase did not recognise the user in DATABASE_URL. Use the Transaction pooler string, whose user looks like postgres.<project-ref>.';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code))
    return 'The database host in DATABASE_URL could not be found. Copy the connection string again from Supabase → Connect.';
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(code) || /timeout|terminated/i.test(msg))
    return 'The database could not be reached. Check that the Supabase project is running (not paused) and that DATABASE_URL uses the Transaction pooler (port 6543).';
  if (/certificate|self[- ]signed|SSL/i.test(msg))
    return 'The secure connection to the database failed. If you added db/ca.crt, check it is the certificate downloaded from your Supabase project.';
  return 'The server could not start. Check the function log in Netlify (Logs → Functions → api) for details.';
}

module.exports = { explainStartupError };
