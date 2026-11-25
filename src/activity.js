// What a session has been doing, worked out from its whole transcript: the to-do list Claude keeps
// (TaskCreate / TaskUpdate, or TodoWrite in older versions), its latest plan, the files it changed,
// the commands it ran, its sub-agent runs, and when it started and last did something.
// Transcripts only ever grow, so each one is read once and after that only its new lines.
import fs from 'node:fs/promises';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const STATUSES = new Set(['pending', 'in_progress', 'completed']);
const MAX_COMMANDS = 300, MAX_FILES = 500, MAX_AGENTS = 100, MAX_TODOS = 200;
const CHUNK = 4 * 1024 * 1024, MAX_LINE = 64 * 1024 * 1024;
const clip = (s, n = 300) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x?.type === 'text' ? x.text : '')).join('\n') : '';
const tag = (s, name) => (new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s) || [])[1];

function fresh(file) {
  return {
    file, offset: 0, todos: [], creates: new Map(), nextTask: 1, plan: null,
    files: new Map(), commands: [], commandById: new Map(), agents: new Map(), tools: 0,
    first: 0, last: 0, prompts: 0
  };
}

export class Activity {
  constructor(store) {
    this.store = store;
    this.cache = new Map(); // sessionId -> state
    this.reading = new Map(); // sessionId -> promise, so callers asking at once share one read
  }

  async of(sessionId) {
    if (!this.reading.has(sessionId)) this.reading.set(sessionId, this.read(sessionId).finally(() => this.reading.delete(sessionId)));
    return this.reading.get(sessionId);
  }

  async read(sessionId) {
    const file = await this.store.sessionFile(sessionId);
    if (!file) return null;
    let size;
    try { size = (await fs.stat(file)).size; } catch { return null; }
    let s = this.cache.get(sessionId);
    if (!s || s.file !== file || size < s.offset) { s = fresh(file); this.cache.set(sessionId, s); }
    if (s.offset < size) {
      const fh = await fs.open(file, 'r');
      try {
        let chunk = CHUNK;
        while (s.offset < size) {
          const len = Math.min(size - s.offset, chunk);
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buf, 0, len, s.offset);
          const nl = buf.lastIndexOf(10, bytesRead - 1);
          if (nl < 0) {
            if (s.offset + bytesRead >= size) break; // the last line is still being written
            if (chunk < MAX_LINE) { chunk *= 2; continue; } // one very long line: read more at once
            s.offset += bytesRead; continue; // absurdly long line: skip past it
          }
          for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) if (line) this.apply(s, line);
          s.offset += nl + 1;
          chunk = CHUNK;
        }
      } finally { await fh.close(); }
    }
    return summary(s);
  }

  apply(s, line) {
    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (!o || o.isSidechain) return;
    const ts = Date.parse(o.timestamp) || 0;
    if (ts) { if (!s.first) s.first = ts; s.last = ts; }
    const c = o.message?.content;
    if (o.type === 'user') {
      if (typeof c === 'string') {
        if (c.includes('<task-notification>')) this.notification(s, c);
        else if (!o.isMeta && c.trim() && !c.trimStart().startsWith('<')) s.prompts++;
        return;
      }
      if (!Array.isArray(c)) return;
      if (!o.isMeta && c.some(b => b?.type === 'text' && b.text?.trim() && !b.text.trimStart().startsWith('<'))) s.prompts++;
      for (const b of c) if (b?.type === 'tool_result') this.result(s, b, o);
    } else if (o.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) if (b?.type === 'tool_use') this.use(s, b, ts);
    }
  }

  use(s, b, ts) {
    s.tools++;
    const i = b.input && typeof b.input === 'object' ? b.input : {};
    const item = (subject, status, activeForm) => ({ id: String(s.nextTask++), subject: clip(subject, 300), status: STATUSES.has(status) ? status : 'pending', activeForm: clip(activeForm || '', 300) });
    if (b.name === 'TodoWrite' && Array.isArray(i.todos)) {
      s.nextTask = 1;
      s.todos = i.todos.slice(0, MAX_TODOS).map(t => item(t.content ?? t.subject, t.status, t.activeForm));
    } else if (b.name === 'TaskCreate') {
      let list = i.tasks; // some versions send a list (sometimes as a JSON string)
      if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
      if (Array.isArray(list)) { for (const t of list) if (s.todos.length < MAX_TODOS) s.todos.push(item(t.content ?? t.subject, t.status, t.activeForm)); }
      else if (s.todos.length < MAX_TODOS) { const t = item(i.subject ?? i.content, i.status, i.activeForm); s.todos.push(t); s.creates.set(b.id, t); }
    } else if (b.name === 'TaskUpdate') {
      const t = s.todos.find(x => x.id === String(i.taskId));
      if (t) {
        if (i.status === 'deleted') s.todos.splice(s.todos.indexOf(t), 1);
        else {
          if (STATUSES.has(i.status)) t.status = i.status;
          if (i.subject) t.subject = clip(i.subject, 300);
          if (i.activeForm) t.activeForm = clip(i.activeForm, 300);
        }
      }
    } else if (b.name === 'ExitPlanMode') {
      s.plan = { toolUseId: b.id, text: clip(i.plan, 20000), ts, status: 'pending', feedback: '' };
    } else if (FILE_TOOLS.has(b.name)) {
      const p = i.file_path || i.notebook_path;
      if (p) {
        const f = s.files.get(p) || { path: String(p), changes: 0, last: 0 };
        f.changes++; f.last = ts; f.tool = b.name;
        s.files.delete(p); s.files.set(p, f); // most recent last
        if (s.files.size > MAX_FILES) s.files.delete(s.files.keys().next().value);
      }
    } else if (SHELL_TOOLS.has(b.name)) {
      const cmd = { id: b.id, command: clip(i.command, 600), description: clip(i.description, 200), ts, ok: null };
      s.commands.push(cmd); s.commandById.set(b.id, cmd);
      if (s.commands.length > MAX_COMMANDS) s.commandById.delete(s.commands.shift().id);
    } else if (AGENT_TOOLS.has(b.name)) {
      s.agents.set(b.id, { toolUseId: b.id, description: clip(i.description, 200), type: String(i.subagent_type || 'general-purpose'), prompt: clip(i.prompt, 3000), ts, status: 'running', result: '', agentId: '' });
      if (s.agents.size > MAX_AGENTS) s.agents.delete(s.agents.keys().next().value);
    }
  }

  result(s, b, o) {
    const id = b.tool_use_id, text = textOf(b.content);
    const created = s.creates.get(id);
    if (created) {
      s.creates.delete(id);
      const m = /Task #(\d+)/.exec(text);
      if (b.is_error) s.todos.splice(s.todos.indexOf(created), 1);
      else if (m) { created.id = m[1]; s.nextTask = Math.max(s.nextTask, Number(m[1]) + 1); }
    }
    if (s.plan?.toolUseId === id) {
      s.plan.status = !b.is_error && /approved/i.test(text) ? 'approved' : 'rejected';
      s.plan.feedback = s.plan.status === 'rejected' ? clip(text, 1000) : '';
    }
    const cmd = s.commandById.get(id);
    if (cmd) cmd.ok = !b.is_error;
    const ag = s.agents.get(id);
    if (ag) {
      const r = o.toolUseResult && typeof o.toolUseResult === 'object' ? o.toolUseResult : {};
      if (r.agentId) ag.agentId = String(r.agentId);
      if (r.status === 'async_launched') ag.status = 'background';
      else { ag.status = b.is_error ? 'failed' : 'done'; ag.result = clip(text, 4000); }
    }
  }

  // a background agent finished: "<task-notification><tool-use-id>…</tool-use-id><status>…"
  notification(s, text) {
    const ag = s.agents.get(tag(text, 'tool-use-id'));
    if (!ag) return;
    const status = tag(text, 'status') || 'completed';
    ag.status = /fail|error|kill|stop/i.test(status) ? 'failed' : 'done';
    ag.result = clip(tag(text, 'result') || tag(text, 'summary') || ag.result, 4000);
    if (!ag.agentId) ag.agentId = tag(text, 'task-id') || '';
  }
}

function summary(s) {
  return {
    todos: s.todos.map(t => ({ ...t })),
    plan: s.plan ? { ...s.plan } : null,
    files: [...s.files.values()].reverse().map(f => ({ ...f })),
    commands: s.commands.slice(-100).reverse().map(({ id, ...c }) => c),
    commandCount: s.commands.length,
    agents: [...s.agents.values()].reverse().map(a => ({ ...a })),
    tools: s.tools, prompts: s.prompts, first: s.first, last: s.last
  };
}
