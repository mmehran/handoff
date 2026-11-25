// The API part (HANDOFF_API): /api/v1/* for programs, signed in with an API key
// (Authorization: Bearer hk_..., or X-Api-Key). Built on the shared core; server.js sends /api/v1 here
// before anything else, and the web app's cookies and CSRF header play no part in it.
// Errors always look like { error: { code, message } }. See docs/api.md.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { httpErr, EFFORTS } from './runner.js';
import { projectName, UUID_RE } from './store.js';
import { json, clientIp } from './http-util.js';
import { TOOL_PRESETS, SCOPES } from './apikeys.js';
import { API_PREFIX, apiErr, sendError, isWithin, keyDir } from './api-util.js';
import { addSending } from './api-send.js';
import { addFiles } from './api-files.js';
import { addWebhooks } from './webhooks.js';
import { addOpenAI } from './openai.js';

export { API_PREFIX, apiErr, sendError, isWithin };
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '?'; } })();

export function createApi(core, { log = console.log } = {}) {
  const { cfg, store, runner, activity, keys, audit } = core;
  const routes = [];
  // scope: what the key must be allowed to do (null: any key); public: no key needed
  const route = (method, pattern, scope, handler, opts = {}) => routes.push({ method, pattern: new RegExp(`^${API_PREFIX}${pattern}$`), scope, handler, ...opts });
  const ctxOf = {}; // filled by the parts that add routes (turns, files, ...)

  // ---------- helpers every route uses ----------
  // a key sees its projects, and its own folder for sessions started without a project
  const inScope = (k, cwd) => !k.projects || (!!cwd && (k.projects.some(p => isWithin(cwd, p)) || isWithin(cwd, keyDir(cfg, k))));
  const webUrl = id => (cfg.web && cfg.publicHostname && id ? `https://${cfg.publicHostname}/#/s/${id}` : null);
  const iso = t => (t ? new Date(t).toISOString() : null);

  // where a session works now: its running process's folder, or the latest one in its transcript
  async function sessionCwd(id) {
    const run = runner.bySession(id);
    if (run) return { cwd: run.cwd, run, info: await store.sessionInfo(id) };
    const info = await store.sessionInfo(id);
    return { cwd: info?.cwd || null, run: null, info };
  }
  // the session, if it exists and the key may see it (otherwise it looks like it doesn't exist)
  async function sessionFor(k, id) {
    if (!UUID_RE.test(String(id))) throw apiErr(404, 'session_not_found', 'No such session.');
    const s = await sessionCwd(id);
    if ((!s.info && !s.run) || !inScope(k, s.cwd)) throw apiErr(404, 'session_not_found', 'No such session (or this key can\'t see it).');
    return s;
  }
  const statusOf = (id, live) => {
    const run = runner.bySession(id);
    if (run) return run.status === 'waiting' ? 'waiting' : run.status === 'idle' ? 'idle' : 'running';
    return live ? 'laptop' : 'saved';
  };
  const viaOf = id => { const v = keys.sessionKey(id); return v ? { type: 'api', key: v.keyName, keyId: v.keyId } : null; };
  function sessionView({ id, title, cwd, key, mtime, size, live }) {
    return {
      id, title: title || '(untitled)', project: key ? { key, name: projectName(cwd || key) } : null, cwd: cwd || null,
      updatedAt: iso(mtime), size: size ?? null, status: statusOf(id, live), laptop: live ? { status: live.status, app: live.entrypoint || null } : null,
      via: viaOf(id), webUrl: webUrl(id)
    };
  }

  // a project given as its key, its full path or its (unique) name -> { key, cwd } (null: not found)
  async function findProject(k, value) {
    const v = String(value || '').trim();
    if (!v) return null;
    const projects = (await store.listProjects()).filter(p => inScope(k, p.cwd));
    const byKey = projects.find(p => p.key === v);
    if (byKey) return byKey;
    if (path.isAbsolute(v)) {
      const abs = path.resolve(v);
      return projects.find(p => path.resolve(p.cwd) === abs || (process.platform === 'win32' && path.resolve(p.cwd).toLowerCase() === abs.toLowerCase())) || { key: null, cwd: abs, name: projectName(abs) };
    }
    const named = projects.filter(p => p.name.toLowerCase() === v.toLowerCase());
    if (named.length > 1) throw apiErr(409, 'ambiguous_project', `More than one project is called "${v}": use its key or full path.`, { candidates: named.map(p => ({ key: p.key, cwd: p.cwd })) });
    return named[0] || null;
  }

  // ---------- public ----------
  route('GET', '/health', null, (req, res) => json(res, 200, { ok: true, version: VERSION, api: 'v1', claudeSignedIn: core.claudeSignedIn ?? null }), { public: true });

  // ---------- this key ----------
  route('GET', '/me', null, (req, res, ctx) => {
    const k = ctx.key;
    const v = keys.view(k);
    json(res, 200, {
      key: { id: v.id, name: v.name, prefix: v.prefix, preset: v.preset, scopes: v.scopes, projects: v.projects, modes: v.modes, defaultMode: v.defaultMode, tools: v.tools, alerts: v.alerts, defaults: v.defaults,
        limits: { requestsPerMinute: v.rateLimit, turnsAtOnce: v.maxTurns, dailyBudgetUsd: v.dailyBudgetUsd }, expiresAt: iso(v.expiresAt), createdAt: iso(v.createdAt), webhookSecret: v.webhookSecret, full: v.full },
      today: keys.today(k.id), selection: k.selection || null,
      services: { web: !!cfg.web, whatsapp: !!cfg.notify?.enabled, api: !!cfg.api }, version: VERSION
    });
  });
  route('GET', '/usage', 'read', (req, res, ctx) => {
    const days = Math.floor(Number(ctx.url.searchParams.get('days')) || 30);
    json(res, 200, { days: keys.usageDays(ctx.key.id, days) });
  });

  // models / effort levels, as the installed Claude Code reports them. The OpenAI list shape, so
  // OpenAI tools understand it too, with Handoff's own fields next to it.
  route('GET', '/models', 'read', async (req, res, ctx) => {
    const o = await runner.options();
    json(res, 200, {
      object: 'list',
      data: o.models.map(m => ({ id: m.value, object: 'model', created: 0, owned_by: 'anthropic', name: m.displayName, description: m.description || '', efforts: m.supportsEffort ? (m.supportedEffortLevels?.length ? m.supportedEffortLevels : EFFORTS) : [] })),
      efforts: EFFORTS, modes: ctx.key.modes, defaultMode: ctx.key.defaultMode, tools: TOOL_PRESETS.slice(TOOL_PRESETS.indexOf(ctx.key.tools)), fromCli: o.fromCli
    });
  });

  // ---------- projects and sessions ----------
  route('GET', '/projects', 'read', async (req, res, ctx) => {
    const projects = (await store.listProjects()).filter(p => inScope(ctx.key, p.cwd));
    json(res, 200, { projects: projects.map(p => ({ key: p.key, name: p.name, cwd: p.cwd, sessions: p.sessions, live: p.live, lastActivity: iso(p.lastActivity) })) });
  });

  route('GET', '/sessions', 'read', async (req, res, ctx) => {
    const k = ctx.key, q = ctx.url.searchParams;
    const limit = Math.min(Math.max(1, Math.floor(Number(q.get('limit')) || 50)), 200);
    const before = Number(q.get('before')) || null;
    const text = String(q.get('q') || '').trim().toLowerCase().slice(0, 200);
    const liveOnly = q.get('live') === 'true' || q.get('live') === '1';
    const viaApi = q.get('via') === 'api';
    let all = await store.allSessions();
    if (q.get('project')) {
      const p = await findProject(k, q.get('project'));
      if (!p?.key) throw apiErr(404, 'project_not_found', 'No such project (or this key can\'t see it).');
      all = all.filter(s => s.key === p.key);
    }
    if (before) all = all.filter(s => s.mtime < before);
    const live = new Map((await store.liveSessions()).map(l => [l.sessionId, l]));
    const out = [];
    let scanned = 0, last = null;
    for (const s of all) {
      if (out.length >= limit || scanned >= 3000) break;
      scanned++; last = s.mtime;
      if (viaApi && !keys.sessionKey(s.id)) continue;
      if (liveOnly && !live.has(s.id) && !runner.bySession(s.id)) continue;
      let meta;
      try { meta = await store.meta(s.file); } catch { continue; }
      const l = live.get(s.id);
      const title = (l && l.name) || meta.title;
      if (!inScope(k, runner.bySession(s.id)?.cwd || meta.cwd)) continue;
      if (text && !String(title).toLowerCase().includes(text)) continue;
      out.push(sessionView({ id: s.id, title, cwd: meta.cwd, key: s.key, mtime: s.mtime, size: s.size, live: l }));
    }
    const more = out.length >= limit || (scanned >= 3000 && scanned < all.length);
    json(res, 200, { sessions: out, next: more && last ? last : null });
  });

  route('GET', '/sessions/([0-9a-f-]{36})', 'read', async (req, res, ctx, m) => {
    const { info, run, cwd } = await sessionFor(ctx.key, m[1]);
    const live = info?.live && !(run && info.live.pid === run.proc.pid) ? info.live : null;
    const a = await activity.of(m[1]).catch(() => null);
    json(res, 200, {
      ...sessionView({ id: m[1], title: info?.title || 'New session', cwd, key: info?.projectKey, mtime: info?.mtime, size: info?.size, live }),
      run: run ? runner.publicRun(run) : null,
      pending: {
        approvals: runner.pendingPermissions().filter(p => p.sessionId === m[1]),
        question: (await store.pendingQuestion(m[1])) || null
      },
      activity: a ? { todos: a.todos, filesChanged: a.files.length, commands: a.commandCount, prompts: a.prompts, tools: a.tools, first: iso(a.first), last: iso(a.last) } : null
    });
  });

  // The conversation, newest last, paging backwards with `before` (the cursor the previous page gave).
  // chat: only what was said, with long texts whole; events: what the web app shows (tool calls too).
  route('GET', '/sessions/([0-9a-f-]{36})/messages', 'read', async (req, res, ctx, m) => {
    await sessionFor(ctx.key, m[1]);
    const q = ctx.url.searchParams;
    const format = q.get('format') === 'events' ? 'events' : 'chat';
    const limit = Math.min(Math.max(1, Math.floor(Number(q.get('limit')) || 100)), 500);
    const before = q.get('before') == null || q.get('before') === '' ? null : Number(q.get('before'));
    const keep = format === 'chat' ? e => e.kind === 'user' || e.kind === 'assistant' : () => true;
    const r = await store.readEvents(m[1], { before, limit, full: format === 'chat', keep });
    if (!r) return json(res, 200, { messages: [], before: null });
    const messages = format === 'chat'
      ? r.events.map(e => ({ role: e.kind, text: e.text, ts: e.ts || null, ...(e.remote ? { sentFromHandoff: true } : {}) }))
      : r.events;
    json(res, 200, { messages, before: r.before });
  });

  route('GET', '/sessions/([0-9a-f-]{36})/activity', 'read', async (req, res, ctx, m) => {
    await sessionFor(ctx.key, m[1]);
    json(res, 200, (await activity.of(m[1])) || { todos: [], plan: null, files: [], commands: [], commandCount: 0, agents: [], tools: 0, prompts: 0, first: 0, last: 0 });
  });

  // ---------- search ----------
  const searchFor = async (ctx, sessionId) => {
    if (!core.search) throw apiErr(404, 'search_off', 'Search is turned off in this Handoff (HANDOFF_SEARCH).');
    const r = await core.search.search(String(ctx.url.searchParams.get('q') || '').slice(0, 200), sessionId ? { sessionId } : {});
    return { results: r.results.filter(x => inScope(ctx.key, x.cwd)).map(x => ({ ...x, webUrl: webUrl(x.sessionId) })), indexing: r.indexing };
  };
  route('GET', '/search', 'read', async (req, res, ctx) => json(res, 200, await searchFor(ctx)));
  route('GET', '/sessions/([0-9a-f-]{36})/search', 'read', async (req, res, ctx, m) => {
    await sessionFor(ctx.key, m[1]);
    json(res, 200, await searchFor(ctx, m[1]));
  });

  // ---------- requests ----------
  function cors(req, res) {
    const origin = req.headers.origin;
    if (!origin || !cfg.apiCors?.includes(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-Api-Key, Content-Type, Idempotency-Key, X-Handoff-Session, X-Handoff-Project, X-Handoff-Language, X-Handoff-Length');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Location, Retry-After');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }
  const keyOf = req => {
    const a = String(req.headers.authorization || '');
    if (/^Bearer\s+/i.test(a)) return a.replace(/^Bearer\s+/i, '').trim();
    return String(req.headers['x-api-key'] || '').trim();
  };

  async function handle(req, res, url) {
    const started = Date.now();
    const ip = clientIp(req);
    res.setHeader('Cache-Control', 'no-store');
    const allowed = cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(allowed ? 204 : 403); return res.end(); }
    let key = null;
    try {
      if (!cfg.api) throw apiErr(404, 'api_off', 'The API is turned off in this Handoff (HANDOFF_API).');
      let route = null, m = null, pathOk = false;
      for (const r of routes) {
        const mm = url.pathname.match(r.pattern);
        if (!mm) continue;
        pathOk = true;
        if (r.method === req.method || (r.method === 'GET' && req.method === 'HEAD')) { route = r; m = mm; break; }
      }
      if (!route) throw pathOk ? apiErr(405, 'method_not_allowed', `${req.method} isn't allowed here.`) : apiErr(404, 'not_found', 'No such endpoint. See /api/v1/docs.');
      const ctx = { url, ip, key: null, started };
      if (!route.public) {
        if (keys.blocked(ip)) { const e = apiErr(429, 'too_many_wrong_keys', 'Too many wrong keys from this address. Try again in 15 minutes.'); e.retryAfter = 900; throw e; }
        const given = keyOf(req);
        if (!given) throw apiErr(401, 'unauthorized', 'Send your API key as "Authorization: Bearer <key>" or "X-Api-Key: <key>".');
        key = keys.verify(given);
        if (!key) { keys.fail(ip); throw apiErr(401, 'unauthorized', 'That API key isn\'t valid (wrong, revoked or expired).'); }
        const rate = keys.allow(key);
        if (!rate.ok) { const e = apiErr(429, 'rate_limited', `This key is limited to ${key.rateLimit} requests a minute.`); e.retryAfter = rate.retryAfter; throw e; }
        keys.touch(key, ip);
        if (route.scope && !key.scopes.includes(route.scope)) throw apiErr(403, 'forbidden_scope', `This key doesn't have the "${route.scope}" permission.`, { scope: route.scope });
        ctx.key = key;
      }
      await route.handler(req, res, ctx, m);
    } catch (e) {
      if (!e.status) log('error', e);
      if (!res.headersSent) sendError(res, e);
      else res.end();
    } finally {
      if (key) {
        const done = () => audit(ip, 'api', { via: 'api', key: key.name, keyId: key.id, method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started });
        if (res.writableEnded) done(); else res.once('close', done);
      }
    }
  }

  const api = { handle, route, inScope, sessionFor, sessionView, findProject, webUrl, ctxOf, statusOf, iso, version: VERSION };
  api.turns = addSending(api, core); // sending prompts and getting answers (api-send.js)
  addFiles(api, core);              // attached files, the project's files, git (api-files.js)
  addWebhooks(api, core);           // calls to a program's own address as turns need approval and end (webhooks.js)
  addOpenAI(api, core);             // POST /chat/completions for OpenAI-style clients (openai.js)
  return api;
}

export { SCOPES };
