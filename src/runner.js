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

// same choices as Claude Desktop's mode menu ('manual' = Ask permissions; older configs say 'default')
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
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

  publicRun(r) {
    return { runId: r.runId, sessionId: r.sessionId, cwd: r.cwd, status: r.status, mode: r.mode, model: r.model || 'default', effort: r.effort || null, startedAt: r.startedAt, lastActivity: r.lastActivity, lastError: r.lastError || null, pending: [...r.pending].length };
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
  async send({ sessionId, cwd, text, mode, model, effort, fork }) {
    if (typeof text !== 'string' || !text.trim()) throw httpErr(400, 'empty message');
    if (text.length > 100_000) throw httpErr(413, 'message too long');
    mode = this.normalizeMode(mode || this.cfg.defaultPermissionMode);
    if (model === 'default') model = undefined;
    this.validate({ mode, model, effort });

    let existing = sessionId && !fork ? this.bySession(sessionId) : null;
    // effort can only be set at startup: restart our process on the same session (nothing is lost)
    if (existing && effort && existing.effort !== effort && existing.status !== 'running' && existing.status !== 'waiting') {
      await new Promise(res => { existing.proc.once('exit', res); this.kill(existing); setTimeout(res, 5000); });
      cwd = existing.cwd;
      existing = null;
    }
    if (existing) {
      if (existing.mode !== mode) { this.control(existing, { subtype: 'set_permission_mode', mode }); existing.mode = mode; }
      if (model && existing.model !== model) { this.control(existing, { subtype: 'set_model', model }); existing.model = model; }
      this.writeUser(existing, text);
      return { sessionId: existing.sessionId, runId: existing.runId };
    }
    const active = [...this.runs.values()].filter(r => r.status !== 'exited').length;
    if (active >= this.cfg.maxConcurrentRuns) throw httpErr(429, `too many running sessions (max ${this.cfg.maxConcurrentRuns}); stop one first`);
    if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw httpErr(400, 'working directory does not exist');
    if (this.cfg.allowedRoots.length && !this.cfg.allowedRoots.some(root => isWithin(cwd, root))) throw httpErr(403, 'directory is outside allowedRoots');

    const run = this.spawn({ cwd, resume: sessionId, fork, mode, model, effort });
    this.writeUser(run, text);
    const sid = await run.ready;
    return { sessionId: sid, runId: run.runId };
  }

  spawn({ cwd, resume, fork, mode, model, effort }) {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio', '--permission-mode', mode,
      '--disallowedTools', 'AskUserQuestion'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (resume) args.push('--resume', resume);
    if (resume && fork) args.push('--fork-session');

    let cmd = this.claudePath, pre = [];
    if (/\.(c|m)?js$/i.test(cmd)) { pre = [cmd]; cmd = process.execPath; } // test stub support
    const env = cleanEnv();
    if (this.cfg.claudeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.cfg.claudeOauthToken;
    const proc = spawn(cmd, [...pre, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    const run = {
      runId: crypto.randomUUID(), sessionId: resume && !fork ? resume : null, cwd, mode, model, effort, proc,
      status: 'starting', startedAt: Date.now(), lastActivity: Date.now(), pending: new Set(), stderr: '', ctl: 0
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
      run.sessionId = m.session_id;
      run.status = 'running';
      run._resolve(m.session_id);
      this.emitRun(run);
    } else if (m.type === 'control_request') {
      const req = m.request || {};
      if (req.subtype === 'can_use_tool') this.askPermission(run, m.request_id, req);
      else this.respond(run, m.request_id, null, `unsupported control request: ${req.subtype}`);
    } else if (m.type === 'result') {
      run.status = 'idle';
      run.lastError = m.is_error ? String(m.result || m.subtype || 'error').slice(0, 500) : null;
      run.lastCost = m.total_cost_usd;
      this.emitRun(run, { result: { isError: !!m.is_error, text: String(m.result || '').slice(0, 2000), cost: m.total_cost_usd, turns: m.num_turns } });
    } else if (m.type === 'assistant' || m.type === 'user') {
      if (run.status !== 'running') { run.status = 'running'; this.emitRun(run); }
      // stream to viewers immediately; the transcript tail de-duplicates by uuid
      if (run.sessionId) this.emit('message', run.sessionId, m);
    }
  }

  askPermission(run, requestId, req) {
    const id = crypto.randomBytes(9).toString('base64url');
    let input = '';
    try { input = JSON.stringify(req.input, null, 1); } catch { /* ignore */ }
    const pub = { id, sessionId: run.sessionId, cwd: run.cwd, tool: req.tool_name, input: input.slice(0, 6000), createdAt: Date.now() };
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

  reap() {
    const limit = this.cfg.idleKillMinutes * 60e3;
    for (const r of this.runs.values()) {
      if (r.status === 'idle' && !r.pending.size && Date.now() - r.lastActivity > limit) this.kill(r);
    }
  }

  shutdown() { clearInterval(this.reaper); for (const r of this.runs.values()) if (r.status !== 'exited') this.kill(r); }

  writeUser(run, text) {
    run.lastActivity = Date.now();
    if (run.status === 'idle') { run.status = 'running'; this.emitRun(run); }
    this.write(run, { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: run.sessionId || '' });
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
