// Usage page: tokens and an estimated cost per day, project, session and model, read from Claude
// Code's transcripts (every reply records its token counts), plus the plan's limits (the 5-hour session
// and the weekly window) as Claude Code reports them while Handoff runs it.
//
// The cost is what the same tokens would cost on the API at list prices. On a Pro or Max plan nothing
// is billed per token; the estimate shows what is heavy.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectName } from './store.js';

// $ per million tokens: input, output, cache read. Cache writes are 1.25x input (5 minutes) or 2x (1 hour).
// Anthropic's list prices (November 2026). Fast mode costs twice as much.
const PRICES = [
  [/fable-5-2|mythos-5-2/, 8, 40, 0.2],
  [/fable-5-1|mythos-5-1/, 10, 50, 0.25],
  [/fable|mythos/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus-(5|4-[5-9])/, 5, 25, 0.5],
  [/opus/, 15, 75, 1.5],
  [/sonnet-5-5/, 2, 10, 0.1],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet/, 3, 15, 0.3],
  [/haiku-5/, 0.1, 0.5, 0.01],
  [/haiku-4/, 1, 5, 0.1],
  [/haiku/, 0.8, 4, 0.08]
];

export function priceOf(model) {
  const p = PRICES.find(([re]) => re.test(String(model)));
  return p ? { input: p[1], output: p[2], cacheRead: p[3] } : null;
}

// t = [input, output, cache write 5m, cache write 1h, cache read, replies]
export function costOf(model, t, fast = false) {
  const p = priceOf(model);
  if (!p) return 0;
  const usd = (t[0] * p.input + t[1] * p.output + t[2] * p.input * 1.25 + t[3] * p.input * 2 + t[4] * p.cacheRead) / 1e6;
  return fast ? usd * 2 : usd;
}

const CACHE_VERSION = 1;
const pad = n => String(n).padStart(2, '0');
// buckets are hours of the computer's local time: "2026-11-27T16"
const hourKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`; };
const add = (a, b) => { for (let i = 0; i < 6; i++) a[i] += b[i] || 0; return a; };
const zero = () => [0, 0, 0, 0, 0, 0];

export class Usage {
  constructor({ store, dataDir, log = () => {} }) {
    this.store = store;
    this.file = path.join(dataDir, 'usage-cache.json');
    this.log = log;
    this.files = new Map(); // transcript path -> { size, offset, sessionId, key, hours: { hour: { model: tally } }, ids: [] }
    this.loaded = false;
    this.updating = null;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j.v === CACHE_VERSION) for (const [f, e] of Object.entries(j.files || {})) this.files.set(f, e);
    } catch { /* first run: everything is read once */ }
  }

  save() {
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, files: Object.fromEntries(this.files) }));
      fs.renameSync(tmp, this.file);
    } catch (e) { this.log(`[usage] couldn't save the cache: ${e.message}`); }
  }

  // read what was added to each transcript (and its sub-agents) since last time
  update() {
    return (this.updating ||= this.doUpdate().finally(() => { this.updating = null; }));
  }

  async doUpdate() {
    this.load();
    const sessions = await this.store.allSessions();
    const present = new Set();
    let changed = 0;
    for (const s of sessions) {
      const files = [s.file];
      try {
        const dir = path.join(s.file.slice(0, -6), 'subagents');
        for (const n of await fsp.readdir(dir)) if (/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(n)) files.push(path.join(dir, n));
      } catch { /* no sub-agents */ }
      for (const f of files) {
        present.add(f);
        let size;
        try { size = f === s.file ? s.size : (await fsp.stat(f)).size; } catch { continue; }
        const e = this.files.get(f);
        if (e && e.size === size) continue;
        await this.readFile(f, size, s, e);
        changed++;
      }
    }
    for (const f of this.files.keys()) if (!present.has(f)) { this.files.delete(f); changed++; }
    if (changed) this.save();
    return changed;
  }

  async readFile(f, size, s, prev) {
    // a file that got shorter was rewritten: read it again from the start
    const e = prev && size >= prev.offset ? prev : { size: 0, offset: 0, sessionId: s.id, key: s.key, hours: {}, ids: [] };
    const fh = await fsp.open(f, 'r').catch(() => null);
    if (!fh) return;
    try {
      const len = size - e.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, e.offset);
      const end = buf.lastIndexOf(10); // only whole lines; a line being written is read next time
      if (end < 0) { e.size = size; this.files.set(f, e); return; }
      const ids = new Set(e.ids);
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.includes('"usage"')) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        const m = o.message, u = m?.usage;
        if (o.type !== 'assistant' || !u || !m.model || m.model === '<synthetic>') continue;
        // one reply is written as several lines (one per block), each with the same usage
        const id = m.id ? `${m.id}:${o.requestId || ''}` : null;
        if (id) { if (ids.has(id)) continue; ids.add(id); }
        const w1 = Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0;
        const cw = Number(u.cache_creation_input_tokens) || 0;
        const t = [Number(u.input_tokens) || 0, Number(u.output_tokens) || 0, Math.max(0, cw - w1), w1, Number(u.cache_read_input_tokens) || 0, 1];
        const ts = Date.parse(o.timestamp) || Date.now();
        const model = (u.speed === 'fast' ? 'fast:' : '') + m.model;
        const h = (e.hours[hourKey(ts)] ||= {});
        h[model] = add(h[model] || zero(), t);
      }
      e.ids = [...ids].slice(-500);
      e.offset += end + 1;
      e.size = size;
      this.files.set(f, e);
    } finally { await fh.close(); }
  }

  // The usage page. `days`: how far back the per-day, project, session and model lists go.
  async report({ days = 30, now = Date.now() } = {}) {
    await this.update();
    const since = hourKey(now - (days - 1) * 86400e3).slice(0, 10);
    const today = hourKey(now).slice(0, 10);
    const weekFrom = hourKey(now - 6 * 86400e3).slice(0, 10);
    const fiveHours = hourKey(now - 4 * 3600e3); // this hour and the 4 before it
    const blank = () => ({ tokens: zero(), cost: 0 });
    const totals = { today: blank(), week: blank(), range: blank(), fiveHours: blank() };
    const byDay = new Map(), byProject = new Map(), bySession = new Map(), byModel = new Map();
    const tally = (map, k, init) => { let x = map.get(k); if (!x) map.set(k, x = { ...init(), ...blank() }); return x; };
    const put = (x, t, c) => { add(x.tokens, t); x.cost += c; };
    for (const e of this.files.values()) {
      for (const [hour, models] of Object.entries(e.hours)) {
        const day = hour.slice(0, 10);
        for (const [mk, t] of Object.entries(models)) {
          const fast = mk.startsWith('fast:'), model = fast ? mk.slice(5) : mk;
          const c = costOf(model, t, fast);
          if (hour >= fiveHours) put(totals.fiveHours, t, c);
          if (day === today) put(totals.today, t, c);
          if (day >= weekFrom) put(totals.week, t, c);
          if (day < since) continue;
          put(totals.range, t, c);
          put(tally(byDay, day, () => ({ day })), t, c);
          put(tally(byProject, e.key, () => ({ key: e.key })), t, c);
          const s = tally(bySession, e.sessionId, () => ({ id: e.sessionId, key: e.key, last: '' }));
          put(s, t, c);
          if (hour > s.last) s.last = hour;
          put(tally(byModel, model, () => ({ model, priced: !!priceOf(model) })), t, c);
        }
      }
    }
    // every day of the range, so a chart has no gaps
    const dayList = [];
    for (let i = days - 1; i >= 0; i--) { const d = hourKey(now - i * 86400e3).slice(0, 10); dayList.push(byDay.get(d) || { day: d, ...blank() }); }
    const round = x => ({ ...x, cost: Math.round(x.cost * 1e4) / 1e4, tokens: tokensOf(x.tokens) });
    const projects = await this.store.listProjects().catch(() => []);
    const cwdOf = new Map(projects.map(p => [p.key, p.cwd]));
    const top = [...bySession.values()].sort((a, b) => b.cost - a.cost).slice(0, 30);
    const titles = await Promise.all(top.map(s => this.store.sessionInfo(s.id).then(i => i?.title || '', () => '')));
    return {
      days, generatedAt: now,
      totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, round(v)])),
      byDay: dayList.map(round),
      byProject: [...byProject.values()].sort((a, b) => b.cost - a.cost).slice(0, 30).map(p => round({ ...p, cwd: cwdOf.get(p.key) || '', name: cwdOf.get(p.key) ? projectName(cwdOf.get(p.key)) : p.key })),
      bySession: top.map((s, i) => round({ ...s, title: titles[i] || s.id.slice(0, 8), project: cwdOf.get(s.key) ? projectName(cwdOf.get(s.key)) : s.key, last: s.last ? Date.parse(s.last + ':00:00') : 0 })),
      byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost).map(round)
    };
  }
}

const tokensOf = t => ({ input: t[0], output: t[1], cacheWrite: t[2] + t[3], cacheRead: t[4], replies: t[5], total: t[0] + t[1] + t[2] + t[3] + t[4] });

// ---------- the plan's limits ----------
// Claude Code reports them in a rate_limit_event on its output: the 5-hour session window and the
// weekly ones, each with how much is used (0-1, past 1 when over), when it resets and its status.
export class Limits {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'limits.json');
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.state = { windows: {}, at: 0 }; }
  }

  update(info, at = Date.now()) {
    if (!info || typeof info !== 'object') return;
    const w = { ...this.state.windows };
    const put = (name, x) => {
      if (!x || typeof x !== 'object') return;
      const utilization = Number(x.utilization), resetsAt = Number(x.resetsAt);
      if (!Number.isFinite(utilization) && !Number.isFinite(resetsAt)) return;
      w[name] = { utilization: Number.isFinite(utilization) ? utilization : null, resetsAt: Number.isFinite(resetsAt) ? resetsAt * 1000 : null, status: x.status || null, at };
    };
    for (const [name, x] of Object.entries(info.unifiedWindows || {})) put(name, x);
    if (info.rateLimitType) put(info.rateLimitType, info);
    this.state = { windows: w, status: info.status || null, at };
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.state)); } catch { /* shown from memory */ }
  }

  // a window that has reset since it was reported starts again from nothing
  view(now = Date.now()) {
    const windows = {};
    for (const [name, x] of Object.entries(this.state.windows || {})) {
      windows[name] = x.resetsAt && x.resetsAt <= now ? { ...x, utilization: 0, status: 'allowed', reset: true } : x;
    }
    return { at: this.state.at || 0, status: this.state.status || null, windows };
  }
}
