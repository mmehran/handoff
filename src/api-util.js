// Small helpers shared by the API's modules (api.js and the ones it loads).
import path from 'node:path';
import { httpErr } from './runner.js';
import { json } from './http-util.js';

export const API_PREFIX = '/api/v1';
const CODES = { 400: 'invalid_request', 401: 'unauthorized', 402: 'budget_exceeded', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 409: 'conflict', 413: 'too_large', 415: 'unsupported_media_type', 429: 'rate_limited', 501: 'not_supported', 502: 'claude_error', 503: 'unavailable', 504: 'timeout' };

// an error with its own code (and extra fields) for the { error } answer
export function apiErr(status, code, message, extra = {}) { const e = httpErr(status, message); e.code = code; e.extra = extra; return e; }

export function sendError(res, e) {
  const status = e.status || 500;
  if (e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
  json(res, status, { error: { code: e.code || CODES[status] || 'internal_error', message: e.status ? e.message : 'internal error', ...(e.extra || {}) } });
}

export function isWithin(child, root) {
  if (!child || !root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// a key's own folder for sessions started without a project: <HANDOFF_API_DIR>/<name>-<id>
export function keyDir(cfg, k) {
  const slug = String(k.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'key';
  return path.join(cfg.apiDir, `${slug}-${k.id.slice(4, 10)}`);
}
