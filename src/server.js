import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA_DIR, ENV_FILE } from './config.js';
import { verifyPassword, verifyTotp, SessionStore, LoginLimiter } from './auth.js';
import { Store, tailFile, normalize, UUID_RE } from './store.js';
import { Runner, httpErr } from './runner.js';
import { injectMessage } from './inbox.js';
import { Notifier, buildAnswer } from './notify.js';
import { FileBrowser } from './files.js';
import { rotate } from './logfile.js';
import { SearchIndex } from './search.js';
import { changes, diff } from './changes.js';
import { parseImages, saveForLiveSession } from './attachments.js';
import { PushService } from './push.js';

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
  let auditWrites = 0;
  const audit = (ip, action, { text, ...detail } = {}) => {
    if (text !== undefined && cfg.auditText) detail.text = text;
    if (auditWrites++ % 200 === 0) rotate(auditFile); // past 5 MB: audit.log.1, so it can't grow forever
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

  // Phone push notifications: each device opts in from the web app (menu -> Phone notifications)
  const push = cfg.push ? new PushService({
    dataDir: DATA_DIR, log,
    contact: cfg.pushContact || (cfg.publicHostname ? `https://${cfg.publicHostname}` : 'mailto:handoff@example.com')
  }) : null;

  // WhatsApp notifications (approval needed / waiting / finished / error), and push to phones
  const notifier = new Notifier(cfg, {
    push,
    store, runner, log,
    // replies typed on WhatsApp take the same path as taps in the web UI
    onAnswer: (sessionId, pick) => answerQuestion(sessionId, pick, 'whatsapp'),
    onApproval: (permId, allow) => runner.decide(permId, { allow, message: 'Denied from WhatsApp' }),
    // open pages show a warning while WhatsApp alerts can't be delivered
    onLinkChange: s => broadcast('whatsapp', s),
    prefsFile: path.join(DATA_DIR, 'notify.json') // projects muted from the web app
  }).start();
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

  route('POST', /^\/api\/logout-all$/, (req, res, ctx) => {
    sessions.destroyAll(); audit(ctx.ip, 'logout_all');
    json(res, 200, { ok: true });
  });

  // The settings the page is built with. `version` covers them and the page's own files: an open page
  // that reconnects and gets a different one (the server restarted with an update) reloads itself.
  const pageSettings = () => ({ totp: cfg.totpEnabled, allowBypass: cfg.allowBypassPermissions, defaultMode: runner.normalizeMode(cfg.defaultPermissionMode), files: !!cfg.fileBrowser, search: !!cfg.search, push: !!cfg.push });
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
    for (const s of list) { const r = runner.bySession(s.id); s.run = r ? r.status : null; }
    json(res, 200, list);
  });

  route('GET', /^\/api\/live$/, async (req, res) => {
    const titleOf = async id => (id && (await store.sessionInfo(id))?.title) || '';
    const live = await Promise.all((await store.liveSessions()).map(async l => ({ ...l, title: l.name || await titleOf(l.sessionId) })));
    const runs = await Promise.all(runner.list().map(async r => ({ ...r, title: await titleOf(r.sessionId) })));
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
      question: (await store.pendingQuestion(m[1])) || null
    });
  });

  route('GET', /^\/api\/sessions\/([0-9a-f-]{36})\/transcript$/, async (req, res, ctx, m) => {
    const before = ctx.url.searchParams.get('before');
    const t = await store.readTranscript(m[1], before == null ? null : Number(before));
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
        stop = tailFile(file, from, o => push(o));
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
  // Never shown: Handoff's own secrets, Claude Code's login, and the session inbox tokens.
  const files = new FileBrowser({
    deny: [ENV_FILE, DATA_DIR, path.join(cfg.claudeHome, '.credentials.json'), path.join(cfg.claudeHome, 'sessions')],
    allowedRoots: cfg.allowedRoots
  });
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

  // ---------- search (optional; on by default) ----------
  // The index is built in the background shortly after start, and topped up before every search.
  const search = cfg.search ? new SearchIndex({ store, dir: path.join(DATA_DIR, 'search'), log }) : null;
  if (search) {
    const t = setTimeout(() => search.update()
      .then(n => n && log(`[search] index up to date (${n} chat${n === 1 ? '' : 's'} added or updated)`))
      .catch(e => log(`[search] ${e.message}`)), 15e3);
    t.unref?.();
  }
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

  // Answer a pending AskUserQuestion. `picks` are option numbers (as shown in the UI and on
  // WhatsApp); `text` is a free-text answer. Delivered like any other prompt: straight into a
  // session running on the laptop, or into our own process.
  async function answerQuestion(id, { picks = [], text = '' }, ip) {
    const q = await store.pendingQuestion(id);
    if (!q) throw httpErr(409, 'that question is no longer open');
    const { chosen, free, prompt } = buildAnswer(q, { picks, text });

    const run = runner.bySession(id);
    const info = await store.sessionInfo(id);
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
    const b = await readJson(req, BODY_WITH_PHOTOS);
    const images = parseImages(b.images);
    const r = await runner.send({ cwd: String(b.cwd || ''), text: String(b.text ?? ''), images, mode: b.mode, model: b.model || undefined, effort: b.effort || undefined });
    audit(ctx.ip, 'session_new', { cwd: b.cwd, sessionId: r.sessionId, mode: b.mode, model: b.model, effort: b.effort, photos: images.length || undefined, text: String(b.text ?? '').slice(0, 200) });
    json(res, 200, r);
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
    // local inbox, so the prompt shows up on the laptop in real time (and no second writer is started).
    const live = !run && !fork ? info?.live : null;
    if (live) {
      if (!b.text.trim() && !images.length) throw httpErr(400, 'empty message');
      if (b.text.length > 100_000) throw httpErr(413, 'message too long');
      // the laptop's inbox takes text: photos are saved in the project folder and named in the message
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

  // ---------- request pipeline ----------
  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://x');
    const ip = clientIp(req);
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const ctx = { url, ip, token };
    try {
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

const BODY_WITH_PHOTOS = 4 * 7 * 1024 * 1024; // up to 4 photos of 5 MB, base64-encoded
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

// version: changes whenever the page's files do. index.html points at /app.js?v=<version> and
// /style.css?v=<version>, so no cache in between (a CDN or the browser) can serve an old script or
// stylesheet after an update, whatever its own caching rules: an update means new addresses.
function serveStatic(req, res, pathname, version) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA routes
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    if (rel === '/index.html') data = Buffer.from(String(data).replace(/(src|href)="\/(app\.js|style\.css)"/g, `$1="/$2?v=${version}"`));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); // tiny files; always pick up updates
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const delay = ms => new Promise(r => setTimeout(r, ms));
export { UUID_RE };
