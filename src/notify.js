// WhatsApp notifications for Claude Code events, sent through the self-hosted sender in ./whatsapp.
// Two sources:
//  - sessions this app drives (runner): tool approval requests, finished turns, errors
//  - every other running session (Claude Desktop / terminal), from ~/.claude/sessions/<pid>.json:
//      status -> "waiting"   needs your input/approval (waitingFor says what)
//      "busy" -> "idle"      finished its work
// +923001234567 -> +92•••••4567: logs show which number without giving it away
import fs from 'node:fs';

export const maskNumber = n => { const d = String(n || '').replace(/\D/g, ''); return d.length > 6 ? `+${d.slice(0, 2)}${'•'.repeat(d.length - 6)}${d.slice(-4)}` : '+' + '•'.repeat(d.length); };

const PER_SESSION_GAP = 20e3;   // same kind of message for one session at most every 20s
const MAX_PER_MINUTE = 12;
const HELD_MAX = 50;

// Quiet hours "23:00-07:00" (the computer's local time; may span midnight) -> { from, to, text } in minutes
export function parseQuiet(s) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s || ''));
  if (!m) return null;
  const from = +m[1] * 60 + +m[2], to = +m[3] * 60 + +m[4];
  if (+m[1] > 23 || +m[3] > 23 || +m[2] > 59 || +m[4] > 59 || from === to) return null;
  return { from, to, text: String(s).trim() };
}
export function inQuiet(q, date = new Date()) {
  if (!q) return false;
  const t = date.getHours() * 60 + date.getMinutes();
  return q.from < q.to ? t >= q.from && t < q.to : t >= q.from || t < q.to;
}
// folder names compared the way the system does: forward slashes, no trailing slash, case-insensitive on Windows
const sameFolder = s => { const f = String(s || '').replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? f.toLowerCase() : f; };

export class Notifier {
  // prefsFile: where muted projects are kept (data/notify.json)
  // push: a PushService; alerts also go to phones that turned on push notifications
  constructor(cfg, { store, runner, log = console.log, send, onAnswer, onApproval, onLinkChange, prefsFile, push = null, now = () => new Date() } = {}) {
    this.cfg = cfg;
    this.store = store;
    this.runner = runner;
    this.log = log;
    this.send = send || (text => this.sendWhatsApp(text));
    this.onAnswer = onAnswer;     // (sessionId, {picks, text}) -> Promise
    this.onApproval = onApproval; // (permId, allow) -> boolean
    this.onLinkChange = onLinkChange; // (linkState()) -> void, when the sender starts or stops being able to send
    this.problem = undefined;     // null = sender connected; 'unlinked' | 'offline' | 'not-running'; undefined = not checked yet
    this.seenProblem = null;
    this.last = new Map();   // `${sessionId}:${kind}` -> time
    this.sent = [];          // timestamps for the global rate limit
    this.seen = null;        // sessionId -> status, from the previous registry scan
    this.askedQ = new Map(); // sessionId -> toolUseId already sent to WhatsApp
    this.openAsk = null;     // the question a WhatsApp reply would answer
    this.openPerm = null;    // the approval a WhatsApp yes/no would answer
    this.inboxSince = 0;
    this.now = now;
    this.push = push;
    this.quiet = parseQuiet(cfg.notify?.quiet);
    if (cfg.notify?.quiet && !this.quiet) log(`[notify] ignoring HANDOFF_WHATSAPP_QUIET="${cfg.notify.quiet}": use HH:MM-HH:MM, e.g. 23:00-07:00`);
    this.quietAllow = new Set(cfg.notify?.quietAllow || []);
    this.held = [];          // alerts kept back during quiet hours, summed up afterwards
    this.prefsFile = prefsFile;
    this.muted = new Map();  // project folders whose alerts are off (sub-folders too): compared name -> as written
    this.mutedSessions = new Set(); // single chats whose alerts are off
    try {
      const p = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
      for (const c of p.muted || []) this.muted.set(sameFolder(c), c);
      for (const id of p.mutedSessions || []) this.mutedSessions.add(String(id));
    } catch { /* none yet */ }
  }

  // ----- quiet hours and muted projects -----
  // a muted project also covers the folders inside it, such as git worktrees under .claude/worktrees
  isMuted(cwd) {
    if (!cwd) return false;
    const f = sameFolder(cwd);
    for (const m of this.muted.keys()) if (f === m || f.startsWith(m + '/')) return true;
    return false;
  }
  setMuted(cwd, on) {
    if (!cwd) return;
    if (on) this.muted.set(sameFolder(cwd), cwd); else this.muted.delete(sameFolder(cwd));
    this.savePrefs();
  }
  setSessionMuted(sessionId, on) {
    if (on) this.mutedSessions.add(sessionId); else this.mutedSessions.delete(sessionId);
    this.savePrefs();
  }
  savePrefs() {
    if (this.prefsFile) fs.writeFileSync(this.prefsFile, JSON.stringify({ muted: [...this.muted.values()], mutedSessions: [...this.mutedSessions] }, null, 2));
  }
  prefs() {
    return {
      enabled: this.on || !!this.push, quiet: this.quiet ? { text: this.quiet.text, active: inQuiet(this.quiet, this.now()), allow: [...this.quietAllow] } : null,
      muted: [...this.muted.values()], mutedSessions: [...this.mutedSessions], held: this.held.length
    };
  }

  // After quiet hours, one message sums up what was kept back
  async flushHeld() {
    if (!this.held.length || inQuiet(this.quiet, this.now())) return;
    const held = this.held.splice(0);
    const lines = [];
    for (const [kind, label] of [['question', '❓ Asked you'], ['approval', '🔐 Needed approval'], ['waiting', '⏳ Waiting for you'], ['error', '⚠️ Hit an error'], ['done', '✅ Finished']]) {
      const ids = [...new Set(held.filter(h => h.kind === kind).map(h => h.sessionId))];
      if (!ids.length) continue;
      const names = await Promise.all(ids.slice(0, 6).map(async id => {
        const h = held.find(x => x.sessionId === id);
        let info = null;
        try { info = await this.store.sessionInfo(id); } catch { /* gone */ }
        const project = (h.cwd || info?.cwd || '').split(/[\\/]/).filter(Boolean).pop();
        return `${h.title || info?.title || 'Claude session'}${project ? ` (${project})` : ''}`;
      }));
      lines.push(`${label}: ${names.join(', ')}${ids.length > 6 ? ` and ${ids.length - 6} more` : ''}`);
    }
    const link = this.cfg.publicHostname ? `\n\nOpen: https://${this.cfg.publicHostname}/` : '';
    const title = `🌙 While quiet hours were on (${this.quiet?.text || ''})`;
    if (this.on) {
      this.send(`*${title}*\n${lines.join('\n')}${link}`)
        .then(() => this.log(`[notify] sent the quiet-hours summary (${held.length} alert${held.length === 1 ? '' : 's'})`))
        .catch(e => this.log(`[notify] WhatsApp send failed (quiet-hours summary): ${e.message}`));
    }
    if (this.push?.has()) this.push.send({ title, body: lines.join('\n'), url: '/', tag: 'quiet-summary' }).catch(() => {});
  }

  // anything to send to: WhatsApp set up, or a phone subscribed to push notifications
  get active() { return this.on || !!this.push?.has(); }

  get on() { return !!(this.cfg.notify?.enabled && this.cfg.notify.token && this.cfg.notify.to); }
  wants(kind) { return this.cfg.notify?.events?.[kind] !== false; }

  start() {
    // phones can subscribe to push at any time, so watch sessions whenever push is available
    if (!this.on && !this.push) return this;
    this.runner.on('permission', p => {
      this.openPerm = { id: p.id, sessionId: p.sessionId, at: Date.now() };
      this.event('approval', p.sessionId, {
        detail: `Tool: ${p.tool}${summarize(p.input) ? ' — ' + summarize(p.input) : ''}${p.via ? `\nStarted from the API (key "${p.via}")` : ''}\n\nReply *yes* to allow or *no* to deny.`, cwd: p.cwd,
        permission: { id: p.id, tool: p.tool }
      });
    });
    this.runner.on('permission_resolved', p => { if (this.openPerm?.id === p.id) this.openPerm = null; });
    this.runner.on('run', r => {
      // work an API key started: the program that asked gets the answer, so no "finished" alert
      // unless that key asks for one (approvals always alert, above)
      if (r.via && !r.via.alerts) return;
      if (r.result && !r.result.isError) this.event('done', r.sessionId, { detail: clip(r.result.text, 300), cwd: r.cwd });
      else if (r.result?.isError || (r.status === 'exited' && r.lastError)) this.event('error', r.sessionId, { detail: clip(r.result?.text || r.lastError, 300), cwd: r.cwd });
    });
    this.timer = setInterval(() => this.scan(), 3000);
    this.timer.unref?.();
    this.scan();
    if (!this.on) return this; // the rest is WhatsApp only
    this.inbox = setInterval(() => this.pollInbox().catch(() => {}), 4000);
    this.inbox.unref?.();
    this.linkTimer = setInterval(() => this.checkLink(), 30e3);
    this.linkTimer.unref?.();
    this.checkLink();
    this.log(`[notify] WhatsApp notifications on -> ${maskNumber(this.cfg.notify.to)}`);
    return this;
  }
  stop() { clearInterval(this.timer); clearInterval(this.inbox); clearInterval(this.linkTimer); }

  // Can the sender deliver right now? Without this, an unlinked phone fails silently for days.
  linkState() {
    if (!this.on) return { enabled: false };
    return { enabled: true, connected: this.problem === null, problem: this.problem || null, qrUrl: `${this.cfg.notify.url}/qr` };
  }

  async checkLink() {
    if (!this.on) return;
    let next;
    try {
      const d = await (await fetch(`${this.cfg.notify.url}/status`, { signal: AbortSignal.timeout(4000) })).json();
      next = d.connected ? null : d.waitingForScan ? 'unlinked' : 'offline';
    } catch { next = 'not-running'; }
    // A sender that is restarting or reconnecting is fine: other problems count once seen twice in a row
    // (30s apart). An unlinked phone counts at once.
    const confirmed = !next || next === 'unlinked' || next === this.seenProblem;
    this.seenProblem = next;
    if (confirmed) this.setProblem(next);
  }

  setProblem(next) {
    if (next === this.problem) return;
    const before = this.problem;
    this.problem = next;
    if (next === 'unlinked') this.log(`[notify] WhatsApp alerts paused: the sending phone is unlinked. Scan the QR at ${this.cfg.notify.url}/qr`);
    else if (next === 'offline') this.log('[notify] WhatsApp alerts paused: the sender can\'t reach WhatsApp');
    else if (next === 'not-running') this.log(`[notify] WhatsApp alerts paused: the sender at ${this.cfg.notify.url} isn't running`);
    else if (before) this.log('[notify] WhatsApp sender connected again');
    this.onLinkChange?.(this.linkState());
  }

  // compare the session registry with the previous scan (runs every 3s; never two at once)
  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try { await this.flushHeld(); await this.compare(); } finally { this.scanning = false; }
  }

  async compare() {
    let live;
    try { live = await this.store.liveSessions(); } catch { return; }
    const now = new Map(live.map(l => [l.sessionId, l]));
    if (this.seen) {
      for (const [id, l] of now) {
        if (this.runner.bySession(id)) continue; // our own sessions are reported from runner events
        if (this.runner.quietPids?.has(l.pid)) continue; // a one-off of ours (commit message, limit check)
        const before = this.seen.get(id);
        if (l.status === 'waiting') {
          // Claude asked a multiple-choice question: send it with its options, once per question
          const q = await this.pending(id);
          if (q && this.askedQ.get(id) !== q.toolUseId) {
            this.askedQ.set(id, q.toolUseId);
            this.openAsk = { sessionId: id, toolUseId: q.toolUseId, at: Date.now() };
            this.event('question', id, { detail: renderQuestions(q.questions), cwd: l.cwd, title: l.name, force: true });
          } else if (!q && before !== 'waiting') {
            this.event('waiting', id, { detail: l.waitingFor ? `Needs: ${l.waitingFor}` : 'Needs your input or approval', cwd: l.cwd, title: l.name });
          }
        } else if (l.status === 'idle' && (before === 'busy' || before === 'waiting')) {
          this.askedQ.delete(id);
          if (this.openAsk?.sessionId === id) this.openAsk = null;
          this.event('done', id, { detail: await this.lastReply(id), cwd: l.cwd, title: l.name });
        }
      }
    }
    this.seen = new Map([...now].map(([id, l]) => [id, l.status]));
  }

  async pending(sessionId) {
    try { return await this.store.pendingQuestion(sessionId); } catch { return null; }
  }

  // Called when the question was answered (from the web UI or from WhatsApp).
  answered(sessionId, summary) {
    this.askedQ.delete(sessionId);
    if (this.openAsk?.sessionId === sessionId) this.openAsk = null;
    if (this.on && summary) this.send(`✅ *Answer sent:* ${clip(summary, 200)}`).catch(() => {});
  }

  // Replies come back by polling the WhatsApp sender; nothing inbound is exposed to the internet.
  async pollInbox() {
    if (!this.on || !(this.onAnswer || this.onApproval)) return;
    let msgs = [];
    try {
      const r = await fetch(`${this.cfg.notify.url}/inbox?since=${this.inboxSince}`, {
        signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${this.cfg.notify.token}` }
      });
      if (!r.ok) return;
      const d = await r.json();
      msgs = d.messages || [];
      if (d.now) this.inboxSince = d.now;
    } catch { return; } // sender not running
    for (const m of msgs) {
      if (String(m.from || '').replace(/\D/g, '') !== String(this.cfg.notify.to).replace(/\D/g, '')) continue;
      try { await this.handleReply(String(m.text || '').trim()); }
      catch (e) { this.send(`⚠️ ${clip(e.message, 200)}`).catch(() => {}); }
    }
  }

  async handleReply(text) {
    if (!text) return;
    const low = text.toLowerCase();
    const expired = this.openAsk && Date.now() - this.openAsk.at > 12 * 3600e3;
    if (expired) this.openAsk = null;

    if (this.openPerm && /^(y|yes|ok|okay|allow|approve|accept)\b/.test(low)) {
      const ok = this.onApproval?.(this.openPerm.id, true);
      this.openPerm = null;
      return this.send(ok ? '✅ Allowed.' : '⚠️ That approval is no longer waiting.');
    }
    if (this.openPerm && /^(n|no|deny|reject|stop)\b/.test(low)) {
      const ok = this.onApproval?.(this.openPerm.id, false);
      this.openPerm = null;
      return this.send(ok ? '🚫 Denied.' : '⚠️ That approval is no longer waiting.');
    }
    if (!this.openAsk) return this.send('Nothing is waiting for an answer right now.');

    const picks = [...new Set((text.match(/\d{1,2}/g) || []).map(Number))].filter(n => n > 0 && n <= 80);
    const onlyNumbers = /^[\d\s,.&+and]*$/i.test(text);
    const r = await this.onAnswer(this.openAsk.sessionId, { picks, text: onlyNumbers && picks.length ? '' : text });
    const where = r?.queuedBehindPicker
      ? '\nThe laptop is showing the picker for this question — close it there (Esc) and this answer runs next.'
      : '';
    return this.send(`✅ *Sent to Claude*${r?.answered?.length ? '\n' + r.answered.join('\n') : ''}${where}`);
  }

  async lastReply(sessionId) {
    try {
      const t = await this.store.readTranscript(sessionId, null, 256 * 1024);
      const a = t?.events.filter(e => e.kind === 'assistant').pop();
      return a ? clip(a.text, 300) : '';
    } catch { return ''; }
  }

  // An API turn sent into a session open on the computer: its "finished" alert is skipped, as the
  // program that asked gets the answer (unless the key wants alerts, in which case this isn't called).
  quietDone(sessionId, ms) { (this.quietUntil ||= new Map()).set(sessionId, Date.now() + ms); }

  event(kind, sessionId, { detail = '', cwd = '', title = '', force = false, permission = null } = {}) {
    if (!this.active || !this.wants(kind) || !sessionId) return false;
    if ((kind === 'done' || kind === 'error') && (this.quietUntil?.get(sessionId) || 0) > Date.now()) return false;
    // a chained prompt is about to be sent: "finished" comes after the last step
    if (kind === 'done' && this.moreQueued?.(sessionId)) return false;
    if (this.isMuted(cwd) || this.mutedSessions.has(sessionId)) return false;
    if (inQuiet(this.quiet, this.now()) && !this.quietAllow.has(kind)) {
      this.held.push({ kind, sessionId, title, cwd, at: Date.now() });
      if (this.held.length > HELD_MAX) this.held.shift();
      return false;
    }
    const key = `${sessionId}:${kind}`, t = Date.now();
    if (!force && t - (this.last.get(key) || 0) < PER_SESSION_GAP) return false;
    this.sent = this.sent.filter(x => t - x < 60e3);
    if (this.sent.length >= MAX_PER_MINUTE) return false;
    this.last.set(key, t); this.sent.push(t);
    // the rate limits above are decided at once; the message is built (reading the transcript) and sent after
    const urgent = kind === 'approval' || kind === 'question';
    this.compose(kind, sessionId, { detail, cwd, title, permission }).then(m => {
      if (m.muted) return; // listed under a muted project although it now works in another folder
      if (this.on) {
        this.send(m.text).then(() => this.log(`[notify] sent ${kind} for ${sessionId.slice(0, 8)}`))
          .catch(e => this.log(`[notify] WhatsApp send failed (${kind}): ${e.message}`));
      }
      if (this.push?.has()) this.push.send(m.push, { urgent }).catch(e => this.log(`[push] ${e.message}`));
    });
    return true;
  }

  async compose(kind, sessionId, { detail = '', cwd = '', title = '', permission = null } = {}) {
    let info = null;
    try { info = await this.store.sessionInfo(sessionId); } catch { /* new session not on disk yet */ }
    const name = title || info?.title || 'Claude session';
    const project = (cwd || info?.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
    const head = { approval: '🔐 Claude needs your approval', waiting: '⏳ Claude is waiting for you', question: '❓ Claude is asking you', done: '✅ Claude finished', error: '⚠️ Claude hit an error' }[kind];
    const link = this.cfg.publicHostname ? `https://${this.cfg.publicHostname}/#/s/${sessionId}` : '';
    const text = [`*${head}*`, `Session: ${name}`, project && `Project: ${project}`, detail && '', detail, link && '', link && `Open: ${link}`]
      .filter(x => x !== false && x !== undefined && x !== null).join('\n').replace(/\n{3,}/g, '\n\n');
    // a phone notification: shorter, no WhatsApp reply instructions, opens the chat when tapped
    const pushBody = [`${name}${project ? ` · ${project}` : ''}`, detail.replace(/\n\nReply \*yes\*[\s\S]*$/, '').replace(/\nReply with the number[\s\S]*$/, '').replace(/\*/g, '')].filter(Boolean).join('\n');
    const push = { title: head, body: pushBody, url: `/#/s/${sessionId}`, tag: `${sessionId}:${kind}` };
    // an approval can be answered from the notification itself (where the phone shows buttons)
    if (kind === 'approval' && permission?.id) {
      push.permission = permission.id;
      push.actions = permission.tool === 'ExitPlanMode'
        ? [{ action: 'allow', title: 'Approve plan' }, { action: 'deny', title: 'Keep planning' }]
        : [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }];
    }
    return { text, muted: this.isMuted(info?.cwd), push };
  }

  async sendWhatsApp(text) {
    const r = await fetch(`${this.cfg.notify.url}/send`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.notify.token}` },
      body: JSON.stringify({ to: this.cfg.notify.to, text })
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.json().catch(() => ({}))).error || ''}`.trim());
    if (this.problem) this.setProblem(null); // it just delivered, so it's fine again
  }

  async status() {
    if (!this.on) return { enabled: false };
    try {
      const r = await fetch(`${this.cfg.notify.url}/status`, { signal: AbortSignal.timeout(4000) });
      return { enabled: true, to: this.cfg.notify.to, ...(await r.json()) };
    } catch { return { enabled: true, to: this.cfg.notify.to, connected: false, error: 'WhatsApp service not running' }; }
  }
}

// Turn picked option numbers and/or free text into the prompt that answers an AskUserQuestion.
export function buildAnswer(q, { picks = [], text = '' }) {
  const chosen = [];
  for (const qq of q.questions) {
    const hit = qq.options.filter(o => picks.includes(o.n));
    if (hit.length) chosen.push(`${qq.header || qq.question}: ${hit.map(o => o.label).join(', ')}`);
  }
  const free = String(text || '').trim().slice(0, 4000);
  if (!chosen.length && !free) throw Object.assign(new Error('pick an option or type an answer'), { status: 400 });
  const body = [chosen.length ? `My answers — ${chosen.join(' · ')}` : '', free].filter(Boolean).join('\n');
  const prompt = `${body}\n\n(Answer to your question, sent from Handoff. Treat it as the user's own choice and continue.)`;
  return { chosen, free, prompt };
}

// Numbered options, so a WhatsApp reply of "1 5" answers both questions.
function renderQuestions(questions) {
  const parts = questions.map(q => {
    const opts = q.options.map(o => `${o.n}. *${o.label}*` + (o.description ? `\n    ${clip(o.description, 160)}` : ''));
    return [q.header ? `*${q.header}*` : '', q.question, ...opts].filter(Boolean).join('\n');
  });
  const n = questions.reduce((a, q) => a + q.options.length, 0);
  const hint = `_Reply with the number(s) you choose${questions.length > 1 ? ', e.g. "1 5"' : ''}, or type your own answer._`;
  return parts.join('\n\n') + (n ? `\n\n${hint}` : '');
}

function clip(s, n) { s = String(s || '').replace(/\s+\n/g, '\n').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function summarize(input) {
  try {
    const o = JSON.parse(input);
    return clip(String(o.command || o.file_path || o.url || o.pattern || o.description || '').split('\n')[0], 120);
  } catch { return ''; }
}
