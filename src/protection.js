'use strict';

/**
 * Keeping the boards for people: rate limits, a human check, and simple bot traps.
 *
 * - Rate limits are counted in memory per process. That's fine for one server; with several,
 *   move the counters to a shared store such as Redis.
 * - The human check uses Cloudflare Turnstile when TURNSTILE_SECRET_KEY is set. Without it,
 *   the check is skipped in development and refused in production, so a live site can't
 *   accidentally run without one.
 * - Bot traps: a hidden "website" field that people never fill in, and a minimum time between
 *   the form appearing and being sent.
 */

const { httpError } = require('./http');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Default limits: [max requests, window in ms]. */
const DEFAULT_LIMITS = {
  login: [10, 15 * MINUTE], // per IP + email
  loginIp: [50, 15 * MINUTE], // per IP
  signup: [5, HOUR], // per IP
  guestQuestion: [3, HOUR], // per IP
  guestQuestionDay: [10, 24 * HOUR], // per IP
  question: [10, HOUR], // per member
  answer: [30, HOUR], // per member
  message: [120, HOUR], // per member
  connection: [30, 24 * HOUR], // per member
  report: [30, HOUR], // per member
};

const MIN_FORM_SECONDS = 3;

function createRateLimiter(overrides = {}) {
  if (overrides === false) return { hit: () => {} };
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const hits = new Map(); // key -> array of timestamps

  // Drop old entries now and then so memory doesn't grow forever.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, times] of hits) if (!times.length || now - times[times.length - 1] > 24 * HOUR) hits.delete(key);
  }, 10 * MINUTE);
  sweep.unref();

  return {
    /** Record one request for `name`/`key`; throws 429 when over the limit. */
    hit(name, key) {
      const [max, windowMs] = limits[name];
      const now = Date.now();
      const id = `${name}:${key}`;
      const times = (hits.get(id) || []).filter((t) => now - t < windowMs);
      if (times.length >= max) {
        const retryAfter = Math.ceil((windowMs - (now - times[0])) / 1000);
        const err = httpError(429, 'Too many attempts. Please wait a little and try again.');
        err.retryAfter = retryAfter;
        throw err;
      }
      times.push(now);
      hits.set(id, times);
    },
  };
}

/** Verify a Cloudflare Turnstile token. */
function turnstileVerifier(secret) {
  return async (token, ip) => {
    if (!token) return false;
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({}));
    return data.success === true;
  };
}

function defaultHumanVerifier() {
  if (process.env.TURNSTILE_SECRET_KEY) return turnstileVerifier(process.env.TURNSTILE_SECRET_KEY);
  if (process.env.NODE_ENV === 'production') return async () => false;
  return async () => true; // development: no human check configured
}

/**
 * Run the bot traps and the human check on a guest post or signup.
 * `verifyHuman(token, ip)` resolves to true for a person.
 */
async function requireHuman(req, verifyHuman) {
  const b = req.body || {};
  // Bots fill in every field, including the hidden one.
  if (typeof b.website === 'string' && b.website.trim() !== '') throw httpError(400, "We couldn't send that. Please try again.");
  const startedAt = Number(b.startedAt);
  if (!Number.isFinite(startedAt) || Date.now() - startedAt < MIN_FORM_SECONDS * 1000) {
    throw httpError(400, 'That was quick! Please take a moment and try again.');
  }
  let ok = false;
  try {
    ok = await verifyHuman(b.humanToken, req.ip);
  } catch {
    ok = false;
  }
  if (!ok) throw httpError(400, 'Please complete the check that shows you are a person.');
}

module.exports = { createRateLimiter, defaultHumanVerifier, requireHuman, DEFAULT_LIMITS };
