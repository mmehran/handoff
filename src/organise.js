// Organising chats and sharing them.
//
// - SessionMeta: Handoff's own title, pin, tags and archive flag per chat (data/session-meta.json).
//   Claude Code's transcripts are never written to, so a rename here doesn't rename the chat in
//   Claude Desktop, and nothing is lost if Handoff is removed.
// - Shares: read-only links to one chat that expire (data/shares.json). Only a hash of each link's
//   secret is kept; the link itself is shown once.
// - toMarkdown: a chat as a Markdown document (export, print to PDF, and what a share link shows).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { httpErr } from './runner.js';

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value));
  fs.renameSync(file + '.tmp', file);
};

export class SessionMeta {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'session-meta.json');
    this.data = readJson(this.file, {});
  }

  get(id) { return this.data[id] || null; }
  all() { return this.data; }

  // patch: { title, pinned, tags, archived }; a blank title goes back to Claude's own
  set(id, patch = {}) {
    const m = { ...(this.data[id] || {}) };
    if ('title' in patch) {
      const t = String(patch.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (t) m.title = t; else delete m.title;
    }
    if ('pinned' in patch) { if (patch.pinned) m.pinned = Date.now(); else delete m.pinned; }
    if ('archived' in patch) { if (patch.archived) m.archived = Date.now(); else delete m.archived; }
    if ('tags' in patch) {
      if (!Array.isArray(patch.tags)) throw httpErr(400, 'tags: a list of words');
      const tags = [...new Set(patch.tags.map(t => String(t).replace(/[#,]/g, '').trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 10);
      if (tags.length) m.tags = tags; else delete m.tags;
    }
    if (Object.keys(m).length) this.data[id] = m; else delete this.data[id];
    writeJson(this.file, this.data);
    return this.data[id] || {};
  }

  tags() {
    const count = new Map();
    for (const m of Object.values(this.data)) for (const t of m.tags || []) count.set(t, (count.get(t) || 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, n]) => ({ tag, n }));
  }

  // what a list or a page shows for a chat: our title over Claude's, and the flags
  apply(id, item) {
    const m = this.data[id];
    if (!m) return item;
    return { ...item, ...(m.title ? { title: m.title, claudeTitle: item.title } : {}), pinned: m.pinned || null, tags: m.tags || [], archived: m.archived || null };
  }
}

export const SHARE_HOURS = [1, 24, 24 * 7, 24 * 30];

export class Shares {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'shares.json');
    this.list = readJson(this.file, []).filter(s => s.expires > Date.now());
  }

  save() { this.list = this.list.filter(s => s.expires > Date.now()); writeJson(this.file, this.list); }

  create(sessionId, { hours = 24, tools = false } = {}) {
    if (!SHARE_HOURS.includes(Number(hours))) throw httpErr(400, `a link lasts ${SHARE_HOURS.join(', ')} hours`);
    if (this.list.length >= 100) throw httpErr(409, 'too many share links: remove some first');
    const token = crypto.randomBytes(24).toString('base64url');
    const rec = { id: crypto.randomBytes(6).toString('hex'), sessionId, hash: hash(token), tools: !!tools, created: Date.now(), expires: Date.now() + Number(hours) * 3600e3, views: 0 };
    this.list.push(rec);
    this.save();
    return { token, record: publicShare(rec) };
  }

  find(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const h = hash(token);
    const rec = this.list.find(s => crypto.timingSafeEqual(Buffer.from(s.hash, 'hex'), Buffer.from(h, 'hex')));
    if (!rec || rec.expires <= Date.now()) return null;
    rec.views++;
    this.save();
    return rec;
  }

  of(sessionId) { return this.list.filter(s => s.expires > Date.now() && (!sessionId || s.sessionId === sessionId)).map(publicShare); }

  revoke(id) {
    const n = this.list.length;
    this.list = this.list.filter(s => s.id !== id);
    this.save();
    return this.list.length < n;
  }

  revokeAll() { const n = this.list.length; this.list = []; this.save(); return n; }
}

const hash = t => crypto.createHash('sha256').update(t).digest('hex');
const publicShare = ({ hash: _h, ...rest }) => rest;

// ---------- a chat as Markdown ----------
const fence = s => { const n = Math.max(3, ...(String(s).match(/`{3,}/g) || []).map(x => x.length + 1)); return '`'.repeat(n); };

export function toMarkdown({ title, project, events, tools = false, at = Date.now() }) {
  const out = [`# ${title || 'Chat'}`, '', `_${[project, `exported ${new Date(at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`].filter(Boolean).join(' · ')}_`, ''];
  let last = '';
  const head = (who, ts) => {
    if (last === who) return;
    last = who;
    out.push(`## ${who}${ts ? ` · ${new Date(ts).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}`, '');
  };
  for (const e of events) {
    if (e.kind === 'user') { head('You', e.ts); out.push(e.text, ''); }
    else if (e.kind === 'assistant') { head('Claude', e.ts); out.push(e.text, ''); }
    else if (e.kind === 'plan') { head('Claude', e.ts); out.push('**Plan**', '', e.text, ''); }
    else if (e.kind === 'question') {
      head('Claude', e.ts);
      for (const q of e.questions || []) {
        out.push(`**${q.question || q.header}**`, '');
        for (const o of q.options || []) out.push(`${o.n}. ${o.label}${o.description ? ` — ${o.description}` : ''}`);
        out.push('');
      }
    } else if (e.kind === 'system') { last = ''; out.push(`_${e.text}_`, ''); }
    else if (tools && e.kind === 'tool_use') { head('Claude', e.ts); out.push(`> 🔧 **${e.name}** ${e.summary || ''}`.trimEnd(), ''); }
    else if (tools && e.kind === 'tool_result' && e.text) {
      const t = e.text.length > 3000 ? e.text.slice(0, 3000) + '\n…' : e.text;
      const f = fence(t);
      out.push(`${f}${e.isError ? ' error' : ''}`, t, f, '');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
