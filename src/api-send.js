// The API's sending side: prompts in, answers out (see turns.js for how a turn is followed).
//
//   POST /chat                      the simple one: continues the selected session, or starts one
//   POST /sessions                  a new session          POST /sessions/:id/messages   continue one
//   POST /sessions/:id/ask          ask without a trace (an unsaved copy; nothing changes)
//   GET  /turns/:id[?wait=60]       a turn (long-poll)     GET /turns/:id/stream          its events
//   DELETE /turns/:id               cancel / interrupt     GET /turns                     recent turns
//   PUT|GET|DELETE /selection       pick a session for /chat
//   GET /approvals, POST /approvals/:id, POST /sessions/:id/answer, /interrupt, /stop
//
// An answer is waited for up to `wait` seconds (default 60, at most 90: Cloudflare drops responses that
// take over 100 s to start), then 202 with the turn so far; `stream: true` sends Server-Sent Events;
// `format: "text"` (or Accept: text/plain) answers with just the text.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ENV_FILE, DATA_DIR } from './config.js';
import { EFFORTS, PERMISSION_MODES, httpErr } from './runner.js';
import { parseImages, imageContent, saveForLiveSession } from './attachments.js';
import { TOOL_PRESETS, LENGTHS } from './apikeys.js';
import { TurnManager, ACTIVE, stripMarkdown } from './turns.js';
import { createWorktree, dropWorktree } from './changes.js';
import { json, sse } from './http-util.js';
import { apiErr, keyDir, API_PREFIX } from './api-util.js';

const TOOL_RANK = { all: 0, readOnly: 1, none: 2 };
const LENGTH_NOTE = { brief: 'Keep it brief.', normal: '', detailed: 'Answer in detail.' };
const SEND_BODY = 72 * 1024 * 1024; // photos and files, base64-encoded
const MODEL_ID_RE = /^claude-[a-z0-9][a-z0-9.-]*(\[[a-z0-9]+\])?$/i;

export function addSending(api, core) {
  const { cfg, store, runner, keys, audit } = core;
  const turns = new TurnManager(core, { webUrl: api.webUrl });
  const { route, inScope, sessionFor, findProject } = api;

  // ---------- reading requests ----------
  // JSON, with or without a Content-Type (curl -d sends form encoding). Multipart: see uploads.
  async function readBody(req, limit = 256 * 1024) {
    const ct = String(req.headers['content-type'] || '');
    if (/multipart\/form-data/i.test(ct)) return api.readMultipart(req, ct, limit);
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > limit) throw apiErr(413, 'too_large', `The body is larger than ${Math.round(limit / 1048576)} MB.`); chunks.push(c); }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return {};
    let b;
    try { b = JSON.parse(text); } catch { throw apiErr(400, 'invalid_json', 'The body must be JSON, e.g. {"prompt": "Hello"}.'); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw apiErr(400, 'invalid_json', 'The body must be a JSON object.');
    return b;
  }
  api.readBody = readBody;

  // Claude's file tools may not read or change Handoff's own secrets, Claude's sign-in or the session
  // inboxes. (Rule forms that work on Windows: C:\... and //c/...; elsewhere //absolute/path.)
  const protect = (p, dir) => {
    const forms = [];
    if (process.platform === 'win32') {
      forms.push('//' + p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase()) + (dir ? '/**' : ''));
      if (!dir) forms.push(p);
    } else forms.push('/' + p + (dir ? '/**' : ''));
    return forms;
  };
  const deny = [
    ...protect(ENV_FILE), ...protect(DATA_DIR, true),
    ...protect(path.join(cfg.claudeHome, '.credentials.json')), ...protect(path.join(cfg.claudeHome, 'sessions'), true)
  ].flatMap(f => ['Read', 'Edit', 'Write'].map(tool => `${tool}(${f})`));

  // ---------- where a prompt goes ----------
  async function sessionTarget(k, id) {
    const s = await sessionFor(k, id);
    const live = !s.run && s.info?.live ? s.info.live : null;
    return { kind: 'session', sessionId: id, cwd: s.cwd, live };
  }
  async function newTarget(k, b) {
    let cwd;
    if (b.project) {
      const p = await findProject(k, b.project);
      if (!p) throw apiErr(404, 'project_not_found', 'No such project (or this key can\'t see it). See GET /api/v1/projects.');
      cwd = p.cwd;
    } else {
      cwd = keyDir(cfg, k);
      await fsp.mkdir(cwd, { recursive: true });
    }
    if (!inScope(k, cwd)) throw apiErr(404, 'project_not_found', 'No such project (or this key can\'t see it).');
    const target = { kind: 'new', cwd };
    if (b.worktree) {
      if (!cfg.gitActions) throw apiErr(403, 'git_off', 'Worktrees are turned off in this Handoff (HANDOFF_GIT_ACTIONS).');
      runner.checkStart(cwd, { api: true });
      target.worktree = await createWorktree(cwd, typeof b.worktree === 'string' && b.worktree.trim() ? b.worktree : String(b.prompt || ''));
      target.cwd = target.worktree.cwd;
    }
    return target;
  }
  async function latestTarget(k, project) {
    let all = await store.allSessions();
    if (project) {
      const p = await findProject(k, project);
      if (!p?.key) throw apiErr(404, 'project_not_found', 'No such project (or this key can\'t see it).');
      all = all.filter(s => s.key === p.key);
    }
    for (const s of all.slice(0, 200)) {
      const meta = await store.meta(s.file).catch(() => null);
      if (meta && inScope(k, meta.cwd)) return sessionTarget(k, s.id);
    }
    throw apiErr(404, 'session_not_found', 'There is no session there yet.');
  }

  // ---------- checking a prompt ----------
  async function checkModel(model, warnings) {
    if (!model || model === 'default') return undefined;
    const o = await runner.options();
    const m = o.models.find(x => x.value === model);
    if (!m && !MODEL_ID_RE.test(model)) throw apiErr(400, 'unknown_model', `Unknown model "${model}". Use one of: ${o.models.map(x => x.value).join(', ')} (or a full claude-… id).`, { models: o.models.map(x => x.value) });
    return { value: model, info: m || null };
  }

  // the request body -> what TurnManager.start needs
  async function prepare(ctx, b, { target, fork = false, save = true, ask = false }) {
    const k = ctx.key;
    const warnings = [];
    if (keys.overBudget(k)) throw apiErr(402, 'budget_exceeded', `This key's daily budget ($${k.dailyBudgetUsd}) is used up. It starts again at midnight, the computer's time.`);
    if (turns.active(k.id).length >= k.maxTurns) { const e = apiErr(429, 'too_many_turns', `This key may run ${k.maxTurns} turn${k.maxTurns === 1 ? '' : 's'} at once. Wait for one to finish.`); e.retryAfter = 10; throw e; }
    let text = b.prompt ?? b.text ?? '';
    if (typeof text !== 'string') throw apiErr(400, 'invalid_request', '"prompt" must be text.');
    if (text.length > 100_000) throw apiErr(413, 'too_large', 'The prompt is longer than 100,000 characters.');
    let images;
    try { images = parseImages(b.images); } catch (e) { throw apiErr(e.status || 400, 'invalid_image', e.message); }
    // tools first: they decide how attached files are handed over
    const tools = b.tools || (ask && TOOL_RANK[k.tools] < 1 ? 'readOnly' : k.tools);
    if (!TOOL_PRESETS.includes(tools)) throw apiErr(400, 'invalid_request', `"tools" is one of ${TOOL_PRESETS.join(', ')}.`);
    if (TOOL_RANK[tools] < TOOL_RANK[k.tools]) throw apiErr(403, 'tools_not_allowed', `This key is limited to "${k.tools}" tools.`);
    if (ask && tools === 'all') throw apiErr(400, 'invalid_request', 'Asking without a trace can\'t change files: use "tools": "readOnly" or "none".');
    const extra = await api.attachments?.(ctx, b, { target, fork, tools, text }) || { text, blocks: [], note: '', laptopNote: '' };
    if (!text.trim() && !images.length && !extra.blocks.length && !extra.note) throw apiErr(400, 'empty_prompt', 'Send a "prompt" (or a photo or file).');
    const original = text;
    text = (extra.text.trim() || (images.length || extra.note || extra.blocks.length ? 'Please look at this.' : '')) + extra.note;

    // the answer's language and length: a short note at the end of the prompt (works everywhere,
    // continued sessions and sessions open on the computer too)
    const language = String(b.language ?? k.defaults?.language ?? '').trim().slice(0, 40);
    const length = b.length ?? k.defaults?.length ?? '';
    if (length && !LENGTHS.includes(length)) throw apiErr(400, 'invalid_request', `"length" is one of ${LENGTHS.join(', ')}.`);
    const note = [language ? `Answer in ${language}.` : '', LENGTH_NOTE[length] || ''].filter(Boolean).join(' ');
    if (note) text = `${text}\n\n(${note})`;

    const m = await checkModel(b.model || k.defaults?.model, warnings);
    let effort = b.effort || k.defaults?.effort || undefined;
    if (effort && !EFFORTS.includes(effort)) throw apiErr(400, 'invalid_request', `"effort" is one of ${EFFORTS.join(', ')}.`);
    if (effort && m?.info && (!m.info.supportsEffort || (m.info.efforts?.length && !m.info.efforts.includes(effort)) || (m.info.supportedEffortLevels?.length && !m.info.supportedEffortLevels.includes(effort)))) {
      warnings.push(`${m.value} doesn't take the effort level "${effort}", so it was left out.`);
      effort = undefined;
    }

    const mode = b.mode ? runner.normalizeMode(b.mode) : k.defaultMode;
    if (!PERMISSION_MODES.includes(mode)) throw apiErr(400, 'invalid_request', `"mode" is one of ${PERMISSION_MODES.join(', ')}.`);
    if (!k.modes.includes(mode)) throw apiErr(403, 'mode_not_allowed', `This key may use these modes: ${k.modes.join(', ')}.`);

    // settings only a new process can take: never into a session someone else is using
    const startOnly = ['system', 'schema', 'maxBudgetUsd', 'tools'].filter(f => b[f] != null && b[f] !== '');
    const isStart = target.kind === 'new' || fork || !save;
    if (startOnly.length && !isStart) throw apiErr(400, 'start_only', `${startOnly.map(f => `"${f}"`).join(', ')} can only be set on a new session, a fork ("fork": true) or a one-off ("save": false).`);
    let schema = b.schema ?? b.json_schema;
    if (schema != null) {
      if (typeof schema === 'string') { try { JSON.parse(schema); } catch { throw apiErr(400, 'invalid_request', '"schema" must be a JSON Schema.'); } }
      else if (typeof schema === 'object') schema = JSON.stringify(schema);
      else throw apiErr(400, 'invalid_request', '"schema" must be a JSON Schema.');
      if (schema.length > 20000) throw apiErr(413, 'too_large', '"schema" is too long.');
    }
    if (b.system != null && (typeof b.system !== 'string' || b.system.length > 20000)) throw apiErr(400, 'invalid_request', '"system" must be text (at most 20,000 characters).');
    const maxBudgetUsd = b.maxBudgetUsd == null ? undefined : Number(b.maxBudgetUsd);
    if (maxBudgetUsd !== undefined && !(maxBudgetUsd > 0 && maxBudgetUsd <= 1000)) throw apiErr(400, 'invalid_request', '"maxBudgetUsd" is a number of dollars above 0.');
    const ifBusy = b.ifBusy || 'queue';
    if (!['queue', 'interrupt', 'fail'].includes(ifBusy)) throw apiErr(400, 'invalid_request', '"ifBusy" is queue, interrupt or fail.');
    const ifLaptop = b.ifLaptop || 'send';
    if (!['send', 'fork'].includes(ifLaptop)) throw apiErr(400, 'invalid_request', '"ifLaptop" is send or fork.');
    const timeout = b.timeout == null ? null : Number(b.timeout);
    if (timeout !== null && !(timeout >= 1 && timeout <= 7200)) throw apiErr(400, 'invalid_request', '"timeout" is a number of seconds from 1 to 7200.');

    const content = images.length || extra.blocks.length ? [...imageContent(text.trim(), images), ...extra.blocks] : text;
    // a session open on the computer takes text: photos are saved in its folder and named in the message
    let laptopText = text;
    if (target.live && !fork) {
      if (images.length) laptopText += await saveForLiveSession(target.cwd, images);
      laptopText += extra.laptopNote || '';
    }
    return {
      key: k, ip: ctx.ip, target, fork, save, content, laptopText, prompt: original,
      model: m?.value, effort, mode, modeGiven: !!b.mode,
      api: { tools, system: b.system || undefined, schema: schema || undefined, maxBudgetUsd, deny },
      ifBusy, ifLaptop, timeout, plain: !!(b.plain ?? k.defaults?.plain), webhook: api.checkWebhook ? api.checkWebhook(b.webhook) : null, warnings,
      restricted: !keys.isFull(k)
    };
  }

  // ---------- answering ----------
  const waitOf = (ctx, b) => {
    const w = Number(b?.wait ?? ctx.url.searchParams.get('wait') ?? 60);
    return Math.min(Math.max(0, Number.isFinite(w) ? w : 60), 90);
  };
  const formatOf = (req, ctx, b) => {
    const f = b?.format || ctx.url.searchParams.get('format');
    if (f) return f === 'text' ? 'text' : 'json';
    const accept = String(req.headers.accept || '');
    return /text\/plain/.test(accept) && !/json/.test(accept) ? 'text' : 'json';
  };
  function sendTurn(res, t, format) {
    const v = turns.view(t);
    const running = ACTIVE.has(t.status);
    if (running) res.setHeader('Location', `${API_PREFIX}/turns/${t.id}`);
    if (format === 'text') {
      if (running) { res.writeHead(202, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(`Still working. Ask again with: GET ${API_PREFIX}/turns/${t.id}?format=text&wait=60\n`); }
      if (t.status === 'error') {
        res.writeHead(t.error?.code === 'claude_limit' ? 429 : 502, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end((t.error?.message || 'Claude stopped with an error.') + '\n');
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end((v.text || '') + (t.status === 'interrupted' ? `\n\n(stopped before the end${t.warnings.length ? ': ' + t.warnings.at(-1) : ''})` : '') + '\n');
    }
    json(res, running ? 202 : 200, v);
  }
  // Server-Sent Events: what happened so far, then live, until the turn ends
  function streamTurn(req, res, t, from = 0) {
    sse(res);
    const write = ev => res.write(`id: ${ev.id}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    res.write(`event: turn\ndata: ${JSON.stringify(turns.view(t))}\n\n`);
    for (const ev of t.events) if (ev.id > from) write(ev);
    if (!ACTIVE.has(t.status)) return res.end();
    const hb = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 15e3);
    const off = turns.listen(t, ev => {
      write(ev);
      if (ev.event === 'done' || ev.event === 'error') { clearInterval(hb); off(); res.end(); }
    });
    req.on('close', () => { clearInterval(hb); off(); });
  }
  async function respond(req, res, ctx, t, b) {
    if (b?.stream === true || ctx.url.searchParams.get('stream') === 'true') return streamTurn(req, res, t);
    await turns.wait(t, waitOf(ctx, b) * 1000);
    sendTurn(res, t, formatOf(req, ctx, b));
  }
  api.respondTurn = respond;

  // start a turn; a new worktree that never got its session is removed again
  async function begin(o) {
    try { return await turns.start(o); }
    catch (e) { if (o.target.worktree) await dropWorktree(o.target.worktree).catch(() => {}); throw e; }
  }
  // the same request again (Idempotency-Key): the first turn, not a second prompt
  const replayed = (ctx, req) => {
    const id = keys.idempotent(ctx.key.id, req.headers['idempotency-key']);
    return id ? turns.get(id) : null;
  };
  api.startTurn = begin;
  api.prepare = prepare;
  api.targets = { sessionTarget, newTarget, latestTarget };

  // ---------- sending ----------
  route('POST', '/chat', 'chat', async (req, res, ctx) => {
    const again = replayed(ctx, req);
    const b = await readBody(req, SEND_BODY);
    if (again) return respond(req, res, ctx, again, b);
    const k = ctx.key;
    const save = b.save !== false;
    const spec = b.session ?? b.sessionId ?? null;
    const warnings = [];
    let target, select = false;
    if (!save || spec === 'new' || (!spec && !k.selection)) { target = await newTarget(k, b); select = save; }
    else if (spec === 'latest') target = await latestTarget(k, b.project);
    else if (spec) { target = await sessionTarget(k, String(spec)); select = !!b.select; }
    else {
      try { target = await sessionTarget(k, k.selection); }
      catch { warnings.push('The selected session no longer exists, so a new one was started.'); target = await newTarget(k, b); select = true; }
    }
    const o = await prepare(ctx, b, { target, fork: !!b.fork, save });
    o.warnings.unshift(...warnings);
    const t = await begin(o);
    if (select && t.sessionId && t.save) keys.setSelection(k.id, t.sessionId);
    keys.remember(k.id, req.headers['idempotency-key'], t.id);
    await respond(req, res, ctx, t, b);
  });

  route('POST', '/sessions', 'chat', async (req, res, ctx) => {
    const again = replayed(ctx, req);
    const b = await readBody(req, SEND_BODY);
    if (again) return respond(req, res, ctx, again, b);
    const target = await newTarget(ctx.key, b);
    const t = await begin(await prepare(ctx, b, { target, save: b.save !== false }));
    if (b.select && t.sessionId && t.save) keys.setSelection(ctx.key.id, t.sessionId);
    keys.remember(ctx.key.id, req.headers['idempotency-key'], t.id);
    await respond(req, res, ctx, t, b);
  });

  route('POST', '/sessions/([0-9a-f-]{36})/messages', 'chat', async (req, res, ctx, m) => {
    const again = replayed(ctx, req);
    const b = await readBody(req, SEND_BODY);
    if (again) return respond(req, res, ctx, again, b);
    const target = await sessionTarget(ctx.key, m[1]);
    const t = await begin(await prepare(ctx, b, { target, fork: !!b.fork, save: b.save !== false }));
    if (b.select && t.sessionId && t.save) keys.setSelection(ctx.key.id, t.sessionId);
    keys.remember(ctx.key.id, req.headers['idempotency-key'], t.id);
    await respond(req, res, ctx, t, b);
  });

  // ask without a trace: an unsaved copy of the session answers; nothing is added to it, no chat is saved
  route('POST', '/sessions/([0-9a-f-]{36})/ask', 'chat', async (req, res, ctx, m) => {
    const b = await readBody(req, SEND_BODY);
    const target = await sessionTarget(ctx.key, m[1]);
    const t = await begin(await prepare(ctx, b, { target, fork: true, save: false, ask: true }));
    await respond(req, res, ctx, t, b);
  });

  // ---------- turns ----------
  const turnFor = (ctx, id) => {
    const t = turns.get(id);
    if (t && t.keyId === ctx.key.id) return t;
    return null;
  };
  route('GET', '/turns', 'read', (req, res, ctx) => {
    const q = ctx.url.searchParams;
    const limit = Math.min(Math.max(1, Number(q.get('limit')) || 50), 200);
    const live = turns.ofKey(ctx.key.id).map(t => {
      const v = turns.view(t);
      return { id: v.id, sessionId: v.sessionId, status: v.status, prompt: t.prompt.slice(0, 120), createdAt: v.createdAt, endedAt: v.endedAt, costUsd: v.usage?.costUsd ?? null, webUrl: v.webUrl };
    });
    const seen = new Set(live.map(t => t.id));
    const old = keys.turnNotes(ctx.key.id).filter(n => !seen.has(n.id)).map(n => ({
      id: n.id, sessionId: n.sessionId, status: ACTIVE.has(n.status) ? 'lost' : n.status, prompt: n.prompt, createdAt: api.iso(n.at), endedAt: api.iso(n.endedAt), costUsd: n.costUsd, webUrl: api.webUrl(n.sessionId)
    }));
    let all = [...live, ...old].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (q.get('session')) all = all.filter(t => t.sessionId === q.get('session'));
    if (q.get('status')) all = all.filter(t => t.status === q.get('status'));
    json(res, 200, { turns: all.slice(0, limit) });
  });
  route('GET', '/turns/([A-Za-z0-9_-]{6,60})', 'read', async (req, res, ctx, m) => {
    const t = turnFor(ctx, m[1]);
    if (t) {
      await turns.wait(t, waitOf(ctx) * 1000, { change: true });
      return sendTurn(res, t, formatOf(req, ctx));
    }
    const n = keys.turnNote(m[1]);
    if (!n || n.keyId !== ctx.key.id) throw apiErr(404, 'turn_not_found', 'No such turn (turns are kept for 24 hours).');
    // from before a restart: only a note is left
    json(res, 200, { id: m[1], object: 'turn', sessionId: n.sessionId, status: ACTIVE.has(n.status) ? 'lost' : n.status, lost: true,
      message: 'Handoff restarted after this turn started, so its details are gone. The answer, if there is one, is in the session\'s messages.',
      messagesUrl: n.sessionId ? `${API_PREFIX}/sessions/${n.sessionId}/messages` : null, webUrl: api.webUrl(n.sessionId), createdAt: api.iso(n.at) });
  });
  route('GET', '/turns/([A-Za-z0-9_-]{6,60})/stream', 'read', (req, res, ctx, m) => {
    const t = turnFor(ctx, m[1]);
    if (!t) throw apiErr(404, 'turn_not_found', 'No such turn (turns are kept for 24 hours).');
    streamTurn(req, res, t, Number(req.headers['last-event-id']) || 0);
  });
  route('DELETE', '/turns/([A-Za-z0-9_-]{6,60})', 'chat', async (req, res, ctx, m) => {
    const t = turnFor(ctx, m[1]);
    if (!t) throw apiErr(404, 'turn_not_found', 'No such turn.');
    turns.cancel(t);
    await turns.wait(t, 5000);
    json(res, 200, turns.view(t));
  });

  // ---------- picking a session for /chat ----------
  route('GET', '/selection', 'read', async (req, res, ctx) => {
    const id = ctx.key.selection;
    let session = null;
    if (id) session = await sessionFor(ctx.key, id).then(() => id, () => null);
    json(res, 200, { session, ...(id && !session ? { gone: id } : {}) });
  });
  route('PUT', '/selection', 'read', async (req, res, ctx) => {
    const b = await readBody(req);
    const id = b.session ?? b.sessionId;
    if (!id) throw apiErr(400, 'invalid_request', 'Send {"session": "<session id>"}.');
    await sessionFor(ctx.key, String(id));
    keys.setSelection(ctx.key.id, String(id));
    json(res, 200, { session: String(id) });
  });
  route('DELETE', '/selection', 'read', (req, res, ctx) => { keys.setSelection(ctx.key.id, null); json(res, 200, { session: null }); });

  // ---------- approvals and questions ----------
  route('GET', '/approvals', 'approve', (req, res, ctx) => {
    const list = runner.pendingPermissions().filter(p => inScope(ctx.key, p.cwd)).map(p => {
      const t = [...turns.turns.values()].find(x => x.pending?.id === p.id && x.keyId === ctx.key.id);
      return { ...p, turnId: t?.id || null, webUrl: api.webUrl(p.sessionId) };
    });
    json(res, 200, { approvals: list });
  });
  route('POST', '/approvals/([A-Za-z0-9_-]{6,40})', 'approve', async (req, res, ctx, m) => {
    const b = await readBody(req);
    const p = runner.permissions.get(m[1]);
    if (!p || !inScope(ctx.key, p.run.cwd)) throw apiErr(404, 'approval_not_found', 'No such request (or it was already answered).');
    let alwaysMode = b.alwaysMode ? runner.normalizeMode(b.alwaysMode) : undefined;
    if (alwaysMode && (!ctx.key.modes.includes(alwaysMode) || alwaysMode === 'bypassPermissions')) throw apiErr(403, 'mode_not_allowed', `This key may switch to these modes: ${ctx.key.modes.filter(x => x !== 'bypassPermissions').join(', ')}.`);
    const ok = runner.decide(m[1], { allow: !!b.allow, message: b.message || 'Denied through the API', alwaysMode });
    audit(ctx.ip, 'permission', { via: 'api', key: ctx.key.name, keyId: ctx.key.id, id: m[1], allow: !!b.allow, alwaysMode });
    if (!ok) throw apiErr(404, 'approval_not_found', 'That request was already answered.');
    json(res, 200, { ok: true });
  });
  route('POST', '/sessions/([0-9a-f-]{36})/answer', 'approve', async (req, res, ctx, m) => {
    await sessionFor(ctx.key, m[1]);
    const b = await readBody(req);
    const picks = Array.isArray(b.picks) ? b.picks.map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 80) : [];
    try { json(res, 200, await core.answerQuestion(m[1], { picks, text: String(b.text || '') }, ctx.ip)); }
    catch (e) { throw e.status === 409 ? apiErr(409, 'no_question', e.message) : e; }
  });

  // ---------- stopping ----------
  const ours = async (ctx, id) => {
    const s = await sessionFor(ctx.key, id);
    if (!s.run && s.info?.live) throw apiErr(409, 'laptop_session', 'That session is open on the computer: stop it there.');
    return s;
  };
  route('POST', '/sessions/([0-9a-f-]{36})/interrupt', 'chat', async (req, res, ctx, m) => {
    await ours(ctx, m[1]);
    audit(ctx.ip, 'interrupt', { via: 'api', key: ctx.key.name, keyId: ctx.key.id, sessionId: m[1] });
    for (const t of turns.turns.values()) if (t.sessionId === m[1] && ACTIVE.has(t.status) && t.status !== 'queued') t.interrupted = true;
    json(res, 200, { ok: runner.interrupt(m[1]) });
  });
  route('POST', '/sessions/([0-9a-f-]{36})/stop', 'chat', async (req, res, ctx, m) => {
    await ours(ctx, m[1]);
    audit(ctx.ip, 'stop', { via: 'api', key: ctx.key.name, keyId: ctx.key.id, sessionId: m[1] });
    turns.cancelQueued(m[1]);
    for (const t of turns.turns.values()) if (t.sessionId === m[1] && ACTIVE.has(t.status)) t.interrupted = true;
    json(res, 200, { ok: runner.stop(m[1]) });
  });

  return turns;
}

export { stripMarkdown, httpErr };
