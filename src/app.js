'use strict';
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createAuth, requireAuth } = require('./auth');
const { HttpError } = require('./util');

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  // Netlify (and most hosts) sit behind a proxy; trust it so req.ip is the visitor's address.
  if (process.env.TRUST_PROXY || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) app.set('trust proxy', process.env.TRUST_PROXY || true);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  const auth = createAuth(db);
  app.use(auth.loadUser);

  // CSRF defence: state-changing API calls must be JSON and carry a custom header,
  // which browsers will not send cross-site without a CORS preflight (none is allowed).
  app.use('/api', (req, _res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (req.get('X-Requested-With') !== 'nm-app') return next(new HttpError(403, 'Missing request header'));
    }
    next();
  });

  const ctx = { db, auth };
  app.post('/api/login', async (req, res) => {
    const user = await auth.login(req, res, req.body.email, req.body.password);
    res.json({ user });
  });
  app.post('/api/logout', async (req, res) => { await auth.logout(req, res); res.json({ ok: true }); });
  app.get('/api/health', async (_req, res) => { await db.get('SELECT 1 AS ok'); res.json({ ok: true }); });

  app.use('/api', requireAuth);
  require('./routes/users')(app, ctx);
  require('./routes/teachers')(app, ctx);
  require('./routes/candidates')(app, ctx);
  require('./routes/admissions')(app, ctx);
  require('./routes/classes')(app, ctx);
  require('./routes/reports')(app, ctx);
  require('./routes/settings')(app, ctx);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.code === '22P02' || err.code === '22007' || err.code === '22008') return res.status(400).json({ error: 'A value has the wrong format' });
    if (err.code === '23505') return res.status(409).json({ error: 'This record already exists' });
    if (['23503', '23514', '23502'].includes(err.code)) return res.status(400).json({ error: 'The data violates a database rule: ' + err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  });
  return app;
}

module.exports = { createApp };
