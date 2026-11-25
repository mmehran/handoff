// WhatsApp notifications for Claude Code events, sent through the self-hosted sender in ./whatsapp.
// Two sources:
//  - sessions this app drives (runner): tool approval requests, finished turns, errors
//  - every other running session (Claude Desktop / terminal), from ~/.claude/sessions/<pid>.json:
//      status -> "waiting"   needs your input/approval (waitingFor says what)
//      "busy" -> "idle"      finished its work
// +923001234567 -> +92•••••4567: logs show which number without giving it away
export const maskNumber = n => { const d = String(n || '').replace(/\D/g, ''); return d.length > 6 ? `+${d.slice(0, 2)}${'•'.repeat(d.length - 6)}${d.slice(-4)}` : '+' + '•'.repeat(d.length); };

const PER_SESSION_GAP = 20e3;   // same kind of message for one session at most every 20s
const MAX_PER_MINUTE = 12;

export class Notifier {
  constructor(cfg, { store, runner, log = console.log, send, onAnswer, onApproval, onLinkChange } = {}) {
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
  }

  get on() { return !!(this.cfg.notify?.enabled && this.cfg.notify.token && this.cfg.notify.to); }
  wants(kind) { return this.cfg.notify?.events?.[kind] !== false; }

  start() {
    if (!this.on) return this;
    this.runner.on('permission', p => {
      this.openPerm = { id: p.id, sessionId: p.sessionId, at: Date.now() };
      this.event('approval', p.sessionId, {
        detail: `Tool: ${p.tool}${summarize(p.input) ? ' — ' + summarize(p.input) : ''}\n\nReply *yes* to allow or *no* to deny.`, cwd: p.cwd
      });
    });
    this.runner.on('permission_resolved', p => { if (this.openPerm?.id === p.id) this.openPerm = null; });
    this.runner.on('run', r => {
      if (r.result && !r.result.isError) this.event('done', r.sessionId, { detail: clip(r.result.text, 300), cwd: r.cwd });
      else if (r.result?.isError || (r.status === 'exited' && r.lastError)) this.event('error', r.sessionId, { detail: clip(r.result?.text || r.lastError, 300), cwd: r.cwd });
    });
    this.timer = setInterval(() => this.scan(), 3000);
    this.timer.unref?.();
    this.inbox = setInterval(() => this.pollInbox().catch(() => {}), 4000);
    this.inbox.unref?.();
    this.linkTimer = setInterval(() => this.checkLink(), 30e3);
    this.linkTimer.unref?.();
    this.scan();
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
    try { await this.compare(); } finally { this.scanning = false; }
  }

  async compare() {
    let live;
    try { live = await this.store.liveSessions(); } catch { return; }
    const now = new Map(live.map(l => [l.sessionId, l]));
    if (this.seen) {
      for (const [id, l] of now) {
        if (this.runner.bySession(id)) continue; // our own sessions are reported from runner events
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

  event(kind, sessionId, { detail = '', cwd = '', title = '', force = false } = {}) {
    if (!this.on || !this.wants(kind) || !sessionId) return false;
    const key = `${sessionId}:${kind}`, t = Date.now();
    if (!force && t - (this.last.get(key) || 0) < PER_SESSION_GAP) return false;
    this.sent = this.sent.filter(x => t - x < 60e3);
    if (this.sent.length >= MAX_PER_MINUTE) return false;
    this.last.set(key, t); this.sent.push(t);
    // the rate limits above are decided at once; the message is built (reading the transcript) and sent after
    this.compose(kind, sessionId, { detail, cwd, title })
      .then(text => this.send(text))
      .then(() => this.log(`[notify] sent ${kind} for ${sessionId.slice(0, 8)}`))
      .catch(e => this.log(`[notify] WhatsApp send failed (${kind}): ${e.message}`));
    return true;
  }

  async compose(kind, sessionId, { detail = '', cwd = '', title = '' } = {}) {
    let info = null;
    try { info = await this.store.sessionInfo(sessionId); } catch { /* new session not on disk yet */ }
    const name = title || info?.title || 'Claude session';
    const project = (cwd || info?.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
    const head = { approval: '🔐 Claude needs your approval', waiting: '⏳ Claude is waiting for you', question: '❓ Claude is asking you', done: '✅ Claude finished', error: '⚠️ Claude hit an error' }[kind];
    const link = this.cfg.publicHostname ? `https://${this.cfg.publicHostname}/#/s/${sessionId}` : '';
    const text = [`*${head}*`, `Session: ${name}`, project && `Project: ${project}`, detail && '', detail, link && '', link && `Open: ${link}`]
      .filter(x => x !== false && x !== undefined && x !== null).join('\n').replace(/\n{3,}/g, '\n\n');
    return text;
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
