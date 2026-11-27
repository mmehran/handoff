// Drives `claude -p` in bidirectional stream-json mode:
//  - user messages are written to stdin (never argv, so no shell/argument injection)
//  - tool permission prompts arrive as control_request/can_use_tool and are relayed to the phone
//  - one process per session stays alive between turns, reaped after idleKillMinutes
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageContent } from './attachments.js';

// same choices as Claude Desktop's mode menu ('manual' = Ask permissions; older configs say 'default')
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// the tools a "read only" API key's sessions get
export const READ_ONLY_TOOLS = 'Read,Glob,Grep,WebSearch,WebFetch';
// what a process was started with that a later prompt can't change; null for ordinary processes
const limitsOf = api => (api && (api.tools !== 'all' || api.system || api.schema || api.maxBudgetUsd || api.save === false)
  ? JSON.stringify([api.keyId, api.tools, api.system || '', api.schema || '', api.maxBudgetUsd || 0, api.save !== false]) : null);
const MODEL_RE = /^[A-Za-z0-9._\-[\]]{1,64}$/;
// used when the installed CLI can't be asked (e.g. not logged in)
const FALLBACK_MODELS = [
  { value: 'default', displayName: 'Default (recommended)', description: '', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAutoMode: true },
  { value: 'opus', displayName: 'Opus', description: '', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAutoMode: true },
  { value: 'sonnet', displayName: 'Sonnet', description: '', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAutoMode: true },
  { value: 'haiku', displayName: 'Haiku', description: '' }
];

export class Runner extends EventEmitter {
  constructor(cfg, claudePath) {
    super();
    this.cfg = cfg;
    this.claudePath = claudePath;
    this.runs = new Map();        // runId -> run
    this.permissions = new Map(); // permId -> {run, requestId, ...}
    // one-off processes (commit messages, limit checks): Claude Code lists them as running sessions
    // too, so alerts leave them out
    this.quietPids = new Set();
    this.reaper = setInterval(() => this.reap(), 30e3);
    this.reaper.unref?.();
  }

  bySession(sessionId) {
    for (const r of this.runs.values()) if (r.sessionId === sessionId && r.status !== 'exited') return r;
    return null;
  }

  normalizeMode(mode) { return !mode || mode === 'default' ? 'manual' : mode; }

  // Models (with their effort levels) exactly as the installed Claude Code reports them in its
  // initialize handshake — the same list Claude Desktop shows. Cached for 6 hours.
  async options() {
    if (this._opts && Date.now() - this._opts.at < 6 * 3600e3) return this._opts.value;
    if (!this._optsPending) this._optsPending = this.probeModels().finally(() => { this._optsPending = null; });
    const models = await this._optsPending;
    const value = { models: models?.length ? models : FALLBACK_MODELS, modes: PERMISSION_MODES, efforts: EFFORTS, fromCli: !!models?.length };
    this._opts = { at: models?.length ? Date.now() : Date.now() - 6 * 3600e3 + 60e3, value }; // retry a failed probe after 1 min
    return value;
  }

  probeModels() {
    return new Promise(resolve => {
      let cmd = this.claudePath, pre = [];
      if (/\.(c|m)?js$/i.test(cmd)) { pre = [cmd]; cmd = process.execPath; }
      const env = cleanEnv();
      if (this.cfg.claudeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.cfg.claudeOauthToken;
      let proc;
      try {
        proc = spawn(cmd, [...pre, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'],
          { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      } catch { return resolve(null); }
      const done = v => { clearTimeout(timer); try { proc.kill(); } catch { /* gone */ } resolve(v); };
      const timer = setTimeout(() => done(null), 30e3);
      let buf = '';
      proc.on('error', () => done(null));
      proc.stdout.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          try {
            const m = JSON.parse(line);
            if (m.type === 'control_response' && m.response?.request_id === 'probe') {
              const models = (m.response.response?.models || []).filter(x => MODEL_RE.test(x.value)).map(x => ({
                value: x.value, displayName: x.displayName || x.value, description: x.description || '',
                supportsEffort: !!x.supportsEffort, supportedEffortLevels: (x.supportedEffortLevels || []).filter(e => EFFORTS.includes(e)),
                supportsAutoMode: !!x.supportsAutoMode
              }));
              done(models);
            }
          } catch { /* not json */ }
        }
      });
      proc.stdin.on('error', () => {});
      proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'probe', request: { subtype: 'initialize', hooks: null } }) + '\n');
    });
  }

  // Can a new process start in this folder? (also checked before a worktree is made for it)
  // Idle processes the API started make room first, oldest first; the API may use all but one of the
  // places, so the web app always has room.
  checkStart(cwd, { api = false } = {}) {
    const max = this.cfg.maxConcurrentRuns;
    const active = () => [...this.runs.values()].filter(r => r.status !== 'exited' && !r.killed);
    const idleApi = () => active().filter(r => r.via && this.isIdle(r)).sort((a, b) => a.lastActivity - b.lastActivity);
    if (api) {
      const apiMax = Math.max(1, max - 1);
      while (active().filter(r => r.via).length >= apiMax && idleApi().length) this.kill(idleApi()[0]);
      if (active().filter(r => r.via).length >= apiMax) { const e = httpErr(429, `the API already runs ${apiMax} Claude process${apiMax === 1 ? '' : 'es'} (HANDOFF_MAX_RUNS keeps one for the web app); try again when one finishes`); e.code = 'too_many_runs'; e.retryAfter = 30; throw e; }
    }
    while (active().length >= max && idleApi().length) this.kill(idleApi()[0]);
    if (active().length >= max) { const e = httpErr(429, `too many running sessions (max ${max}); stop one first`); e.code = 'too_many_runs'; e.retryAfter = 30; throw e; }
    if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw httpErr(400, 'working directory does not exist');
    if (this.cfg.allowedRoots.length && !this.cfg.allowedRoots.some(root => isWithin(cwd, root))) throw httpErr(403, 'directory is outside allowedRoots');
  }

  // A one-off question to a quick model, answered as plain text (e.g. a commit message). No tools, no
  // settings files or hooks, nothing saved: it never shows up as a chat.
  async oneShot(prompt, { model = 'haiku', timeout = 90e3 } = {}) {
    const attempt = restricted => new Promise((resolve, reject) => {
      let cmd = this.claudePath, pre = [];
      if (/\.(c|m)?js$/i.test(cmd)) { pre = [cmd]; cmd = process.execPath; }
      const env = cleanEnv();
      if (this.cfg.claudeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.cfg.claudeOauthToken;
      const args = ['-p', '--output-format', 'text', '--no-session-persistence', '--tools', '', '--model', model, ...(restricted ? ['--restricted'] : [])];
      let proc;
      try { proc = spawn(cmd, [...pre, ...args], { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
      catch (e) { return reject(httpErr(500, `couldn't start Claude: ${e.message}`)); }
      let out = '', err = '';
      this.quiet(proc);
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } reject(httpErr(504, 'Claude took too long to answer')); }, timeout);
      proc.stdout.setEncoding('utf8').on('data', d => { out += d; });
      proc.stderr.setEncoding('utf8').on('data', d => { err = (err + d).slice(-2000); });
      proc.on('error', e => { clearTimeout(timer); reject(httpErr(500, `couldn't start Claude: ${e.message}`)); });
      proc.on('exit', code => {
        clearTimeout(timer);
        if (code === 0 && out.trim()) return resolve(out.trim());
        const why = (err.trim() || out.trim()).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
        const e = httpErr(502, `Claude couldn't answer${why ? `: ${why}` : ''}`);
        e.unknownOption = /unknown option/i.test(err);
        reject(e);
      });
      proc.stdin.on('error', () => {});
      proc.stdin.end(prompt);
    });
    // --restricted is newer than some installs: without it, --tools '' still leaves no tools
    return attempt(true).catch(e => (e.unknownOption ? attempt(false) : Promise.reject(e)));
  }

  quiet(proc) {
    if (!proc?.pid) return;
    this.quietPids.add(proc.pid);
    proc.on('exit', () => setTimeout(() => this.quietPids.delete(proc.pid), 60e3).unref?.());
  }

  // The plan's limits right now: the smallest possible request to the quickest model, only to read the
  // rate_limit_event Claude Code prints about it. Resolves to that event's info, or null.
  checkLimits({ timeout = 90e3 } = {}) {
    return new Promise((resolve, reject) => {
      let cmd = this.claudePath, pre = [];
      if (/\.(c|m)?js$/i.test(cmd)) { pre = [cmd]; cmd = process.execPath; }
      const env = cleanEnv();
      if (this.cfg.claudeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.cfg.claudeOauthToken;
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--tools', '', '--model', 'haiku'];
      let proc;
      try { proc = spawn(cmd, [...pre, ...args], { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
      catch (e) { return reject(httpErr(500, `couldn't start Claude: ${e.message}`)); }
      this.quiet(proc);
      let buf = '', info = null, error = '';
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, timeout);
      proc.stdout.setEncoding('utf8').on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.type === 'rate_limit_event' && m.rate_limit_info) { info = m.rate_limit_info; this.emit('rate_limit', info); }
          if (m.type === 'result' && m.is_error) error = String(m.result || m.subtype || 'error').slice(0, 300);
        }
      });
      proc.stderr.on('data', () => {});
      proc.on('error', e => { clearTimeout(timer); reject(httpErr(500, `couldn't start Claude: ${e.message}`)); });
      proc.on('exit', () => {
        clearTimeout(timer);
        if (!info && error) return reject(httpErr(502, `Claude couldn't answer: ${error}`));
        resolve(info);
      });
      proc.stdin.on('error', () => {});
      proc.stdin.end('Reply with OK.');
    });
  }

  publicRun(r) {
    return {
      runId: r.runId, sessionId: r.sessionId, cwd: r.cwd, status: r.status, mode: r.mode, model: r.model || 'default', effort: r.effort || null, startedAt: r.startedAt, lastActivity: r.lastActivity, lastError: r.lastError || null, pending: [...r.pending].length,
      // started from the API: by which key, and whether that key wants "finished" alerts
      via: r.via ? { keyId: r.via.keyId, keyName: r.via.keyName, alerts: !!r.via.alerts } : null, limited: !!r.limits
    };
  }
  // no turn running, nothing waiting to be answered, no prompt on its way
  isIdle(r) { return r.status === 'idle' && !r.pending.size && !r.writesInFlight; }

  // Which newer options this Claude Code has (read from `claude --help`, at most once a day), so an
  // older one keeps working, with fewer extras.
  async features() {
    if (this._features && Date.now() - this._features.at < 24 * 3600e3) return this._features.set;
    if (!this._featuresP) {
      this._featuresP = new Promise(resolve => {
        let cmd = this.claudePath, pre = [];
        if (/\.(c|m)?js$/i.test(cmd)) { pre = [cmd]; cmd = process.execPath; }
        let out = '', proc;
        try { proc = spawn(cmd, [...pre, '--help'], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch { return resolve(new Set()); }
        const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } resolve(new Set()); }, 15e3);
        proc.stdout.setEncoding('utf8').on('data', d => { out += d; });
        proc.on('error', () => { clearTimeout(timer); resolve(new Set()); });
        proc.on('exit', () => { clearTimeout(timer); resolve(new Set(out.match(/--[a-z][a-z-]+/g) || [])); });
      }).then(set => { this._features = { at: set.size ? Date.now() : Date.now() - 23.9 * 3600e3, set }; this._featuresP = null; return set; });
    }
    return this._featuresP;
  }

  // Stops our process and waits until it has really exited, so a new one can resume the same session
  // without two processes ever writing one transcript.
  async restart(run) {
    if (run.status === 'exited') return;
    await new Promise(res => { const t = setTimeout(res, 10e3); run.proc.once('exit', () => { clearTimeout(t); res(); }); this.kill(run); });
    if (run.proc.exitCode === null && run.proc.signalCode === null) throw httpErr(409, 'the session\'s previous Claude process hasn\'t stopped yet; try again in a moment');
  }
  list() { return [...this.runs.values()].filter(r => r.status !== 'exited').map(r => this.publicRun(r)); }
  pendingPermissions() { return [...this.permissions.values()].map(p => p.public); }

  validate({ mode, model, effort }) {
    if (mode && !PERMISSION_MODES.includes(mode)) throw httpErr(400, 'invalid permission mode');
    if (effort && !EFFORTS.includes(effort)) throw httpErr(400, 'invalid effort level');
    if (mode === 'bypassPermissions' && !this.cfg.allowBypassPermissions) throw httpErr(403, 'bypassPermissions is disabled in config');
    if (model && !MODEL_RE.test(model)) throw httpErr(400, 'invalid model');
  }

  // Send a message to a session: reuse our live process, or spawn one (new / resume in place / fork).
  // images: checked photos ({ media_type, data }) sent along as image blocks
  // content: ready-made content blocks instead of text + images (the API: photos, documents)
  // api: a prompt from the API: { keyId, keyName, alerts, tools, system, schema, maxBudgetUsd, save, deny }
  // uuid: the prompt's id, echoed back by Claude Code so its answer can be matched to it
  // onRun(run): called with the process before the prompt is written, so nothing it says is missed
  async send({ sessionId, cwd, text, content, mode, model, effort, fork, images = [], api = null, uuid, onRun }) {
    if (!content) {
      if (typeof text !== 'string' || (!text.trim() && !images.length)) throw httpErr(400, 'empty message');
      if (text.length > 100_000) throw httpErr(413, 'message too long');
      content = images.length ? imageContent(text.trim(), images) : text;
    }
    mode = this.normalizeMode(mode || this.cfg.defaultPermissionMode);
    if (model === 'default') model = undefined;
    this.validate({ mode, model, effort });

    let existing = sessionId && !fork ? this.bySession(sessionId) : null;
    // A process started with an API key's limits (fewer tools, a schema, ...) goes back to normal
    // settings for anyone else, once it's idle. Effort can only be set at startup, too. Either way the
    // process is restarted on the same session: nothing is lost.
    if (existing && this.isIdle(existing) && ((existing.limits && existing.limits !== limitsOf(api)) || (effort && existing.effort !== effort))) {
      await this.restart(existing);
      cwd = existing.cwd;
      existing = null;
    }
    if (existing) {
      if (existing.mode !== mode) { this.control(existing, { subtype: 'set_permission_mode', mode }); existing.mode = mode; }
      if (model && existing.model !== model) { this.control(existing, { subtype: 'set_model', model }); existing.model = model; }
      onRun?.(existing);
      this.writeUser(existing, content, uuid);
      return { sessionId: existing.sessionId, runId: existing.runId };
    }
    this.checkStart(cwd, { api: !!api });
    const feats = api ? await this.features() : new Set();
    if (api) {
      if (api.tools !== 'all' && !feats.has('--tools')) throw httpErr(501, 'this Claude Code is too old to limit its tools: update it (claude update)');
      if (api.schema && !feats.has('--json-schema')) throw httpErr(501, 'this Claude Code is too old for structured answers (--json-schema): update it (claude update)');
    }

    const run = this.spawn({ cwd, resume: sessionId, fork, mode, model, effort, api, feats });
    onRun?.(run);
    this.writeUser(run, content, uuid);
    const sid = await run.ready;
    return { sessionId: sid, runId: run.runId };
  }

  spawn({ cwd, resume, fork, mode, model, effort, api = null, feats = new Set() }) {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio', '--permission-mode', mode,
      '--disallowedTools', 'AskUserQuestion'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (resume) args.push('--resume', resume);
    if (resume && fork) args.push('--fork-session');
    // a prompt from the API: answers streamed in pieces, prompts echoed back with their id, and the
    // settings only a new process can take
    if (api) {
      const has = f => feats.has(f);
      if (has('--include-partial-messages')) args.push('--include-partial-messages');
      if (has('--replay-user-messages')) args.push('--replay-user-messages');
      if (api.tools === 'none') args.push('--tools', '');
      else if (api.tools === 'readOnly') args.push('--tools', READ_ONLY_TOOLS);
      if (api.tools !== 'all' && has('--strict-mcp-config')) args.push('--strict-mcp-config'); // no MCP servers either
      if (api.system && has('--append-system-prompt')) args.push('--append-system-prompt', api.system);
      if (api.schema) args.push('--json-schema', api.schema);
      if (api.maxBudgetUsd && has('--max-budget-usd')) args.push('--max-budget-usd', String(api.maxBudgetUsd));
      if (api.save === false) args.push('--no-session-persistence');
      if (api.deny?.length && has('--settings')) args.push('--settings', JSON.stringify({ permissions: { deny: api.deny } }));
    }

    let cmd = this.claudePath, pre = [];
    if (/\.(c|m)?js$/i.test(cmd)) { pre = [cmd]; cmd = process.execPath; } // test stub support
    const env = cleanEnv();
    if (this.cfg.claudeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.cfg.claudeOauthToken;
    const proc = spawn(cmd, [...pre, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    const run = {
      runId: crypto.randomUUID(), sessionId: resume && !fork ? resume : null, cwd, mode, model, effort, proc,
      status: 'starting', startedAt: Date.now(), lastActivity: Date.now(), pending: new Set(), stderr: '', ctl: 0,
      writesInFlight: 0, replaysSinceResult: 0, costTotal: 0,
      via: api ? { keyId: api.keyId, keyName: api.keyName, alerts: !!api.alerts } : null,
      limits: limitsOf(api), save: api?.save !== false, replay: !!(api && feats.has('--replay-user-messages'))
    };
    run.ready = new Promise((resolve, reject) => { run._resolve = resolve; run._reject = reject; });
    run.ready.catch(() => {});
    this.runs.set(run.runId, run);

    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        this.onMessage(run, m);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', d => { run.stderr = (run.stderr + d).slice(-4000); });
    proc.stdin.on('error', () => {});
    proc.on('error', err => { run.lastError = `failed to start claude: ${err.message}`; this.finish(run); });
    proc.on('exit', code => {
      if (code && !run.lastError && !run.killed) run.lastError = `claude exited with code ${code}` + (run.stderr ? `: ${run.stderr.trim().split('\n').slice(-3).join(' ')}` : '');
      this.finish(run);
    });

    this.control(run, { subtype: 'initialize', hooks: null });
    this.emitRun(run);
    return run;
  }

  onMessage(run, m) {
    run.lastActivity = Date.now();
    if (m.type === 'system' && m.subtype === 'init') {
      // Claude Code sends this before every turn; the first one says which session this is
      run.sessionId = m.session_id;
      run.status = 'running';
      run._resolve(m.session_id);
      this.emitRun(run);
    } else if (m.type === 'rate_limit_event') {
      this.emit('rate_limit', m.rate_limit_info); // the plan's 5-hour and weekly windows (usage page)
    } else if (m.type === 'stream_event') {
      this.emit('partial', run, m); // a piece of the answer as it's written (--include-partial-messages)
    } else if (m.type === 'control_request') {
      const req = m.request || {};
      if (req.subtype === 'can_use_tool') this.askPermission(run, m.request_id, req);
      else this.respond(run, m.request_id, null, `unsupported control request: ${req.subtype}`);
    } else if (m.type === 'result') {
      run.status = 'idle';
      run.lastError = m.is_error ? String(m.result || m.subtype || 'error').slice(0, 500) : null;
      // total_cost_usd is a running total for the process: this turn cost the difference
      const total = Number(m.total_cost_usd) || 0;
      const cost = total >= run.costTotal ? total - run.costTotal : total;
      run.costTotal = total;
      run.lastCost = cost;
      // prompts sent while Claude was busy can be answered together: one result for all echoed since
      run.writesInFlight = Math.max(0, run.writesInFlight - Math.max(1, run.replaysSinceResult));
      run.replaysSinceResult = 0;
      this.emit('result', run, { text: String(m.result ?? ''), isError: !!m.is_error, subtype: m.subtype || '', usage: m.usage || null, costUsd: Math.round(cost * 1e6) / 1e6, structured: m.structured_output, turns: m.num_turns });
      this.emitRun(run, { result: { isError: !!m.is_error, text: String(m.result || '').slice(0, 2000), cost, turns: m.num_turns } });
      if (!run.save) this.kill(run); // an unsaved one-off: there is nothing to continue
    } else if (m.type === 'assistant' || m.type === 'user') {
      if (m.type === 'user' && m.isReplay) { run.replaysSinceResult++; this.emit('replay', run, m); }
      if (run.status !== 'running') { run.status = 'running'; this.emitRun(run); }
      // stream to viewers immediately; the transcript tail de-duplicates by uuid
      if (run.sessionId) this.emit('message', run.sessionId, m);
      this.emit('run_message', run, m);
    }
  }

  askPermission(run, requestId, req) {
    const id = crypto.randomBytes(9).toString('base64url');
    let input = '';
    try { input = JSON.stringify(req.input, null, 1); } catch { /* ignore */ }
    const pub = { id, runId: run.runId, sessionId: run.sessionId, cwd: run.cwd, tool: req.tool_name, input: input.slice(0, 6000), createdAt: Date.now(), via: run.via?.keyName || null };
    if (req.tool_name === 'ExitPlanMode') pub.plan = String(req.input?.plan || '').slice(0, 20000); // approving a plan: show the plan, not its JSON
    const timer = setTimeout(() => this.decide(id, { allow: false, message: 'Timed out waiting for remote approval' }), this.cfg.permissionTimeoutMinutes * 60e3);
    timer.unref?.();
    this.permissions.set(id, { run, requestId, rawInput: req.input, public: pub, timer });
    run.pending.add(id);
    run.status = 'waiting';
    this.emit('permission', pub);
    this.emitRun(run);
  }

  decide(id, { allow, message, alwaysMode }) {
    const p = this.permissions.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.permissions.delete(id);
    p.run.pending.delete(id);
    const response = allow
      ? { behavior: 'allow', updatedInput: p.rawInput }
      : { behavior: 'deny', message: String(message || 'Denied by remote user').slice(0, 1000) };
    this.respond(p.run, p.requestId, response);
    if (allow && alwaysMode && PERMISSION_MODES.includes(alwaysMode) && alwaysMode !== 'bypassPermissions') {
      this.control(p.run, { subtype: 'set_permission_mode', mode: alwaysMode });
      p.run.mode = alwaysMode;
    }
    if (p.run.status === 'waiting' && !p.run.pending.size) p.run.status = 'running';
    this.emit('permission_resolved', { id, allow: !!allow, sessionId: p.run.sessionId });
    this.emitRun(p.run);
    return true;
  }

  interrupt(sessionId) {
    const r = this.bySession(sessionId);
    if (!r) return false;
    for (const id of [...r.pending]) this.decide(id, { allow: false, message: 'Interrupted' });
    this.control(r, { subtype: 'interrupt' });
    return true;
  }

  stop(sessionId) {
    const r = this.bySession(sessionId);
    if (!r) return false;
    this.kill(r);
    return true;
  }

  kill(r) {
    r.killed = true; // stopped on purpose: the non-zero exit code is not an error
    try { r.proc.stdin.end(); } catch { /* ignore */ }
    if (process.platform === 'win32' && r.proc.pid) {
      spawn('taskkill', ['/pid', String(r.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      r.proc.kill('SIGTERM');
    }
  }

  finish(run) {
    if (run.status === 'exited') return;
    run.status = 'exited';
    for (const id of [...run.pending]) { const p = this.permissions.get(id); if (p) { clearTimeout(p.timer); this.permissions.delete(id); this.emit('permission_resolved', { id, allow: false, sessionId: run.sessionId }); } }
    run._reject(new Error(run.lastError || 'claude exited before starting'));
    this.emitRun(run);
    setTimeout(() => this.runs.delete(run.runId), 60e3).unref?.();
  }

  // idle processes stop after a while (the next prompt resumes the session); the API's sooner
  reap() {
    for (const r of this.runs.values()) {
      if (!this.isIdle(r) || r.killed) continue;
      const limit = r.via ? (this.cfg.apiIdleSeconds ?? 60) * 1e3 : this.cfg.idleKillMinutes * 60e3;
      if (Date.now() - r.lastActivity > limit) this.kill(r);
    }
  }

  shutdown() { clearInterval(this.reaper); for (const r of this.runs.values()) if (r.status !== 'exited') this.kill(r); }

  // content: text, or a list of content blocks (text and images); uuid: the prompt's id (see send)
  writeUser(run, content, uuid) {
    run.lastActivity = Date.now();
    run.writesInFlight = (run.writesInFlight || 0) + 1;
    if (run.status === 'idle') { run.status = 'running'; this.emitRun(run); }
    this.write(run, { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: run.sessionId || '', ...(uuid ? { uuid } : {}) });
  }
  control(run, request) { this.write(run, { type: 'control_request', request_id: `handoff-${++run.ctl}`, request }); }
  respond(run, requestId, response, error) {
    this.write(run, { type: 'control_response', response: error ? { subtype: 'error', request_id: requestId, error } : { subtype: 'success', request_id: requestId, response } });
  }
  write(run, obj) { try { run.proc.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* process gone */ } }
  emitRun(run, extra = {}) { this.emit('run', { ...this.publicRun(run), ...extra }); }
}

// Child gets a clean environment: drop variables injected by a parent Claude Code / desktop host
// so the spawned CLI behaves like a normal standalone login.
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT|BAGGAGE|HANDOFF_)/.test(k) &&
        !/^CLAUDE_CODE_(OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|GIT_BASH_PATH)$/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

function isWithin(child, root) {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
