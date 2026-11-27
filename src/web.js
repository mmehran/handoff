// The web app (HANDOFF_WEB): sign-in, the pages, and the /api/* routes the pages use. Built on the
// shared core (core.js); server.js puts it behind the HTTP server.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA_DIR, updateEnvFile } from './config.js';
import { PRESETS, SCOPES, TOOL_PRESETS, LENGTHS } from './apikeys.js';
import { EFFORTS } from './runner.js';
import { verifyPassword, verifyTotp, SessionStore, LoginLimiter } from './auth.js';
import { tailFile, normalize, UUID_RE } from './store.js';
import { httpErr } from './runner.js';
import { injectMessage } from './inbox.js';
import { changes, diff, commit as gitCommit, push as gitPush, discard as gitDiscard, commitContext, tidyMessage, createWorktree, dropWorktree, removeWorktree } from './changes.js';
import { parseImages, saveForLiveSession } from './attachments.js';
import { json, sse, readJson, clientIp, delay, BODY_WITH_PHOTOS } from './http-util.js';
import { mentionedPorts } from './preview.js';

const PUBLIC = path.join(ROOT, 'public');
const COOKIE = 'handoff_sid';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

export function createWeb(core, { log = console.log, preview = null } = {}) {
  const { cfg, store, runner, notifier, push, audit, answerQuestion, files, activity, folderPicker, search, keys } = core;
  const sessions = new SessionStore(cfg);
  const limiter = new LoginLimiter();
  const globalClients = new Set();

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of globalClients) res.write(msg);
  };
  runner.on('run', r => broadcast('run', r));
  runner.on('permission', p => broadcast('permission', p));
  runner.on('permission_resolved', p => broadcast('permission_resolved', p));
  // open pages show a warning while WhatsApp alerts can't be delivered
  core.events.on('whatsapp', s => broadcast('whatsapp', s));

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts });

  // ---------- alerts: muted projects and chats, phone push, WhatsApp test ----------
  route('GET', /^\/api\/notify\/prefs$/, async (req, res) => json(res, 200, await prefsWithTitles()));
  const prefsWithTitles = async () => {
    const p = notifier.prefs();
    p.mutedChats = await Promise.all(p.mutedSessions.map(async id => ({ id, title: (await store.sessionInfo(id).catch(() => null))?.title || id.slice(0, 8) })));
    return p;
  };
  route('POST', /^\/api\/notify\/mute-session$/, async (req, res, ctx) => {
    const b = await readJson(req);
    const id = String(b.sessionId || '');
    if (!UUID_RE.test(id)) throw httpErr(400, 'which chat?');
    notifier.setSessionMuted(id, !!b.muted);
    audit(ctx.ip, 'notify_mute', { sessionId: id, muted: !!b.muted });
    json(res, 200, await prefsWithTitles());
  });
  const needPush = () => { if (!push) throw httpErr(404, 'push notifications are turned off (HANDOFF_PUSH)'); return push; };
  route('GET', /^\/api\/push$/, (req, res) => json(res, 200, push ? { enabled: true, publicKey: push.publicKey, devices: push.subs.length } : { enabled: false }));
  route('POST', /^\/api\/push\/subscribe$/, async (req, res, ctx) => {
    const b = await readJson(req);
    needPush().subscribe(b.subscription, req.headers['user-agent']);
    audit(ctx.ip, 'push_subscribe', { ua: String(req.headers['user-agent'] || '').slice(0, 120) });
    json(res, 200, { ok: true, devices: push.subs.length });
  });
  route('POST', /^\/api\/push\/unsubscribe$/, async (req, res, ctx) => {
    const b = await readJson(req);
    needPush().unsubscribe(String(b.endpoint || ''));
    audit(ctx.ip, 'push_unsubscribe');
    json(res, 200, { ok: true, devices: push.subs.length });
  });
  route('POST', /^\/api\/push\/test$/, async (req, res, ctx) => {
    const b = await readJson(req);
    const r = await needPush().send({ title: '👋 Handoff test', body: 'Phone notifications are working.', url: '/', tag: 'test' }, { only: b.endpoint ? String(b.endpoint) : undefined });
    audit(ctx.ip, 'push_test');
    json(res, 200, r);
  });
  route('POST', /^\/api\/notify\/mute$/, async (req, res, ctx) => {
    const b = await readJson(req);
    const cwd = String(b.cwd || '');
    if (!cwd || cwd.length > 1000) throw httpErr(400, 'which project folder?');
    notifier.setMuted(cwd, !!b.muted);
    audit(ctx.ip, 'notify_mute', { cwd, muted: !!b.muted });
    json(res, 200, await prefsWithTitles());
  });
  route('GET', /^\/api\/notify$/, async (req, res) => json(res, 200, await notifier.status()));
  route('POST', /^\/api\/notify\/test$/, async (req, res, ctx) => {
    if (!notifier.on) return json(res, 400, { error: 'WhatsApp notifications are not set up' });
    await notifier.sendWhatsApp('*👋 Handoff test*\nWhatsApp notifications are working.' + (cfg.publicHostname ? `\nhttps://${cfg.publicHostname}` : ''));
    audit(ctx.ip, 'notify_test');
    json(res, 200, { ok: true });
  });

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
    const remember = body.remember === true && cfg.rememberDays > 0;
    const token = sessions.create(ctx.ip, req.headers['user-agent'], { remember });
    audit(ctx.ip, 'login_ok', { remember, ua: String(req.headers['user-agent'] || '').slice(0, 120) });
    // "Remember me": a cookie that survives closing the browser. Otherwise it ends with the browser session.
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/${remember ? `; Max-Age=${Math.round(cfg.rememberDays * 86400)}` : ''}`);
    json(res, 200, { ok: true });
  }, { public: true });

  // what the sign-in page offers (before anyone is signed in)
  route('GET', /^\/api\/login-options$/, (req, res) => json(res, 200, { rememberDays: cfg.rememberDays > 0 ? cfg.rememberDays : 0 }), { public: true });

  route('POST', /^\/api\/logout$/, (req, res, ctx) => {
    sessions.destroy(ctx.token);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
    json(res, 200, { ok: true });
  });

  route('POST', /^\/api\/logout-all$/, async (req, res, ctx) => {
    const b = await readJson(req).catch(() => ({}));
    sessions.destroyAll();
    preview?.clear();
    // API keys outlive sign-ins unless asked: a stolen browser cookie could have made one
    const revoked = b.revokeKeys ? keys.revokeAll() : 0;
    audit(ctx.ip, 'logout_all', { revokedKeys: revoked || undefined });
    json(res, 200, { ok: true, revokedKeys: revoked });
  });

  // ---------- API keys (the API part, HANDOFF_API) ----------
  // Anything that hands out access asks again: the 2FA code, or the password when 2FA is off.
  const reauth = (b, ip) => {
    if (limiter.blocked(ip)) throw httpErr(429, 'Too many attempts. Try again later.');
    const ok = cfg.totpEnabled ? verifyTotp(cfg.totpSecret, String(b.code || '').trim()) : verifyPassword(String(b.password || ''), cfg.passwordHash);
    if (!ok) {
      limiter.fail(ip); audit(ip, 'reauth_failed');
      throw httpErr(401, cfg.totpEnabled ? 'That 2FA code isn\'t right (or was just used: wait for the next one).' : 'That password isn\'t right.');
    }
    limiter.success(ip);
  };
  route('GET', /^\/api\/keys$/, async (req, res) => json(res, 200, {
    enabled: !!cfg.api, totp: cfg.totpEnabled, keys: keys.list(),
    presets: PRESETS, scopes: SCOPES, modes: keys.availableModes(), tools: TOOL_PRESETS, lengths: LENGTHS, efforts: EFFORTS,
    git: !!cfg.gitActions, files: !!cfg.fileBrowser,
    base: cfg.publicHostname ? `https://${cfg.publicHostname}/api/v1` : null,
    projects: (await store.listProjects()).map(p => ({ cwd: p.cwd, name: p.name }))
  }));
  route('POST', /^\/api\/keys$/, async (req, res, ctx) => {
    const b = await readJson(req);
    reauth(b, ctx.ip);
    const r = keys.create(b);
    audit(ctx.ip, 'api_key_create', { keyId: r.record.id, name: r.record.name, scopes: r.record.scopes });
    json(res, 200, r);
  });
  route('DELETE', /^\/api\/keys\/(key_[0-9a-f]{12})$/, (req, res, ctx, m) => {
    const ok = keys.revoke(m[1]);
    audit(ctx.ip, 'api_key_revoke', { keyId: m[1] });
    json(res, ok ? 200 : 404, ok ? { ok } : { error: 'no such key' });
  });
  // one key's recent calls, newest first, from the audit log (and the older audit.log.1)
  route('GET', /^\/api\/keys\/(key_[0-9a-f]{12})\/activity$/, async (req, res, ctx, m) => {
    const limit = Math.min(Math.max(1, Number(ctx.url.searchParams.get('limit')) || 100), 500);
    const errorsOnly = ctx.url.searchParams.get('errors') === '1';
    const out = [];
    const log = path.join(DATA_DIR, 'audit.log');
    for (const f of [log, log + '.1']) {
      let text = '';
      try { text = await fsp.readFile(f, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        if (!lines[i].includes(m[1])) continue;
        let e; try { e = JSON.parse(lines[i]); } catch { continue; }
        if (e.keyId !== m[1]) continue;
        if (errorsOnly && !(e.status >= 400 || e.turnStatus === 'error')) continue;
        const { keyId, key, via, ...rest } = e;
        out.push(rest);
      }
      if (out.length >= limit) break;
    }
    json(res, 200, { entries: out });
  });
  // turn the API on or off; written to .env, and in effect at once
  route('POST', /^\/api\/api-enabled$/, async (req, res, ctx) => {
    const b = await readJson(req);
    reauth(b, ctx.ip);
    const on = !!b.on;
    updateEnvFile({ HANDOFF_API: on ? 'true' : 'false' });
    cfg.api = on;
    audit(ctx.ip, 'api_enabled', { on });
    json(res, 200, { enabled: on });
  });

  // The settings the page is built with. `version` covers them and the page's own files: an open page
  // that reconnects and gets a different one (the server restarted with an update) reloads itself.
  const pageSettings = () => ({ totp: cfg.totpEnabled, allowBypass: cfg.allowBypassPermissions, defaultMode: runner.normalizeMode(cfg.defaultPermissionMode), files: !!cfg.fileBrowser, git: !!cfg.gitActions, search: !!cfg.search, push: !!cfg.push, api: !!cfg.api, preview: !!preview?.enabled });
  const pageFiles = crypto.createHash('sha256');
  for (const f of fs.readdirSync(PUBLIC, { withFileTypes: true }).filter(f => f.isFile()).map(f => f.name).sort()) pageFiles.update(f).update(fs.readFileSync(path.join(PUBLIC, f)));
  const filesHash = pageFiles.digest('hex');
  const pageVersion = () => crypto.createHash('sha256').update(filesHash + JSON.stringify(pageSettings())).digest('hex').slice(0, 16);

  route('GET', /^\/api\/me$/, (req, res) => json(res, 200, { ok: true, ...pageSettings(), logins: sessions.list().length, version: pageVersion(), whatsapp: notifier.linkState() }));

  // ---------- browsing (read-only) ----------
  route('GET', /^\/api\/projects$/, async (req, res) => json(res, 200, await store.listProjects()));

  route('GET', /^\/api\/projects\/([^/]+)\/sessions$/, async (req, res, ctx, m) => {
    const list = await store.listSessions(decodeURIComponent(m[1]));
    if (!list) return json(res, 404, { error: 'project not found' });
    for (const s of list) { const r = runner.bySession(s.id); s.run = r ? r.status : null; s.via = keys.sessionKey(s.id)?.keyName || null; }
    json(res, 200, list);
  });

  route('GET', /^\/api\/live$/, async (req, res) => {
    const titleOf = async id => (id && (await store.sessionInfo(id))?.title) || '';
    const live = await Promise.all((await store.liveSessions()).map(async l => ({ ...l, title: l.name || await titleOf(l.sessionId) })));
    const runs = await Promise.all(runner.list().map(async r => ({ ...r, title: await titleOf(r.sessionId), via: keys.sessionKey(r.sessionId)?.keyName || null })));
    const ours = new Set(runs.map(r => r.sessionId));
    const others = live.filter(l => !ours.has(l.sessionId));
    for (const l of others) if (l.status === 'waiting') l.question = (await store.pendingQuestion(l.sessionId)) || null;
    json(res, 200, { live: others, runs, permissions: runner.pendingPermissions(), version: pageVersion(), whatsapp: notifier.linkState() });
  });

  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})$/, async (req, res, ctx, m) => {
    const info = await store.sessionInfo(m[1]);
    const run = runner.bySession(m[1]);
    if (!info && !run) return json(res, 404, { error: 'session not found' });
    // a session our runner drives also shows up in the registry; only report *other* live processes
    if (info?.live && run && info.live.pid === run.proc.pid) info.live = null;
    json(res, 200, {
      ...(info || { id: m[1], cwd: run.cwd, title: 'New session' }),
      run: run ? runner.publicRun(run) : null,
      question: (await store.pendingQuestion(m[1])) || null,
      via: keys.sessionKey(m[1])?.keyName || null // started from the API, with this key
    });
  });

  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/transcript$/, async (req, res, ctx, m) => {
    const before = ctx.url.searchParams.get('before');
    const t = await store.readTranscript(m[1], before == null ? null : Number(before));
    if (!t) return json(res, 200, { events: [], start: 0, end: 0, size: 0 });
    json(res, 200, t);
  });

  // what the session has been doing: its to-do list, latest plan, changed files, commands, sub-agents
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/activity$/, async (req, res, ctx, m) => {
    const a = await activity.of(m[1]);
    json(res, 200, a || { todos: [], plan: null, files: [], commands: [], commandCount: 0, agents: [], tools: 0, prompts: 0, first: 0, last: 0 });
  });

  // sub-agent runs: the list, and one run's messages
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/agents$/, async (req, res, ctx, m) => json(res, 200, (await store.subagents(m[1])) || []));
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/agents\/([A-Za-z0-9_-]{1,64})$/, async (req, res, ctx, m) => {
    const t = await store.readSubagent(m[1], m[2]);
    if (!t) return json(res, 404, { error: 'sub-agent run not found' });
    json(res, 200, t);
  });

  // live tail of one session transcript (Server-Sent Events)
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/stream$/, (req, res, ctx, m) => {
    const id = m[1];
    sse(res);
    let from = Number(ctx.url.searchParams.get('from'));
    let stop = null;
    const seen = new Set();
    const send = (o) => {
      for (const e of normalize(o)) {
        const k = e.uuid ? `${e.uuid}:${e.kind}:${e.id || e.toolUseId || ''}:${(e.text || '').length}` : null;
        if (k) { if (seen.has(k)) continue; seen.add(k); if (seen.size > 5000) seen.clear(); }
        res.write(`event: msg\ndata: ${JSON.stringify(e)}\n\n`);
      }
    };
    const onRunnerMsg = (sid, msg) => { if (sid === id) send(msg); };
    runner.on('message', onRunnerMsg);
    // a brand-new session has no transcript yet: look for it every second until it appears
    let waiter = null, closed = false, attaching = false;
    const attach = async () => {
      if (attaching || stop || closed) return;
      attaching = true;
      try {
        const file = await store.sessionFile(id);
        if (!file || closed) return;
        if (!Number.isFinite(from)) from = (await fsp.stat(file)).size;
        if (closed) return;
        stop = tailFile(file, from, o => send(o));
        clearInterval(waiter); waiter = null;
      } catch { /* not there yet */ } finally { attaching = false; }
    };
    waiter = setInterval(attach, 1000);
    attach();
    res.write('event: ready\ndata: {}\n\n'); // lets the client tell a working stream from a buffering proxy
    const hb = setInterval(() => res.write('event: ping\ndata: 1\n\n'), 15e3); // an event (not a comment) so the page can see it
    req.on('close', () => { closed = true; stop?.(); clearInterval(hb); clearInterval(waiter); runner.off('message', onRunnerMsg); });
  });

  // ---------- files in the session's folder (optional, read-only) ----------
  const sessionFolder = async id => {
    if (!cfg.fileBrowser) throw httpErr(404, 'the file browser is turned off (HANDOFF_FILE_BROWSER)');
    const cwd = (await store.sessionInfo(id))?.cwd || runner.bySession(id)?.cwd;
    if (!cwd) throw httpErr(404, 'session not found');
    return cwd;
  };
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/files$/, async (req, res, ctx, m) => {
    json(res, 200, files.list(await sessionFolder(m[1]), ctx.url.searchParams.get('path')));
  });
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/file$/, async (req, res, ctx, m) => {
    const f = files.read(await sessionFolder(m[1]), ctx.url.searchParams.get('path'));
    audit(ctx.ip, 'file_view', { sessionId: m[1], path: f.path });
    json(res, 200, f);
  });
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/raw$/, async (req, res, ctx, m) => {
    const f = files.image(await sessionFolder(m[1]), ctx.url.searchParams.get('path'));
    res.writeHead(200, {
      'Content-Type': f.type, 'Content-Length': f.size, 'Cache-Control': 'private, no-store',
      // an SVG opened on its own must not be able to run scripts on this site
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`
    });
    fs.createReadStream(f.abs).on('error', () => res.destroy()).pipe(res);
  });
  // find files and folders by name anywhere in the project
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/find$/, async (req, res, ctx, m) => {
    json(res, 200, await files.find(await sessionFolder(m[1]), String(ctx.url.searchParams.get('q') || '').slice(0, 200)));
  });
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/download$/, async (req, res, ctx, m) => {
    const f = files.download(await sessionFolder(m[1]), ctx.url.searchParams.get('path'));
    audit(ctx.ip, 'file_download', { sessionId: m[1], path: f.path });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Content-Length': f.size, 'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`
    });
    fs.createReadStream(f.abs).on('error', () => res.destroy()).pipe(res);
  });
  // Changes tab: the folder's uncommitted git changes, and one file's diff
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/changes$/, async (req, res, ctx, m) => {
    json(res, 200, await changes(files, await sessionFolder(m[1])));
  });
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/diff$/, async (req, res, ctx, m) => {
    const d = await diff(files, await sessionFolder(m[1]), ctx.url.searchParams.get('path'));
    audit(ctx.ip, 'diff_view', { sessionId: m[1], path: d.path });
    json(res, 200, d);
  });
  // commit, push and discard (HANDOFF_GIT_ACTIONS), with the computer's own git and its saved sign-ins
  const gitFolder = async id => {
    if (!cfg.gitActions) throw httpErr(404, 'git actions are turned off (HANDOFF_GIT_ACTIONS)');
    return sessionFolder(id);
  };
  const pathList = v => (Array.isArray(v) ? v.slice(0, 5000).map(String) : undefined);
  route('POST', /^\/api\/sessions\/([0-9a-f-]{36})\/commit-message$/, async (req, res, ctx, m) => {
    const b = await readJson(req);
    const prompt = await commitContext(files, await gitFolder(m[1]), pathList(b.paths));
    json(res, 200, { message: tidyMessage(await runner.oneShot(prompt)) });
  });
  route('POST', /^\/api\/sessions\/([0-9a-f-]{36})\/commit$/, async (req, res, ctx, m) => {
    const b = await readJson(req);
    const r = await gitCommit(files, await gitFolder(m[1]), { message: b.message, paths: pathList(b.paths) });
    audit(ctx.ip, 'git_commit', { sessionId: m[1], branch: r.branch, hash: r.hash, files: r.files, subject: r.subject.slice(0, 200) });
    json(res, 200, r);
  });
  route('POST', /^\/api\/sessions\/([0-9a-f-]{36})\/push$/, async (req, res, ctx, m) => {
    const r = await gitPush(files, await gitFolder(m[1]));
    audit(ctx.ip, 'git_push', { sessionId: m[1], branch: r.branch, remote: r.remote });
    json(res, 200, r);
  });
  route('POST', /^\/api\/sessions\/([0-9a-f-]{36})\/discard$/, async (req, res, ctx, m) => {
    const b = await readJson(req);
    const r = await gitDiscard(files, await gitFolder(m[1]), b.path, path.join(DATA_DIR, 'discarded'));
    audit(ctx.ip, 'git_discard', { sessionId: m[1], path: r.path, status: r.status, saved: r.saved || undefined });
    json(res, 200, r);
  });
  // a session's own worktree, once its work is committed (its branch stays)
  route('POST', /^\/api\/sessions\/([0-9a-f-]{36})\/worktree\/remove$/, async (req, res, ctx, m) => {
    const cwd = await gitFolder(m[1]);
    const info = await store.sessionInfo(m[1]);
    const run = runner.bySession(m[1]);
    if ((run && run.status !== 'exited') || info?.live) throw httpErr(409, 'this session is still running: stop it first');
    const r = await removeWorktree(files, cwd);
    audit(ctx.ip, 'worktree_remove', { sessionId: m[1], name: r.name, branch: r.branch });
    json(res, 200, r);
  });

  // ---------- app preview (HANDOFF_PREVIEW_HOSTNAME) ----------
  // what could be previewed: ports the session's chat mentions, and everything listening on the computer
  route('GET', /^\/api\/preview$/, async (req, res, ctx) => {
    if (!preview?.enabled) return json(res, 200, { enabled: false });
    const sid = ctx.url.searchParams.get('sessionId');
    let mentioned = [];
    if (sid && UUID_RE.test(sid)) {
      const file = await store.sessionFile(sid);
      if (file) mentioned = mentionedPorts(await readTail(file, 512 * 1024));
    }
    json(res, 200, { enabled: true, hostname: cfg.previewHostname, mentioned, ports: await preview.ports() });
  });
  route('POST', /^\/api\/preview$/, async (req, res, ctx) => {
    const b = await readJson(req);
    if (!preview) throw httpErr(404, 'App preview needs the web app.');
    const r = preview.ticket(b.port);
    audit(ctx.ip, 'preview_open', { port: r.port });
    json(res, 200, r);
  });

  // ---------- search (optional; on by default) ----------
  const searchIndex = () => { if (!search) throw httpErr(404, 'search is turned off (HANDOFF_SEARCH)'); return search; };
  const query = ctx => String(ctx.url.searchParams.get('q') || '').slice(0, 200);
  route('GET', /^\/api\/search$/, async (req, res, ctx) => json(res, 200, await searchIndex().search(query(ctx))));
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/search$/, async (req, res, ctx, m) => {
    json(res, 200, await searchIndex().search(query(ctx), { sessionId: m[1] }));
  });
  // a search hit in context: the messages around one transcript line
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/around$/, async (req, res, ctx, m) => {
    const r = await store.readAround(m[1], ctx.url.searchParams.get('offset'));
    if (!r) return json(res, 404, { error: 'session not found' });
    json(res, 200, r);
  });

  // polling fallback for networks/proxies that buffer event streams
  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/since$/, async (req, res, ctx, m) => {
    json(res, 200, await store.readSince(m[1], Number(ctx.url.searchParams.get('from'))));
  });

  // models / effort levels / modes, as reported by the installed Claude Code
  route('GET', /^\/api\/options$/, async (req, res) => {
    json(res, 200, { ...(await runner.options()), defaultMode: runner.normalizeMode(cfg.defaultPermissionMode), allowBypass: cfg.allowBypassPermissions });
  });

  // global event stream: run status + permission prompts
  route('GET', /^\/api\/events$/, (req, res) => {
    sse(res);
    globalClients.add(res);
    res.write(`event: hello\ndata: ${JSON.stringify({ runs: runner.list(), permissions: runner.pendingPermissions(), version: pageVersion(), whatsapp: notifier.linkState() })}\n\n`);
    const hb = setInterval(() => res.write('event: ping\ndata: 1\n\n'), 15e3); // an event (not a comment) so the page can see it
    req.on('close', () => { globalClients.delete(res); clearInterval(hb); });
  });

  route('POST', /^\/api\/sessions\/([0-9a-f-]{36})\/answer$/, async (req, res, ctx, m) => {
    const b = await readJson(req);
    const picks = Array.isArray(b.picks) ? b.picks.map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 80) : [];
    json(res, 200, await answerQuestion(m[1], { picks, text: b.text }, ctx.ip));
  });

  // ---------- control ----------
  // the New session page's folder picker: drives (or the allowed folders), the folders in a folder, a new folder
  route('GET', /^\/api\/folders$/, (req, res, ctx) => {
    const p = ctx.url.searchParams.get('path');
    json(res, 200, p ? folderPicker.list(p) : { path: null, roots: folderPicker.roots() });
  });
  route('POST', /^\/api\/folders$/, async (req, res, ctx) => {
    const b = await readJson(req);
    const r = await folderPicker.make(b.parent, b.name, { git: !!b.git });
    audit(ctx.ip, 'folder_create', { path: r.path, git: r.git });
    json(res, 200, r);
  });

  route('POST', /^\/api\/sessions\/new$/, async (req, res, ctx) => {
    const b = await readJson(req, BODY_WITH_PHOTOS);
    const images = parseImages(b.images);
    let cwd = String(b.cwd || '').trim(), wt = null;
    // its own worktree: a new folder and branch made from the project's last commit
    if (b.worktree) {
      if (!cfg.gitActions) throw httpErr(403, 'worktrees are turned off (HANDOFF_GIT_ACTIONS)');
      runner.checkStart(cwd);
      wt = await createWorktree(cwd, typeof b.worktree === 'string' && b.worktree.trim() ? b.worktree : String(b.text ?? ''));
      cwd = wt.cwd;
    }
    let r;
    try { r = await runner.send({ cwd, text: String(b.text ?? ''), images, mode: b.mode, model: b.model || undefined, effort: b.effort || undefined }); }
    catch (e) { if (wt) await dropWorktree(wt); throw e; }
    audit(ctx.ip, 'session_new', { cwd, sessionId: r.sessionId, worktree: wt?.branch, mode: b.mode, model: b.model, effort: b.effort, photos: images.length || undefined, text: String(b.text ?? '').slice(0, 200) });
    json(res, 200, wt ? { ...r, worktree: { branch: wt.branch, path: wt.worktree, from: wt.from } } : r);
  });

  route('POST', /^\/api\/sessions\/([0-9a-f-]{36})\/message$/, async (req, res, ctx, m) => {
    const b = await readJson(req, BODY_WITH_PHOTOS);
    const images = parseImages(b.images);
    if (typeof b.text !== 'string') b.text = '';
    const info = await store.sessionInfo(m[1]);
    const run = runner.bySession(m[1]);
    if (!info && !run) return json(res, 404, { error: 'session not found' });
    const fork = !!b.fork;
    // Open in Claude Desktop / a terminal right now: deliver straight into that process through its
    // local inbox, so the prompt shows up on the computer in real time (and no second writer is started).
    const live = !run && !fork ? info?.live : null;
    if (live) {
      if (!b.text.trim() && !images.length) throw httpErr(400, 'empty message');
      if (b.text.length > 100_000) throw httpErr(413, 'message too long');
      // the computer's inbox takes text: photos are saved in the project folder and named in the message
      const note = images.length ? await saveForLiveSession(info.cwd, images) : '';
      await injectMessage(cfg.claudeHome, live, (b.text.trim() || 'Please look at this.') + note);
      audit(ctx.ip, 'message_live', { sessionId: m[1], pid: live.pid, photos: images.length || undefined, text: String(b.text).slice(0, 200) });
      return json(res, 200, { sessionId: m[1], delivered: 'live' });
    }
    const r = await runner.send({ sessionId: m[1], cwd: run?.cwd || info.cwd, text: b.text, images, mode: b.mode, model: b.model || undefined, effort: b.effort || undefined, fork });
    audit(ctx.ip, 'message', { sessionId: m[1], target: r.sessionId, fork, mode: b.mode, model: b.model, effort: b.effort, photos: images.length || undefined, text: String(b.text).slice(0, 200) });
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

  // ---------- requests ----------
  // Everything that isn't another part's: the pages, and the /api/* routes they use. Errors are
  // answered by the server around it.
  async function handle(req, res, url) {
    const ip = clientIp(req);
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const ctx = { url, ip, token };
    // "Share → Handoff" is answered by the page's service worker; if that isn't installed yet, the
    // share arrives here: open the New session page instead of an error (what was shared is lost)
    if (url.pathname === '/share' && req.method === 'POST') { req.resume(); res.writeHead(303, { Location: '/#/new?shared=0' }); return res.end(); }
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname, filesHash.slice(0, 12));
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // CSRF: same-origin JSON requests with our custom header only. Our own page always sends it,
      // so without it the page is usually an old copy from before an update: say how to fix that.
      if (req.headers['x-handoff'] !== '1') return json(res, 403, { error: 'This page is out of date. Reload it (on a phone, close the app fully and open it again).' });
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
  }

  return { handle, sessions };
}

// the last `bytes` of a file, as text
async function readTail(file, bytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { await fh.close(); }
}

function parseCookies(h = '') {
  const out = {};
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client; SameSite=Strict cookie + custom header still required
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  const allowed = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map(h => String(h).split(',')[0].trim());
  return allowed.includes(host);
}

// version: changes whenever the page's files do. index.html points at /app.js?v=<version> (and the
// same for /theme.js and /style.css), so no cache in between (a CDN or the browser) can serve an old
// script or stylesheet after an update, whatever its own caching rules: an update means new addresses.
function serveStatic(req, res, pathname, version) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA routes
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    if (rel === '/index.html') data = Buffer.from(String(data).replace(/(src|href)="\/(app\.js|theme\.js|style\.css)"/g, `$1="/$2?v=${version}"`));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); // tiny files; always pick up updates
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}
