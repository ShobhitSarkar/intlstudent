'use strict';

/** Shared request-validation and error helpers. */

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Required string field, trimmed and length-checked. */
function str(value, { field, min = 1, max = 5000 }) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length < min) throw httpError(400, `${field} is required${min > 1 ? ` (at least ${min} characters)` : ''}.`);
  if (s.length > max) throw httpError(400, `${field} must be at most ${max} characters.`);
  return s;
}

/** Optional string field: empty values become null. */
function optStr(value, { field, max = 500 }) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  return str(value, { field, max });
}

/** Optional non-negative number field: empty values become null. */
function optNum(value, { field, max = 10_000_000 }) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) throw httpError(400, `${field} must be a number between 0 and ${max}.`);
  return Math.round(n);
}

/** Optional http(s) URL field. */
function optUrl(value, { field }) {
  const s = optStr(value, { field, max: 500 });
  if (s === null) return null;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw httpError(400, `${field} must be a full URL, starting with https://`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw httpError(400, `${field} must start with http:// or https://`);
  return url.toString();
}

/** Positive integer from a route or query parameter, or null. */
function intParam(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = { httpError, str, optStr, optNum, optUrl, intParam };
