import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA_DIR } from './config.js';
import { verifyPassword, verifyTotp, SessionStore, LoginLimiter } from './auth.js';
import { Store, tailFile, normalize, UUID_RE } from './store.js';
import { Runner, httpErr } from './runner.js';
import { injectMessage } from './inbox.js';
import { Notifier, buildAnswer } from './notify.js';

const PUBLIC = path.join(ROOT, 'public');
const COOKIE = 'handoff_sid';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
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

export function createServer(cfg, { claudePath, log = console.log } = {}) {
  const sessions = new SessionStore(cfg);
  const limiter = new LoginLimiter();
  const store = new Store(cfg);
  const runner = new Runner(cfg, claudePath);
  const globalClients = new Set();
  const auditFile = path.join(DATA_DIR, 'audit.log');
  const audit = (ip, action, detail = {}) => {
    fs.appendFile(auditFile, JSON.stringify({ t: new Date().toISOString(), ip, action, ...detail }) + '\n', () => {});
  };

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of globalClients) res.write(msg);
  };
  runner.on('run', r => broadcast('run', r));
  runner.on('permission', p => broadcast('permission', p));
  runner.on('permission_resolved', p => broadcast('permission_resolved', p));

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts });

  // WhatsApp notifications (approval needed / waiting / finished / error)
  const notifier = new Notifier(cfg, {
    store, runner, log,
    // replies typed on WhatsApp take the same path as taps in the web UI
    onAnswer: (sessionId, pick) => answerQuestion(sessionId, pick, 'whatsapp'),
    onApproval: (permId, allow) => runner.decide(permId, { allow, message: 'Denied from WhatsApp' })
  }).start();
  route('GET', /^\/api\/notify$/, async (req, res) => json(res, 200, await notifier.status()));
  route('POST', /^\/api\/notify\/test$/, async (req, res, ctx) => {
    if (!notifier.on) return json(res, 400, { error: 'WhatsApp notifications are not set up' });
    await notifier.sendWhatsApp('*👋 Handoff test*\nWhatsApp notifications are working.' + (cfg.publicHostname ? `\nhttps://${cfg.publicHostname}` : ''));
    audit(ctx.ip, 'notify_test');
    json(res, 200, { ok: true });
  });

  // tunnel watchdog probe: random per-process id proves the public URL reaches *this* server
  const healthId = crypto.randomBytes(8).toString('hex');
  route('GET', /^\/api\/health$/, (req, res) => json(res, 200, { ok: true, id: healthId }), { public: true });

  // ---------- auth ----------
  route('POST', /^\/api\/login$/, async (req, res, ctx) => {
    if (limiter.blocked(ctx.ip)) { audit(ctx.ip, 'login_blocked'); return json(res, 429, { error: 'Too many attempts. Try again later.' }); }
    const body = await readJson(req);
    // always do the (slow) scrypt check so timing doesn't reveal which factor failed
    const pwOk = verifyPassword(String(body.password || ''), cfg.passwordHash);
    const totpOk = !cfg.totpEnabled || verifyTotp(cfg.totpSecret, String(body.code || '').trim());
    if (!pwOk || !totpOk) {
      limiter.fail(ctx.ip); audit(ctx.ip, 'login_failed');
      await delay(400 + Math.random() * 400);
      return json(res, 401, { error: 'Invalid credentials' });
    }
    limiter.success(ctx.ip);
    const token = sessions.create(ctx.ip, req.headers['user-agent']);
    audit(ctx.ip, 'login_ok', { ua: String(req.headers['user-agent'] || '').slice(0, 120) });
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${cfg.sessionMaxDays * 86400}`);
    json(res, 200, { ok: true });
  }, { public: true });

  route('POST', /^\/api\/logout$/, (req, res, ctx) => {
    sessions.destroy(ctx.token);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
    json(res, 200, { ok: true });
  });

  route('POST', /^\/api\/logout-all$/, (req, res, ctx) => {
    sessions.destroyAll(); audit(ctx.ip, 'logout_all');
    json(res, 200, { ok: true });
  });

  route('GET', /^\/api\/me$/, (req, res) => json(res, 200, {
    ok: true, totp: cfg.totpEnabled, allowBypass: cfg.allowBypassPermissions, defaultMode: runner.normalizeMode(cfg.defaultPermissionMode), logins: sessions.list().length
  }));

  // ---------- browsing (read-only) ----------
  route('GET', /^\/api\/projects$/, (req, res) => json(res, 200, store.listProjects()));

  route('GET', /^\/api\/projects\/([^/]+)\/sessions$/, (req, res, ctx, m) => {
    const list = store.listSessions(decodeURIComponent(m[1]));
    if (!list) return json(res, 404, { error: 'project not found' });
    for (const s of list) { const r = runner.bySession(s.id); s.run = r ? r.status : null; }
    json(res, 200, list);
  });

  route('GET', /^\/api\/live$/, (req, res) => {
    const live = store.liveSessions().map(l => ({ ...l, title: l.name || store.sessionInfo(l.sessionId)?.title || '' }));
    const runs = runner.list().map(r => ({ ...r, title: (r.sessionId && store.sessionInfo(r.sessionId)?.title) || '' }));
    const ours = new Set(runs.map(r => r.sessionId));
    const others = live.filter(l => !ours.has(l.sessionId));
    for (const l of others) if (l.status === 'waiting') l.question = store.pendingQuestion(l.sessionId) || null;
    json(res, 200, { live: others, runs, permissions: runner.pendingPermissions() });
  });

  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})$/, (req, res, ctx, m) => {
    const info = store.sessionInfo(m[1]);
    const run = runner.bySession(m[1]);
    if (!info && !run) return json(res, 404, { error: 'session not found' });
    // a session our runner drives also shows up in the registry; only report *other* live processes
    if (info?.live && run && info.live.pid === run.proc.pid) info.live = null;
    json(res, 200, {
      ...(info || { id: m[1], cwd: run.cwd, title: 'New session' }),
      run: run ? runner.publicRun(run) : null,
      question: store.pendingQuestion(m[1]) || null
    });
  });

  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/transcript$/, (req, res, ctx, m) => {
    const before = ctx.url.searchParams.get('before');
    const t = store.readTranscript(m[1], before == null ? null : Number(before));
    if (!t) return json(res, 200, { events: [], start: 0, end: 0, size: 0 });
    json(res, 200, t);
  });

  // live tail of one session transcript (Server-Sent Events)
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/stream$/, (req, res, ctx, m) => {
    const id = m[1];
    sse(res);
    let from = Number(ctx.url.searchParams.get('from'));
    let stop = null;
    const seen = new Set();
    const push = (o) => {
      for (const e of normalize(o)) {
        const k = e.uuid ? `${e.uuid}:${e.kind}:${e.id || e.toolUseId || ''}:${(e.text || '').length}` : null;
        if (k) { if (seen.has(k)) continue; seen.add(k); if (seen.size > 5000) seen.clear(); }
        res.write(`event: msg\ndata: ${JSON.stringify(e)}\n\n`);
      }
    };
    const onRunnerMsg = (sid, msg) => { if (sid === id) push(msg); };
    runner.on('message', onRunnerMsg);
    const attach = () => {
      const file = store.sessionFile(id);
      if (!file) return false;
      if (!Number.isFinite(from)) from = fs.statSync(file).size;
      stop = tailFile(file, from, o => push(o));
      return true;
    };
    let waiter = null;
    if (!attach()) waiter = setInterval(() => { if (attach()) { clearInterval(waiter); waiter = null; } }, 1000);
    res.write('event: ready\ndata: {}\n\n'); // lets the client tell a working stream from a buffering proxy
    const hb = setInterval(() => res.write('event: ping\ndata: 1\n\n'), 15e3); // an event (not a comment) so the page can see it
    req.on('close', () => { stop?.(); clearInterval(hb); if (waiter) clearInterval(waiter); runner.off('message', onRunnerMsg); });
  });

  // polling fallback for networks/proxies that buffer event streams
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/since$/, (req, res, ctx, m) => {
    json(res, 200, store.readSince(m[1], Number(ctx.url.searchParams.get('from'))));
  });

  // models / effort levels / modes, as reported by the installed Claude Code
  route('GET', /^\/api\/options$/, async (req, res) => {
    json(res, 200, { ...(await runner.options()), defaultMode: runner.normalizeMode(cfg.defaultPermissionMode), allowBypass: cfg.allowBypassPermissions });
  });

  // global event stream: run status + permission prompts
  route('GET', /^\/api\/events$/, (req, res) => {
    sse(res);
    globalClients.add(res);
    res.write(`event: hello\ndata: ${JSON.stringify({ runs: runner.list(), permissions: runner.pendingPermissions() })}\n\n`);
    const hb = setInterval(() => res.write('event: ping\ndata: 1\n\n'), 15e3); // an event (not a comment) so the page can see it
    req.on('close', () => { globalClients.delete(res); clearInterval(hb); });
  });

  // Answer a pending AskUserQuestion. `picks` are option numbers (as shown in the UI and on
  // WhatsApp); `text` is a free-text answer. Delivered like any other prompt: straight into a
  // session running on the laptop, or into our own process.
  async function answerQuestion(id, { picks = [], text = '' }, ip) {
    const q = store.pendingQuestion(id);
    if (!q) throw httpErr(409, 'that question is no longer open');
    const { chosen, free, prompt } = buildAnswer(q, { picks, text });

    const run = runner.bySession(id);
    const info = store.sessionInfo(id);
    const live = !run && info?.live;
    if (live) await injectMessage(cfg.claudeHome, live, prompt);
    else if (run) runner.writeUser(run, prompt);
    else await runner.send({ sessionId: id, cwd: info?.cwd, text: prompt });
    audit(ip, 'answer', { sessionId: id, toolUseId: q.toolUseId, picks, text: free.slice(0, 200) });
    // (a WhatsApp reply gets its own confirmation from the notifier, so don't send a second one)
    notifier?.answered(id, ip === 'whatsapp' ? '' : chosen.join(' · ') || free);
    // a question open on the laptop keeps its own picker; the answer waits in that session's queue
    return { ok: true, answered: chosen, delivered: live ? 'live' : 'remote', queuedBehindPicker: !!live };
  }

  route('POST', /^\/api\/sessions\/([0-9a-f-]{36})\/answer$/, async (req, res, ctx, m) => {
    const b = await readJson(req);
    const picks = Array.isArray(b.picks) ? b.picks.map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 80) : [];
    json(res, 200, await answerQuestion(m[1], { picks, text: b.text }, ctx.ip));
  });

  // ---------- control ----------
  route('POST', /^\/api\/sessions\/new$/, async (req, res, ctx) => {
    const b = await readJson(req);
    const r = await runner.send({ cwd: String(b.cwd || ''), text: b.text, mode: b.mode, model: b.model || undefined, effort: b.effort || undefined });
    audit(ctx.ip, 'session_new', { cwd: b.cwd, sessionId: r.sessionId, mode: b.mode, model: b.model, effort: b.effort, text: String(b.text).slice(0, 200) });
    json(res, 200, r);
  });

  route('POST', /^\/api\/sessions\/([0-9a-f-]{36})\/message$/, async (req, res, ctx, m) => {
    const b = await readJson(req);
    const info = store.sessionInfo(m[1]);
    const run = runner.bySession(m[1]);
    if (!info && !run) return json(res, 404, { error: 'session not found' });
    const fork = !!b.fork;
    // Open in Claude Desktop / a terminal right now: deliver straight into that process through its
    // local inbox, so the prompt shows up on the laptop in real time (and no second writer is started).
    const live = !run && !fork ? info?.live : null;
    if (live) {
      if (typeof b.text !== 'string' || !b.text.trim()) throw httpErr(400, 'empty message');
      if (b.text.length > 100_000) throw httpErr(413, 'message too long');
      await injectMessage(cfg.claudeHome, live, b.text);
      audit(ctx.ip, 'message_live', { sessionId: m[1], pid: live.pid, text: String(b.text).slice(0, 200) });
      return json(res, 200, { sessionId: m[1], delivered: 'live' });
    }
    const r = await runner.send({ sessionId: m[1], cwd: run?.cwd || info.cwd, text: b.text, mode: b.mode, model: b.model || undefined, effort: b.effort || undefined, fork });
    audit(ctx.ip, 'message', { sessionId: m[1], target: r.sessionId, fork, mode: b.mode, model: b.model, effort: b.effort, text: String(b.text).slice(0, 200) });
    json(res, 200, { ...r, delivered: fork ? 'fork' : 'resume' });
  });

  route('POST', /^\/api\/sessions\/([0-9a-f-]{36})\/interrupt$/, (req, res, ctx, m) => {
    audit(ctx.ip, 'interrupt', { sessionId: m[1] });
    json(res, 200, { ok: runner.interrupt(m[1]) });
  });

  route('POST', /^\/api\/sessions\/([0-9a-f-]{36})\/stop$/, (req, res, ctx, m) => {
    audit(ctx.ip, 'stop', { sessionId: m[1] });
    json(res, 200, { ok: runner.stop(m[1]) });
  });

  route('POST', /^\/api\/permissions\/([A-Za-z0-9_-]{6,40})$/, async (req, res, ctx, m) => {
    const b = await readJson(req);
    const ok = runner.decide(m[1], { allow: !!b.allow, message: b.message, alwaysMode: b.alwaysMode });
    audit(ctx.ip, 'permission', { id: m[1], allow: !!b.allow, alwaysMode: b.alwaysMode });
    json(res, ok ? 200 : 404, ok ? { ok } : { error: 'request no longer pending' });
  });

  // ---------- request pipeline ----------
  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://x');
    const ip = clientIp(req);
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const ctx = { url, ip, token };
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // CSRF: same-origin JSON requests with our custom header only
        if (req.headers['x-handoff'] !== '1') return json(res, 403, { error: 'missing header' });
        if (!sameOrigin(req)) return json(res, 403, { error: 'bad origin' });
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        if (!r.public && !sessions.check(token)) return json(res, 401, { error: 'unauthorized' });
        res.setHeader('Cache-Control', 'no-store');
        return await r.handler(req, res, ctx, m);
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!e.status) log('error', e);
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
      else res.end();
    }
  });
  server.requestTimeout = 0; // SSE streams are long-lived
  server.headersTimeout = 20e3;
  server.on('close', () => { runner.shutdown(); notifier.stop(); });
  return { server, runner, store, sessions, healthId };
}

// ---------- helpers ----------
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sse(res) {
  // no-transform stops Cloudflare from compressing (and therefore buffering) the stream;
  // the 2 KB comment pushes the first bytes through any proxy buffer immediately
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store, no-transform', 'Content-Encoding': 'identity', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`:${' '.repeat(2048)}\nretry: 3000\n\n`);
}

async function readJson(req, limit = 256 * 1024) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.startsWith('application/json')) throw httpErr(415, 'expected application/json');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw httpErr(413, 'body too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw httpErr(400, 'invalid json'); }
}

function parseCookies(h = '') {
  const out = {};
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}

function clientIp(req) {
  // We only listen on loopback, so forwarded headers can only come from the local tunnel agent.
  const xf = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || '?';
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client; SameSite=Strict cookie + custom header still required
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  const allowed = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map(h => String(h).split(',')[0].trim());
  return allowed.includes(host);
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA routes
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); // tiny files; always pick up updates
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const delay = ms => new Promise(r => setTimeout(r, ms));
export { UUID_RE };
