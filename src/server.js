// The HTTP server, for the parts of Handoff that answer requests (see services.js). It always answers
// the tunnel watchdog's /api/health, sends /api/v1 to the API (api.js) and everything else to the web
// app (web.js), when they are turned on. All of them share one core (core.js).
import http from 'node:http';
import crypto from 'node:crypto';
import { createCore } from './core.js';
import { createWeb } from './web.js';
import { createApi, API_PREFIX } from './api.js';
import { Preview } from './preview.js';
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
  // App preview: a second hostname whose every request goes to a dev server on this computer
  const preview = cfg.web ? new Preview(cfg, { log }) : null;
  const web = cfg.web ? createWeb(core, { log, preview }) : null;
  // the API is always there to answer (with "api_off" while HANDOFF_API is off), so the web app can
  // turn it on without a restart
  const api = createApi(core, { log });
  // tunnel watchdog probe: random per-process id proves the public URL reaches *this* server
  const healthId = crypto.randomBytes(8).toString('hex');

  const server = http.createServer(async (req, res) => {
    // the previewed app sets its own headers: Handoff's strict ones would break it
    if (preview?.isPreviewHost(req)) return preview.handle(req, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, id: healthId });
      if (url.pathname === API_PREFIX || url.pathname.startsWith(API_PREFIX + '/')) return await api.handle(req, res, url);
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
  server.on('listening', () => { if (preview) preview.ownPort = server.address()?.port || 0; });
  // WebSockets are only used by previewed apps (live reload)
  server.on('upgrade', (req, socket, head) => {
    if (preview?.isPreviewHost(req)) return preview.upgrade(req, socket, head);
    socket.destroy();
  });
  server.on('close', () => core.stop());
  return { server, core, api, runner: core.runner, store: core.store, sessions: web?.sessions || null, preview, healthId };
}

export { UUID_RE };
