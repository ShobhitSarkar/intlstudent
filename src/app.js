'use strict';

const path = require('node:path');
const express = require('express');
const auth = require('./auth');
const { createRateLimiter, defaultHumanVerifier } = require('./protection');

/**
 * options.rateLimits   – overrides for the default limits, or false to turn limiting off (tests)
 * options.verifyHuman  – async (token, ip) => boolean; defaults to Cloudflare Turnstile when configured
 */
function createApp(db, options = {}) {
  const ctx = {
    limiter: createRateLimiter(options.rateLimits),
    verifyHuman: options.verifyHuman || defaultHumanVerifier(),
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
  };
  const app = express();
  app.disable('x-powered-by');
  // Behind a proxy or load balancer, set TRUST_PROXY (e.g. 1) so rate limits see the real client IP.
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
  app.use(express.json({ limit: '100kb' }));
  app.use(auth.loadUser(db));

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    const turnstile = ctx.turnstileSiteKey ? ' https://challenges.cloudflare.com' : '';
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; img-src 'self' data: https:; script-src 'self'${turnstile}; frame-src 'self'${turnstile}; frame-ancestors 'none'`
    );
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

  // Public settings the browser needs (e.g. the human-check site key).
  app.get('/api/config', (_req, res) => res.json({ turnstileSiteKey: ctx.turnstileSiteKey }));

  app.use('/api/auth', require('./routes/auth')(db, ctx));
  app.use('/api/universities', require('./routes/universities')(db));
  app.use('/api', require('./routes/boards')(db, ctx));
  app.use('/api/admin', require('./routes/admin')(db));
  app.use('/api', require('./routes/network')(db, ctx));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  // Self-hosted fonts (no requests to third-party font servers).
  for (const font of ['inter', 'inter-tight']) {
    app.use(`/fonts/${font}`, express.static(path.join(__dirname, '..', 'node_modules', '@fontsource-variable', font)));
  }
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message });
  });

  return app;
}

module.exports = { createApp };
