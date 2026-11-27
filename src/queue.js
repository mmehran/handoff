// Chained prompts: steps queued for a chat ("then run the tests", "then commit"), each sent when Claude
// has finished the one before. Works for chats Handoff runs and for chats open in Claude Desktop or a
// terminal, and for a chat that isn't running at all (the next step resumes it).
//
// A step waits while Claude is busy, asks a question or waits for an approval. A step that ends in an
// error pauses the chain. Steps are kept in data/queue.json, so a restart doesn't lose them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { httpErr } from './runner.js';

const MAX_STEPS = 20;
const GRACE_MS = 20e3; // a step sent into a laptop session: how long before "idle" can mean "done with it"

export class PromptQueue extends EventEmitter {
  // deliver(sessionId, step) sends one step the way a typed message would go (see core.js)
  constructor({ store, runner, deliver, dataDir, log = () => {}, interval = 3000 }) {
    super();
    this.store = store;
    this.runner = runner;
    this.deliver = deliver;
    this.log = log;
    this.file = path.join(dataDir, 'queue.json');
    this.chains = new Map(); // sessionId -> { steps: [{ id, text, added }], paused, note, sentAt, sawBusy }
    try {
      for (const [id, c] of Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8')))) {
        if (Array.isArray(c.steps) && c.steps.length) this.chains.set(id, { steps: c.steps, paused: !!c.paused, note: c.note || '', sentAt: 0, sawBusy: true });
      }
    } catch { /* nothing queued */ }
    this.busy = false;
    this.timer = setInterval(() => this.tick().catch(e => this.log(`[queue] ${e.message}`)), interval);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  save() {
    const out = {};
    for (const [id, c] of this.chains) if (c.steps.length) out[id] = { steps: c.steps, paused: c.paused, note: c.note };
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(out)); } catch (e) { this.log(`[queue] couldn't save: ${e.message}`); }
  }

  view(sessionId) {
    const c = this.chains.get(sessionId);
    return { sessionId, steps: c ? c.steps.map(({ id, text, added }) => ({ id, text, added })) : [], paused: !!c?.paused, note: c?.note || '' };
  }

  changed(sessionId) { this.save(); this.emit('change', this.view(sessionId)); }

  pending(sessionId) { return this.chains.get(sessionId)?.steps.length || 0; }

  // opts: the model, effort and mode picked when the step was added (used if the chat has to be started)
  add(sessionId, text, opts = {}) {
    text = String(text ?? '').trim();
    if (!text) throw httpErr(400, 'empty step');
    if (text.length > 100_000) throw httpErr(413, 'step too long');
    let c = this.chains.get(sessionId);
    if (!c) this.chains.set(sessionId, c = { steps: [], paused: false, note: '', sentAt: 0, sawBusy: true });
    if (c.steps.length >= MAX_STEPS) throw httpErr(409, `at most ${MAX_STEPS} steps can wait`);
    const pick = k => (typeof opts[k] === 'string' && opts[k] ? opts[k].slice(0, 100) : undefined);
    c.steps.push({ id: crypto.randomBytes(6).toString('hex'), text, added: Date.now(), mode: pick('mode'), model: pick('model'), effort: pick('effort') });
    this.changed(sessionId);
    setImmediate(() => this.tick().catch(() => {})); // an idle chat gets it right away
    return this.view(sessionId);
  }

  remove(sessionId, stepId) {
    const c = this.chains.get(sessionId);
    if (c) c.steps = c.steps.filter(s => s.id !== stepId);
    this.changed(sessionId);
    return this.view(sessionId);
  }

  move(sessionId, stepId, by) {
    const c = this.chains.get(sessionId);
    const i = c ? c.steps.findIndex(s => s.id === stepId) : -1;
    const j = i + Math.sign(by);
    if (i >= 0 && j >= 0 && j < c.steps.length) [c.steps[i], c.steps[j]] = [c.steps[j], c.steps[i]];
    this.changed(sessionId);
    return this.view(sessionId);
  }

  clear(sessionId) {
    this.chains.delete(sessionId);
    this.changed(sessionId);
    return this.view(sessionId);
  }

  pause(sessionId, paused) {
    const c = this.chains.get(sessionId);
    // going on after an error: that error is the past, not a reason to stop again
    if (c) { c.paused = !!paused; if (!paused) { c.note = ''; c.sentAt = 0; c.sawBusy = true; } }
    this.changed(sessionId);
    if (!paused) setImmediate(() => this.tick().catch(() => {}));
    return this.view(sessionId);
  }

  // Where the chat is: 'busy' (working, or waiting for an answer or approval), 'idle', 'error' (the
  // last turn failed) or 'stopped' (no process: the next step starts one).
  async stateOf(sessionId) {
    const run = this.runner.bySession(sessionId);
    if (run) {
      if (!this.runner.isIdle(run)) return 'busy';
      return run.lastError ? 'error' : 'idle';
    }
    const live = (await this.store.liveSessions()).find(l => l.sessionId === sessionId);
    if (live) return live.status === 'idle' ? 'idle' : 'busy';
    return 'stopped';
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const [id, c] of this.chains) {
        if (!c.steps.length) { this.chains.delete(id); continue; }
        if (c.paused) continue;
        const state = await this.stateOf(id);
        if (state === 'busy') { c.sawBusy = true; continue; }
        // just sent: give the chat time to pick it up before "idle" counts as done with it
        if (!c.sawBusy && Date.now() - c.sentAt < GRACE_MS) continue;
        if (state === 'error' && c.sentAt) {
          c.paused = true;
          c.note = 'Paused: the last step ended with an error.';
          this.changed(id);
          continue;
        }
        if (await this.store.pendingQuestion(id).catch(() => null)) continue; // Claude asked something
        const step = c.steps.shift();
        c.sentAt = Date.now();
        c.sawBusy = false;
        try {
          await this.deliver(id, step);
          this.log(`[queue] sent the next step to ${id.slice(0, 8)} (${c.steps.length} left)`);
        } catch (e) {
          c.steps.unshift(step);
          c.paused = true;
          c.note = `Paused: couldn't send the next step (${e.message}).`;
        }
        this.changed(id);
      }
    } finally { this.busy = false; }
  }
}
