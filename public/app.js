'use strict';
// Handoff — vanilla SPA. All untrusted text is inserted with textContent (no innerHTML).

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const state = { me: null, runs: new Map(), perms: new Map(), es: null, projects: [], options: null, cleanup: [] };
// same labels as Claude Desktop's menus
const MODE_LABELS = { manual: 'Ask permissions', acceptEdits: 'Accept edits', plan: 'Plan mode', auto: 'Auto', bypassPermissions: 'Bypass permissions' };
const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('handoff.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('handoff.' + k, JSON.stringify(v)); } catch { /* private mode */ } }
};
const optionsReady = () => state.options ? Promise.resolve(state.options)
  : (state.optionsP ||= api('GET', '/api/options').then(o => (state.options = o)).catch(() => null));

// Model / effort / mode menus. `current` (a running session's settings) wins over the last choice.
function makePickers(current = {}) {
  const saved = store.get('pick', {});
  const model = h('select', { 'aria-label': 'Model', class: 'pick' });
  const effort = h('select', { 'aria-label': 'Effort', class: 'pick' });
  const mode = h('select', { 'aria-label': 'Mode', class: 'pick' });
  const fill = (o) => {
    const want = { model: current.model || saved.model || 'default', effort: current.effort || saved.effort || '', mode: current.mode || saved.mode || o.defaultMode };
    model.replaceChildren(...o.models.map(m => h('option', { value: m.value, title: m.description, selected: m.value === want.model }, m.displayName)));
    if (!o.models.some(m => m.value === want.model)) model.value = o.models[0]?.value;
    const sync = () => {
      const m = o.models.find(x => x.value === model.value) || {};
      const prevEffort = effort.value || want.effort;
      effort.replaceChildren(h('option', { value: '' }, 'Default effort'),
        ...(m.supportedEffortLevels || []).map(e => h('option', { value: e, selected: e === prevEffort }, EFFORT_LABELS[e] || e)));
      effort.hidden = !m.supportsEffort;
      const prevMode = mode.value || want.mode;
      const modes = o.modes.filter(x => MODE_LABELS[x] && (x !== 'auto' || m.supportsAutoMode) && (x !== 'bypassPermissions' || o.allowBypass));
      mode.replaceChildren(...modes.map(x => h('option', { value: x, selected: x === prevMode }, MODE_LABELS[x])));
      if (!modes.includes(mode.value)) mode.value = modes.includes(o.defaultMode) ? o.defaultMode : modes[0];
    };
    sync();
    model.addEventListener('change', sync);
  };
  model.append(h('option', {}, 'Loading models…'));
  optionsReady().then(o => o && fill(o));
  const values = () => {
    const v = { model: model.value, effort: effort.hidden ? '' : effort.value, mode: mode.value };
    store.set('pick', v);
    return { model: v.model || undefined, effort: v.effort || undefined, mode: v.mode || undefined };
  };
  return { model, effort, mode, values, els: [model, effort, mode] };
}

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

function toast(msg, ms = 3000) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
const size = b => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json', 'X-Handoff': '1' } : { 'X-Handoff': '1' },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- markdown (safe: builds DOM nodes) ----------
function md(text) {
  const frag = document.createDocumentFragment();
  const parts = String(text).split(/```[^\n]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) { frag.append(h('pre', {}, h('code', { text: part.replace(/\n$/, '') }))); return; }
    let list = null;
    for (const block of part.split(/\n{2,}/)) {
      const lines = block.split('\n');
      for (const line of lines) {
        const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
        if (li) { if (!list) { list = h('ul'); frag.append(list); } list.append(h('li', {}, inline(li[1]))); continue; }
        list = null;
        const hd = line.match(/^(#{1,4})\s+(.*)/);
        if (hd) { frag.append(h(hd[1].length <= 2 ? 'h3' : 'h4', {}, inline(hd[2]))); continue; }
        if (line.trim()) { const p = h('p', {}, inline(line)); frag.append(p); }
      }
    }
  });
  return frag;
}
function inline(s) {
  const out = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(m[0][0] === '`' ? h('code', { text: m[0].slice(1, -1) }) : h('b', { text: m[0].slice(2, -2) }));
    last = m.index + m[0].length;
  }
  out.push(s.slice(last));
  return out;
}

// ---------- chrome ----------
function setTop(title, backHref) {
  $('#title').textContent = title;
  const b = $('#back');
  b.hidden = !backHref;
  b.onclick = () => (location.hash = backHref);
  $('#menu').hidden = !state.me;
}

$('#menu').addEventListener('click', () => {
  const sheet = h('div', { class: 'list' },
    h('button', { class: 'btn', onclick: () => { location.hash = '#/new'; close(); } }, '+ New session'),
    h('button', { class: 'btn', onclick: async () => {
      try { await api('POST', '/api/notify/test'); toast('Test WhatsApp message sent'); }
      catch (x) { toast('WhatsApp: ' + x.message, 6000); }
      close();
    } }, 'Send test WhatsApp'),
    h('button', { class: 'btn', onclick: async () => { await api('POST', '/api/logout'); location.reload(); } }, 'Sign out'),
    h('button', { class: 'btn danger', onclick: async () => { if (confirm('Sign out every device?')) { await api('POST', '/api/logout-all'); location.reload(); } } }, 'Sign out all devices'),
    h('button', { class: 'btn', onclick: () => close() }, 'Close'));
  const wrap = h('div', { class: 'perm' }, sheet);
  const ps = $('#perm-sheet');
  ps.replaceChildren(wrap); ps.hidden = false; ps.dataset.kind = 'menu';
  function close() { ps.dataset.kind = ''; renderPerms(); }
});

// ---------- login ----------
function showLogin() {
  state.me = null;
  state.es?.close(); state.es = null;
  setTop('Handoff');
  const err = h('div', { class: 'err' });
  const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
  const code = h('input', { type: 'text', placeholder: '6-digit code (2FA)', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'login', onsubmit: async e => {
    e.preventDefault(); btn.disabled = true; err.textContent = '';
    try { await api('POST', '/api/login', { password: pw.value, code: code.value }); await boot(); }
    catch (x) { err.textContent = x.message; btn.disabled = false; }
  } }, h('h1', {}, 'Handoff'), h('div', { class: 'muted small' }, 'Remote control for Claude Code on your laptop'), pw, code, btn, err);
  view.replaceChildren(form);
  pw.focus();
}

// ---------- global events (runs + permissions) ----------
// Run status + approvals arrive over an event stream. Some proxies (e.g. Cloudflare quick tunnels)
// buffer streams, so if the stream says nothing within 5s we poll /api/live every 3s instead.
// Phones drop the stream whenever the screen locks or the network changes, so it is watched:
// while it is down we poll instead (yellow dot), reopen it, and reopen at once when the page
// becomes visible again. Red only means the laptop really can't be reached.
const setConn = (cls, title) => { const c = $('#conn'); c.className = 'dot ' + cls; c.title = title; };
function connectEvents() {
  state.es?.close();
  clearInterval(state.livePoll); state.livePoll = null;
  clearTimeout(state.esRetry);
  const es = new EventSource('/api/events');
  state.es = es;
  state.esSeen = Date.now();
  let streaming = false;
  const applyLive = (runs, perms) => {
    state.runs = new Map(runs.map(r => [r.sessionId || r.runId, r]));
    const before = state.perms.size;
    state.perms = new Map(perms.map(p => [p.id, p]));
    if (state.perms.size > before && navigator.vibrate) navigator.vibrate(150);
    renderPerms(); onRunChange();
  };
  const startPolling = () => {
    if (state.livePoll || state.es !== es) return;
    const poll = () => api('GET', '/api/live')
      .then(d => { applyLive(d.runs, d.permissions); if (!streaming) setConn('poll', 'live updates by polling'); })
      .catch(x => { if (x.message !== 'unauthorized') setConn('off', 'offline: cannot reach the laptop, retrying'); });
    poll(); state.livePoll = setInterval(poll, 3000);
  };
  setTimeout(() => { if (!streaming) startPolling(); }, 5000);
  es.addEventListener('error', () => {
    if (state.es !== es) return;
    streaming = false;
    startPolling();
    // CLOSED means the browser gave up on its own retries: reopen ourselves
    if (es.readyState === EventSource.CLOSED) state.esRetry = setTimeout(connectEvents, 3000);
  });
  es.addEventListener('ping', () => { state.esSeen = Date.now(); });
  es.addEventListener('hello', e => {
    streaming = true; state.esSeen = Date.now();
    clearInterval(state.livePoll); state.livePoll = null;
    setConn('on', 'live');
    const d = JSON.parse(e.data);
    applyLive(d.runs, d.permissions);
  });
  es.addEventListener('run', e => {
    const r = JSON.parse(e.data);
    if (r.status === 'exited') state.runs.delete(r.sessionId || r.runId); else state.runs.set(r.sessionId || r.runId, r);
    if (r.result?.isError) toast('Claude: ' + r.result.text.slice(0, 160), 6000);
    if (r.status === 'exited' && r.lastError) toast(r.lastError.slice(0, 200), 8000);
    onRunChange(r);
  });
  es.addEventListener('permission', e => {
    const p = JSON.parse(e.data); state.perms.set(p.id, p); renderPerms();
    if (navigator.vibrate) navigator.vibrate(150);
  });
  es.addEventListener('permission_resolved', e => { state.perms.delete(JSON.parse(e.data).id); renderPerms(); });
}

function renderPerms() {
  const ps = $('#perm-sheet');
  const items = [...state.perms.values()];
  const ids = items.map(p => p.id).join(',');
  if (ps.dataset.kind === 'menu') return; // the menu is open; approvals show again when it closes
  if (ids === renderPerms.shown && ps.dataset.kind === 'perms') return; // unchanged: keep buttons stable under the finger
  renderPerms.shown = ids;
  ps.dataset.kind = 'perms';
  if (!items.length) { ps.hidden = true; ps.replaceChildren(); return; }
  ps.replaceChildren(...items.map(p => {
    const decide = async (allow, alwaysMode) => {
      try { await api('POST', `/api/permissions/${p.id}`, { allow, alwaysMode }); state.perms.delete(p.id); renderPerms(); }
      catch (x) { toast(x.message); state.perms.delete(p.id); renderPerms(); }
    };
    return h('div', { class: 'perm' },
      h('div', { class: 'row' }, h('b', {}, `Allow ${p.tool}?`), h('span', { class: 'grow' }),
        h('a', { href: `#/s/${p.sessionId}`, class: 'small muted' }, 'open session')),
      h('div', { class: 'small muted mono' }, p.cwd),
      h('pre', { text: p.input }),
      h('div', { class: 'row' },
        h('button', { class: 'btn ok', onclick: () => decide(true) }, 'Allow'),
        p.tool && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(p.tool) ? h('button', { class: 'btn', onclick: () => decide(true, 'acceptEdits') }, 'Allow all edits') : null,
        h('button', { class: 'btn danger', onclick: () => decide(false) }, 'Deny')));
  }));
  ps.hidden = false;
}

let runListeners = [];
function onRunChange(r) { runListeners.forEach(fn => fn(r)); }

// ---------- views ----------
async function homeView() {
  setTop('Handoff');
  const live = h('div', { class: 'list' }, h('div', { class: 'muted small' }, 'Loading…'));
  const filter = h('input', { type: 'search', placeholder: 'Filter projects…' });
  const projList = h('div', { class: 'list' });
  view.replaceChildren(
    h('div', { class: 'row' }, h('a', { href: '#/new', class: 'btn primary' }, '+ New session'), h('span', { class: 'grow' })),
    h('h2', {}, 'Live now'), live,
    h('h2', {}, 'Projects'), filter, projList);

  const loadLive = async () => {
    const d = await api('GET', '/api/live');
    const seen = new Set();
    const cards = [];
    for (const r of d.runs) {
      if (!r.sessionId) continue;
      seen.add(r.sessionId);
      cards.push(h('a', { class: 'card', href: `#/s/${r.sessionId}` },
        h('div', { class: 't' }, r.title || 'Remote session', h('span', { class: `chip ${r.status}` }, 'remote · ' + r.status)),
        h('div', { class: 's' }, r.cwd)));
    }
    for (const l of d.live) {
      if (seen.has(l.sessionId)) continue;
      cards.push(h('a', { class: 'card', href: `#/s/${l.sessionId}` },
        h('div', { class: 't' }, l.title || l.name || l.sessionId.slice(0, 8),
          l.question ? h('span', { class: 'chip question' }, 'question') : h('span', { class: `chip ${l.status}` }, l.status)),
        h('div', { class: 's' }, `${l.entrypoint === 'claude-desktop' ? 'Desktop' : (l.entrypoint || 'CLI')} · ${l.cwd}`)));
    }
    live.replaceChildren(...(cards.length ? cards : [h('div', { class: 'empty' }, 'No Claude Code sessions are running right now.')]));
  };
  const renderProjects = () => {
    const q = filter.value.toLowerCase();
    const items = state.projects.filter(p => !q || p.cwd.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    projList.replaceChildren(...items.map(p => h('a', { class: 'card', href: `#/p/${encodeURIComponent(p.key)}` },
      h('div', { class: 't' }, p.name, p.live ? h('span', { class: 'chip busy' }, `${p.live} live`) : null),
      h('div', { class: 's' }, `${p.sessions} session${p.sessions === 1 ? '' : 's'} · ${ago(p.lastActivity)} · ${p.cwd}`))));
    if (!items.length) projList.replaceChildren(h('div', { class: 'empty' }, 'No projects found.'));
  };
  filter.addEventListener('input', renderProjects);
  await Promise.all([loadLive(), api('GET', '/api/projects').then(p => { state.projects = p; renderProjects(); })]);
  const t = setInterval(() => { if (location.hash === '' || location.hash === '#/') loadLive().catch(() => {}); else clearInterval(t); }, 5000);
  runListeners = [() => loadLive().catch(() => {})];
}

async function projectView(key) {
  const projects = state.projects.length ? state.projects : (state.projects = await api('GET', '/api/projects'));
  const p = projects.find(x => x.key === key) || { name: key, cwd: '' };
  setTop(p.name, '#/');
  const list = h('div', { class: 'list' }, h('div', { class: 'muted small' }, 'Loading…'));
  view.replaceChildren(
    h('div', { class: 'session-head' }, h('div', { class: 'mono' }, p.cwd),
      h('div', { class: 'row' }, h('a', { class: 'btn primary', href: `#/new?cwd=${encodeURIComponent(p.cwd)}` }, '+ New session here'))),
    h('h2', {}, 'Sessions'), list);
  const sessions = await api('GET', `/api/projects/${encodeURIComponent(key)}/sessions`);
  list.replaceChildren(...sessions.map(s => h('a', { class: 'card', href: `#/s/${s.id}` },
    h('div', { class: 't' }, s.title, s.run ? h('span', { class: `chip ${s.run}` }, 'remote ' + s.run) : s.live ? h('span', { class: `chip ${s.live}` }, s.live) : null),
    h('div', { class: 's' }, `${ago(s.mtime)} · ${size(s.size)} · ${s.id.slice(0, 8)}`))));
  if (!sessions.length) list.replaceChildren(h('div', { class: 'empty' }, 'No sessions.'));
}

// A multiple-choice question from Claude (AskUserQuestion): tap an option, or type your own.
function questionCard(sessionId, e, onAnswered) {
  const picks = new Set();
  const status = h('div', { class: 'q-status' });
  const free = h('input', { type: 'text', placeholder: 'Or type your own answer…' });
  const sendBtn = h('button', { class: 'btn primary' }, 'Send answer');
  const card = h('div', { class: 'qcard' }, h('div', { class: 'q-head' }, '❓ Claude is asking you'));
  const btns = [];

  const submit = async (alsoFree) => {
    if (!picks.size && !free.value.trim()) return toast('Pick an option or type an answer');
    sendBtn.disabled = true;
    try {
      const r = await api('POST', `/api/sessions/${sessionId}/answer`, { picks: [...picks], text: alsoFree ? free.value : '' });
      card.classList.add('answered');
      for (const b of btns) b.disabled = true;
      free.disabled = true; sendBtn.hidden = true;
      status.textContent = r.queuedBehindPicker
        ? 'Sent. The laptop is still showing this question — close it there (Esc) and your answer runs next.'
        : 'Answer sent to Claude.';
      onAnswered?.();
    } catch (x) { toast(x.message, 6000); sendBtn.disabled = false; }
  };

  for (const q of e.questions) {
    if (q.header) card.append(h('div', { class: 'q-tag' }, q.header));
    card.append(h('div', { class: 'q-text' }, q.question));
    for (const o of q.options) {
      const b = h('button', { class: 'q-opt', onclick: () => {
        if (!q.multiSelect) for (const other of btns) if (other.dataset.q === String(q.question)) { picks.delete(+other.dataset.n); other.classList.remove('on'); }
        const on = !picks.has(o.n);
        if (on) picks.add(o.n); else picks.delete(o.n);
        b.classList.toggle('on', on);
      } }, h('span', { class: 'q-n' }, o.n), h('span', {}, h('b', {}, o.label), o.description ? h('div', { class: 'q-desc' }, o.description) : null));
      b.dataset.q = String(q.question); b.dataset.n = String(o.n);
      btns.push(b); card.append(b);
    }
  }
  free.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); submit(true); } });
  sendBtn.addEventListener('click', () => submit(true));
  card.append(free, h('div', { class: 'row' }, sendBtn), status);
  return card;
}

function answerQuestionCard(card, text) {
  if (card.classList.contains('answered')) return;
  card.classList.add('answered');
  for (const b of card.querySelectorAll('button, input')) b.disabled = true;
  const m = /answered:?\s*(.*)$/is.exec(String(text || ''));
  card.append(h('div', { class: 'q-status' }, 'Answered' + (m && m[1] ? ': ' + m[1].slice(0, 300) : '')));
}

async function sessionView(id) {
  setTop('Session', '#/');
  let info = await api('GET', `/api/sessions/${id}`);
  setTop(info.title || 'Session', info.projectKey ? `#/p/${encodeURIComponent(info.projectKey)}` : '#/');

  const status = h('span', { class: 'chip' });
  const settings = h('div', { class: 'small muted' });
  const stopBtn = h('button', { class: 'btn danger', hidden: true, onclick: async () => { await api('POST', `/api/sessions/${id}/stop`); toast('Stopped'); } }, 'Stop');
  const intBtn = h('button', { class: 'btn', hidden: true, onclick: async () => { await api('POST', `/api/sessions/${id}/interrupt`); toast('Interrupt sent'); } }, 'Interrupt');
  const head = h('div', { class: 'session-head' },
    h('div', { class: 'row' }, h('div', { class: 'grow mono' }, info.cwd || ''), status),
    settings,
    h('div', { class: 'row' }, intBtn, stopBtn));
  const msgs = h('div', { id: 'msgs' });
  const working = h('div', { class: 'working', hidden: true }, h('span', { class: 'spinner' }), h('span', { class: 'wtext' }, 'Claude is working…'));
  const older = h('button', { class: 'btn', hidden: true }, 'Load older messages');

  // composer
  const ta = h('textarea', { rows: '2', placeholder: 'Message Claude…', enterkeyhint: 'send' });
  const picks = makePickers(info.run ? { model: info.run.model, effort: info.run.effort, mode: info.run.mode } : {});
  const send = h('button', { class: 'btn primary' }, 'Send');
  const notice = h('div', { class: 'notice', hidden: true });
  const forkBox = h('input', { type: 'checkbox', id: 'fork' });
  const forkLabel = h('label', { for: 'fork', class: 'small muted row' }, forkBox, 'Fork');
  const isLive = () => !!info.live && !info.run && !forkBox.checked;
  const updateNotice = () => {
    notice.hidden = !isLive() && !forkBox.checked && !info.question;
    if (info.question && !forkBox.checked) {
      notice.replaceChildren('Claude is waiting on a question above — ',
        h('a', { href: '#', onclick: ev => { ev.preventDefault(); questions.get(info.question.toolUseId)?.scrollIntoView({ block: 'center' }); } }, 'go to it'), '.');
      return;
    }
    if (forkBox.checked) notice.textContent = 'Fork: continues this conversation in a new session; the original is left as is.';
    else if (isLive()) notice.textContent = `Live in ${info.live.entrypoint === 'claude-desktop' ? 'Claude Desktop' : 'a terminal'}: your message goes straight into that session and shows on the laptop. Model, effort, mode and tool approvals stay as set on the laptop.`;
    for (const el of picks.els) el.classList.toggle('off', isLive()); // the running laptop session keeps its own settings
  };
  forkBox.addEventListener('change', updateNotice);

  // transcript rendering (de-duplicated: events can arrive from the stream, the poller and the initial load)
  const tools = new Map(), questions = new Map(), seen = new Set(), pending = [];
  const keyOf = e => e.uuid ? `${e.uuid}:${e.kind}:${e.id || e.toolUseId || ''}:${(e.text || '').length}` : null;
  const nearBottom = () => innerHeight + scrollY >= document.body.scrollHeight - 160;
  const render = (e) => {
    if (e.kind === 'user') {
      const i = pending.findIndex(p => p.text === e.text.trim());
      if (i >= 0) { pending[i].el.remove(); pending.splice(i, 1); }
      return h('div', { class: 'msg user' }, e.text, e.remote ? h('div', { class: 'via' }, 'sent from Handoff') : null);
    }
    if (e.kind === 'assistant') return h('div', { class: 'msg assistant' + (e.error ? ' error' : '') }, md(e.text));
    if (e.kind === 'system') return h('div', { class: 'msg system', text: e.text });
    if (e.kind === 'question') {
      const card = questionCard(id, e, () => info.question = null);
      questions.set(e.id, card);
      return card;
    }
    if (e.kind === 'tool_use') {
      const d = h('details', { class: 'tool' }, h('summary', {}, h('b', {}, e.name), ' ', e.summary || ''), h('div', { class: 'label' }, 'input'), h('pre', { text: e.input }));
      tools.set(e.id, d);
      return d;
    }
    if (e.kind === 'tool_result') {
      const q = questions.get(e.toolUseId);
      if (q) { answerQuestionCard(q, e.text); return null; } // the question was answered
      const d = tools.get(e.toolUseId);
      const pre = [h('div', { class: 'label' }, e.isError ? 'error' : 'result'), h('pre', { text: e.text || '(empty)' })];
      if (d) { d.append(...pre); if (e.isError) d.classList.add('err'); return null; }
      return h('details', { class: 'tool' + (e.isError ? ' err' : '') }, h('summary', {}, 'tool result'), ...pre);
    }
    return null;
  };
  const appendEvents = (events, atTop = false) => {
    const stick = !atTop && nearBottom();
    const nodes = [];
    for (const e of events) {
      const k = keyOf(e);
      if (k) { if (seen.has(k)) continue; seen.add(k); }
      const n = render(e);
      if (n) nodes.push(n);
    }
    if (!nodes.length) return;
    if (atTop) msgs.prepend(...nodes); else { msgs.append(...nodes); for (const p of pending) msgs.append(p.el); }
    if (stick) scrollTo(0, document.body.scrollHeight);
  };

  const doSend = async () => {
    const text = ta.value.trim();
    if (!text) return;
    send.disabled = true;
    // show it right away; replaced by the real entry when the session records it
    const el = h('div', { class: 'msg user pending' }, text, h('div', { class: 'via' }, 'sending…'));
    const p = { text, el };
    pending.push(p); msgs.append(el); scrollTo(0, document.body.scrollHeight);
    ta.value = ''; ta.style.height = '';
    try {
      const body = { text, fork: forkBox.checked, ...(isLive() ? {} : picks.values()) };
      const r = await api('POST', `/api/sessions/${id}/message`, body);
      el.lastChild.textContent = r.delivered === 'live' ? 'delivered to your laptop' : 'sent';
      if (r.sessionId && r.sessionId !== id) { toast('Forked into a new session'); location.hash = `#/s/${r.sessionId}`; return; }
      refreshInfo();
    } catch (x) {
      el.classList.add('failed'); el.lastChild.textContent = 'not sent: ' + x.message;
      pending.splice(pending.indexOf(p), 1);
      ta.value = text;
    }
    send.disabled = false;
  };
  send.addEventListener('click', doSend);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); } });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.4) + 'px'; });
  const composer = h('div', { class: 'composer' }, notice, ta, h('div', { class: 'row opts' }, ...picks.els, forkLabel, h('span', { class: 'grow spacer' }), send));

  view.replaceChildren(head, older, msgs, working, composer);
  updateNotice();

  const setStatus = () => {
    const r = state.runs.get(id);
    if (r) info.run = r;
    const live = info.live;
    const st = r ? r.status : live ? live.status : 'history';
    status.textContent = r ? `remote · ${st}` : live ? `${live.entrypoint === 'claude-desktop' ? 'desktop' : 'cli'} · ${st}` : 'history';
    status.className = `chip ${st}`;
    stopBtn.hidden = !r; intBtn.hidden = !r || r.status === 'idle';
    working.hidden = !['running', 'busy', 'waiting', 'starting'].includes(st);
    working.lastChild.textContent = st === 'waiting' ? 'Waiting for your approval…' : 'Claude is working…';
    settings.textContent = r ? [r.model && r.model !== 'default' ? r.model : 'default model', r.effort ? `${EFFORT_LABELS[r.effort] || r.effort} effort` : null, MODE_LABELS[r.mode] || r.mode].filter(Boolean).join(' · ') : '';
    settings.hidden = !r;
    updateNotice();
  };
  // laptop-side status (busy/idle) changes outside our runner, so re-check it every 5s
  const refreshInfo = () => api('GET', `/api/sessions/${id}`).then(i => { info = { ...i, run: state.runs.get(id) || i.run }; setStatus(); }).catch(() => {});
  setStatus();
  runListeners = [r => { if (!r || r.sessionId === id) setStatus(); }];
  const infoTimer = setInterval(refreshInfo, 5000);
  state.cleanup.push(() => clearInterval(infoTimer));

  // initial history (newest part), then live updates
  const t = await api('GET', `/api/sessions/${id}/transcript`);
  appendEvents(t.events);
  let start = t.start, end = t.end;
  older.hidden = start <= 0;
  older.onclick = async () => {
    const before = document.body.scrollHeight;
    const o = await api('GET', `/api/sessions/${id}/transcript?before=${start}`);
    appendEvents(o.events, true);
    start = o.start; older.hidden = start <= 0;
    scrollTo(0, document.body.scrollHeight - before);
  };
  if (!t.events.length && t.size === 0) msgs.append(h('div', { class: 'msg system' }, 'Waiting for the session to start…'));
  scrollTo(0, document.body.scrollHeight);

  // Live: event stream first; if it hasn't said "ready" within 5s (a proxy is buffering it),
  // fall back to fetching only the new part of the transcript every 2s.
  // A dropped stream (phone asleep, network change) is caught up from the transcript and reopened;
  // `seen` drops anything delivered twice.
  let es = null, streaming = false, pollTimer = null, fallback = null, retry = null, gone = false;
  const catchUp = async () => {
    try { const d = await api('GET', `/api/sessions/${id}/since?from=${end}`); end = d.end; appendEvents(d.events); } catch { /* retry next tick */ }
  };
  const open = () => {
    if (gone) return;
    es?.close(); clearTimeout(fallback); clearTimeout(retry);
    streaming = false;
    const s = es = new EventSource(`/api/sessions/${id}/stream?from=${end}`);
    s.addEventListener('ready', () => { streaming = true; });
    s.addEventListener('msg', ev => appendEvents([JSON.parse(ev.data)]));
    s.addEventListener('error', () => {
      if (es !== s || pollTimer) return;
      s.close(); streaming = false;
      retry = setTimeout(() => catchUp().then(open), 3000);
    });
    fallback = setTimeout(() => {
      if (streaming || es !== s) return;
      s.close();
      catchUp(); pollTimer = setInterval(catchUp, 2000);
    }, 5000);
  };
  open();
  const onResume = () => { catchUp().then(() => { if (!pollTimer && !(streaming && es?.readyState === EventSource.OPEN)) open(); }); };
  window.addEventListener('handoff-resume', onResume);
  state.cleanup.push(() => { gone = true; es?.close(); clearTimeout(fallback); clearTimeout(retry); clearInterval(pollTimer); window.removeEventListener('handoff-resume', onResume); });
}

async function newView(params) {
  setTop('New session', '#/');
  if (!state.projects.length) state.projects = await api('GET', '/api/projects').catch(() => []);
  const dl = h('datalist', { id: 'cwds' }, state.projects.filter(p => !p.scratch).map(p => h('option', { value: p.cwd })));
  const cwd = h('input', { type: 'text', list: 'cwds', placeholder: 'Working directory, e.g. D:\\projects\\my-app', value: params.get('cwd') || '' });
  const ta = h('textarea', { rows: '5', placeholder: 'What should Claude do?' });
  const picks = makePickers();
  const err = h('div', { class: 'err' });
  const go = h('button', { class: 'btn primary', onclick: async () => {
    go.disabled = true; err.textContent = 'Starting Claude…';
    try {
      const r = await api('POST', '/api/sessions/new', { cwd: cwd.value.trim(), text: ta.value, ...picks.values() });
      location.hash = `#/s/${r.sessionId}`;
    } catch (x) { err.textContent = x.message; go.disabled = false; }
  } }, 'Start session');
  view.replaceChildren(h('div', { class: 'list' },
    h('div', { class: 'label' }, 'Project folder'), cwd, dl,
    h('div', { class: 'label' }, 'Prompt'), ta,
    h('div', { class: 'label' }, 'Model · effort · mode'),
    h('div', { class: 'row opts' }, ...picks.els),
    h('div', { class: 'row' }, h('span', { class: 'grow' }), go), err));
  (cwd.value ? ta : cwd).focus();
}

// ---------- router ----------
async function route() {
  if (!state.me) return;
  for (const fn of state.cleanup.splice(0)) fn(); // close the previous page's streams/timers
  runListeners = [];
  const [path, query] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query || '');
  const parts = (path || '/').split('/').filter(Boolean);
  try {
    if (parts[0] === 'p' && parts[1]) await projectView(decodeURIComponent(parts[1]));
    else if (parts[0] === 's' && parts[1]) await sessionView(parts[1]);
    else if (parts[0] === 'new') await newView(params);
    else await homeView();
  } catch (x) {
    if (x.message !== 'unauthorized') view.replaceChildren(h('div', { class: 'empty' }, 'Error: ' + x.message));
  }
}
addEventListener('hashchange', route);

async function boot() {
  try { state.me = await api('GET', '/api/me'); }
  catch { return; }
  optionsReady(); // start fetching the model list early
  connectEvents();
  route();
}
boot();

// Coming back to the page (screen unlocked, app switched back, network back): reconnect if the
// stream went quiet, and tell the open page to fetch whatever it missed.
function resume() {
  if (!state.me || document.hidden) return;
  if (state.es?.readyState !== EventSource.OPEN || Date.now() - state.esSeen > 20e3) connectEvents();
  window.dispatchEvent(new Event('handoff-resume'));
}
document.addEventListener('visibilitychange', resume);
window.addEventListener('online', resume);
window.addEventListener('pageshow', e => { if (e.persisted) resume(); });
// the server pings every 15s; a stream silent for 45s is dead even if the browser hasn't noticed
setInterval(() => { if (state.me && !document.hidden && Date.now() - state.esSeen > 45e3) connectEvents(); }, 10e3);
