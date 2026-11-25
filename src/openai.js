// An OpenAI-compatible endpoint: POST /api/v1/chat/completions (and GET /api/v1/models, in api.js),
// so chat apps and the OpenAI SDKs work with base URL https://<host>/api/v1 and a Handoff key.
//
// Which session a request continues:
//   - X-Handoff-Session: <id> | new (or metadata.handoff_session); the project from X-Handoff-Project
//   - otherwise by its last assistant message: Handoff remembers a hash of every reply it gave and
//     the session it came from, so a chat app that resends the whole history continues that session
//     with just the new message. Anything else (an edited or regenerated chat) starts a new session,
//     with the earlier messages put into its first prompt. System messages don't count (they often
//     change every time), and become `system` on a new session.
// A request repeated while its turn is still going (the SDK retries one that seems to hang) joins
// that turn instead of sending the prompt again.
//
// Replies: without streaming, headers go out after 20 s and spaces follow every 15 s (spaces before
// JSON are still JSON), so Cloudflare doesn't cut a long answer; with streaming, chunks then [DONE],
// keep-alives as SSE comments only. Claude's steps go out as reasoning_content.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { ACTIVE } from './turns.js';
import { apiErr, sendError } from './api-util.js';
import { UUID_RE } from './store.js';

const FILE = path.join(DATA_DIR, 'api-conversations.json');
const KEEP = 2000;
const hash = s => crypto.createHash('sha256').update(String(s).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 32);
const EFFORT = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
const oaiErr = (status, code, message, param) => apiErr(status, code, message, { type: status === 401 ? 'authentication_error' : 'invalid_request_error', param: param || null });

// message content (a string, or parts) -> { text, images, files }
function partsOf(content, role) {
  if (typeof content === 'string') return { text: content, images: [], files: [] };
  if (!Array.isArray(content)) return { text: '', images: [], files: [] };
  const out = { text: '', images: [], files: [] };
  for (const p of content) {
    if (p?.type === 'text' || p?.type === 'input_text') out.text += (out.text ? '\n' : '') + String(p.text || '');
    else if (p?.type === 'image_url' && role === 'user') {
      const url = String(p.image_url?.url || p.image_url || '');
      const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
      if (!m) throw oaiErr(400, 'image_url_not_data', 'Images must be data: URLs; Handoff doesn\'t fetch addresses.', 'messages');
      out.images.push({ media_type: m[1].toLowerCase(), data: m[2] });
    } else if (p?.type === 'file' && role === 'user') {
      const f = p.file || {};
      out.files.push({ name: String(f.filename || 'file'), data: String(f.file_data || '').replace(/^data:[^;,]*;base64,/, '') });
    } else if (p?.type === 'input_audio') throw oaiErr(400, 'audio_not_supported', 'Audio isn\'t supported yet: send text.', 'messages');
  }
  return out;
}

export function addOpenAI(api, core) {
  const { keys } = core;
  const { route, turns } = api;
  // reply hash -> session, and each session's latest reply hash
  let conv = { replies: {}, latest: {} };
  try { conv = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* none yet */ }
  let writeTimer = null;
  const save = () => {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      const ids = Object.keys(conv.replies);
      if (ids.length > KEEP) for (const h of ids.slice(0, ids.length - KEEP)) delete conv.replies[h];
      try { fs.writeFileSync(FILE, JSON.stringify(conv), { mode: 0o600 }); } catch { /* kept in memory */ }
    }, 1000);
    writeTimer.unref?.();
  };
  const remember = (keyId, sessionId, reply) => {
    if (!sessionId || !reply) return;
    const h = hash(reply);
    conv.replies[h] = { sessionId, keyId, at: Date.now() };
    conv.latest[sessionId] = h;
    save();
  };
  const recent = new Map(); // repeats of a request -> the turn already answering it

  route('POST', '/chat/completions', 'chat', async (req, res, ctx) => {
    const b = await api.readBody(req, 72 * 1024 * 1024);
    const k = ctx.key;
    if ((Array.isArray(b.tools) && b.tools.length) || (Array.isArray(b.functions) && b.functions.length)) {
      throw oaiErr(400, 'tools_not_supported', 'Function calling isn\'t supported: Claude Code uses its own tools on the computer.', 'tools');
    }
    if (b.n != null && Number(b.n) !== 1) throw oaiErr(400, 'n_not_supported', 'Only one answer per request (n: 1).', 'n');
    const messages = Array.isArray(b.messages) ? b.messages : [];
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user') throw oaiErr(400, 'invalid_messages', '"messages" must end with a user message.', 'messages');
    const meta = b.metadata && typeof b.metadata === 'object' ? b.metadata : {};
    const hdr = name => String(req.headers[name] || '').trim();
    const sessionSpec = hdr('x-handoff-session') || meta.handoff_session || '';
    const project = hdr('x-handoff-project') || meta.handoff_project || '';
    const system = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => partsOf(m.content, m.role).text).filter(Boolean).join('\n\n');
    const convo = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    const lastAssistant = [...convo].reverse().find(m => m.role === 'assistant');
    const now = partsOf(last.content, 'user');

    // a repeat of a request still being answered joins it
    const repeatKey = `${k.id}:${hash([sessionSpec, lastAssistant ? hash(partsOf(lastAssistant.content).text) : '', now.text, now.images.length, now.files.length].join('|'))}`;
    const prev = recent.get(repeatKey);
    if (prev && Date.now() - prev.at < 30 * 60e3) {
      const t = await prev.turn.catch(() => null); // it may still be starting
      if (t && (ACTIVE.has(t.status) || Date.now() - t.endedAt < 60e3)) return reply(req, res, ctx, t, b);
    }
    // noted before anything is awaited, so a repeat arriving while this one starts joins it
    const starting = start();
    starting.catch(() => {});
    recent.set(repeatKey, { at: Date.now(), turn: starting });
    if (recent.size > 1000) recent.delete(recent.keys().next().value);
    let t;
    try { t = await starting; } catch (e) { recent.delete(repeatKey); throw e; }
    const off = turns.listen(t, ev => { if (ev.event === 'done') { off(); remember(k.id, t.save ? t.sessionId : null, answerOf(t)); } });
    if (!ACTIVE.has(t.status)) { off(); if (t.status === 'done') remember(k.id, t.sessionId, answerOf(t)); }
    return reply(req, res, ctx, t, b);

    async function start() {
    // where it goes
    let target, history = '';
    if (sessionSpec && sessionSpec !== 'new') {
      if (!UUID_RE.test(sessionSpec)) throw oaiErr(400, 'invalid_session', 'X-Handoff-Session is a session id, or "new".');
      target = await api.targets.sessionTarget(k, sessionSpec);
    } else {
      const known = !sessionSpec && lastAssistant ? conv.replies[hash(partsOf(lastAssistant.content).text)] : null;
      if (known && known.keyId === k.id && conv.latest[known.sessionId] === hash(partsOf(lastAssistant.content).text)) {
        try { target = await api.targets.sessionTarget(k, known.sessionId); } catch { target = null; }
      }
      if (!target) {
        target = await api.targets.newTarget(k, { project });
        const earlier = convo.slice(0, -1);
        if (earlier.length) history = 'Earlier in this conversation:\n\n' + earlier.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${partsOf(m.content, m.role).text}`).join('\n\n') + '\n\nNow:\n';
      }
    }
    const body = {
      prompt: history + now.text, images: now.images, files: now.files.length ? now.files : undefined,
      model: b.model, effort: b.reasoning_effort ? EFFORT[b.reasoning_effort] : undefined,
      language: hdr('x-handoff-language') || meta.handoff_language || undefined, length: hdr('x-handoff-length') || meta.handoff_length || undefined
    };
    if (target.kind === 'new') {
      if (system) body.system = system;
      const rf = b.response_format;
      if (rf?.type === 'json_schema' && rf.json_schema?.schema) body.schema = rf.json_schema.schema;
    }
    if (b.reasoning_effort && !EFFORT[b.reasoning_effort]) throw oaiErr(400, 'invalid_effort', `reasoning_effort is one of ${Object.keys(EFFORT).join(', ')}.`, 'reasoning_effort');
    return api.startTurn(await api.prepare(ctx, body, { target }));
    }
  });

  // every text block of the turn, the same with or without streaming
  const answerOf = t => (t.messages.length ? t.messages.join('\n\n') : t.text) || '';
  const created = t => Math.floor(t.createdAt / 1000);
  const usageOf = t => {
    const u = t.usage || {};
    const prompt = (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
    return { prompt_tokens: prompt, completion_tokens: u.outputTokens || 0, total_tokens: prompt + (u.outputTokens || 0) };
  };
  const extra = t => ({ handoff: { turnId: t.id, sessionId: t.save ? t.sessionId : null, status: t.status, costUsd: t.usage?.costUsd ?? null, warnings: t.warnings, error: t.error, webUrl: api.webUrl(t.sessionId) } });
  const modelOf = (t, b) => t.model || b.model || 'default';

  async function reply(req, res, ctx, t, b) {
    if (b.stream) return stream(req, res, t, b);
    // a short wait with nothing sent, so quick answers and early errors get a normal reply
    await turns.wait(t, 20e3);
    if (!ACTIVE.has(t.status) && t.status === 'error' && !t.messages.length) {
      return sendError(res, oaiErr(t.error?.code === 'claude_limit' ? 429 : 502, t.error?.code || 'claude_error', t.error?.message || 'Claude stopped with an error.'));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache, no-store, no-transform', 'Content-Encoding': 'identity' });
    // spaces before the JSON keep the connection alive (they are valid JSON whitespace)
    const ka = setInterval(() => res.write(' '), 15e3);
    req.on('close', () => clearInterval(ka));
    await turns.wait(t, 4 * 3600e3);
    clearInterval(ka);
    const content = t.status === 'error' ? `⚠️ ${t.error?.message || 'Claude stopped with an error.'}${answerOf(t) ? '\n\n' + answerOf(t) : ''}` : answerOf(t);
    res.end(JSON.stringify({
      id: `chatcmpl-${t.id}`, object: 'chat.completion', created: created(t), model: modelOf(t, b),
      choices: [{ index: 0, message: { role: 'assistant', content, ...(t.json ? { parsed: t.json } : {}) }, finish_reason: t.status === 'interrupted' ? 'length' : 'stop' }],
      usage: usageOf(t), ...extra(t)
    }));
  }

  function stream(req, res, t, b) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store, no-transform', 'Content-Encoding': 'identity', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`:${' '.repeat(2048)}\n\n`); // a comment, to push the first bytes through any proxy buffer
    const base = { id: `chatcmpl-${t.id}`, object: 'chat.completion.chunk', created: created(t), model: modelOf(t, b) };
    const chunk = (delta, finish = null, more = {}) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...more })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    let pieces = false, blocks = 0, ka = null, off = () => {};
    const onEvent = ev => {
      if (ev.event === 'text') { chunk({ content: (pieces || !blocks ? '' : '\n\n') + ev.data.text }); pieces = true; }
      else if (ev.event === 'message') {
        // the block is complete: if it came in pieces it's been sent; otherwise send it whole
        if (!pieces) chunk({ content: (blocks ? '\n\n' : '') + ev.data.text });
        pieces = false; blocks++;
      } else if (ev.event === 'tool') chunk({ reasoning_content: `• ${ev.data.tool}${ev.data.summary ? ': ' + ev.data.summary : ''}\n` });
      else if (ev.event === 'approval') chunk({ reasoning_content: `Waiting for your approval on your phone: ${ev.data.tool}${ev.data.input ? ' ' + String(ev.data.input).replace(/\s+/g, ' ').slice(0, 120) : ''}\n` });
      else if (ev.event === 'done' || ev.event === 'error') {
        if (t.status === 'error') chunk({ content: `${blocks ? '\n\n' : ''}⚠️ ${t.error?.message || 'Claude stopped with an error.'}` });
        chunk({}, t.status === 'interrupted' ? 'length' : 'stop', extra(t));
        if (b.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: usageOf(t) })}\n\n`);
        res.write('data: [DONE]\n\n');
        clearInterval(ka); off(); res.end();
      }
    };
    for (const ev of t.events) onEvent(ev);
    if (res.writableEnded) return;
    ka = setInterval(() => res.write(': keep-alive\n\n'), 15e3);
    off = turns.listen(t, onEvent);
    req.on('close', () => { clearInterval(ka); off(); });
  }
}
