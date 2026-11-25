// The HTTP server, for the parts of Handoff that answer requests (see services.js). It always answers
// the tunnel watchdog's /api/health, and hands everything else to the parts that are turned on:
// today the web app (web.js). All of them share one core (core.js).
import http from 'node:http';
import crypto from 'node:crypto';
import { createCore } from './core.js';
import { createWeb } from './web.js';
import { UUID_RE } from './store.js';
import { json } from './http-util.js';

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000'
};

export function createServer(cfg, { claudePath, log = console.log, core = createCore(cfg, { claudePath, log }) } = {}) {
  const web = cfg.web ? createWeb(core, { log }) : null;
  // tunnel watchdog probe: random per-process id proves the public URL reaches *this* server
  const healthId = crypto.randomBytes(8).toString('hex');

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, id: healthId });
      if (web) return await web.handle(req, res, url);
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!e.status) log('error', e);
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
      else res.end();
    }
  });
  server.requestTimeout = 0; // SSE streams are long-lived
  server.headersTimeout = 20e3;
  server.on('close', () => core.stop());
  return { server, core, runner: core.runner, store: core.store, sessions: web?.sessions || null, healthId };
}

export { UUID_RE };
