// Full-text search across every chat. Transcripts are mostly tool output (about 99% on real data), so
// the index keeps only what people read: your prompts and Claude's replies, one JSON line per message
// in data/search/<sessionId>.jsonl, with the byte offset of the transcript line it came from.
// Transcripts only grow, so each update reads just what was added since the last one.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { normalize, UUID_RE } from './store.js';

const ENTRY_MAX = 4000;   // characters kept per message
const CHUNK = 1024 * 1024;
const CACHE_MAX = 64 * 1024 * 1024; // index text kept in memory between searches

export class SearchIndex {
  constructor({ store, dir, log = () => {} }) {
    this.store = store;
    this.dir = dir;                 // data/search
    this.log = log;
    this.metaFile = path.join(dir, 'index.json');
    this.sessions = new Map();      // sessionId -> { file, projectKey, cwd, title, size, mtime }
    this.loaded = null;
    this.updating = null;
    this.progress = { done: 0, total: 0 };
    this.cache = new Map();         // sessionId -> index text, so repeat searches skip the disk
    this.cached = 0;
  }

  async entries(id) {
    const hit = this.cache.get(id);
    if (hit !== undefined) return hit;
    let text = '';
    try { text = await fsp.readFile(this.entriesFile(id), 'utf8'); } catch { /* none yet */ }
    if (this.cached + text.length <= CACHE_MAX) { this.cache.set(id, text); this.cached += text.length; }
    return text;
  }
  forget(id) { const t = this.cache.get(id); if (t !== undefined) { this.cached -= t.length; this.cache.delete(id); } }

  async load() {
    await fsp.mkdir(this.dir, { recursive: true });
    try {
      for (const [id, s] of Object.entries(JSON.parse(await fsp.readFile(this.metaFile, 'utf8')))) this.sessions.set(id, s);
    } catch { /* first run */ }
  }
  save() { return fsp.writeFile(this.metaFile, JSON.stringify(Object.fromEntries(this.sessions))).catch(() => {}); }

  // Bring the index up to date with the transcripts on disk. Concurrent callers share one run.
  update() {
    return (this.updating ||= this.run().finally(() => { this.updating = null; }));
  }

  async run() {
    await (this.loaded ||= this.load());
    const files = await this.transcripts();
    const seen = new Set(files.map(f => f.id));
    for (const id of this.sessions.keys()) if (!seen.has(id)) { this.sessions.delete(id); this.forget(id); await fsp.rm(this.entriesFile(id), { force: true }); }
    const todo = files.filter(f => { const s = this.sessions.get(f.id); return !s || s.size !== f.size || s.mtime !== f.mtime; });
    this.progress = { done: files.length - todo.length, total: files.length };
    let changed = 0;
    for (const f of todo) {
      try { await this.index(f); changed++; } catch (e) { this.log(`[search] could not index ${f.id}: ${e.message}`); }
      this.progress.done++;
      if (changed % 20 === 0) await this.save();
      await new Promise(r => setImmediate(r)); // let requests through between files
    }
    if (changed) await this.save();
    return changed;
  }

  async transcripts() {
    const out = [];
    let dirs = [];
    try { dirs = (await fsp.readdir(this.store.projectsDir, { withFileTypes: true })).filter(d => d.isDirectory()); } catch { return out; }
    await Promise.all(dirs.map(async d => {
      let names = [];
      try { names = await fsp.readdir(path.join(this.store.projectsDir, d.name)); } catch { return; }
      await Promise.all(names.filter(n => n.endsWith('.jsonl') && UUID_RE.test(n.slice(0, -6))).map(async n => {
        const file = path.join(this.store.projectsDir, d.name, n);
        try { const st = await fsp.stat(file); out.push({ id: n.slice(0, -6), file, projectKey: d.name, size: st.size, mtime: st.mtimeMs }); } catch { /* gone */ }
      }));
    }));
    return out;
  }

  entriesFile(id) { return path.join(this.dir, id + '.jsonl'); }

  // Read the transcript from where the last run stopped (or from the start if it was rewritten).
  async index(f) {
    const prev = this.sessions.get(f.id);
    const fresh = !prev || f.size < prev.size;
    let pos = fresh ? 0 : prev.size;
    const s = { file: f.file, projectKey: f.projectKey, cwd: fresh ? '' : prev.cwd, title: fresh ? '' : prev.title, size: pos, mtime: f.mtime };
    const out = [];
    const fh = await fsp.open(f.file, 'r');
    try {
      let rest = Buffer.alloc(0), restAt = pos;
      while (pos < f.size) {
        const buf = Buffer.alloc(Math.min(CHUNK, f.size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        let data = rest.length ? Buffer.concat([rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        let start = 0, nl;
        while ((nl = data.indexOf(10, start)) >= 0) {
          this.line(data.subarray(start, nl), restAt + start, s, out);
          start = nl + 1;
        }
        restAt += start;
        rest = Buffer.from(data.subarray(start)); // an unfinished last line waits for the next update
      }
      s.size = restAt;
    } finally { await fh.close(); }
    if (!s.title) s.title = (await this.store.meta(f.file).catch(() => null))?.title || '';
    const text = out.map(e => JSON.stringify(e)).join('\n') + (out.length ? '\n' : '');
    if (fresh) await fsp.writeFile(this.entriesFile(f.id), text);
    else if (text) await fsp.appendFile(this.entriesFile(f.id), text);
    if (fresh || text) this.forget(f.id);
    this.sessions.set(f.id, s);
  }

  line(bytes, offset, s, out) {
    // titles and the working folder are cheap to spot; only user/assistant lines are worth parsing
    const str = bytes.toString('utf8');
    if (str.includes('"customTitle"') || str.includes('"aiTitle"')) {
      const m = /"(?:customTitle|aiTitle)":"((?:[^"\\]|\\.){1,300})"/.exec(str);
      if (m) try { s.title = JSON.parse(`"${m[1]}"`); } catch { /* ignore */ }
    }
    if (!s.cwd) { const c = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(str); if (c) try { s.cwd = JSON.parse(`"${c[1]}"`); } catch { /* ignore */ } }
    if (!str.includes('"type":"user"') && !str.includes('"type":"assistant"')) return;
    let o;
    try { o = JSON.parse(str); } catch { return; }
    for (const e of normalize(o)) {
      if ((e.kind === 'user' || e.kind === 'assistant') && e.text) out.push({ o: offset, k: e.kind === 'user' ? 'u' : 'a', t: e.text.slice(0, ENTRY_MAX), ts: o.timestamp });
    }
  }

  // All words must appear (case-insensitive, anywhere). Newest sessions first.
  // Returns { results: [{ sessionId, projectKey, cwd, title, mtime, titleMatch, hits: [{ offset, kind, snippet, ts }] }], indexing }
  async search(q, { sessionId = null, maxSessions = 30, maxHits = 3 } = {}) {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return { results: [], indexing: this.progress };
    await this.update();
    const list = [...this.sessions.entries()].filter(([id]) => !sessionId || id === sessionId).sort((a, b) => b[1].mtime - a[1].mtime);
    const results = [];
    const all = s => terms.every(t => s.includes(t));
    for (const [id, s] of list) {
      if (results.length >= maxSessions) break;
      const titleMatch = all(String(s.title).toLowerCase());
      const entries = await this.entries(id);
      const hits = [];
      for (const line of entries.split('\n')) {
        if (!line || !all(line.toLowerCase())) continue; // quick check on the raw line, exact check below
        let e; try { e = JSON.parse(line); } catch { continue; }
        const low = e.t.toLowerCase();
        if (!all(low)) continue;
        hits.push({ offset: e.o, kind: e.k === 'u' ? 'user' : 'assistant', snippet: snippet(e.t, low, terms), ts: e.ts });
      }
      if (!hits.length && !titleMatch) continue;
      // newest messages first within a session
      hits.reverse();
      results.push({ sessionId: id, projectKey: s.projectKey, cwd: s.cwd, title: s.title || '(untitled)', mtime: s.mtime, titleMatch, total: hits.length, hits: hits.slice(0, sessionId ? 200 : maxHits) });
    }
    return { results, indexing: this.progress };
  }
}

function snippet(text, low, terms) {
  const at = Math.max(0, Math.min(...terms.map(t => low.indexOf(t)).filter(i => i >= 0)));
  const start = Math.max(0, at - 70);
  const s = text.slice(start, at + 150).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + s + (at + 150 < text.length ? '…' : '');
}
