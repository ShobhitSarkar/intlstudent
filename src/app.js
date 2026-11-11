'use strict';

const path = require('node:path');
const express = require('express');
const auth = require('./auth');

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(auth.loadUser(db));

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    next();
  });

  // Mutating API requests must be JSON. Together with SameSite=Lax cookies this blocks
  // cross-site form posts (a basic CSRF defence).
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Requests must be sent as application/json.' });
    }
    if (!req.body || typeof req.body !== 'object') req.body = {};
    next();
  });

  app.use('/api/auth', require('./routes/auth')(db));
  app.use('/api/universities', require('./routes/universities')(db));
  app.use('/api', require('./routes/boards')(db));
  app.use('/api/admin', require('./routes/admin')(db));
  app.use('/api', require('./routes/network')(db));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message });
  });

  return app;
}

module.exports = { createApp };
