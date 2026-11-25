// API keys for the API part (HANDOFF_API), and what Handoff remembers about their use.
//
//   data/api-keys.json      the keys: only a SHA-256 of each key is kept (a key is 32 random bytes, so
//                           a plain hash is enough), plus its settings. Mode 0600. The running server
//                           re-reads it when `node scripts/api-key.js` changes it.
//   data/api-usage.json     turns, tokens and cost per key per day (90 days)
//   data/api-sessions.json  which sessions an API key started (for labels, filters and rules)
//   data/api-turns.json     a short note per turn, so a turn id from before a restart still says where
//                           its answer is
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { PERMISSION_MODES, EFFORTS, httpErr } from './runner.js';

export const SCOPES = ['read', 'chat', 'approve', 'files', 'git'];
export const TOOL_PRESETS = ['all', 'readOnly', 'none'];
export const LENGTHS = ['brief', 'normal', 'detailed'];
const MODEL_RE = /^[A-Za-z0-9._\-[\]]{1,64}$/;
const DAY = 86400e3;

// one tap in the New key form; every field can still be changed
export const PRESETS = {
  phone: { label: 'Phone shortcut', scopes: ['read', 'chat'], tools: 'readOnly', modes: ['manual'], defaultMode: 'manual', defaults: { model: 'haiku', effort: 'low', plain: true } },
  automation: { label: 'Automation', scopes: ['read', 'chat', 'approve', 'files'], tools: 'all', modes: ['manual', 'plan', 'acceptEdits'], defaultMode: 'manual', defaults: {} },
  chat: { label: 'Chat app', scopes: ['read', 'chat'], tools: 'none', modes: ['manual'], defaultMode: 'manual', defaults: {} }
};

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
// the computer's own date, so "today" and "until midnight" mean what they say on the laptop
export const dayOf = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const isWithin = (child, root) => { const rel = path.relative(path.resolve(root), path.resolve(child)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const readJsonFile = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writePrivate = (f, obj) => { fs.writeFileSync(f, JSON.stringify(obj, null, 1), { mode: 0o600 }); try { fs.chmodSync(f, 0o600); } catch { /* not supported */ } };

export class KeyStore {
  constructor({ cfg, dir = DATA_DIR } = {}) {
    this.cfg = cfg || {};
    this.file = path.join(dir, 'api-keys.json');
    this.usageFile = path.join(dir, 'api-usage.json');
    this.sessionsFile = path.join(dir, 'api-sessions.json');
    this.turnsFile = path.join(dir, 'api-turns.json');
    this.mtime = -1;
    this.keys = [];
    this.byHash = new Map();
    this.rate = new Map();    // keyId -> request times in the last minute
    this.bad = new Map();     // ip -> wrong-key times in the last 15 minutes
    this.idem = new Map();    // `${keyId}:${Idempotency-Key}` -> { value, at }
    this.usage = readJsonFile(this.usageFile, {});
    this.sessions = readJsonFile(this.sessionsFile, {});
    this.turns = readJsonFile(this.turnsFile, {});
    this.timers = {};
    this.refresh();
  }

  // ----- the keys file -----
  refresh() {
    let st;
    try { st = fs.statSync(this.file); } catch { if (this.mtime !== 0) { this.keys = []; this.byHash.clear(); this.mtime = 0; } return; }
    if (st.mtimeMs === this.mtime) return;
    this.keys = (readJsonFile(this.file, {}).keys || []).filter(k => k && k.id && k.hash);
    this.byHash = new Map(this.keys.map(k => [k.hash, k]));
    this.mtime = st.mtimeMs;
  }
  mutate(fn) {
    this.refresh();
    const r = fn();
    writePrivate(this.file, { keys: this.keys });
    this.byHash = new Map(this.keys.map(k => [k.hash, k]));
    try { this.mtime = fs.statSync(this.file).mtimeMs; } catch { /* written just now */ }
    return r;
  }
  get count() { this.refresh(); return this.keys.length; }
  list() { this.refresh(); return this.keys.map(k => this.view(k)); }
  get(id) { this.refresh(); return this.keys.find(k => k.id === id) || null; }
  // by id, the key's first characters, or its name (for the terminal script)
  find(s) {
    this.refresh();
    const q = String(s || '').trim();
    return this.keys.find(k => k.id === q) || this.keys.find(k => q.length >= 6 && k.prefix.startsWith(q)) || this.keys.find(k => k.name.toLowerCase() === q.toLowerCase()) || null;
  }

  // what may be shown about a key: everything but its hash
  view(k) {
    const { hash, ...rest } = k;
    return { ...rest, full: this.isFull(k), today: this.today(k.id), expired: !!(k.expiresAt && Date.now() > k.expiresAt) };
  }
  isFull(k) {
    return SCOPES.every(s => k.scopes.includes(s)) && !k.projects && k.tools === 'all' && this.availableModes().every(m => k.modes.includes(m));
  }
  availableModes() { return PERMISSION_MODES.filter(m => m !== 'bypassPermissions' || this.cfg.allowBypassPermissions); }

  // Checks and fills in a key's settings: a preset first, then what was given. Throws a 400 with a
  // message a person can act on.
  settings(o = {}) {
    const preset = o.preset && PRESETS[o.preset] ? PRESETS[o.preset] : null;
    if (o.preset && !preset && o.preset !== 'custom') throw httpErr(400, `unknown preset: use one of ${Object.keys(PRESETS).join(', ')} or custom`);
    const pick = (k, d) => (o[k] !== undefined && o[k] !== null && o[k] !== '' ? o[k] : (preset?.[k] ?? d));
    const name = String(o.name || '').trim().slice(0, 60);
    if (!name) throw httpErr(400, 'give the key a name, e.g. "iPhone shortcut"');
    const scopes = [...new Set([].concat(pick('scopes', ['read', 'chat'])).map(String))];
    if (!scopes.length || scopes.some(s => !SCOPES.includes(s))) throw httpErr(400, `scopes: one or more of ${SCOPES.join(', ')}`);
    let projects = o.projects == null || o.projects === 'all' || (Array.isArray(o.projects) && !o.projects.length) ? null : [].concat(o.projects).map(p => String(p).trim()).filter(Boolean);
    if (projects) {
      if (projects.length > 20) throw httpErr(400, 'at most 20 project folders per key');
      projects = projects.map(p => {
        if (!path.isAbsolute(p)) throw httpErr(400, `project folders must be full paths: ${p}`);
        return path.resolve(p);
      });
      if (this.cfg.allowedRoots?.length) for (const p of projects) if (!this.cfg.allowedRoots.some(r => isWithin(p, r))) throw httpErr(400, `outside HANDOFF_ALLOWED_ROOTS: ${p}`);
    }
    const modes = [...new Set([].concat(pick('modes', ['manual'])).map(m => (m === 'default' ? 'manual' : String(m))))];
    if (!modes.length || modes.some(m => !PERMISSION_MODES.includes(m))) throw httpErr(400, `modes: one or more of ${PERMISSION_MODES.join(', ')}`);
    if (modes.includes('bypassPermissions') && !this.cfg.allowBypassPermissions) throw httpErr(400, 'bypassPermissions is turned off in this Handoff (HANDOFF_ALLOW_BYPASS)');
    if (projects && modes.some(m => m === 'auto' || m === 'bypassPermissions')) throw httpErr(400, 'auto and bypassPermissions are only for keys with every project: they let Claude act without asking');
    const defaultMode = String(pick('defaultMode', modes[0]));
    if (!modes.includes(defaultMode)) throw httpErr(400, 'the default mode must be one of the key\'s modes');
    const tools = String(pick('tools', 'all'));
    if (!TOOL_PRESETS.includes(tools)) throw httpErr(400, `tools: one of ${TOOL_PRESETS.join(', ')}`);
    const num = (v, min, max, d) => { if (v == null || v === '') return d; const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw httpErr(400, `a number from ${min} to ${max} was expected, got ${v}`); return n; };
    // what was given wins over the preset, but only where something was given
    const given = Object.fromEntries(Object.entries(o.defaults || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    const d = { ...(preset?.defaults || {}), ...given };
    const defaults = {};
    if (d.model) { if (!MODEL_RE.test(String(d.model))) throw httpErr(400, 'invalid default model'); defaults.model = String(d.model); }
    if (d.effort) { if (!EFFORTS.includes(d.effort)) throw httpErr(400, `effort: one of ${EFFORTS.join(', ')}`); defaults.effort = d.effort; }
    if (d.plain) defaults.plain = true;
    if (d.language) defaults.language = String(d.language).trim().slice(0, 40);
    if (d.length) { if (!LENGTHS.includes(d.length)) throw httpErr(400, `length: one of ${LENGTHS.join(', ')}`); defaults.length = d.length; }
    const expiresDays = num(o.expiresDays, 1, 3650, null);
    return {
      name, scopes, projects, modes, defaultMode, tools, defaults,
      preset: preset ? o.preset : 'custom',
      alerts: !!o.alerts,
      rateLimit: num(o.rateLimit, 1, 600, 30),
      maxTurns: num(o.maxTurns, 1, 10, 2),
      dailyBudgetUsd: num(o.dailyBudgetUsd, 0.01, 10000, null),
      expiresAt: expiresDays ? Date.now() + expiresDays * DAY : null
    };
  }

  // -> { key (shown once), record }
  create(o) {
    const s = this.settings(o);
    const key = 'hk_' + crypto.randomBytes(32).toString('base64url');
    const rec = {
      id: 'key_' + crypto.randomBytes(6).toString('hex'), ...s, prefix: key.slice(0, 10), hash: sha(key),
      webhookSecret: 'whsec_' + crypto.randomBytes(24).toString('base64url'),
      createdAt: Date.now(), lastUsedAt: null, lastIp: null, selection: null
    };
    this.mutate(() => { this.keys.push(rec); });
    return { key, record: this.view(rec) };
  }
  revoke(id) { return this.mutate(() => { const n = this.keys.length; this.keys = this.keys.filter(k => k.id !== id); return this.keys.length < n; }); }
  revokeAll() { return this.mutate(() => { const n = this.keys.length; this.keys = []; return n; }); }

  // the key's record, or null (unknown, revoked or expired)
  verify(key) {
    if (!key || typeof key !== 'string' || key.length > 200) return null;
    this.refresh();
    const k = this.byHash.get(sha(key));
    if (!k || (k.expiresAt && Date.now() > k.expiresAt)) return null;
    return k;
  }
  // last use and where from, written at most once a minute per key (or when the address changes)
  touch(k, ip) {
    if (Date.now() - (k.lastUsedAt || 0) < 60e3 && k.lastIp === ip) return;
    this.mutate(() => { const r = this.keys.find(x => x.id === k.id); if (r) { r.lastUsedAt = Date.now(); r.lastIp = ip; } });
  }
  setSelection(id, sessionId) {
    this.mutate(() => { const r = this.keys.find(x => x.id === id); if (r) r.selection = sessionId || null; });
  }

  // ----- limits -----
  // requests per minute per key -> { ok, retryAfter (s) }
  allow(k, now = Date.now()) {
    const times = (this.rate.get(k.id) || []).filter(t => now - t < 60e3);
    if (times.length >= (k.rateLimit || 30)) { this.rate.set(k.id, times); return { ok: false, retryAfter: Math.max(1, Math.ceil((times[0] + 60e3 - now) / 1000)) }; }
    times.push(now);
    this.rate.set(k.id, times);
    return { ok: true };
  }
  // wrong keys, per address only: 5 in 15 minutes block that address for 15 minutes. (A lock for
  // everyone would let anyone lock you out.)
  blocked(ip, now = Date.now()) { return (this.bad.get(ip) || []).filter(t => now - t < 15 * 60e3).length >= 5; }
  fail(ip, now = Date.now()) {
    const times = (this.bad.get(ip) || []).filter(t => now - t < 15 * 60e3);
    times.push(now);
    this.bad.set(ip, times);
    if (this.bad.size > 5000) this.bad.delete(this.bad.keys().next().value);
  }

  // ----- the same request twice (Idempotency-Key) -----
  idempotent(keyId, idemKey) {
    if (!idemKey) return null;
    const e = this.idem.get(`${keyId}:${idemKey}`);
    return e && Date.now() - e.at < DAY ? e.value : null;
  }
  remember(keyId, idemKey, value) {
    if (!idemKey) return;
    this.idem.set(`${keyId}:${String(idemKey).slice(0, 200)}`, { value, at: Date.now() });
    if (this.idem.size > 5000) this.idem.delete(this.idem.keys().next().value);
  }

  // ----- usage per day -----
  addUsage(keyId, { turns = 1, costUsd = 0, inputTokens = 0, outputTokens = 0 } = {}) {
    const day = dayOf();
    const u = ((this.usage[keyId] ||= {})[day] ||= { turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 });
    u.turns += turns; u.costUsd = Math.round((u.costUsd + (costUsd || 0)) * 1e6) / 1e6;
    u.inputTokens += inputTokens || 0; u.outputTokens += outputTokens || 0;
    this.later('usage', () => {
      const oldest = dayOf(Date.now() - 90 * DAY);
      for (const days of Object.values(this.usage)) for (const d of Object.keys(days)) if (d < oldest) delete days[d];
      writePrivate(this.usageFile, this.usage);
    });
  }
  today(keyId) { return this.usage[keyId]?.[dayOf()] || { turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 }; }
  usageDays(keyId, days = 30) {
    const out = [];
    for (let i = Math.min(Math.max(1, days), 90) - 1; i >= 0; i--) {
      const day = dayOf(Date.now() - i * DAY);
      out.push({ day, ...(this.usage[keyId]?.[day] || { turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 }) });
    }
    return out;
  }
  overBudget(k) { return !!(k.dailyBudgetUsd && this.today(k.id).costUsd >= k.dailyBudgetUsd); }

  // ----- sessions an API key started -----
  // forkOf: the session this one is a copy of (a limited key's own copy of someone else's session)
  markSession(sessionId, k, { forkOf = null } = {}) {
    if (!sessionId || this.sessions[sessionId]) return;
    this.sessions[sessionId] = { keyId: k.id, keyName: k.name, at: Date.now(), ...(forkOf ? { forkOf } : {}) };
    const ids = Object.keys(this.sessions);
    if (ids.length > 5000) for (const id of ids.slice(0, ids.length - 5000)) delete this.sessions[id];
    this.later('sessions', () => writePrivate(this.sessionsFile, this.sessions));
  }
  sessionKey(sessionId) { return this.sessions[sessionId] || null; }
  // a key's latest copy of a session, so it keeps talking in the same copy
  forkFor(keyId, sessionId) {
    let best = null;
    for (const [id, s] of Object.entries(this.sessions)) if (s.keyId === keyId && s.forkOf === sessionId && (!best || s.at > best.at)) best = { id, at: s.at };
    return best?.id || null;
  }

  // ----- notes about turns, kept across restarts -----
  noteTurn(t) {
    this.turns[t.id] = { sessionId: t.sessionId || null, keyId: t.keyId, status: t.status, at: t.createdAt, prompt: String(t.prompt || '').slice(0, 120), costUsd: t.usage?.costUsd ?? null, endedAt: t.endedAt || null };
    const ids = Object.keys(this.turns);
    if (ids.length > 2000) for (const id of ids.slice(0, ids.length - 2000)) delete this.turns[id];
    this.later('turns', () => writePrivate(this.turnsFile, this.turns));
  }
  turnNote(id) { return this.turns[id] || null; }
  turnNotes(keyId) { return Object.entries(this.turns).filter(([, t]) => t.keyId === keyId).map(([id, t]) => ({ id, ...t })); }

  // writes that can wait a moment, so many changes make one write
  later(what, fn) {
    (this.writers ||= {})[what] = fn;
    if (this.timers[what]) return;
    this.timers[what] = setTimeout(() => { this.timers[what] = null; try { fn(); } catch { /* disk full etc.: kept in memory */ } }, 1000);
    this.timers[what].unref?.();
  }
  // on the way out: whatever is still waiting to be written
  flush() {
    for (const [what, t] of Object.entries(this.timers)) {
      if (!t) continue;
      clearTimeout(t); this.timers[what] = null;
      try { this.writers[what](); } catch { /* best effort */ }
    }
  }
}
