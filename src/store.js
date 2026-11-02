// Read-only access to Claude Code's on-disk state (~/.claude):
//   projects/<encoded-cwd>/<sessionId>.jsonl   transcripts
//   projects/<encoded-cwd>/<sessionId>/custom-title.json
//   sessions/<pid>.json                        registry of running sessions (desktop + CLI)
import fs from 'node:fs';
import path from 'node:path';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[A-Za-z0-9._-]{1,255}$/;

const TEXT_MAX = 20000, TOOL_RESULT_MAX = 4000, TOOL_INPUT_MAX = 3000;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more chars]` : s);

function readSlice(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

function stripReminders(s) {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

// Turn one transcript/stream-json record into zero or more display events.
export function normalize(o) {
  const out = [];
  if (!o || typeof o !== 'object' || o.isSidechain) return out;
  const base = { uuid: o.uuid, ts: o.timestamp };
  if (o.type === 'user' && o.message) {
    // a prompt delivered from this app into a running desktop/CLI session is stored as a hidden peer message
    if (o.isMeta && o.origin?.kind === 'peer' && typeof o.message.content === 'string') {
      const t = o.message.content.replace(/^Another Claude session sent a message:\n/, '').split(/\n\nThis came from another Claude session/)[0].trim();
      if (t) out.push({ ...base, kind: 'user', text: clip(t, TEXT_MAX), remote: true });
      return out;
    }
    if (o.isMeta) return out;
    const c = o.message.content;
    if (typeof c === 'string') {
      const t = stripReminders(c);
      if (!t) return out;
      if (/^<(command-|local-command|bash-|task-notification)/.test(t)) out.push({ ...base, kind: 'system', text: clip(t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), 500) });
      else out.push({ ...base, kind: 'user', text: clip(t, TEXT_MAX) });
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text') {
          const t = stripReminders(b.text || '');
          if (t) out.push({ ...base, kind: 'user', text: clip(t, TEXT_MAX) });
        } else if (b.type === 'tool_result') {
          let t = '';
          if (typeof b.content === 'string') t = b.content;
          else if (Array.isArray(b.content)) t = b.content.map(x => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n');
          out.push({ ...base, kind: 'tool_result', toolUseId: b.tool_use_id, isError: !!b.is_error, text: clip(stripReminders(t), TOOL_RESULT_MAX) });
        } else if (b.type === 'image') {
          out.push({ ...base, kind: 'user', text: '[image]' });
        }
      }
    }
  } else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
    for (const b of o.message.content) {
      if (b.type === 'text' && b.text?.trim()) out.push({ ...base, kind: 'assistant', text: clip(b.text, TEXT_MAX), error: o.error || undefined });
      else if (b.type === 'tool_use' && b.name === 'AskUserQuestion') {
        // Claude is asking the user to choose — render it as a question card, not a tool call
        out.push({ ...base, kind: 'question', id: b.id, questions: parseQuestions(b.input) });
      } else if (b.type === 'tool_use') {
        let input = '';
        try { input = JSON.stringify(b.input, null, 1); } catch { /* ignore */ }
        out.push({ ...base, kind: 'tool_use', id: b.id, name: b.name, summary: toolSummary(b.name, b.input), input: clip(input, TOOL_INPUT_MAX) });
      }
    }
  } else if (o.type === 'system' && o.subtype === 'compact_boundary') {
    out.push({ ...base, kind: 'system', text: 'Conversation compacted' });
  }
  return out;
}

// AskUserQuestion input -> questions with options numbered 1..N across the whole request,
// so a phone reply can pick an option with a single number.
export function parseQuestions(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  let n = 0;
  return qs.slice(0, 10).map(q => ({
    header: clip(String(q.header || ''), 60),
    question: clip(String(q.question || ''), 1000),
    multiSelect: !!q.multiSelect,
    options: (Array.isArray(q.options) ? q.options : []).slice(0, 8).map(o => ({
      n: ++n,
      label: clip(String(o.label ?? o), 120),
      description: clip(String(o.description || ''), 400)
    }))
  })).filter(q => q.question || q.options.length);
}

function toolSummary(name, input = {}) {
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || input.prompt || '';
  return String(v).split('\n')[0].slice(0, 160);
}

export class Store {
  constructor(cfg) {
    this.home = cfg.claudeHome;
    this.projectsDir = path.join(this.home, 'projects');
    this.registryDir = path.join(this.home, 'sessions');
    this.metaCache = new Map(); // file -> {mtimeMs, size, title, cwd}
    this.fileCache = new Map(); // sessionId -> file
    this.questionCache = new Map(); // sessionId -> {size, value}
  }

  // ----- live registry -----
  liveSessions() {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(this.registryDir); } catch { return out; }
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue; // never touch the *.key files
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.registryDir, n), 'utf8'));
        if (!r.sessionId || !isAlive(r.pid)) continue;
        out.push({
          pid: r.pid, sessionId: r.sessionId, cwd: r.cwd, name: r.name || '', status: r.status || 'unknown',
          waitingFor: typeof r.waitingFor === 'string' ? r.waitingFor.slice(0, 200) : undefined,
          entrypoint: r.entrypoint || r.kind || '', startedAt: r.startedAt, updatedAt: r.updatedAt
        });
      } catch { /* partial write, skip */ }
    }
    return out;
  }

  // ----- projects -----
  listProjects() {
    let dirs = [];
    try { dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return []; }
    const live = this.liveSessions();
    const out = [];
    for (const d of dirs) {
      const dir = path.join(this.projectsDir, d.name);
      let files;
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && UUID_RE.test(f.slice(0, -6))); } catch { continue; }
      if (!files.length) continue;
      let last = 0, lastFile = null;
      for (const f of files) {
        const st = fs.statSync(path.join(dir, f));
        if (st.mtimeMs > last) { last = st.mtimeMs; lastFile = f; }
      }
      const cwd = this.cwdOf(path.join(dir, lastFile)) || d.name;
      const ids = new Set(files.map(f => f.slice(0, -6)));
      out.push({
        key: d.name, cwd, name: projectName(cwd), sessions: files.length, lastActivity: last,
        scratch: /scratch-workspaces/i.test(cwd), live: live.filter(l => ids.has(l.sessionId)).length
      });
    }
    return out.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  projectDir(key) {
    if (!KEY_RE.test(key) || key === '.' || key === '..') return null;
    const dir = path.join(this.projectsDir, key);
    return fs.existsSync(dir) ? dir : null;
  }

  listSessions(key) {
    const dir = this.projectDir(key);
    if (!dir) return null;
    const live = new Map(this.liveSessions().map(l => [l.sessionId, l]));
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      const id = f.slice(0, -6);
      if (!f.endsWith('.jsonl') || !UUID_RE.test(id)) continue;
      const file = path.join(dir, f);
      const meta = this.meta(file);
      const l = live.get(id);
      out.push({ id, title: (l && l.name) || meta.title, mtime: meta.mtimeMs, size: meta.size, live: l ? l.status : null, entrypoint: l?.entrypoint });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  sessionFile(id) {
    if (!UUID_RE.test(id)) return null;
    const cached = this.fileCache.get(id);
    if (cached && fs.existsSync(cached)) return cached;
    let dirs = [];
    try { dirs = fs.readdirSync(this.projectsDir); } catch { return null; }
    for (const d of dirs) {
      const f = path.join(this.projectsDir, d, id + '.jsonl');
      if (fs.existsSync(f)) { this.fileCache.set(id, f); return f; }
    }
    return null;
  }

  sessionInfo(id) {
    const file = this.sessionFile(id);
    if (!file) return null;
    const meta = this.meta(file);
    const l = this.liveSessions().find(x => x.sessionId === id);
    const key = path.basename(path.dirname(file));
    return { id, projectKey: key, cwd: meta.cwd, title: (l && l.name) || meta.title, size: meta.size, mtime: meta.mtimeMs, live: l || null };
  }

  // The question a session is blocked on, if any: the last AskUserQuestion tool_use in the
  // transcript tail that has no tool_result yet. Cached per (file size) so polling stays cheap.
  pendingQuestion(id) {
    const file = this.sessionFile(id);
    if (!file) return null;
    let size;
    try { size = fs.statSync(file).size; } catch { return null; }
    const c = this.questionCache.get(id);
    if (c && c.size === size) return c.value;
    const start = Math.max(0, size - 512 * 1024);
    let text = readSlice(file, start, size - start).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    let asked = null;
    const answered = new Set();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (!line.includes('AskUserQuestion') && !line.includes('tool_result')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const content = (o.message || {}).content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b.type === 'tool_use' && b.name === 'AskUserQuestion') asked = { toolUseId: b.id, questions: parseQuestions(b.input), ts: o.timestamp };
        else if (b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);
      }
    }
    const value = asked && !answered.has(asked.toolUseId) && asked.questions.length ? asked : null;
    this.questionCache.set(id, { size, value });
    return value;
  }

  meta(file) {
    const st = fs.statSync(file);
    const c = this.metaCache.get(file);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c;
    const m = { mtimeMs: st.mtimeMs, size: st.size, title: '', cwd: c?.cwd || '' };
    // 1) title file written by the desktop app / CLI rename
    try {
      const t = JSON.parse(fs.readFileSync(path.join(file.slice(0, -6), 'custom-title.json'), 'utf8'));
      m.title = t.customTitle || '';
    } catch { /* none */ }
    // 2) latest custom-title / ai-title in the tail
    if (!m.title) {
      const tail = readSlice(file, Math.max(0, st.size - 256 * 1024), Math.min(st.size, 256 * 1024)).toString('utf8');
      const all = [...tail.matchAll(/"(?:customTitle|aiTitle)":"((?:[^"\\]|\\.){1,300})"/g)];
      if (all.length) m.title = safeJsonString(all[all.length - 1][1]);
    }
    // 3) first user prompt
    if (!m.title || !m.cwd) {
      const head = readSlice(file, 0, Math.min(st.size, 128 * 1024)).toString('utf8');
      if (!m.cwd) { const cm = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/); if (cm) m.cwd = safeJsonString(cm[1]); }
      if (!m.title) {
        for (const line of head.split('\n')) {
          if (!line.includes('"type":"user"')) continue;
          try {
            const o = JSON.parse(line);
            const ev = normalize(o).find(e => e.kind === 'user');
            if (ev) { m.title = ev.text.split('\n')[0].slice(0, 120); break; }
          } catch { /* partial */ }
        }
      }
    }
    if (!m.title) m.title = '(untitled)';
    this.metaCache.set(file, m);
    return m;
  }

  cwdOf(file) {
    try { return this.meta(file).cwd; } catch { return ''; }
  }

  // Read display events from the end of a transcript, paging backwards via `before` (byte offset).
  readTranscript(id, before, maxBytes = 1024 * 1024) {
    const file = this.sessionFile(id);
    if (!file) return null;
    const size = fs.statSync(file).size;
    const end = before == null ? size : Math.min(Math.max(0, before), size);
    let start = Math.max(0, end - maxBytes);
    let chunk = readSlice(file, start, end - start);
    // grow the window if a single huge line swallowed it (up to 16MB)
    while (start > 0 && chunk.indexOf(10) === -1 && end - start < 16 * 1024 * 1024) {
      start = Math.max(0, end - (end - start) * 2);
      chunk = readSlice(file, start, end - start);
    }
    let text = chunk.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      start += Buffer.byteLength(text.slice(0, nl + 1));
      text = text.slice(nl + 1);
    }
    // a line still being written must be left for the live tail, so `end` stops at the last newline
    let stop = end;
    if (!text.endsWith('\n')) {
      const nl = text.lastIndexOf('\n');
      stop = end - Buffer.byteLength(text.slice(nl + 1));
      text = text.slice(0, nl + 1);
    }
    const events = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(...normalize(JSON.parse(line))); } catch { /* partial line */ }
    }
    return { events, start, end: stop, size };
  }

  // Events appended after byte offset `from` (complete lines only), for clients that can't stream.
  readSince(id, from, maxBytes = 2 * 1024 * 1024) {
    const file = this.sessionFile(id);
    if (!file) return { events: [], end: 0 };
    const size = fs.statSync(file).size;
    if (!(from >= 0) || from > size) from = size;
    const buf = readSlice(file, from, Math.min(size - from, maxBytes));
    const lastNl = buf.lastIndexOf(10);
    if (lastNl < 0) return { events: [], end: from };
    const events = [];
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { events.push(...normalize(JSON.parse(line))); } catch { /* skip */ }
    }
    return { events, end: from + lastNl + 1 };
  }
}

// Follow a growing JSONL file from a byte offset; calls onRecord for each complete line.
export function tailFile(file, from, onRecord) {
  let pos = from, partial = '', closed = false, reading = false;
  const read = () => {
    if (closed || reading) return;
    reading = true;
    try {
      const size = fs.statSync(file).size;
      if (size < pos) pos = size; // truncated/rewritten
      if (size > pos) {
        const buf = readSlice(file, pos, size - pos);
        pos = size;
        const lines = (partial + buf.toString('utf8')).split('\n');
        partial = lines.pop();
        for (const l of lines) { if (l.trim()) { try { onRecord(JSON.parse(l), pos); } catch { /* skip */ } } }
      }
    } catch { /* file gone */ }
    reading = false;
  };
  let watcher = null;
  try { watcher = fs.watch(file, { persistent: false }, read); } catch { /* fall back to polling */ }
  const timer = setInterval(read, watcher ? 3000 : 1000); // safety net; fs.watch can miss events on Windows
  timer.unref?.();
  read();
  return () => { closed = true; clearInterval(timer); watcher?.close(); };
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function projectName(cwd) {
  if (/scratch-workspaces/i.test(cwd)) return 'Desktop scratch · ' + cwd.split(/[\\/]/).pop();
  return cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
}

function safeJsonString(s) {
  try { return JSON.parse('"' + s + '"'); } catch { return s; }
}
