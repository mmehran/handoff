// Compare models: POST /api/v1/compare sends one prompt to 2 or 3 models at once and returns the
// answers side by side. Each answers in its own unsaved copy of a session (or with no session at all),
// so nothing is saved and nothing changes. Tools default to none (readOnly is allowed, all is not).
// They run at the same time while the API's process limit has room, otherwise one after another.
import crypto from 'node:crypto';
import { json, sse } from './http-util.js';
import { apiErr, API_PREFIX } from './api-util.js';
import { ACTIVE } from './turns.js';

export function addCompare(api, core) {
  const { route, turns } = api;
  const comparisons = new Map(); // id -> comparison (24 hours, like turns)

  const view = c => {
    const answers = c.entries.map(e => {
      const v = e.turn ? turns.view(e.turn) : null;
      return { model: e.model, effort: e.effort || null, status: v ? v.status : e.error ? 'error' : 'queued', text: v?.text ?? '', messages: v?.messages ?? [],
        durationMs: v?.durationMs ?? 0, usage: v?.usage ?? null, costUsd: v?.usage?.costUsd ?? null, warnings: v?.warnings ?? [], error: v?.error ?? e.error ?? null, turnId: e.turn?.id ?? null };
    });
    const running = answers.some(a => a.status === 'queued' || ACTIVE.has(a.status));
    return { id: c.id, object: 'comparison', status: running ? 'running' : 'done', prompt: c.prompt.slice(0, 200), answers, createdAt: new Date(c.createdAt).toISOString() };
  };
  const done = c => c.entries.every(e => e.error || (e.turn && !ACTIVE.has(e.turn.status)));

  // start what can start; the rest waits for a place (the API's process limit)
  async function pump(c) {
    for (const e of c.entries) {
      if (e.turn || e.error || e.starting) continue;
      e.starting = true;
      try {
        e.turn = await turns.start(e.options);
        // everything a model's turn does goes to the comparison's listeners, tagged with the model
        turns.listen(e.turn, ev => { notify(c, e, ev); if (ev.event === 'done' || ev.event === 'error') pump(c); });
        notify(c, e, { event: 'status', data: { status: e.turn.status } });
      } catch (err) {
        if (err.code !== 'too_many_runs' || !c.entries.some(x => x.turn && ACTIVE.has(x.turn.status))) e.error = { code: err.code || 'send_failed', message: err.message };
      } finally { e.starting = false; }
      if (e.error) notify(c, e, { event: 'error', data: { status: 'error', error: e.error } });
    }
    if (done(c)) for (const l of c.listeners) l({ event: 'all_done' });
  }
  function notify(c, e, ev) {
    for (const l of c.listeners) l({ event: ev.event, data: { model: e.model, ...(ev.data || {}) } });
    for (const w of [...c.waiters]) if (done(c)) w();
  }
  const waitAll = (c, ms) => (done(c) || ms <= 0 ? Promise.resolve() : new Promise(resolve => {
    const t = setTimeout(end, ms);
    function end() { clearTimeout(t); c.waiters.delete(end); resolve(); }
    c.waiters.add(end);
  }));

  route('POST', '/compare', 'chat', async (req, res, ctx) => {
    const b = await api.readBody(req, 72 * 1024 * 1024);
    const k = ctx.key;
    const list = Array.isArray(b.models) ? b.models.map(m => (typeof m === 'string' ? { model: m } : { model: m?.model, effort: m?.effort })) : [];
    if (list.length < 2 || list.length > 3 || list.some(m => !m.model)) throw apiErr(400, 'invalid_request', '"models" lists 2 or 3 models, e.g. ["opus", {"model": "haiku", "effort": "low"}].');
    if (b.tools === 'all') throw apiErr(400, 'invalid_request', 'Comparing can\'t change files: use "tools": "none" (the default) or "readOnly".');
    if (turns.active(k.id).length + list.length > k.maxTurns) { const e = apiErr(429, 'too_many_turns', `Comparing ${list.length} models needs ${list.length} turns at once; this key may run ${k.maxTurns}.`); e.retryAfter = 10; throw e; }
    const target = b.session ? await api.targets.sessionTarget(k, String(b.session)) : await api.targets.newTarget(k, { project: b.project });
    const entries = [];
    for (const m of list) {
      const options = await api.prepare(ctx, { ...b, model: m.model, effort: m.effort, tools: b.tools || 'none' }, { target, fork: !!b.session, save: false });
      entries.push({ model: m.model, effort: options.effort, options });
    }
    const c = { id: 'cmp_' + crypto.randomBytes(12).toString('base64url'), keyId: k.id, prompt: String(b.prompt || ''), createdAt: Date.now(), entries, listeners: new Set(), waiters: new Set() };
    comparisons.set(c.id, c);
    setTimeout(() => comparisons.delete(c.id), 24 * 3600e3).unref?.();
    await pump(c);
    if (entries.every(e => e.error)) throw apiErr(entries[0].error.code === 'too_many_runs' ? 429 : 502, entries[0].error.code, entries[0].error.message);
    if (b.stream === true) return stream(req, res, c);
    await waitAll(c, Math.min(Math.max(0, Number(b.wait ?? 60)), 90) * 1000);
    send(res, c);
  });

  route('GET', '/compare/([A-Za-z0-9_-]{6,60})', 'read', async (req, res, ctx, m) => {
    const c = comparisons.get(m[1]);
    if (!c || c.keyId !== ctx.key.id) throw apiErr(404, 'comparison_not_found', 'No such comparison (they are kept for 24 hours).');
    await waitAll(c, Math.min(Math.max(0, Number(ctx.url.searchParams.get('wait') ?? 60)), 90) * 1000);
    send(res, c);
  });

  function send(res, c) {
    const v = view(c);
    if (v.status === 'running') res.setHeader('Location', `${API_PREFIX}/compare/${c.id}`);
    json(res, v.status === 'running' ? 202 : 200, v);
  }
  // every model's events, each tagged with its model, then all_done
  function stream(req, res, c) {
    sse(res);
    res.write(`event: comparison\ndata: ${JSON.stringify(view(c))}\n\n`);
    const write = ev => {
      if (ev.event === 'all_done') { res.write(`event: all_done\ndata: ${JSON.stringify(view(c))}\n\n`); end(); return; }
      res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    };
    // what happened before this stream joined, then live
    for (const e of c.entries) for (const ev of e.turn?.events || []) write({ event: ev.event, data: { model: e.model, ...(ev.data || {}) } });
    c.listeners.add(write);
    const hb = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 15e3);
    function end() { clearInterval(hb); c.listeners.delete(write); if (!res.writableEnded) res.end(); }
    req.on('close', end);
    if (done(c)) write({ event: 'all_done' });
  }
}
