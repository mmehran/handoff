// Turns: one prompt sent through the API, and Claude's answer to it.
//
// A turn goes to one of three places:
//   - a process Handoff runs (new session, fork, or a session it resumes): through the Runner, which
//     starts API processes with --replay-user-messages, so Claude Code echoes each prompt back with
//     the id given here; the first `result` after that echo is this prompt's answer
//   - a session open on the computer (Claude Desktop / a terminal): through its inbox, the answer read
//     from its transcript, finished once the session's registry status is idle again
//   - a queue, while the session's process is busy with something else (one turn at a time each)
// Turns live in memory for 24 hours; a short note about each is kept on disk (KeyStore.noteTurn).
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { injectMessage } from './inbox.js';
import { tailFile, toolSummary } from './store.js';

export const ACTIVE = new Set(['queued', 'running', 'waiting_for_approval', 'waiting_for_answer']);
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const KEEP_MS = 24 * 3600e3, KEEP_MAX = 500, EVENTS_MAX = 4000;
const iso = t => (t ? new Date(t).toISOString() : null);

// What a failed answer means, in words a person can act on
export function classifyError(text) {
  const t = String(text || '');
  if (/not logged in|please run \/login|failed to authenticate|invalid bearer token|oauth/i.test(t)) {
    return { code: 'claude_signed_out', message: 'Claude Code on the computer isn\'t signed in. Run `claude setup-token` there, put the token in Handoff\'s .env as CLAUDE_CODE_OAUTH_TOKEN, restart Handoff, and try again.', detail: t.slice(0, 300) };
  }
  if (/usage limit|hit your limit|limit reached|rate.?limit/i.test(t)) {
    const m = /resets?\s+(?:at\s+)?([^\n|·]+)/i.exec(t);
    return { code: 'claude_limit', message: `Your Claude plan's usage limit was reached.${m ? ` It resets ${m[1].trim()}.` : ''}`, resetsAt: m ? m[1].trim() : null, detail: t.slice(0, 300) };
  }
  return { code: 'claude_error', message: t.slice(0, 500) || 'Claude stopped with an error.' };
}

// Markdown to plain text, for voice and short messages: the words stay, the marks go
export function stripMarkdown(s) {
  return String(s || '')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
    .replace(/^\s*\|(.*)\|\s*$/gm, (m, row) => row.split('|').map(c => c.trim()).join(', '))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '- ')
    .replace(/^\s*[*+]\s+/gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class TurnManager extends EventEmitter {
  // webUrl(sessionId): the chat in the web app, or null
  constructor(core, { webUrl = () => null } = {}) {
    super();
    this.core = core;
    this.webUrl = webUrl;
    this.turns = new Map();    // id -> turn
    this.queues = new Map();   // sessionId -> turns waiting for that session to be free
    this.byRun = new Map();    // runId -> turns sent into that process, not finished yet
    this.laptop = new Map();   // sessionId -> the turn being answered by a session open on the computer
    this.pumping = new Set();
    const r = core.runner;
    r.on('replay', (run, m) => this.onReplay(run, m));
    r.on('partial', (run, m) => this.onPartial(run, m));
    r.on('run_message', (run, m) => this.onMessage(run, m));
    r.on('permission', p => this.onPermission(p));
    r.on('permission_resolved', p => this.onPermissionResolved(p));
    r.on('result', (run, res) => this.onResult(run, res));
    r.on('run', pub => {
      if (pub.status === 'exited') this.onExit(pub);
      if (pub.sessionId) this.pump(pub.sessionId);
    });
    this.sweeper = setInterval(() => this.sweep(), 10 * 60e3);
    this.sweeper.unref?.();
  }

  get(id) { return this.turns.get(id) || null; }
  active(keyId) { return [...this.turns.values()].filter(t => t.keyId === keyId && ACTIVE.has(t.status)); }
  ofKey(keyId) { return [...this.turns.values()].filter(t => t.keyId === keyId); }

  // o: { key, ip, target: { kind: 'new' | 'session', sessionId?, cwd }, fork, save, content, laptopText,
  //      prompt, model, effort, mode, modeGiven, api: { tools, system, schema, maxBudgetUsd, deny },
  //      ifBusy, ifLaptop, timeout (s), plain, webhook, warnings, restricted }
  // Resolves with the turn once it is queued or sent. A problem sending it right away (too many
  // processes, a busy session with ifBusy: fail, ...) is thrown, and no turn is kept.
  async start(o) {
    const t = {
      id: 'turn_' + crypto.randomBytes(12).toString('base64url'),
      key: o.key, keyId: o.key.id, keyName: o.key.name, ip: o.ip,
      target: o.target, sessionId: o.target.sessionId || null, cwd: o.target.cwd, fork: !!o.fork, save: o.save !== false,
      content: o.content, laptopText: o.laptopText, prompt: String(o.prompt || ''),
      model: o.model, effort: o.effort, mode: o.mode, modeGiven: !!o.modeGiven, api: o.api || { tools: 'all' },
      ifBusy: o.ifBusy || 'queue', ifLaptop: o.ifLaptop || 'send', timeout: o.timeout || null, plain: !!o.plain, webhook: o.webhook || null,
      restricted: !!o.restricted, wantsAlerts: !!o.key.alerts,
      status: 'queued', createdAt: Date.now(), startedAt: null, endedAt: null, delivered: null,
      text: '', messages: [], json: null, usage: null, steps: [], filesChanged: new Set(), pending: null,
      warnings: [...(o.warnings || [])], error: null, queue: null,
      uuid: crypto.randomUUID(), runId: null, replayed: false, events: [], seq: 0, listeners: new Set()
    };
    this.turns.set(t.id, t);
    t.starting = true; // problems while this request is still waiting are thrown back to it
    if (t.target.kind === 'session' && !t.fork) {
      const q = this.queues.get(t.sessionId) || [];
      q.push(t);
      this.queues.set(t.sessionId, q);
      await this.pump(t.sessionId);
      if (t.status === 'queued') this.positions(t.sessionId);
    } else {
      try { await this.dispatch(t); } catch (e) { t.dispatchError = e; }
    }
    t.starting = false;
    if (t.dispatchError) { this.turns.delete(t.id); throw t.dispatchError; }
    this.note(t);
    if (t.timeout) { t.timer = setTimeout(() => this.cancel(t, `timed out after ${t.timeout} s`), t.timeout * 1000); t.timer.unref?.(); }
    return t;
  }

  // Is the session busy with something else? (its process mid-turn, or a turn on the computer)
  async busy(sessionId) {
    const run = this.core.runner.bySession(sessionId);
    if (run) return !this.core.runner.isIdle(run) || (this.byRun.get(run.runId) || []).some(t => ACTIVE.has(t.status));
    return this.laptop.has(sessionId);
  }

  // Start the next queued turns of a session, while it's free
  async pump(sessionId) {
    const q = this.queues.get(sessionId);
    if (!q?.length || this.pumping.has(sessionId)) return;
    this.pumping.add(sessionId);
    try {
      while (q.length) {
        const t = q[0];
        if (t.status !== 'queued') { q.shift(); continue; }
        if (await this.busy(sessionId)) {
          if (t.ifBusy === 'fail') {
            q.shift();
            const e = Object.assign(new Error('That session is busy with something else. Send with "ifBusy": "queue" to wait, or "interrupt" to stop it.'), { status: 409, code: 'session_busy' });
            if (t.starting) t.dispatchError = e; else this.finish(t, { status: 'error', error: { code: 'session_busy', message: e.message } });
            continue;
          }
          if (t.ifBusy === 'interrupt' && !t.interruptSent) { t.interruptSent = true; this.core.runner.interrupt(sessionId); }
          break;
        }
        q.shift();
        try { await this.dispatch(t); }
        catch (e) {
          if (t.starting) t.dispatchError = e;
          else this.finish(t, { status: 'error', error: { code: e.code || 'send_failed', message: e.message } });
        }
      }
      if (!q.length) this.queues.delete(sessionId);
      else this.positions(sessionId);
    } finally { this.pumping.delete(sessionId); }
  }
  positions(sessionId) {
    (this.queues.get(sessionId) || []).forEach((t, i) => { if (t.queue?.ahead !== i + 1) { t.queue = { ahead: i + 1 }; this.event(t, 'status'); } });
  }

  async dispatch(t) {
    const { runner, store, keys } = this.core;
    t.queue = null;
    if (t.target.kind === 'session' && !t.fork) {
      const run = runner.bySession(t.sessionId);
      const info = run ? null : await store.sessionInfo(t.sessionId);
      if (!run && info?.live) {
        if (t.ifLaptop === 'fork' || t.restricted) {
          t.fork = true;
          if (t.restricted) t.warnings.push('This key is limited, so it answered in a copy of the session open on the computer, which is left as it is.');
        } else return this.toLaptop(t, info.live);
      } else if (t.restricted && keys.sessionKey(t.sessionId)?.keyId !== t.keyId) {
        // A limited key never writes into a session it didn't start: it answers in its own copy, and
        // keeps using that copy next time, so the conversation goes on there.
        const own = keys.forkFor(t.keyId, t.sessionId);
        if (own && await store.sessionFile(own)) {
          t.forkOf = t.sessionId;
          t.sessionId = own;
          t.warnings.push('This key is limited, so it continues its own copy of the session; the original is left as it is.');
          const ownRun = runner.bySession(own);
          if (ownRun && !runner.isIdle(ownRun)) { const q = this.queues.get(own) || []; q.push(t); this.queues.set(own, q); t.status = 'queued'; this.positions(own); return; }
        } else {
          t.fork = true;
          t.forkOf = t.sessionId;
          t.warnings.push('This key is limited, so it answered in its own copy of the session; the original is left as it is.');
        }
      }
    }
    t.status = 'running';
    t.startedAt = Date.now();
    t.delivered = t.fork ? 'fork' : t.target.kind === 'new' ? 'new' : 'handoff';
    this.event(t, 'status');
    const r = await runner.send({
      sessionId: t.target.kind === 'session' ? (t.fork ? t.target.sessionId : t.sessionId) : undefined, cwd: t.cwd, content: t.content,
      mode: t.mode, model: t.model, effort: t.effort, fork: t.fork, uuid: t.uuid,
      api: { keyId: t.keyId, keyName: t.keyName, alerts: t.wantsAlerts, ...t.api, save: t.save },
      onRun: run => this.attach(t, run)
    });
    t.sessionId = r.sessionId;
    if (t.save && (t.target.kind === 'new' || t.fork)) keys.markSession(r.sessionId, t.key, { forkOf: t.forkOf || (t.fork ? t.target.sessionId : null) });
    t.noted = true;
    this.note(t);
    this.event(t, 'status');
  }

  attach(t, run) {
    t.runId = run.runId;
    t.run = run;
    const list = this.byRun.get(run.runId) || [];
    list.push(t);
    this.byRun.set(run.runId, list);
    // a process that doesn't echo prompts (one the web app started): the next answer is this one's
    if (!run.replay) t.replayed = true;
  }
  // the turn being answered right now in a process
  current(run) { return (this.byRun.get(run.runId) || []).find(t => t.replayed && ACTIVE.has(t.status)) || null; }

  onReplay(run, m) {
    const t = (this.byRun.get(run.runId) || []).find(x => x.uuid === m.uuid);
    if (t) t.replayed = true;
  }
  onPartial(run, m) {
    const t = this.current(run);
    const d = m.event?.delta;
    if (t && m.event?.type === 'content_block_delta' && d?.type === 'text_delta' && d.text) this.event(t, 'text', { text: d.text });
  }
  onMessage(run, m) {
    if (m.isReplay) return;
    const t = this.current(run);
    if (t) this.record(t, m);
  }
  // an assistant or tool-result message, from a process or a transcript
  record(t, m) {
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    if (m.type === 'assistant') {
      for (const b of content) {
        if (b.type === 'text' && b.text?.trim()) { t.messages.push(b.text); this.event(t, 'message', { text: b.text }); }
        else if (b.type === 'tool_use') {
          const step = { tool: b.name, summary: toolSummary(b.name, b.input), id: b.id };
          t.steps.push(step);
          if (FILE_TOOLS.has(b.name) && b.input?.file_path) {
            const f = String(b.input.file_path || b.input.notebook_path || '');
            t.filesChanged.add(path.isAbsolute(f) && t.cwd ? path.relative(t.cwd, f).replace(/\\/g, '/') : f);
          }
          this.event(t, 'tool', step);
        }
      }
    } else if (m.type === 'user') {
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(x => x.text || `[${x.type}]`).join('\n') : '';
        this.event(t, 'tool_result', { id: b.tool_use_id, isError: !!b.is_error, text: text.slice(0, 500) });
      }
    }
  }
  onPermission(p) {
    const t = [...(this.byRun.get(p.runId) || [])].find(x => ACTIVE.has(x.status));
    if (!t) return;
    t.status = 'waiting_for_approval';
    t.pending = { type: 'approval', id: p.id, tool: p.tool, input: p.input, ...(p.plan ? { plan: p.plan } : {}) };
    this.event(t, 'approval', t.pending);
    this.event(t, 'status');
  }
  onPermissionResolved(p) {
    for (const t of this.turns.values()) {
      if (t.pending?.id !== p.id) continue;
      t.pending = null;
      if (t.status === 'waiting_for_approval') t.status = 'running';
      this.event(t, 'status');
    }
  }
  onResult(run, res) {
    const list = this.byRun.get(run.runId) || [];
    const answered = list.filter(t => t.replayed && ACTIVE.has(t.status));
    if (!answered.length) return;
    this.byRun.set(run.runId, list.filter(t => !answered.includes(t)));
    const u = res.usage || {};
    answered.forEach((t, i) => {
      if (answered.length > 1) t.warnings.push(`${answered.length} prompts sent close together were answered together.`);
      t.text = res.text || t.messages.at(-1) || '';
      if (t.api.schema) { t.json = res.structured ?? (() => { try { return JSON.parse(res.text); } catch { return null; } })(); }
      t.usage = { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, cacheReadTokens: u.cache_read_input_tokens || 0, cacheWriteTokens: u.cache_creation_input_tokens || 0, costUsd: i === 0 ? res.costUsd || 0 : 0 };
      this.core.keys.addUsage(t.keyId, { costUsd: t.usage.costUsd, inputTokens: t.usage.inputTokens, outputTokens: t.usage.outputTokens });
      if (res.isError && (res.subtype === 'error_during_execution' || t.interrupted)) this.finish(t, { status: 'interrupted' });
      else if (res.isError) this.finish(t, { status: 'error', error: classifyError(res.text) });
      else { this.core.claudeSignedIn = true; this.finish(t, { status: 'done' }); }
    });
  }
  onExit(pub) {
    for (const t of this.byRun.get(pub.runId) || []) {
      if (!ACTIVE.has(t.status)) continue;
      if (t.interrupted) this.finish(t, { status: 'interrupted' });
      else this.finish(t, { status: 'error', error: pub.lastError ? classifyError(pub.lastError) : { code: 'claude_exited', message: 'Claude\'s process ended before answering.' } });
    }
    this.byRun.delete(pub.runId);
  }

  // A session open on the computer: the prompt goes in through its inbox; the answer is read from
  // its transcript once its own message shows up there, and the turn ends when the session's
  // registry says idle again.
  async toLaptop(t, live) {
    const { cfg, store, notifier } = this.core;
    t.status = 'running';
    t.startedAt = Date.now();
    t.delivered = 'laptop';
    if (t.model || t.effort || t.modeGiven || t.api.tools !== 'all') t.warnings.push('Model, effort, mode and tools can\'t be changed for a session open on the computer, so they were left as they are there.');
    this.laptop.set(t.sessionId, t);
    if (!t.wantsAlerts) notifier.quietDone(t.sessionId, 12 * 3600e3);
    const file = await store.sessionFile(t.sessionId);
    let from = 0;
    try { from = file ? (await fsp.stat(file)).size : 0; } catch { /* new */ }
    try {
      await injectMessage(cfg.claudeHome, live, t.laptopText || t.prompt);
    } catch (e) {
      this.laptop.delete(t.sessionId);
      throw e;
    }
    t.noted = true;
    this.note(t);
    this.event(t, 'status');
    let sawPeer = false, sawReply = false;
    const stop = file ? tailFile(file, from, o => {
      if (!sawPeer) { if (o.type === 'user' && o.isMeta && o.origin?.kind === 'peer') sawPeer = true; return; }
      if (o.type === 'assistant') sawReply = true;
      if (!ACTIVE.has(t.status)) return;
      this.record(t, o);
      const last = (o.message?.content || []).filter?.(b => b.type === 'text' && b.text?.trim()).pop();
      if (o.type === 'assistant' && last) t.text = last.text;
    }) : null;
    const poll = setInterval(async () => {
      if (!ACTIVE.has(t.status)) return done();
      const l = (await store.liveSessions().catch(() => [])).find(x => x.sessionId === t.sessionId);
      if (!l) return this.finish(t, sawReply ? { status: 'done' } : { status: 'error', error: { code: 'laptop_closed', message: 'The session open on the computer was closed before it answered.' } });
      if (l.status === 'waiting' && sawPeer) {
        const q = await store.pendingQuestion(t.sessionId).catch(() => null);
        const next = q ? 'waiting_for_answer' : 'waiting_for_approval';
        if (t.status !== next) {
          t.status = next;
          t.pending = q ? { type: 'question', questions: q.questions, where: 'laptop' } : { type: 'laptop', waitingFor: l.waitingFor || null, where: 'laptop' };
          this.event(t, 'status');
        }
      } else if (t.pending && l.status !== 'waiting') { t.pending = null; t.status = 'running'; this.event(t, 'status'); }
      if (sawPeer && sawReply && l.status === 'idle') this.finish(t, { status: 'done' });
      else if (!sawPeer && Date.now() - t.startedAt > 120e3 && !t.slowWarned) {
        t.slowWarned = true;
        t.warnings.push('The session open on the computer hasn\'t picked the message up yet (a question picker open there waits for Esc).');
        this.event(t, 'status');
      }
    }, 1000);
    poll.unref?.();
    const done = () => { clearInterval(poll); stop?.(); if (this.laptop.get(t.sessionId) === t) this.laptop.delete(t.sessionId); };
    t.cleanup = done;
  }

  // Cancel a queued turn, or interrupt the running one. Sessions open on the computer can't be
  // interrupted from here: the turn just stops waiting for them.
  cancel(t, why = 'cancelled') {
    if (!ACTIVE.has(t.status)) return false;
    t.warnings.push(why === 'cancelled' ? 'Cancelled.' : `Stopped: ${why}.`);
    if (t.status === 'queued') {
      const q = this.queues.get(t.sessionId);
      if (q) q.splice(q.indexOf(t), 1);
      this.finish(t, { status: 'interrupted' });
      this.positions(t.sessionId);
      return true;
    }
    if (t.delivered === 'laptop') {
      t.warnings.push('It may still be running on the computer.');
      this.finish(t, { status: 'interrupted' });
      return true;
    }
    t.interrupted = true;
    const run = t.run;
    if (run && run.status !== 'exited') {
      for (const id of [...run.pending]) this.core.runner.decide(id, { allow: false, message: 'Interrupted' });
      this.core.runner.control(run, { subtype: 'interrupt' });
    }
    return true;
  }
  // a session was stopped: its queued turns are cancelled too
  cancelQueued(sessionId) {
    for (const t of [...(this.queues.get(sessionId) || [])]) this.cancel(t, 'the session was stopped');
  }

  finish(t, { status, error = null }) {
    if (!ACTIVE.has(t.status) && t.endedAt) return;
    t.status = status;
    t.error = error;
    t.pending = null;
    t.queue = null;
    t.endedAt = Date.now();
    clearTimeout(t.timer);
    t.cleanup?.();
    if (t.runId) this.byRun.set(t.runId, (this.byRun.get(t.runId) || []).filter(x => x !== t));
    if (error?.code === 'claude_signed_out') this.core.claudeSignedIn = false;
    if (t.delivered === 'laptop' && !t.wantsAlerts) this.core.notifier.quietDone(t.sessionId, 60e3); // the alert for this turn may come a moment later
    this.note(t);
    this.event(t, status === 'error' ? 'error' : 'done', this.view(t));
    this.core.audit(t.ip, 'api_turn', {
      via: 'api', key: t.keyName, keyId: t.keyId, turnId: t.id, sessionId: t.save ? t.sessionId : undefined, turnStatus: status,
      model: t.model || undefined, costUsd: t.usage?.costUsd, ms: t.startedAt ? t.endedAt - t.startedAt : 0, error: error?.code, text: t.prompt.slice(0, 200)
    });
    this.emit('finished', t);
    if (t.sessionId) setImmediate(() => this.pump(t.sessionId));
  }

  // ----- what callers see -----
  view(t) {
    const text = t.plain ? stripMarkdown(t.text) : t.text;
    return {
      id: t.id, object: 'turn', sessionId: t.save ? t.sessionId : null, status: t.status,
      text, messages: t.plain ? t.messages.map(stripMarkdown) : t.messages, json: t.json,
      model: t.model || t.run?.model || 'default', effort: t.effort || t.run?.effort || null, mode: t.mode || null,
      delivered: t.delivered, usage: t.usage, durationMs: t.startedAt ? (t.endedAt || Date.now()) - t.startedAt : 0,
      steps: t.steps.map(({ tool, summary }) => ({ tool, summary })), filesChanged: [...t.filesChanged],
      pending: t.pending, warnings: t.warnings, queue: t.queue, error: t.error,
      webUrl: t.save ? this.webUrl(t.sessionId) : null,
      createdAt: iso(t.createdAt), startedAt: iso(t.startedAt), endedAt: iso(t.endedAt)
    };
  }

  // something happened: kept for streams that join late, and passed to everyone listening
  event(t, name, data) {
    const ev = { id: ++t.seq, event: name, data: data ?? (name === 'status' ? { status: t.status, queue: t.queue, pending: t.pending, warnings: t.warnings } : null) };
    t.events.push(ev);
    if (t.events.length > EVENTS_MAX) t.events.splice(0, t.events.length - EVENTS_MAX);
    for (const l of t.listeners) { try { l(ev); } catch { /* a closed stream */ } }
    if (name === 'status' || name === 'approval') this.emit('state', t, name);
  }
  listen(t, fn) { t.listeners.add(fn); return () => t.listeners.delete(fn); }

  // until the turn finishes (or, with change, until anything about it changes), at most ms
  wait(t, ms, { change = false } = {}) {
    if (!ACTIVE.has(t.status) || ms <= 0) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(end, ms);
      const off = this.listen(t, ev => { if (ev.event === 'done' || ev.event === 'error' || (change && (ev.event === 'status' || ev.event === 'approval'))) end(); });
      function end() { clearTimeout(timer); off(); resolve(); }
    });
  }

  note(t) {
    this.core.keys.noteTurn({ id: t.id, sessionId: t.save ? t.sessionId : null, keyId: t.keyId, status: t.status, createdAt: t.createdAt, prompt: t.prompt, usage: t.usage, endedAt: t.endedAt });
  }
  sweep() {
    const now = Date.now();
    for (const [id, t] of this.turns) if (!ACTIVE.has(t.status) && now - (t.endedAt || t.createdAt) > KEEP_MS) this.turns.delete(id);
    if (this.turns.size > KEEP_MAX) {
      const done = [...this.turns.values()].filter(t => !ACTIVE.has(t.status)).sort((a, b) => a.endedAt - b.endedAt);
      for (const t of done.slice(0, this.turns.size - KEEP_MAX)) this.turns.delete(t.id);
    }
  }
  stop() { clearInterval(this.sweeper); }
}
