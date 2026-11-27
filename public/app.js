'use strict';
// Handoff — vanilla SPA. All untrusted text is inserted with textContent (no innerHTML).

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const state = { me: null, runs: new Map(), perms: new Map(), es: null, projects: [], options: null, cleanup: [], writes: 0 };
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
  const write = method !== 'GET';
  if (write) state.writes++; // a message or an approval on its way: the page doesn't reload under it
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json', 'X-Handoff': '1' } : { 'X-Handoff': '1' },
    body: body !== undefined ? JSON.stringify(body) : undefined
  }).finally(() => { if (write) state.writes--; });
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- markdown (safe: builds DOM nodes, never HTML) ----------
// Covers what Claude writes: headings, paragraphs, bold/italic/strike, inline code, links,
// numbered, bulleted, nested and task lists, quotes, rules, tables and fenced code blocks.
// Links only open http(s) and mailto addresses.
function md(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let i = 0, para = [];
  const flush = () => {
    if (!para.length) return;
    frag.append(h('p', {}, ...para.flatMap((l, k) => k ? [h('br'), ...inline(l)] : inline(l))));
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = FENCE_RE.exec(line))) { flush(); const r = fenced(lines, i, m); frag.append(r.node); i = r.next; continue; }
    if (!line.trim()) { flush(); i++; continue; }
    if ((m = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line))) { flush(); frag.append(h('h' + Math.min(4, m[1].length), {}, inline(m[2]))); i++; continue; }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flush(); frag.append(h('hr')); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      frag.append(h('blockquote', {}, md(q.join('\n'))));
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1])) { flush(); const r = table(lines, i); frag.append(r.node); i = r.next; continue; }
    if (LIST_RE.test(line)) { flush(); i = list(lines, i, frag); continue; }
    para.push(line.trim());
    i++;
  }
  flush();
  return frag;
}
const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const indentOf = s => s.match(/^\s*/)[0].replace(/\t/g, '    ').length;

// ```lang … ``` (an unclosed fence runs to the end, as while Claude is still writing)
function fenced(lines, i, m) {
  const [, ind, fence, lang] = m;
  const close = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
  const body = [];
  for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i].startsWith(ind) ? lines[i].slice(ind.length) : lines[i].trimStart());
  return { node: codeBlock(body.join('\n'), lang), next: i + 1 };
}
const LANG_ALIAS = { javascript: 'js', node: 'js', typescript: 'ts', python: 'py', py3: 'py', shell: 'sh', console: 'sh', terminal: 'sh', powershell: 'ps1', pwsh: 'ps1', ps: 'ps1', golang: 'go', rust: 'rs', ruby: 'rb', csharp: 'cs', 'c#': 'cs', 'c++': 'cpp', kotlin: 'kt', yml: 'yaml', jsonl: 'json' };
function codeBlock(code, lang = '') {
  const name = String(lang).toLowerCase();
  const pre = h('pre', {}, h('code', {}, name === 'diff' || name === 'patch' ? diffLines(code) : highlight(code, LANG_ALIAS[name] || name)));
  const copy = h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Copy code', onclick: async () => {
    try { await navigator.clipboard.writeText(code); copy.textContent = 'Copied'; }
    catch { getSelection().selectAllChildren(pre); copy.textContent = 'Selected'; } // no clipboard access: select it for a manual copy
    setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
  } }, 'Copy');
  return h('div', { class: 'codeblock' }, h('div', { class: 'cb-head' }, h('span', {}, name || 'text'), copy), pre);
}

function diffLines(text) {
  const frag = document.createDocumentFragment();
  for (const line of text.split('\n')) {
    const cls = line.startsWith('@@') ? 'd-hunk' : line.startsWith('+') ? 'd-add' : line.startsWith('-') ? 'd-del' : null;
    frag.append(cls ? h('span', { class: cls }, line) : line, '\n');
  }
  return frag;
}

// | a | b |  then  |---|:--:|  then rows; scrolls sideways inside its own box on a phone
const isTableRule = l => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && /-/.test(l) && (l.includes('|') || /^\s*:?-+:?\s*$/.test(l));
function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out = []; let cur = '', code = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (c === '`') code = !code;
    if (c === '|' && !code) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}
function table(lines, i) {
  const head = cells(lines[i]);
  const align = cells(lines[i + 1]).map(c => /^:-+:$/.test(c) ? 'c' : /-+:$/.test(c) ? 'r' : null);
  while (align.length < head.length) align.push(null);
  const rows = [];
  for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(cells(lines[i]));
  const width = Math.max(head.length, ...rows.map(r => r.length));
  const cols = Array.from({ length: width }, (_, k) => k);
  const node = h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Table' }, h('table', {},
    h('thead', {}, h('tr', {}, ...cols.map(k => h('th', { class: align[k] }, inline(head[k] ?? ''))))),
    h('tbody', {}, ...rows.map(r => h('tr', {}, ...cols.map(k => h('td', { class: align[k] }, inline(r[k] ?? ''))))))));
  return { node, next: i };
}

// - item / 1. item, nested by indent; indented lines and code blocks under an item belong to it
function list(lines, i, frag) {
  const stack = []; // { indent, el, li }
  const startList = (indent, ordered, start, parent) => {
    const el = h(ordered ? 'ol' : 'ul', { start: ordered && start !== 1 ? String(start) : null });
    parent.append(el);
    stack.push({ indent, el, li: null });
  };
  while (i < lines.length) {
    const line = lines[i];
    const m = LIST_RE.exec(line);
    if (m && !/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      const indent = indentOf(m[1]), ordered = /\d/.test(m[2]);
      while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
      const top = stack[stack.length - 1];
      if (!top) startList(indent, ordered, parseInt(m[2], 10), frag);
      else if (indent >= top.indent + 2 && top.li) startList(indent, ordered, parseInt(m[2], 10), top.li);
      else if ((top.el.tagName === 'OL') !== ordered) { // bullets after numbers (or the other way round): a new list
        stack.pop();
        startList(indent, ordered, parseInt(m[2], 10), stack.length ? stack[stack.length - 1].li : frag);
      }
      const cur = stack[stack.length - 1];
      const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
      cur.li = h('li', { class: task ? 'task' : null }, task ? [h('span', { class: 'check' }, task[1] === ' ' ? '☐' : '☑'), ' ', ...inline(task[2])] : inline(m[3]));
      cur.el.append(cur.li);
      i++;
      continue;
    }
    if (!line.trim()) {
      // a blank line ends the list unless the list (or an item's indented text) carries on after it
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && (LIST_RE.test(lines[j]) || indentOf(lines[j]) >= 2) && stack.length) { i = j; continue; }
      break;
    }
    const top = stack[stack.length - 1];
    const fence = FENCE_RE.exec(line);
    if (fence && top?.li && indentOf(line) >= 2) { const r = fenced(lines, i, fence); top.li.append(r.node); i = r.next; continue; }
    // text right under an item (indented, or straight after it) continues that item
    if (top?.li && !fence && !/^\s{0,3}(#{1,6}\s|>)/.test(line) && !(line.includes('|') && isTableRule(lines[i + 1] || ''))) {
      if (indentOf(line) >= 2 || !/^\s*$/.test(lines[i - 1] || '')) { top.li.append(h('br'), ...inline(line.trim())); i++; continue; }
    }
    break;
  }
  return i;
}

// **bold**, *italic*, ~~strike~~, `code`, [text](https://…), bare https://… links, \escapes
const INLINE_RE = /\\([!-/:-@[-`{-~])|(`+)(.+?)\2(?!`)|\*\*(?=\S)(.+?)\*\*|(^|[^\w])__(?=\S)(.+?)__(?!\w)|~~(.+?)~~|\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])|(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)|(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]*_])/g;
const safeHref = u => /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
function inline(s) {
  const out = [], re = new RegExp(INLINE_RE.source, 'g');
  let last = 0, m;
  while ((m = re.exec(s))) {
    let at = m.index, node;
    if (m[1] != null) node = m[1];
    else if (m[3] != null) node = h('code', { text: /^ .* $/.test(m[3]) ? m[3].slice(1, -1) : m[3] });
    else if (m[4] != null) node = h('strong', {}, inline(m[4]));
    else if (m[6] != null) { at += m[5].length; node = h('strong', {}, inline(m[6])); }
    else if (m[7] != null) node = h('del', {}, inline(m[7]));
    else if (m[8] != null) { const href = safeHref(m[9]); node = href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, inline(m[8])) : h('span', {}, inline(m[8])); }
    else if (m[11] != null) { at += m[10].length; node = h('em', {}, inline(m[11])); }
    else if (m[13] != null) { at += m[12].length; node = h('em', {}, inline(m[13])); }
    else if (m[14] != null) node = h('a', { href: m[14], target: '_blank', rel: 'noopener noreferrer' }, m[14]);
    if (at > last) out.push(s.slice(last, at));
    out.push(node);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// ---------- theme: the system's, or light / dark picked in the menu ----------
// theme.js applies the saved choice before the page draws; this keeps it in step afterwards.
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyTheme(t = store.get('theme', 'system')) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && darkQuery.matches);
  $('meta[name=theme-color]')?.setAttribute('content', dark ? '#171a20' : '#ffffff');
}
darkQuery.addEventListener?.('change', () => applyTheme());
function themePicker() {
  const cur = store.get('theme', 'system');
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Theme' });
  for (const [v, label] of [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']]) {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === cur), class: v === cur ? 'on' : null, title: v === 'system' ? 'Follow the system setting' : null, onclick: () => {
      store.set('theme', v); applyTheme(v);
      for (const o of seg.children) { o.classList.toggle('on', o === b); o.setAttribute('aria-checked', String(o === b)); }
    } }, label);
    seg.append(b);
  }
  return seg;
}

// ---------- chrome ----------
// the pinned chat header sits right under the top bar, whatever its height (notch, larger text)
if ('ResizeObserver' in window) new ResizeObserver(() => document.documentElement.style.setProperty('--top-h', $('#topbar').offsetHeight + 'px')).observe($('#topbar'));
function setTop(title, backHref) {
  $('#title').textContent = title;
  const b = $('#back');
  b.hidden = !backHref;
  b.onclick = () => (location.hash = backHref);
  $('#menu').hidden = !state.me;
}

// A sheet over the page: slides up from the bottom on a phone, a dialog in the middle on a wide
// screen. Tapping outside it, × or Esc closes it. Returns its close function.
function openSheet(title, ...body) {
  const close = () => { overlay.remove(); removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'overlay', onclick: e => { if (e.target === overlay) close(); } },
    h('div', { class: 'ctx-sheet', role: 'dialog', 'aria-label': title },
      h('div', { class: 'row' }, h('b', {}, title), h('span', { class: 'grow' }), h('button', { class: 'icon', 'aria-label': 'Close', onclick: () => close() }, '×')),
      ...body));
  document.body.append(overlay);
  addEventListener('keydown', onKey);
  overlay.querySelector('.ctx-sheet button, .ctx-sheet input')?.focus({ preventScroll: true });
  return close;
}

$('#menu').addEventListener('click', () => {
  const close = openSheet('Menu',
    h('div', { class: 'row menu-theme' }, h('span', { class: 'grow' }, 'Theme'), themePicker()),
    h('div', { class: 'list menu' },
      h('button', { class: 'btn', onclick: () => { close(); location.hash = '#/new'; } }, '＋ New session'),
      h('button', { class: 'btn', onclick: () => { close(); showPreview(); } }, '🖥 Preview an app…'),
      state.me?.push ? h('button', { class: 'btn', onclick: () => { close(); showPushSettings(); } }, '🔔 Phone notifications…') : null,
      alertsOn() ? h('button', { class: 'btn', onclick: () => { close(); showAlertSettings(); } }, '🔕 Alert settings…') : null,
      state.me?.whatsapp?.enabled ? h('button', { class: 'btn', onclick: async () => {
        close();
        try { await api('POST', '/api/notify/test'); toast('Test WhatsApp message sent'); }
        catch (x) { toast('WhatsApp: ' + x.message, 6000); }
      } }, '💬 Send test WhatsApp') : null,
      h('button', { class: 'btn', onclick: () => { close(); location.hash = '#/usage'; } }, '📊 Usage and limits'),
      h('button', { class: 'btn', onclick: () => { close(); showLaptop(); } }, '💻 Laptop: battery and keep awake…'),
      h('button', { class: 'btn', onclick: () => { close(); showApiSettings(); } }, '🔑 API access…'),
      h('button', { class: 'btn', onclick: async () => { await api('POST', '/api/logout'); location.reload(); } }, '↪ Sign out'),
      h('button', { class: 'btn danger', onclick: () => { close(); signOutEverywhere(); } }, '⏻ Sign out all devices')));
});

// ---------- phone push notifications ----------
// Each device opts in here; the server then sends the same alerts as WhatsApp to it. On iPhone this
// works once Handoff is added to the Home Screen and opened from there (iOS 16.4+).
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushRegistration = () => navigator.serviceWorker.register('/sw.js');
async function showPushSettings() {
  const box = h('div', { class: 'list' }, h('div', { class: 'muted small' }, 'Loading…'));
  openSheet('Phone notifications', box);
  const say = (...kids) => box.replaceChildren(...kids);
  const render = async () => {
    if (!pushSupported()) {
      return say(h('div', {}, 'This browser can\'t receive push notifications.'),
        h('div', { class: 'muted small' }, 'On iPhone or iPad: tap Share → Add to Home Screen, open Handoff from the Home Screen, and come back here.'));
    }
    const info = await api('GET', '/api/push');
    if (!info.enabled) return say(h('div', { class: 'muted' }, 'Push notifications are turned off on the server (HANDOFF_PUSH=false).'));
    const reg = await pushRegistration();
    const sub = await reg.pushManager.getSubscription();
    const devices = h('div', { class: 'small muted' }, `${info.devices} device${info.devices === 1 ? '' : 's'} get${info.devices === 1 ? 's' : ''} notifications.`);
    if (Notification.permission === 'denied') {
      return say(h('div', {}, 'Notifications are blocked for this site.'), h('div', { class: 'muted small' }, 'Allow them in the browser\'s site settings, then come back here.'), devices);
    }
    if (sub) {
      return say(h('div', {}, '🔔 On for this device: you get the same alerts as WhatsApp (approvals, questions, waiting, finished, errors). Quiet hours and muted projects apply.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: async () => {
            try { const r = await api('POST', '/api/push/test', { endpoint: sub.endpoint }); toast(r.sent ? 'Test notification sent' : 'Could not deliver it; try turning notifications off and on again', 5000); }
            catch (x) { toast(x.message); }
          } }, 'Send a test'),
          h('button', { class: 'btn danger', onclick: async () => {
            await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
            await sub.unsubscribe().catch(() => {});
            render();
          } }, 'Turn off for this device')),
        devices);
    }
    say(h('div', {}, 'Get alerts on this device as notifications, even when Handoff is closed. No WhatsApp needed.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
        try {
          if (await Notification.requestPermission() !== 'granted') return render();
          const key = Uint8Array.from(atob(info.publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
          const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
          await api('POST', '/api/push/subscribe', { subscription: s.toJSON() });
          toast('Notifications are on for this device');
          render();
        } catch (x) { toast('Could not turn them on: ' + x.message, 6000); }
      } }, 'Turn on for this device')),
      devices);
  };
  try { await render(); } catch (x) { say(h('div', { class: 'empty' }, x.message)); }
}

// ---------- WhatsApp alert settings: quiet hours and muted projects ----------
// alerts go out at all: WhatsApp set up, or phone notifications available
const alertsOn = () => !!(state.me?.whatsapp?.enabled || state.me?.push);
const sameDir = (a, b) => String(a).toLowerCase() === String(b).toLowerCase(); // the server compares case-insensitively on Windows
async function showAlertSettings() {
  const box = h('div', { class: 'list' }, h('div', { class: 'muted small' }, 'Loading…'));
  const close = openSheet('Alert settings', box);
  const render = pr => {
    const names = new Map(state.projects.map(p => [p.cwd.toLowerCase(), p.name]));
    box.replaceChildren(
      h('div', { class: 'label' }, 'Quiet hours'),
      pr.quiet
        ? h('div', {}, `${pr.quiet.text}${pr.quiet.active ? ' (on now)' : ''}: alerts are held and summed up in one message afterwards.${pr.quiet.allow.length ? ` Still sent: ${pr.quiet.allow.join(', ')}.` : ''}${pr.held ? ` ${pr.held} held so far.` : ''}`)
        : h('div', { class: 'muted' }, 'Not set. Add HANDOFF_WHATSAPP_QUIET=23:00-07:00 to .env (the computer\'s time) and restart Handoff.'),
      h('div', { class: 'label' }, 'Muted projects'),
      ...(pr.muted.length ? pr.muted.map(cwd => h('div', { class: 'row' },
        h('span', { class: 'grow mono small' }, names.get(cwd.toLowerCase()) ? `${names.get(cwd.toLowerCase())} · ${cwd}` : cwd),
        h('button', { class: 'btn', onclick: async () => render(await api('POST', '/api/notify/mute', { cwd, muted: false })) }, 'Unmute')))
        : [h('div', { class: 'muted' }, 'None. Mute a project from its page; that also covers its worktrees.')]),
      h('div', { class: 'label' }, 'Muted chats'),
      ...(pr.mutedChats?.length ? pr.mutedChats.map(c => h('div', { class: 'row' },
        h('a', { class: 'grow', href: `#/s/${c.id}`, onclick: close }, c.title),
        h('button', { class: 'btn', onclick: async () => render(await api('POST', '/api/notify/mute-session', { sessionId: c.id, muted: false })) }, 'Unmute')))
        : [h('div', { class: 'muted' }, 'None. Mute a chat from its page.')]));
  };
  try { render(await api('GET', '/api/notify/prefs')); }
  catch (x) { box.replaceChildren(h('div', { class: 'empty' }, x.message)); }
}

// ---------- API access: the API's on/off switch, and its keys ----------
const SCOPE_LABELS = { read: 'Read projects and chats', chat: 'Send prompts, start sessions', approve: 'Allow or deny requests, answer questions', files: 'Browse files and changes', git: 'Commit, push and discard' };
const TOOL_LABELS = { all: 'All tools (approvals as set below)', readOnly: 'Read only: can look, can\'t change files', none: 'No tools: just talk' };
const KEY_MODE_LABELS = { ...MODE_LABELS, manual: 'Ask me (approvals come to your phone)', dontAsk: 'Don\'t ask (deny anything not pre-approved)' };
const PRESET_HELP = { phone: 'quick model, can read but not change files, plain-text answers', automation: 'does real work in your projects; approvals come to your phone', chat: 'just talks, for chat apps (OpenAI-compatible)', custom: 'choose everything yourself' };
function copyBtn(text, label = 'Copy') {
  const b = h('button', { class: 'btn sm', onclick: async () => {
    try { await navigator.clipboard.writeText(typeof text === 'function' ? text() : text); b.textContent = 'Copied'; }
    catch { b.textContent = 'Copy failed: select it'; }
    setTimeout(() => { b.textContent = label; }, 1800);
  } }, label);
  return b;
}
const money = n => { const v = Number(n) || 0; return `$${v && v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`; };

async function showApiSettings() {
  const box = h('div', { class: 'list' }, h('div', { class: 'muted small' }, 'Loading…'));
  const close = openSheet('API access', box);
  const say = (...kids) => box.replaceChildren(...kids);
  let info;
  // anything that hands out access asks again: the 2FA code, or the password when 2FA is off
  const reauthField = () => (info.totp
    ? h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '2FA code', class: 'reauth' })
    : h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Your Handoff password', class: 'reauth' }));
  const reauthBody = el => (info.totp ? { code: el.value.trim() } : { password: el.value });
  const base = () => info.base || `${location.origin}/api/v1`;
  const load = async () => { info = await api('GET', '/api/keys'); render(); };

  const keyCard = k => {
    const secret = h('div', { class: 'row', hidden: true }, h('code', { class: 'grow mono small' }, k.webhookSecret), copyBtn(k.webhookSecret));
    return h('div', { class: 'card keycard' },
      h('div', { class: 't' }, h('span', {}, k.name), h('span', { class: 'chip' }, info.presets[k.preset]?.label || 'Custom'), k.expired ? h('span', { class: 'chip waiting' }, 'expired') : null),
      h('div', { class: 's' }, `${k.prefix}… · ${k.scopes.join(', ')} · ${k.projects ? `${k.projects.length} project${k.projects.length === 1 ? '' : 's'}` : 'all projects'} · tools: ${k.tools}`),
      h('div', { class: 's' }, `Last used ${k.lastUsedAt ? ago(k.lastUsedAt) : 'never'}${k.lastIp ? ` from ${k.lastIp}` : ''} · today ${k.today.turns} turn${k.today.turns === 1 ? '' : 's'}, ${money(k.today.costUsd)}${k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : ''}`),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => { secret.hidden = !secret.hidden; } }, 'Webhook secret'),
        h('button', { class: 'btn sm', onclick: () => { close(); showKeyActivity(k); } }, 'Activity'),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!confirm(`Revoke "${k.name}"? Programs using it stop working at once.`)) return;
          try { await api('DELETE', `/api/keys/${k.id}`); toast('Key revoked'); await load(); } catch (x) { toast(x.message); }
        } }, 'Revoke')),
      secret);
  };

  const render = () => {
    const toggleAuth = reauthField();
    say(
      h('div', {}, info.enabled ? '✅ The API is on.' : 'The API is off: programs get "api_off" until you turn it on.'),
      h('div', { class: 'muted small' }, 'Your own programs, scripts and phone shortcuts can send prompts and get answers, pick sessions, attach files and more. Keys are for your own devices: sharing access to your Claude plan with other people can break its terms.'),
      h('div', { class: 'row' }, toggleAuth, h('button', { class: info.enabled ? 'btn danger' : 'btn primary', onclick: async () => {
        try { await api('POST', '/api/api-enabled', { on: !info.enabled, ...reauthBody(toggleAuth) }); toast(info.enabled ? 'The API is off' : 'The API is on'); await load(); }
        catch (x) { toast(x.message, 5000); }
      } }, info.enabled ? 'Turn the API off' : 'Turn the API on')),
      h('div', { class: 'label' }, 'Address'),
      h('div', { class: 'row' }, h('code', { class: 'grow mono small' }, base()), copyBtn(base())),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: '/api/v1/docs', target: '_blank', rel: 'noopener' }, '📖 API docs'),
        h('a', { class: 'btn', href: '#/api', onclick: () => close() }, '🧪 Try it')),
      h('div', { class: 'label' }, `Keys (${info.keys.length})`),
      ...(info.keys.length ? info.keys.map(keyCard) : [h('div', { class: 'muted' }, 'No keys yet.')]),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => keyForm() }, '＋ New key')));
  };

  // the New key form: a preset fills it in, every field can still be changed
  const keyForm = async () => {
    const o = await optionsReady();
    const name = h('input', { type: 'text', placeholder: 'A name, e.g. iPhone shortcut', maxlength: '60' });
    const check = (label, on, title) => { const i = h('input', { type: 'checkbox' }); i.checked = !!on; return { i, el: h('label', { class: 'row', title }, i, h('span', {}, label)) }; };
    const scopes = Object.fromEntries(info.scopes.map(s => [s, check(SCOPE_LABELS[s] || s, false, s === 'git' && !info.git ? 'Git actions are turned off in this Handoff (HANDOFF_GIT_ACTIONS)' : s === 'files' && !info.files ? 'The file browser is turned off in this Handoff (HANDOFF_FILE_BROWSER)' : '')]));
    const allProjects = check('Every project', true);
    const projects = info.projects.map(p => ({ cwd: p.cwd, ...check(`${p.name} · ${p.cwd}`, false) }));
    const projectList = h('div', { class: 'list checks', hidden: true }, ...projects.map(p => p.el));
    allProjects.i.addEventListener('change', () => { projectList.hidden = allProjects.i.checked; syncModes(); });
    const tools = h('select', {}, ...info.tools.map(t => h('option', { value: t }, TOOL_LABELS[t] || t)));
    const modes = Object.fromEntries(info.modes.map(m => [m, check(KEY_MODE_LABELS[m] || m, m === 'manual')]));
    const defaultMode = h('select', {});
    const warn = h('div', { class: 'notice small', hidden: true }, '⚠️ Auto and Bypass let Claude act without asking you. Such a key can do anything you can do on this computer.');
    const syncModes = () => {
      const allowAll = allProjects.i.checked;
      for (const m of ['auto', 'bypassPermissions']) if (modes[m]) { modes[m].i.disabled = !allowAll; if (!allowAll) modes[m].i.checked = false; modes[m].el.title = allowAll ? '' : 'Only for keys with every project'; }
      const chosen = info.modes.filter(m => modes[m].i.checked);
      const prev = defaultMode.value;
      defaultMode.replaceChildren(...chosen.map(m => h('option', { value: m, selected: m === prev }, KEY_MODE_LABELS[m] || m)));
      warn.hidden = !chosen.some(m => m === 'auto' || m === 'bypassPermissions');
    };
    for (const m of info.modes) modes[m].i.addEventListener('change', syncModes);
    const model = h('select', {}, h('option', { value: '' }, 'Claude Code\'s default model'), ...(o?.models || []).filter(m => m.value !== 'default').map(m => h('option', { value: m.value }, m.displayName)));
    const effort = h('select', {}, h('option', { value: '' }, 'Default effort'), ...info.efforts.map(e => h('option', { value: e }, EFFORT_LABELS[e] || e)));
    const plain = check('Plain text answers (no Markdown), for voice and short messages', false);
    const language = h('input', { type: 'text', placeholder: 'Answer language, e.g. English or Urdu (optional)', maxlength: '40' });
    const length = h('select', {}, h('option', { value: '' }, 'Answer length: Claude decides'), ...info.lengths.map(l => h('option', { value: l }, `Answer length: ${l}`)));
    const alerts = check('Also alert my phone when its tasks finish or fail (approvals always alert)', false);
    const num = (ph, v) => h('input', { type: 'text', inputmode: 'decimal', placeholder: ph, value: v ?? '' });
    const rate = num('Requests a minute (30)', 30), turns = num('Turns at once (2)', 2), budget = num('Daily budget in USD (optional)');
    const expires = h('select', {}, ...[['', 'Never expires'], ['30', 'Expires in 30 days'], ['90', 'Expires in 90 days'], ['365', 'Expires in a year']].map(([v, l]) => h('option', { value: v }, l)));
    const help = h('div', { class: 'muted small' });
    const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Kind of key' });
    let preset = 'automation';
    const apply = id => {
      preset = id;
      for (const b of seg.children) b.classList.toggle('on', b.dataset.id === id);
      help.textContent = PRESET_HELP[id] || '';
      const p = info.presets[id];
      if (!p) return;
      for (const s of info.scopes) scopes[s].i.checked = p.scopes.includes(s);
      tools.value = p.tools;
      for (const m of info.modes) modes[m].i.checked = p.modes.includes(m);
      syncModes(); defaultMode.value = p.defaultMode;
      model.value = p.defaults.model || ''; effort.value = p.defaults.effort || ''; plain.i.checked = !!p.defaults.plain;
    };
    for (const id of [...Object.keys(info.presets), 'custom']) {
      seg.append(h('button', { type: 'button', 'data-id': id, onclick: () => apply(id) }, info.presets[id]?.label || 'Custom'));
    }
    const auth = reauthField();
    const create = h('button', { class: 'btn primary', onclick: async () => {
      const chosenProjects = allProjects.i.checked ? null : projects.filter(p => p.i.checked).map(p => p.cwd);
      if (chosenProjects && !chosenProjects.length) return toast('Tick at least one project, or "Every project"');
      create.disabled = true;
      try {
        const r = await api('POST', '/api/keys', {
          name: name.value, preset, scopes: info.scopes.filter(s => scopes[s].i.checked), projects: chosenProjects,
          tools: tools.value, modes: info.modes.filter(m => modes[m].i.checked), defaultMode: defaultMode.value,
          defaults: { model: model.value || undefined, effort: effort.value || undefined, plain: plain.i.checked || undefined, language: language.value.trim() || undefined, length: length.value || undefined },
          alerts: alerts.i.checked, rateLimit: rate.value, maxTurns: turns.value, dailyBudgetUsd: budget.value || undefined, expiresDays: expires.value || undefined,
          ...reauthBody(auth)
        });
        showOnce(r);
      } catch (x) { toast(x.message, 6000); create.disabled = false; }
    } }, 'Create key');
    say(
      h('div', { class: 'label' }, 'New key'), name,
      h('div', { class: 'label' }, 'Kind'), seg, help,
      h('div', { class: 'label' }, 'It may'), h('div', { class: 'list checks' }, ...info.scopes.map(s => scopes[s].el)),
      h('div', { class: 'label' }, 'Projects'), allProjects.el, projectList,
      h('div', { class: 'label' }, 'Tools'), tools,
      h('div', { class: 'label' }, 'When Claude wants to act'), h('div', { class: 'list checks' }, ...info.modes.map(m => modes[m].el)), defaultMode, warn,
      h('div', { class: 'label' }, 'Answers'), model, effort, plain.el, language, length,
      h('div', { class: 'label' }, 'Alerts and limits'), alerts.el, rate, turns, budget, expires,
      h('div', { class: 'muted small' }, 'Keys are for your own programs and devices. Sharing access to your Claude plan with other people can break its terms.'),
      h('div', { class: 'row' }, auth, create, h('button', { class: 'btn', onclick: () => render() }, 'Cancel')));
    apply('automation');
    name.focus();
  };

  // the key itself, shown this once
  const showOnce = r => {
    const k = r.key, b = base();
    const curl = `curl ${b}/chat \\\n  -H "Authorization: Bearer ${k}" \\\n  -d '{"prompt": "What changed in my last commit?"}'`;
    const py = `import requests\nr = requests.post("${b}/chat",\n    headers={"Authorization": "Bearer ${k}"},\n    json={"prompt": "What changed in my last commit?"})\nprint(r.json()["text"])`;
    say(
      h('div', {}, `🔑 "${r.record.name}" is ready. Copy the key now: it is shown only this once.`),
      h('div', { class: 'row' }, h('code', { class: 'grow mono keyonce' }, k), copyBtn(k)),
      h('div', { class: 'label' }, 'Webhook secret (to check webhooks this key\'s requests send)'),
      h('div', { class: 'row' }, h('code', { class: 'grow mono small' }, r.record.webhookSecret), copyBtn(r.record.webhookSecret)),
      ...(info.enabled ? [] : [h('div', { class: 'notice small' }, 'The API is off: turn it on in this sheet before using the key.')]),
      h('div', { class: 'label' }, 'Try it with curl'), codeBlock(curl, 'bash'),
      h('div', { class: 'label' }, 'Or Python'), codeBlock(py, 'python'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => load() }, 'I\'ve saved it')));
  };

  try { await load(); } catch (x) { say(h('div', { class: 'empty' }, x.message)); }
}

// ---------- usage: tokens, estimated cost and the plan's limits ----------
const tokens = n => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));
const until = ms => {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60e3));
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.round(m / 1440)} days`;
};
const LIMIT_NAMES = {
  five_hour: ['Current session', 'the 5-hour window'],
  seven_day: ['This week', 'all models'],
  seven_day_opus: ['This week', 'Opus'],
  seven_day_sonnet: ['This week', 'Sonnet'],
  seven_day_overage_included: ['This week', 'with extra usage']
};
function limitCard(l, onCheck) {
  const names = Object.keys(l.windows).sort((a, b) => Object.keys(LIMIT_NAMES).indexOf(a) - Object.keys(LIMIT_NAMES).indexOf(b));
  const rows = names.map(n => {
    const w = l.windows[n], pct = Math.round((w.utilization || 0) * 100);
    const [title, sub] = LIMIT_NAMES[n] || [n.replace(/_/g, ' '), ''];
    const when = w.resetsAt ? new Date(w.resetsAt) : null;
    const resets = !when ? '' : w.reset
      ? `Reset at ${when.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}; not used since it was checked`
      : `Resets ${n === 'five_hour' ? when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : when.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} (in ${until(w.resetsAt)})`;
    const bar = h('div', { class: 'limit-bar' }, h('span', {}));
    bar.firstChild.style.width = Math.min(100, pct) + '%';
    bar.classList.toggle('warn', pct >= 75 || w.status === 'allowed_warning');
    bar.classList.toggle('full', pct >= 100 || w.status === 'rejected');
    return h('div', { class: 'limit' },
      h('div', { class: 'row' }, h('b', {}, title), sub ? h('span', { class: 'muted small' }, sub) : null, h('span', { class: 'grow' }), h('b', {}, `${pct}% used`)),
      bar, h('div', { class: 'small muted' }, resets));
  });
  const check = h('button', { class: 'btn sm', onclick: async () => { check.disabled = true; check.textContent = 'Checking…'; try { await onCheck(); } finally { check.disabled = false; check.textContent = 'Check now'; } } }, 'Check now');
  return h('div', { class: 'card usage-limits' },
    h('div', { class: 'row' }, h('b', {}, 'Plan limits'), h('span', { class: 'grow' }), check),
    ...(rows.length ? rows : [h('div', { class: 'muted small' }, 'Not known yet. Claude Code reports them with each run Handoff starts; tap Check now to ask (one tiny request to the quickest model).')]),
    l.at ? h('div', { class: 'small muted' }, `As of ${ago(l.at)}. Sessions in Claude Desktop use the same limits but only report them to the app itself.`) : null);
}

async function usageView(params) {
  setTop('Usage and limits', '#/');
  state.activeProject = null; markActive();
  const days = [1, 7, 30, 90].includes(Number(params.get('days'))) ? Number(params.get('days')) : 30;
  view.replaceChildren(h('div', { class: 'muted small' }, 'Adding up the transcripts… (the first time takes a little while)'));
  const gen = state.gen;
  let d;
  try { d = await api('GET', `/api/usage?days=${days}`); } catch (x) { return view.replaceChildren(h('div', { class: 'empty' }, x.message)); }
  if (gen !== state.gen) return;
  const render = () => {
    const tile = (label, x) => h('div', { class: 'stat' }, h('div', { class: 'small muted' }, label), h('div', { class: 'stat-n' }, money(x.cost)), h('div', { class: 'small muted' }, `${tokens(x.tokens.total)} tokens · ${x.tokens.replies} replies`));
    const max = Math.max(...d.byDay.map(x => x.cost), 0.0001);
    const chart = h('div', { class: 'usage-chart', role: 'img', 'aria-label': `Estimated cost per day, last ${days} days` },
      ...d.byDay.map(x => {
        const b = h('div', { class: 'usage-col', title: `${x.day}: ${money(x.cost)} · ${tokens(x.tokens.total)} tokens` }, h('span', {}));
        b.firstChild.style.height = Math.max(x.cost ? 2 : 0, Math.round(x.cost / max * 100)) + '%';
        return b;
      }));
    const range = h('div', { class: 'row seg' }, ...[[1, 'Today'], [7, '7 days'], [30, '30 days'], [90, '90 days']].map(([n, label]) =>
      h('a', { class: 'btn sm' + (n === days ? ' primary' : ''), href: `#/usage?days=${n}` }, label)));
    const breakdown = x => `${tokens(x.tokens.input)} in · ${tokens(x.tokens.output)} out · ${tokens(x.tokens.cacheRead)} cache read · ${tokens(x.tokens.cacheWrite)} cache write`;
    view.replaceChildren(
      limitCard(d.limits, async () => {
        try { const r = await api('POST', '/api/usage/limits'); d.limits = r.limits; if (!r.reported) toast('Claude Code answered but didn\'t report limits.', 5000); render(); }
        catch (x) { toast(x.message, 6000); }
      }),
      h('div', { class: 'stats' }, tile('Last 5 hours', d.totals.fiveHours), tile('Today', d.totals.today), tile('Last 7 days', d.totals.week)),
      h('div', { class: 'small muted' }, 'Cost is an estimate at API list prices, for every Claude Code session on this computer (Desktop, terminal, IDE and Handoff). A Pro or Max plan isn\'t billed per token.'),
      range,
      h('h2', {}, days === 1 ? 'Today' : `Last ${days} days: ${money(d.totals.range.cost)}`),
      days > 1 ? chart : null,
      h('div', { class: 'small muted' }, breakdown(d.totals.range)),
      h('h2', {}, 'By model'),
      h('div', { class: 'list' }, ...(d.byModel.length ? d.byModel.map(m => h('div', { class: 'card' },
        h('div', { class: 't' }, m.model, h('span', { class: 'muted' }, ` · ${money(m.cost)}${m.priced ? '' : ' (price unknown)'}`)),
        h('div', { class: 's' }, breakdown(m)))) : [h('div', { class: 'empty' }, 'Nothing in this period.')])),
      h('h2', {}, 'By project'),
      h('div', { class: 'list' }, ...d.byProject.map(p => h('a', { class: 'card', href: `#/p/${encodeURIComponent(p.key)}` },
        h('div', { class: 't' }, p.name, h('span', { class: 'muted' }, ` · ${money(p.cost)}`)),
        h('div', { class: 's' }, `${tokens(p.tokens.total)} tokens · ${p.tokens.replies} replies`)))),
      h('h2', {}, 'Heaviest chats'),
      h('div', { class: 'list' }, ...d.bySession.map(s => h('a', { class: 'card', href: `#/s/${s.id}` },
        h('div', { class: 't' }, s.title, h('span', { class: 'muted' }, ` · ${money(s.cost)}`)),
        h('div', { class: 's' }, `${s.project} · ${tokens(s.tokens.total)} tokens${s.last ? ' · ' + ago(s.last) : ''}`)))));
  };
  render();
}

// ---------- the laptop: battery, when it would sleep, keep awake ----------
const mins = m => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
const batteryLine = b => !b ? 'No battery' : `${b.percent}% · ${b.charging ? 'charging' : b.plugged ? 'plugged in' : 'on battery'}${!b.plugged && b.minutesLeft ? ` · about ${mins(b.minutesLeft)} left` : ''}`;
const KEEP = [
  ['off', 'Off', 'The computer sleeps as Windows is set up to.'],
  ['working', 'While Claude works', 'Awake while any session is busy or waiting for you, and 10 minutes after.'],
  ['always', 'Always', 'Awake until you turn this off.']
];
async function showLaptop() {
  const body = h('div', { class: 'list laptop' }, h('div', { class: 'muted small' }, 'Asking the computer…'));
  openSheet('Laptop', body);
  const render = s => {
    const k = s.keepAwake, sl = s.sleep;
    const sleepText = !sl ? null
      : sl.afterMinutes === 0 && !sl.hibernateAfterMinutes ? 'Never sleeps by itself (its power setting).'
      : [sl.afterMinutes ? `Sleeps after ${mins(sl.afterMinutes)} idle` : null, sl.hibernateAfterMinutes ? `hibernates after ${mins(sl.hibernateAfterMinutes)}` : null].filter(Boolean).join(', ') + (sl.onBattery ? ' (on battery).' : '.')
        + (k.active ? ' Handoff is keeping it awake now.' : sl.inMinutes != null ? ` Idle for ${mins(sl.idleMinutes)}: it would sleep in about ${mins(sl.inMinutes)}.` : '');
    const awake = !k.supported ? 'Keeping awake isn\'t supported on this system.'
      : !k.active ? 'Not keeping it awake right now.'
      : k.graceUntil && k.graceUntil > Date.now() && k.mode === 'working' ? `Awake: Claude is working, or stopped less than 10 minutes ago (until about ${new Date(k.graceUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} if nothing else happens).`
      : `Awake since ${new Date(k.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    const set = async mode => { try { render(await api('POST', '/api/laptop/keep-awake', { mode })); } catch (x) { toast(x.message); } };
    body.replaceChildren(
      h('div', { class: 'card' }, h('div', { class: 't' }, s.battery && !s.battery.plugged && s.battery.percent <= 20 ? '🪫 ' : '🔋 ', batteryLine(s.battery)),
        sleepText ? h('div', { class: 's wrap' }, sleepText) : null,
        sl?.lid && sl.lid !== 'nothing' ? h('div', { class: 's wrap' }, `Closing the lid: ${sl.lid === 'sleep' ? 'sleeps' : sl.lid === 'hibernate' ? 'hibernates' : 'shuts down'}, even while kept awake.`) : null),
      h('div', { class: 'label' }, 'Keep awake'),
      h('div', { class: 'list' }, ...KEEP.map(([mode, label, text]) => h('button', { class: 'card keep' + (k.mode === mode ? ' on' : ''), 'aria-pressed': String(k.mode === mode), onclick: () => set(mode) },
        h('div', { class: 't' }, (k.mode === mode ? '● ' : '○ ') + label), h('div', { class: 's wrap' }, text)))),
      h('div', { class: 'small muted' }, awake),
      h('div', { class: 'small muted' }, `${s.host.name} · up ${mins(Math.round(s.host.uptime / 60))} · ${Math.round(s.host.memory.free / 1e9)} of ${Math.round(s.host.memory.total / 1e9)} GB memory free`));
  };
  try { render(await api('GET', '/api/laptop')); } catch (x) { body.replaceChildren(h('div', { class: 'empty' }, x.message)); }
}

// ---------- "Try it": the API itself, from this page, with a key pasted here ----------
// The key stays in this page's memory only (never stored), and every call goes to /api/v1 exactly
// as a program's would. The same call is shown as curl, Python and JavaScript, the key masked on
// screen and put in only when copied.
let tryKey = '';
async function tryItView() {
  setTop('Try the API', '#/');
  const base = `${location.origin}/api/v1`;
  const call = (method, p, body) => fetch(base + p, { method, headers: { Authorization: `Bearer ${tryKey}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const keyIn = h('input', { type: 'password', placeholder: 'Paste an API key (hk_…)', autocomplete: 'off', spellcheck: 'false' });
  keyIn.value = tryKey;
  const who = h('div', { class: 'muted small' }, 'Kept only in this page while it\'s open; never saved. Make keys in the menu → API access.');
  const ACTIONS = { chat: 'Chat', message: 'Message a session', ask: 'Ask without a trace', compare: 'Compare models' };
  let action = 'chat';
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'What to do' });
  const session = h('select', { 'aria-label': 'Session' });
  const model = h('select', { 'aria-label': 'Model' }), model2 = h('select', { 'aria-label': 'Second model' }), model3 = h('select', { 'aria-label': 'Third model' });
  const effort = h('select', { 'aria-label': 'Effort' }, h('option', { value: '' }, 'Default effort'), ...['low', 'medium', 'high', 'xhigh', 'max'].map(e => h('option', { value: e }, EFFORT_LABELS[e] || e)));
  const prompt = h('textarea', { rows: '4', placeholder: 'Your prompt…' });
  const filesIn = h('input', { type: 'file', multiple: true, 'aria-label': 'Attach files' });
  const streamBox = h('input', { type: 'checkbox' }); streamBox.checked = true;
  const sendBtn = h('button', { class: 'btn primary' }, 'Send');
  const out = h('div', { class: 'try-out' });
  const info = h('div', { class: 'muted small' });
  const raw = h('pre', { class: 'mono small' });
  const rawBox = h('details', {}, h('summary', {}, 'The full answer (JSON)'), raw);
  const codeBox = h('div', { class: 'list' });
  const sessionRow = h('div', { class: 'row' }, session);
  const compareRow = h('div', { class: 'row', hidden: true }, model2, model3);

  const fillModels = list => {
    for (const [sel, first] of [[model, 'Default model'], [model2, 'Second model'], [model3, 'Third model (optional)']]) {
      sel.replaceChildren(h('option', { value: sel === model ? '' : '' }, first), ...list.map(m => h('option', { value: m.id }, m.name || m.id)));
    }
  };
  const load = async () => {
    tryKey = keyIn.value.trim();
    if (!tryKey) return;
    try {
      const me = await call('GET', '/me');
      const j = await me.json();
      if (!me.ok) { who.textContent = `⚠️ ${j.error?.message || me.statusText}`; return; }
      who.textContent = `Key "${j.key.name}": ${j.key.scopes.join(', ')} · tools ${j.key.tools} · today ${j.today.turns} turn(s). Kept only in this page.`;
      const models = await (await call('GET', '/models')).json();
      fillModels(models.data || []);
      const s = await (await call('GET', '/sessions?limit=50')).json();
      session.replaceChildren(
        h('option', { value: '' }, 'The selected session (or a new one)'), h('option', { value: 'new' }, 'A new session'), h('option', { value: 'latest' }, 'The latest session'),
        ...(s.sessions || []).map(x => h('option', { value: x.id }, `${x.title.slice(0, 60)} · ${x.project?.name || ''}`)));
    } catch (x) { who.textContent = `⚠️ ${x.message}`; }
  };
  keyIn.addEventListener('change', load);
  // before a key is pasted: the choices that need no list
  fillModels([]);
  session.replaceChildren(h('option', { value: '' }, 'The selected session (or a new one)'), h('option', { value: 'new' }, 'A new session'), h('option', { value: 'latest' }, 'The latest session'));
  const pick = id => {
    action = id;
    for (const b of seg.children) b.classList.toggle('on', b.dataset.id === id);
    compareRow.hidden = id !== 'compare';
    renderCode();
  };
  for (const [id, label] of Object.entries(ACTIONS)) seg.append(h('button', { type: 'button', 'data-id': id, onclick: () => pick(id) }, label));

  const files = async () => Promise.all([...filesIn.files].map(f => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: f.name, data: String(r.result).split(',')[1] });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  })));
  // where the request goes, and its body
  const request = (withFiles = []) => {
    const s = session.value;
    const body = { prompt: prompt.value };
    if (model.value) body.model = model.value;
    if (effort.value) body.effort = effort.value;
    if (withFiles.length) body.files = withFiles;
    if (action === 'chat') { if (s) body.session = s; return { path: '/chat', body }; }
    if (action === 'compare') {
      body.models = [model.value || 'default', model2.value, model3.value].filter(Boolean);
      delete body.model;
      if (s && s !== 'new' && s !== 'latest') body.session = s;
      return { path: '/compare', body };
    }
    if (!s || s === 'new' || s === 'latest') return { path: null, body };
    return { path: `/sessions/${s}/${action === 'ask' ? 'ask' : 'messages'}`, body };
  };
  const masked = () => (tryKey ? `${tryKey.slice(0, 6)}…${tryKey.slice(-4)}` : 'hk_…');
  const codeFor = (lang, key) => {
    const { path: p, body } = request();
    const url = `${base}${p || '/sessions/<session id>/messages'}`;
    const j = JSON.stringify(body);
    if (lang === 'curl') return `curl ${url} \\\n  -H "Authorization: Bearer ${key}" \\\n  -d '${j.replace(/'/g, "'\\''")}'`;
    if (lang === 'python') return `import json, requests\nr = requests.post("${url}",\n    headers={"Authorization": "Bearer ${key}"},\n    json=json.loads(r'''${j}'''), timeout=120)\nprint(r.json().get("text"))`;
    return `const r = await fetch("${url}", {\n  method: "POST",\n  headers: { Authorization: "Bearer ${key}" },\n  body: JSON.stringify(${j})\n});\nconsole.log((await r.json()).text);`;
  };
  function renderCode() {
    codeBox.replaceChildren(...[['curl', 'bash', 'curl'], ['python', 'python', 'Python'], ['js', 'javascript', 'JavaScript']].map(([id, lang, label]) =>
      h('div', {}, h('div', { class: 'row' }, h('span', { class: 'label grow' }, label), copyBtn(() => codeFor(id, tryKey || 'hk_YOUR_KEY'), 'Copy with my key')), codeBlock(codeFor(id, masked()), lang))));
  }
  for (const el of [prompt, session, model, model2, model3, effort]) el.addEventListener('input', renderCode);
  for (const el of [session, model, model2, model3, effort]) el.addEventListener('change', renderCode);

  // shows an answer as it comes: Server-Sent Events from fetch, or a wait-and-poll
  const sendIt = async () => {
    if (!tryKey) return toast('Paste an API key first');
    const req = request(await files().catch(() => []));
    if (!req.path) return toast('Pick a session for this');
    sendBtn.disabled = true;
    out.replaceChildren(); raw.textContent = ''; info.textContent = 'Sending…';
    const started = Date.now();
    const columns = new Map();
    const columnFor = m => {
      if (!columns.has(m)) { const text = h('div', { class: 'msg assistant' }); const col = h('div', { class: 'try-col' }, h('div', { class: 'label' }, m), text); out.append(col); columns.set(m, { text, buf: '' }); }
      return columns.get(m);
    };
    try {
      if (streamBox.checked) {
        const r = await call('POST', req.path, { ...req.body, stream: true });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error?.message || r.statusText); }
        const reader = r.body.getReader(), dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = (/^event: (.*)$/m.exec(block) || [])[1];
            const data = (/^data: (.*)$/m.exec(block) || [])[1];
            if (!ev || !data) continue;
            const d = JSON.parse(data);
            const col = columnFor(action === 'compare' ? d.model || 'Answer' : 'Answer'); // one column per model only when comparing
            if (ev === 'text') { col.buf += d.text; col.text.textContent = col.buf; }
            else if (ev === 'message' && !col.buf) { col.text.replaceChildren(md(d.text)); }
            else if (ev === 'tool') info.textContent = `• ${d.tool}${d.summary ? ': ' + d.summary : ''}`;
            else if (ev === 'approval') info.textContent = `Waiting for an approval: ${d.tool} (allow it on your phone or in the session)`;
            else if (ev === 'done' || ev === 'error' || ev === 'all_done') {
              raw.textContent = JSON.stringify(d, null, 2);
              if (ev !== 'all_done' && d.text != null) col.text.replaceChildren(md(d.text || d.error?.message || ''));
              if (ev === 'all_done') for (const a of d.answers) columnFor(a.model).text.replaceChildren(md(a.text || a.error?.message || ''));
              info.textContent = `${d.status || 'done'} · ${((Date.now() - started) / 1000).toFixed(1)} s${d.usage?.costUsd != null ? ` · ${money(d.usage.costUsd)}` : ''}${d.sessionId ? ' · ' : ''}`;
              if (d.sessionId) info.append(h('a', { href: `#/s/${d.sessionId}` }, 'open the chat'));
            }
          }
        }
      } else {
        let r = await call('POST', req.path, { ...req.body, wait: 90 });
        let j = await r.json();
        while (r.status === 202) {
          info.textContent = `${j.status}… ${((Date.now() - started) / 1000).toFixed(0)} s`;
          r = await call('GET', `${req.path === '/compare' ? '/compare' : '/turns'}/${j.id}?wait=60`);
          j = await r.json();
        }
        if (!r.ok) throw new Error(j.error?.message || r.statusText);
        raw.textContent = JSON.stringify(j, null, 2);
        if (j.answers) for (const a of j.answers) columnFor(a.model).text.replaceChildren(md(a.text || a.error?.message || ''));
        else columnFor('Answer').text.replaceChildren(md(j.text || j.error?.message || ''));
        info.textContent = `${j.status} · ${((Date.now() - started) / 1000).toFixed(1)} s`;
      }
    } catch (x) { info.textContent = `⚠️ ${x.message}`; }
    finally { sendBtn.disabled = false; }
  };
  sendBtn.addEventListener('click', sendIt);

  view.replaceChildren(h('div', { class: 'page tryit' },
    h('div', { class: 'label' }, 'API key'), keyIn, who,
    h('div', { class: 'label' }, 'What to do'), seg, sessionRow, compareRow,
    h('div', { class: 'row' }, model, effort),
    prompt,
    h('div', { class: 'row' }, filesIn, h('label', { class: 'row' }, streamBox, h('span', {}, 'Stream the answer')), h('span', { class: 'grow' }), sendBtn),
    info, out, rawBox,
    h('div', { class: 'label' }, 'The same call in code'), codeBox,
    h('div', { class: 'row' }, h('a', { class: 'btn', href: '/api/v1/docs', target: '_blank', rel: 'noopener' }, '📖 Every endpoint (Swagger)'))));
  pick('chat');
  if (tryKey) load();
}

// one key's recent calls: when, from where, what, how it went, how long, what it cost
async function showKeyActivity(k) {
  const box = h('div', { class: 'list' }, h('div', { class: 'muted small' }, 'Loading…'));
  const errorsOnly = h('input', { type: 'checkbox' });
  const close = openSheet(`Activity · ${k.name}`, h('label', { class: 'row' }, errorsOnly, h('span', {}, 'Errors only')), box);
  const load = async () => {
    try {
      const { entries } = await api('GET', `/api/keys/${k.id}/activity?limit=200${errorsOnly.checked ? '&errors=1' : ''}`);
      box.replaceChildren(...(entries.length ? entries.map(e => {
        const bad = e.status >= 400 || e.turnStatus === 'error';
        const what = e.action === 'api_turn' ? `turn ${e.turnStatus}${e.model ? ` · ${e.model}` : ''}${e.costUsd != null ? ` · ${money(e.costUsd)}` : ''}` : `${e.method} ${String(e.path || '').replace(/^\/api\/v1/, '')} → ${e.status}`;
        return h('div', { class: `card act${bad ? ' bad' : ''}` },
          h('div', { class: 't' }, h('span', { class: 'mono' }, what), e.ms != null ? h('span', { class: 'muted small' }, `${e.ms < 1000 ? e.ms + ' ms' : (e.ms / 1000).toFixed(1) + ' s'}`) : null),
          h('div', { class: 's' }, `${ago(Date.parse(e.t))} · ${e.ip || ''}`, e.sessionId ? h('a', { href: `#/s/${e.sessionId}`, onclick: () => close() }, ` · chat ${e.sessionId.slice(0, 8)}`) : null),
          e.text ? h('div', { class: 's' }, e.text) : null);
      }) : [h('div', { class: 'muted' }, errorsOnly.checked ? 'No errors.' : 'No calls yet.')]));
    } catch (x) { box.replaceChildren(h('div', { class: 'empty' }, x.message)); }
  };
  errorsOnly.addEventListener('change', load);
  load();
}

// "Sign out everywhere", and optionally every API key too (a stolen cookie could have made one)
async function signOutEverywhere() {
  let keys = [];
  try { keys = (await api('GET', '/api/keys')).keys; } catch { /* still sign out */ }
  const revoke = h('input', { type: 'checkbox' });
  const close = openSheet('Sign out everywhere',
    h('div', { class: 'list' },
      h('div', {}, 'Every device signed in to Handoff is signed out, this one too.'),
      keys.length ? h('label', { class: 'row' }, revoke, h('span', {}, `Also revoke all ${keys.length} API key${keys.length === 1 ? '' : 's'}`)) : null,
      h('div', { class: 'row' }, h('button', { class: 'btn danger', onclick: async () => {
        await api('POST', '/api/logout-all', { revokeKeys: revoke.checked }).catch(() => {});
        close(); location.reload();
      } }, '⏻ Sign out everywhere'))));
}

// ---------- login ----------
function showLogin() {
  state.me = null;
  renderSide();
  showWhatsApp(null);
  state.es?.close(); state.es = null;
  setTop('Handoff');
  const err = h('div', { class: 'err' });
  const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
  const code = h('input', { type: 'text', placeholder: '6-digit code (2FA)', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' });
  const remember = h('input', { type: 'checkbox', id: 'remember', checked: store.get('remember', false) });
  const rememberRow = h('label', { for: 'remember', class: 'small muted row', hidden: true }, remember, h('span', { class: 'remember-text' }, 'Remember me'));
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'login', onsubmit: async e => {
    e.preventDefault(); btn.disabled = true; err.textContent = '';
    const keep = !rememberRow.hidden && remember.checked;
    try { await api('POST', '/api/login', { password: pw.value, code: code.value, remember: keep }); store.set('remember', keep); await boot(); }
    catch (x) { err.textContent = x.message; btn.disabled = false; }
  } }, h('h1', {}, 'Handoff'), h('div', { class: 'muted small' }, 'Remote control for Claude Code on your laptop'), pw, code, rememberRow, btn, err);
  view.replaceChildren(form);
  pw.focus();
  // the option only shows when the server allows it (HANDOFF_REMEMBER_DAYS > 0)
  fetch('/api/login-options').then(r => r.json()).then(o => {
    if (!o.rememberDays) return;
    rememberRow.lastChild.textContent = `Remember me on this device for ${o.rememberDays} day${o.rememberDays === 1 ? '' : 's'}`;
    rememberRow.hidden = false;
  }).catch(() => {});
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
      .then(d => { applyLive(d.runs, d.permissions); checkVersion(d.version); showWhatsApp(d.whatsapp); if (!streaming) setConn('poll', 'live updates by polling'); })
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
    checkVersion(d.version);
    showWhatsApp(d.whatsapp);
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
  es.addEventListener('whatsapp', e => showWhatsApp(JSON.parse(e.data)));
  // a chat's queued steps changed (one was sent, or another device edited them)
  es.addEventListener('queue', e => window.dispatchEvent(new CustomEvent('handoff-queue', { detail: JSON.parse(e.data) })));
}

// WhatsApp alerts that can't be delivered fail silently, so say so at the top of every page until it's fixed.
// × hides it until the problem changes.
function showWhatsApp(s) {
  const b = $('#banner');
  const problem = s?.enabled ? s.problem : null;
  if (!problem || state.waHidden === problem) { b.hidden = true; return; }
  const text = {
    unlinked: [`WhatsApp alerts are paused: the sending phone got unlinked. On the laptop, open ${s.qrUrl} and scan the code with that phone (WhatsApp → Settings → Linked devices → Link a device).`],
    'not-running': ["WhatsApp alerts are paused: the WhatsApp sender isn't running on the laptop. Start Docker; if it doesn't come back by itself, run ", h('code', {}, 'docker compose up -d'), ' in the folder with docker-compose.yml.'],
    offline: ["WhatsApp alerts are delayed: the sender can't reach WhatsApp right now. Is the laptop online?"]
  }[problem] || [`WhatsApp alerts can't be sent (${problem}).`];
  b.replaceChildren(h('span', { class: 'ban-icon' }, '⚠️'), h('span', { class: 'grow' }, ...text),
    h('button', { class: 'icon', 'aria-label': 'Hide this warning', onclick: () => { state.waHidden = problem; b.hidden = true; } }, '×'));
  b.hidden = false;
}

// Approve Claude's plan (ExitPlanMode), approve it and let Claude make edits without asking, or send
// it back with what to change.
function planActions(p, done) {
  const note = h('input', { type: 'text', placeholder: 'What should change? (optional)', 'aria-label': 'What should change in the plan' });
  const decide = async (allow, alwaysMode) => {
    const text = note.value.trim();
    try {
      await api('POST', `/api/permissions/${p.id}`, { allow, alwaysMode, message: allow ? undefined : text ? `The user wants changes to the plan: ${text}` : 'The user wants you to keep planning and change the plan.' });
      toast(allow ? 'Plan approved' : 'Sent back to Claude');
    } catch (x) { toast(x.message); }
    state.perms.delete(p.id); renderPerms(); done?.();
  };
  return h('div', { class: 'plan-actions' },
    h('div', { class: 'row' },
      h('button', { class: 'btn ok', onclick: () => decide(true) }, 'Approve plan'),
      h('button', { class: 'btn', onclick: () => decide(true, 'acceptEdits') }, 'Approve, accept all edits')),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, note), h('button', { class: 'btn', onclick: () => decide(false) }, 'Keep planning')));
}

function renderPerms() {
  window.dispatchEvent(new Event('handoff-perms')); // an open chat updates its plan card
  const ps = $('#perm-sheet');
  const items = [...state.perms.values()];
  const ids = items.map(p => p.id).join(',');
  if (ids === renderPerms.shown && ps.dataset.kind === 'perms') return; // unchanged: keep buttons stable under the finger
  renderPerms.shown = ids;
  ps.dataset.kind = 'perms';
  if (!items.length) { ps.hidden = true; ps.replaceChildren(); return; }
  ps.replaceChildren(...items.map(p => {
    const decide = async (allow, alwaysMode) => {
      try { await api('POST', `/api/permissions/${p.id}`, { allow, alwaysMode }); state.perms.delete(p.id); renderPerms(); }
      catch (x) { toast(x.message); state.perms.delete(p.id); renderPerms(); }
    };
    if (p.tool === 'ExitPlanMode') {
      return h('div', { class: 'perm' },
        h('div', { class: 'row' }, h('b', {}, '📋 Claude has a plan'), h('span', { class: 'grow' }),
          h('a', { href: `#/s/${p.sessionId}`, class: 'small muted' }, 'open session')),
        h('div', { class: 'small muted mono' }, p.cwd), apiChip(p.via),
        h('div', { class: 'msg assistant plan-text' }, md(p.plan || '')),
        planActions(p));
    }
    return h('div', { class: 'perm' },
      h('div', { class: 'row' }, h('b', {}, `Allow ${p.tool}?`), h('span', { class: 'grow' }),
        h('a', { href: `#/s/${p.sessionId}`, class: 'small muted' }, 'open session')),
      h('div', { class: 'small muted mono' }, p.cwd), apiChip(p.via),
      h('pre', { text: p.input }),
      h('div', { class: 'row' },
        h('button', { class: 'btn ok', onclick: () => decide(true) }, 'Allow'),
        p.tool && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(p.tool) ? h('button', { class: 'btn', onclick: () => decide(true, 'acceptEdits') }, 'Allow all edits') : null,
        h('button', { class: 'btn danger', onclick: () => decide(false) }, 'Deny')));
  }));
  ps.hidden = false;
}

let runListeners = [];
function onRunChange(r) {
  runListeners.forEach(fn => fn(r));
  clearTimeout(onRunChange.t); onRunChange.t = setTimeout(() => refreshSide(), 400); // several changes at once: one refresh
}

// ---------- search ----------
// Text with every search word highlighted (built as DOM nodes, never HTML).
// a search snippet without Markdown marks (# ** ` and table rules), so it reads as text
const plainSnippet = s => String(s || '').replace(/\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?/g, ' ').replace(/(^|\s)#{1,6}\s+/g, '$1')
  .replace(/\*\*|__|`/g, '').replace(/\s*\|\s*/g, ' · ').replace(/(\s*·\s*){2,}/g, ' · ').replace(/(\s·)+\s*$/, '').replace(/^\s*(·\s*)+/, '').replace(/\s{2,}/g, ' ').trim();
function marked(text, terms) {
  const s = String(text || ''), low = s.toLowerCase(), out = [];
  let i = 0;
  while (i < s.length && terms.length) {
    let at = -1, len = 0;
    for (const t of terms) { const j = low.indexOf(t, i); if (j >= 0 && (at < 0 || j < at)) { at = j; len = t.length; } }
    if (at < 0) break;
    if (at > i) out.push(s.slice(i, at));
    out.push(h('mark', {}, s.slice(at, at + len)));
    i = at + len;
  }
  out.push(s.slice(i));
  return out;
}
const termsOf = q => String(q).toLowerCase().split(/\s+/).filter(Boolean);
const indexingNote = d => d.indexing && d.indexing.done < d.indexing.total
  ? h('div', { class: 'notice' }, `Still building the search index (${d.indexing.done} of ${d.indexing.total} chats), so results may be incomplete.`) : null;

// One search hit, in a sheet with the messages around it.
async function showInContext(sessionId, offset, terms) {
  const box = h('div', { class: 'ctx-msgs' }, h('div', { class: 'muted small' }, 'Loading…'));
  const close = () => { overlay.remove(); removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'overlay', onclick: e => { if (e.target === overlay) close(); } },
    h('div', { class: 'ctx-sheet', role: 'dialog', 'aria-label': 'Search hit in context' },
      h('div', { class: 'row' }, h('b', {}, 'In context'), h('span', { class: 'grow' }),
        h('a', { class: 'btn', href: `#/s/${sessionId}`, onclick: close }, 'Open chat'),
        h('button', { class: 'icon', 'aria-label': 'Close', onclick: close }, '×')),
      box));
  document.body.append(overlay);
  addEventListener('keydown', onKey);
  try {
    const d = await api('GET', `/api/sessions/${sessionId}/around?offset=${offset}`);
    box.replaceChildren(...d.events.map(e => {
      const hit = e.hit ? ' hit-msg' : '';
      if (e.kind === 'user') return h('div', { class: 'msg user' + hit }, ...marked(e.text, e.hit ? terms : []));
      if (e.kind === 'assistant') return h('div', { class: 'msg assistant' + hit }, e.hit ? h('div', { class: 'pre' }, ...marked(e.text, terms)) : md(e.text));
      if (e.kind === 'tool_use') return h('div', { class: 'msg system' }, `🔧 ${e.name} ${e.summary || ''}`);
      return null;
    }).filter(Boolean));
    box.querySelector('.hit-msg')?.scrollIntoView({ block: 'center' });
  } catch (x) { box.replaceChildren(h('div', { class: 'empty' }, x.message)); }
}

// ---------- photos for a prompt ----------
// Picked from the camera or the gallery and scaled down on the phone before upload (1568 px on the
// long side, Claude's recommended size), so even big camera photos send quickly. At most 4.
async function shrinkPhoto(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const url = c.toDataURL('image/jpeg', 0.85);
  return { media_type: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), preview: url };
}
function photoPicker() {
  const photos = [];
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const strip = h('div', { class: 'photos', hidden: true });
  const button = h('button', { class: 'btn photo-btn', type: 'button', title: 'Attach photos', 'aria-label': 'Attach photos', onclick: () => input.click() }, '📷');
  const badge = n => n ? h('span', { class: 'count' }, n) : null;
  const render = () => {
    strip.hidden = !photos.length;
    strip.replaceChildren(...photos.map((p, i) => h('div', { class: 'photo' }, h('img', { src: p.preview, alt: 'Photo to send' }),
      h('button', { class: 'icon', type: 'button', 'aria-label': 'Remove this photo', onclick: () => { photos.splice(i, 1); render(); } }, '×'))));
    button.replaceChildren('📷', ...[badge(photos.length)].filter(Boolean));
  };
  const add = async files => {
    for (const f of files) {
      if (photos.length >= 4) { toast('At most 4 photos per message'); break; }
      try { photos.push(await shrinkPhoto(f)); } catch { toast(`Couldn't read ${f.name || 'a file'} as a photo`); }
    }
    render();
  };
  input.addEventListener('change', async () => { await add([...input.files]); input.value = ''; });
  return {
    add,
    button, input, strip,
    count: () => photos.length,
    take: () => photos.map(({ media_type, data }) => ({ media_type, data })),
    previews: () => photos.map(p => p.preview),
    snapshot: () => photos.slice(),
    restore: list => { photos.splice(0, photos.length, ...list); render(); },
    clear: () => { photos.length = 0; render(); }
  };
}

// ---------- views ----------
const base = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
// Cards for what is running now: sessions started from here, and Claude Code open on the laptop.
// a session started from the API, and with which key
const apiChip = via => (via ? h('span', { class: 'chip api', title: `Started from the API with the key "${via}"` }, `API · ${via}`) : null);

async function liveCards(compact = false) {
  const d = await api('GET', '/api/live');
  const seen = new Set(), cards = [];
  for (const r of d.runs) {
    if (!r.sessionId) continue;
    seen.add(r.sessionId);
    cards.push(h('a', { class: 'card', href: `#/s/${r.sessionId}` },
      h('div', { class: 't' }, h('span', {}, r.title || 'Remote session'), apiChip(r.via), h('span', { class: `chip ${r.status}` }, compact ? r.status : 'remote · ' + r.status)),
      h('div', { class: 's' }, compact ? base(r.cwd) : r.cwd)));
  }
  for (const l of d.live) {
    if (seen.has(l.sessionId)) continue;
    const where = l.entrypoint === 'claude-desktop' ? 'Desktop' : (l.entrypoint || 'CLI');
    cards.push(h('a', { class: 'card', href: `#/s/${l.sessionId}` },
      h('div', { class: 't' }, h('span', {}, l.title || l.name || l.sessionId.slice(0, 8)),
        l.question ? h('span', { class: 'chip question' }, 'question') : h('span', { class: `chip ${l.status}` }, l.status)),
      h('div', { class: 's' }, `${where} · ${compact ? base(l.cwd) : l.cwd}`)));
  }
  return cards.length ? cards : [h('div', { class: 'empty' }, 'No Claude Code sessions are running right now.')];
}
function projectCards(q = '', compact = false) {
  q = q.toLowerCase();
  const items = state.projects.filter(p => !q || p.cwd.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  return items.length ? items.map(p => h('a', { class: 'card', href: `#/p/${encodeURIComponent(p.key)}`, 'data-project': p.key },
    h('div', { class: 't' }, h('span', {}, p.name), p.live ? h('span', { class: 'chip busy' }, `${p.live} live`) : null),
    h('div', { class: 's' }, `${p.sessions} session${p.sessions === 1 ? '' : 's'} · ${ago(p.lastActivity)}${compact ? '' : ' · ' + p.cwd}`)))
    : [h('div', { class: 'empty' }, 'No projects found.')];
}

// ---------- wide screens: sessions and projects stay in a sidebar beside the open page ----------
const wide = matchMedia('(min-width: 1000px)');
const twoPane = () => wide.matches && !!state.me;
const side = { timer: null, live: null, list: null, filter: null };
function renderSide() {
  const el = $('#side');
  document.body.classList.toggle('two-pane', twoPane());
  clearInterval(side.timer); side.timer = null;
  if (!twoPane()) { el.replaceChildren(); side.live = null; return; }
  side.live = h('div', { class: 'list' }, h('div', { class: 'muted small' }, 'Loading…'));
  side.filter = h('input', { type: 'search', placeholder: 'Filter projects…', 'aria-label': 'Filter projects' });
  side.list = h('div', { class: 'list' });
  side.filter.addEventListener('input', () => { side.list.replaceChildren(...projectCards(side.filter.value, true)); markActive(); });
  el.replaceChildren(h('a', { href: '#/new', class: 'btn primary side-new' }, '＋ New session'),
    h('h2', {}, 'Live now'), side.live, h('h2', {}, 'Projects'), side.filter, side.list);
  refreshSide(true);
  side.timer = setInterval(() => { if (!document.hidden) refreshSide(); }, 5000);
}
let sideTick = 0;
async function refreshSide(withProjects = false) {
  if (!side.live) return;
  try {
    // projects change slowly: every 30s; what is live: every 5s and on every run change
    if (withProjects || ++sideTick % 6 === 0) { state.projects = await api('GET', '/api/projects'); side.list.replaceChildren(...projectCards(side.filter.value, true)); }
    side.live.replaceChildren(...await liveCards(true));
    markActive();
  } catch { /* offline: the dot in the top bar says so */ }
}
// highlight the open session, and the project it belongs to
function markActive() {
  const hash = location.hash || '#/';
  for (const a of document.querySelectorAll('#side a.card')) {
    const href = a.getAttribute('href');
    a.classList.toggle('active', href.startsWith('#/s/') ? hash.split('?')[0] === href : a.dataset.project === state.activeProject);
  }
}
wide.addEventListener?.('change', () => { renderSide(); if (state.me && /^#?\/?$/.test(location.hash)) route(); });
addEventListener('hashchange', markActive);

async function homeView() {
  setTop('Handoff');
  state.activeProject = null; markActive();
  // search across every chat; while it has text, its results take the place of the page
  const find = state.me.search ? h('input', { type: 'search', class: 'find', placeholder: 'Search all chats…', 'aria-label': 'Search all chats', value: state.homeFind || '' }) : null;
  const results = h('div', { class: 'list', hidden: true });
  const live = h('div', { class: 'list' }, h('div', { class: 'muted small' }, 'Loading…'));
  const filter = h('input', { type: 'search', placeholder: 'Filter projects…', 'aria-label': 'Filter projects' });
  const projList = h('div', { class: 'list' });
  // with the sidebar showing sessions and projects, the page itself is for search and starting work
  const normal = twoPane()
    ? h('div', { class: 'welcome' }, h('div', { class: 'welcome-icon' }), h('h1', {}, 'Pick up where Claude left off'),
        h('p', { class: 'muted' }, 'Open a live session or a project on the left, search every chat above, or start something new.'))
    : h('div', {}, h('h2', {}, 'Live now'), live, h('h2', {}, 'Projects'), filter, projList);
  // the laptop at a glance: battery and whether it's kept awake; opens the Laptop sheet
  const laptopChip = h('button', { class: 'btn sm laptop-chip', hidden: true, title: 'Battery and keep awake', onclick: () => showLaptop() });
  api('GET', '/api/laptop').then(s => {
    laptopChip.textContent = `💻 ${s.battery ? batteryLine(s.battery).split(' · ').slice(0, 2).join(' · ') : 'Laptop'}${s.keepAwake.active ? ' · kept awake' : ''}`;
    laptopChip.hidden = false;
  }).catch(() => {});
  view.replaceChildren(...[
    h('div', { class: 'row' }, twoPane() ? null : h('a', { href: '#/new', class: 'btn primary' }, '＋ New session'), h('span', { class: 'grow' }), laptopChip),
    ...(find ? [find, results] : []), normal].filter(Boolean));
  if (find) {
    let timer, seq = 0;
    const run = async () => {
      const q = find.value.trim();
      state.homeFind = q;
      results.hidden = !q; normal.hidden = !!q;
      if (!q) return;
      const my = ++seq, terms = termsOf(q);
      results.replaceChildren(h('div', { class: 'muted small' }, 'Searching…'));
      try {
        const d = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
        if (my !== seq) return;
        const cards = d.results.map(r => h('a', { class: 'card', href: `#/s/${r.sessionId}?find=${encodeURIComponent(q)}` },
          h('div', { class: 't' }, h('span', {}, ...marked(r.title, terms))),
          h('div', { class: 's' }, `${base(r.cwd || r.projectKey)} · ${ago(r.mtime)}${r.total ? ` · ${r.total} message${r.total === 1 ? '' : 's'}` : ''}`),
          ...r.hits.map(x => h('div', { class: 'hit' }, h('span', { class: 'who' }, x.kind === 'user' ? 'You' : 'Claude'), ' ', ...marked(plainSnippet(x.snippet), terms)))));
        results.replaceChildren(...[indexingNote(d), ...(cards.length ? cards : [h('div', { class: 'empty' }, 'No chat contains all of those words.')])].filter(Boolean));
      } catch (x) { if (my === seq) results.replaceChildren(h('div', { class: 'empty' }, x.message)); }
    };
    find.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 350); });
    if (find.value) run();
    if (new URLSearchParams(location.hash.split('?')[1] || '').has('search')) find.focus(); // the home-screen shortcut
  }
  if (twoPane()) return;
  const loadLive = async () => live.replaceChildren(...await liveCards());
  const renderProjects = () => projList.replaceChildren(...projectCards(filter.value));
  filter.addEventListener('input', renderProjects);
  await Promise.all([loadLive(), api('GET', '/api/projects').then(p => { state.projects = p; renderProjects(); })]);
  const timer = setInterval(() => { if (!document.hidden) loadLive().catch(() => {}); }, 5000);
  state.cleanup.push(() => clearInterval(timer));
  runListeners = [() => loadLive().catch(() => {})];
}

async function projectView(key) {
  const projects = state.projects.length ? state.projects : (state.projects = await api('GET', '/api/projects'));
  const p = projects.find(x => x.key === key) || { name: key, cwd: '' };
  setTop(p.name, '#/');
  state.activeProject = key; markActive();
  const list = h('div', { class: 'list' }, h('div', { class: 'muted small' }, 'Loading…'));
  // WhatsApp alerts can be muted per project (kept on the server)
  let muted = false;
  const muteBtn = alertsOn() && p.cwd ? h('button', { class: 'btn', onclick: async () => {
    try {
      await api('POST', '/api/notify/mute', { cwd: p.cwd, muted: !muted });
      muted = !muted; label();
      toast(muted ? 'Alerts muted for this project' : 'Alerts are on again for this project');
    } catch (x) { toast(x.message); }
  } }) : null;
  const label = () => { muteBtn.textContent = muted ? '🔔 Unmute alerts' : '🔕 Mute alerts'; };
  if (muteBtn) { label(); api('GET', '/api/notify/prefs').then(pr => { muted = pr.muted.some(c => sameDir(c, p.cwd)); label(); }).catch(() => {}); }
  view.replaceChildren(
    h('div', { class: 'page-head' }, h('div', { class: 'mono muted' }, p.cwd),
      h('div', { class: 'row' }, h('a', { class: 'btn primary', href: `#/new?cwd=${encodeURIComponent(p.cwd)}` }, '+ New session here'), muteBtn)),
    h('h2', {}, 'Sessions'), list);
  const sessions = await api('GET', `/api/projects/${encodeURIComponent(key)}/sessions`);
  list.replaceChildren(...sessions.map(s => h('a', { class: 'card', href: `#/s/${s.id}` },
    h('div', { class: 't' }, s.title, apiChip(s.via), s.run ? h('span', { class: `chip ${s.run}` }, 'remote ' + s.run) : s.live ? h('span', { class: `chip ${s.live}` }, s.live) : null),
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

// ---------- code colouring (small and dependency-free; enough to read code on a phone) ----------
const HL_KEYWORDS = {
  c: 'abstract as async await break case catch char class const continue default defer delete do double else enum export extends false final finally float for fn from func function go goto if impl implements import in instanceof int interface let long match mod mut namespace new nil null object of override package private protected pub public readonly return select self short static struct super switch synchronized this throw throws trait true try type typeof union unsafe use using val var void volatile when where while with yield',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield',
  sh: 'case do done elif else esac exit export fi for function if in local return set then until while echo cd source alias unset readonly declare true false null',
  sql: 'select from where and or not insert into values update set delete create table index view drop alter add join left right inner outer on group by order having limit offset as distinct union all null is in like between case when then else end primary key foreign references default',
  json: 'true false null'
};
const HL_LANG = {
  js: 'c', mjs: 'c', cjs: 'c', jsx: 'c', ts: 'c', tsx: 'c', mts: 'c', cts: 'c', java: 'c', c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cs: 'c', go: 'c', rs: 'c',
  swift: 'c', kt: 'c', kts: 'c', scala: 'c', php: 'c', dart: 'c', groovy: 'c', jsonc: 'c', py: 'py', rb: 'sh', sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'sh', yml: 'sh',
  yaml: 'sh', toml: 'sh', ini: 'sh', conf: 'sh', env: 'sh', dockerfile: 'sh', makefile: 'sh', r: 'sh', pl: 'sh', sql: 'sql', json: 'json', css: 'css', scss: 'css',
  less: 'css', html: 'ml', htm: 'ml', xml: 'ml', svg: 'ml', vue: 'ml', svelte: 'ml'
};
// groups: 1 comment, 2 string, 3 number, 4 word (a keyword, tag or property); (?!) marks a group a language doesn't have
const HL_RULES = {
  c: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b(?:0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b)|([A-Za-z_$][\w$]*)/gi,
  py: /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_]\w*)/g,
  sh: /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'[^'\n]*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w-]*)/g,
  sql: /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)/g,
  json: /((?!))|("(?:[^"\\\n]|\\.)*")|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([a-z]+)/gi,
  css: /(\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(#[\da-f]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg)?\b)|(@[\w-]+|[A-Za-z_-][\w-]*(?=\s*:))/gi,
  ml: /(<!--[\s\S]*?-->)|("[^"\n]*"|'[^'\n]*')|((?!))|(<\/?[A-Za-z][\w:.-]*|\/?>)/g
};
function highlight(text, name) {
  const lower = String(name).toLowerCase();
  const lang = HL_LANG[lower.match(/\.([a-z0-9]+)$/)?.[1] || lower];
  const frag = document.createDocumentFragment();
  if (!lang || text.length > 300 * 1024) { frag.append(text); return frag; } // big files: plain text, still fast
  const re = new RegExp(HL_RULES[lang].source, HL_RULES[lang].flags);
  const kw = new Set((HL_KEYWORDS[lang] || '').split(' '));
  const span = (cls, s) => { const e = document.createElement('span'); e.className = cls; e.textContent = s; return e; };
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    const [all, com, str, num, word] = m;
    let node = null;
    if (com) node = span('hl-com', all);
    else if (str) node = span(lang === 'json' && /^\s*:/.test(text.slice(re.lastIndex, re.lastIndex + 20)) ? 'hl-key' : 'hl-str', all);
    else if (num) node = span('hl-num', all);
    else if (word && lang === 'ml') node = span('hl-tag', all);
    else if (word && lang === 'css') node = span('hl-key', all);
    else if (word && kw.has(lang === 'sql' ? word.toLowerCase() : word)) node = span('hl-kw', all);
    if (!node) continue; // a plain name stays part of the text between matches
    if (m.index > last) frag.append(text.slice(last, m.index));
    frag.append(node);
    last = re.lastIndex;
  }
  frag.append(text.slice(last));
  return frag;
}

// ---------- files (read-only browser of the session's folder, HANDOFF_FILE_BROWSER) ----------
// What is open lives in the address (#/s/<id>?dir=src or ?file=src/app.js), so the phone's back
// button steps back through folders and files.
const fsize = b => (b < 1000 ? `${b} B` : size(b));
const fileIcon = e => e.type === 'dir' ? '📁' : e.kind === 'image' ? '🖼️' : e.kind === 'other' ? '📦' : '📄';
function filesPanel(id) {
  const findBox = h('input', { type: 'search', class: 'find', placeholder: 'Find files by name…', 'aria-label': 'Find files by name' });
  const body = h('div', { class: 'files' });
  const el = h('div', {}, findBox, body);
  const url = (what, p) => `/api/sessions/${id}/${what}?path=${encodeURIComponent(p)}`;
  const link = (key, p) => `#/s/${id}?${key}=${encodeURIComponent(p)}`;
  let lastDir = '', seq = 0, current = new URLSearchParams('dir='), findTimer;

  const crumbs = (folder, rel) => {
    const parts = rel ? rel.split('/') : [];
    const out = [parts.length ? h('a', { href: link('dir', '') }, folder) : h('b', {}, folder)];
    parts.forEach((p, i) => {
      out.push(h('span', { class: 'sep' }, '/'));
      out.push(i === parts.length - 1 ? h('b', {}, p) : h('a', { href: link('dir', parts.slice(0, i + 1).join('/')) }, p));
    });
    return h('div', { class: 'crumbs mono' }, ...out);
  };

  const renderDir = d => {
    lastDir = d.path;
    const up = d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/')) : '';
    const rows = d.entries.map(e => {
      const p = d.path ? `${d.path}/${e.name}` : e.name;
      return h('a', { class: 'frow' + (e.kind === 'other' ? ' off' : ''), href: link(e.type === 'dir' ? 'dir' : 'file', p), title: e.kind === 'other' ? 'Can\'t be previewed, but can be downloaded' : null },
        h('span', { class: 'ficon' }, fileIcon(e)), h('span', { class: 'fname' }, e.name),
        h('span', { class: 'fmeta' }, e.type === 'dir' ? '' : `${fsize(e.size)} · ${ago(e.mtime)}`));
    });
    if (d.path) rows.unshift(h('a', { class: 'frow', href: link('dir', up) }, h('span', { class: 'ficon' }, '↩'), h('span', { class: 'fname' }, '..')));
    body.replaceChildren(...[crumbs(d.folder, d.path),
      rows.length ? h('div', { class: 'flist' }, ...rows) : h('div', { class: 'empty' }, 'This folder is empty.'),
      d.truncated && h('div', { class: 'small muted' }, `Only the first ${d.entries.length} entries are shown.`)].filter(Boolean));
  };

  const renderFile = f => {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    lastDir = dir;
    const tools = h('div', { class: 'row small muted' }, `${fsize(f.size)} · ${ago(f.mtime)}`, h('span', { class: 'grow' }));
    let view;
    if (f.kind === 'image') {
      view = f.tooLarge ? h('div', { class: 'empty' }, 'This image is too large to show here (over 20 MB).')
        : h('div', { class: 'fimg' }, h('img', { src: url('raw', f.path), alt: f.name }));
      if (!f.tooLarge) tools.append(h('a', { class: 'btn', href: url('raw', f.path), target: '_blank', rel: 'noopener' }, 'Full size'));
    } else if (f.kind === 'other') {
      view = h('div', { class: 'empty' }, 'This file can\'t be previewed (only text, code and images are shown), but you can download it.');
    } else {
      const lines = f.text.split('\n').length - (f.text.endsWith('\n') ? 1 : 0);
      tools.firstChild.textContent += ` · ${lines} line${lines === 1 ? '' : 's'}`;
      const code = h('pre', { class: 'code' });
      code.append(highlight(f.text, f.name));
      const source = h('div', { class: 'fcode' + (store.get('wrap', false) ? ' wrap' : '') },
        h('pre', { class: 'gutter', 'aria-hidden': 'true', text: Array.from({ length: Math.max(lines, 1) }, (_, i) => i + 1).join('\n') }), code);
      const wrap = h('button', { class: 'btn', onclick: () => { const on = source.classList.toggle('wrap'); store.set('wrap', on); wrap.textContent = on ? 'No wrap' : 'Wrap lines'; } },
        source.classList.contains('wrap') ? 'No wrap' : 'Wrap lines');
      if (/\.(md|markdown|mdx)$/i.test(f.name)) {
        // Markdown opens as a preview; Source shows the text with line numbers
        const preview = h('div', { class: 'msg assistant md-preview' }, md(f.text));
        view = h('div', {}, preview, source);
        const set = on => { preview.hidden = !on; source.hidden = on; wrap.hidden = on; toggle.textContent = on ? 'Source' : 'Preview'; store.set('mdPreview', on); };
        const toggle = h('button', { class: 'btn', onclick: () => set(preview.hidden) });
        tools.append(toggle, wrap);
        set(store.get('mdPreview', true));
      } else {
        view = source;
        tools.append(wrap);
      }
    }
    tools.append(h('a', { class: 'btn', href: url('download', f.path), download: f.name }, 'Download'));
    body.replaceChildren(...[crumbs(f.folder, f.path), tools,
      f.truncated && h('div', { class: 'notice' }, 'This file is large: only the first 1 MB is shown. Download it to see all of it.'), view].filter(Boolean));
  };

  // Find by name anywhere in the project; while the box has text, its results replace the listing
  const runFind = async () => {
    const q = findBox.value.trim();
    if (!q) return show(current);
    const my = ++seq;
    body.replaceChildren(h('div', { class: 'muted small' }, 'Searching…'));
    try {
      const d = await api('GET', `/api/sessions/${id}/find?q=${encodeURIComponent(q)}`);
      if (my !== seq) return;
      const terms = termsOf(q);
      const rows = d.results.map(r => h('a', { class: 'frow' + (r.kind === 'other' ? ' off' : ''), href: link(r.type === 'dir' ? 'dir' : 'file', r.path) },
        h('span', { class: 'ficon' }, fileIcon(r)), h('span', { class: 'fname mono' }, ...marked(r.path, terms))));
      body.replaceChildren(...[
        h('div', { class: 'small muted' }, `${d.results.length}${d.truncated ? '+' : ''} match${d.results.length === 1 ? '' : 'es'} in ${d.folder}`),
        rows.length ? h('div', { class: 'flist' }, ...rows) : h('div', { class: 'empty' }, 'No file or folder name contains that.'),
        d.truncated && h('div', { class: 'small muted' }, 'Stopped early: there are a lot of files. .git and node_modules are never searched.')].filter(Boolean));
    } catch (x) { if (my === seq) body.replaceChildren(h('div', { class: 'empty' }, x.message)); }
  };
  findBox.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 300); });

  const show = async params => {
    current = params;
    findBox.value = ''; // opening a folder or file (also from a find result) ends the search
    const my = ++seq; // ignore answers for a folder or file the user has already left
    body.replaceChildren(h('div', { class: 'muted small' }, 'Loading…'));
    try {
      if (params.has('file')) { const f = await api('GET', url('file', params.get('file'))); if (my === seq) renderFile(f); }
      else { const d = await api('GET', url('files', params.get('dir') || '')); if (my === seq) renderDir(d); }
    } catch (x) {
      if (my === seq && x.message !== 'unauthorized') body.replaceChildren(h('div', { class: 'row' }, h('a', { class: 'btn', href: link('dir', '') }, 'Back to the top folder')), h('div', { class: 'empty' }, x.message));
    }
  };
  return { el, show, lastDir: () => lastDir };
}

// ---------- changes (uncommitted git changes in the session's folder) ----------
// #/s/<id>?changes= lists the changed files, ?diff=<path> shows one file's diff. With git actions on
// (HANDOFF_GIT_ACTIONS): tick files and commit them (Claude can write the message), push, discard one
// file's changes, and remove the session's own worktree once its work is committed.
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// "Are you sure?" with the risky button on the right; the sheet stays open (with the error) if it fails
function confirmSheet(title, text, label, action) {
  const err = h('div', { class: 'err' });
  const go = h('button', { class: 'btn danger', onclick: async () => {
    go.disabled = true; err.textContent = '';
    try { await action(); close(); } catch (x) { if (x.message !== 'unauthorized') err.textContent = x.message; go.disabled = false; }
  } }, label);
  const close = openSheet(title, ...[text].flat().map(t => h('p', { class: 'small sheet-text' }, t)), err,
    h('div', { class: 'row' }, h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), go));
  return close;
}

// Comments on diff lines, kept on this device (per chat) until they are sent to Claude as one message
const reviewKey = id => `handoff.review.${id}`;
function loadNotes(id) {
  try { const v = JSON.parse(localStorage.getItem(reviewKey(id)) || '[]'); return Array.isArray(v) ? v.filter(n => n && n.path && n.text) : []; } catch { return []; }
}
function saveNotes(id, list) {
  try { list.length ? localStorage.setItem(reviewKey(id), JSON.stringify(list)) : localStorage.removeItem(reviewKey(id)); } catch { /* private mode */ }
}
const noteWhere = n => `${n.side === 'old' ? 'removed line' : 'line'} ${n.num}`;
function reviewMessage(list, extra = '') {
  const files = [...new Set(list.map(n => n.path))];
  const parts = ['My comments on the changes, line by line (the file, the line as it is in the diff, then the comment):'];
  for (const file of files) {
    for (const n of list.filter(x => x.path === file).sort((a, b) => a.num - b.num)) {
      parts.push(`${file}, ${noteWhere(n)}:\n> ${n.code.trim() || '(blank line)'}\n${n.text.trim()}`);
    }
  }
  if (extra.trim()) parts.push(extra.trim());
  return parts.join('\n\n');
}

function changesPanel(id) {
  const el = h('div', { class: 'files' });
  const link = (key, p) => `#/s/${id}?${key}=${encodeURIComponent(p)}`;
  const BADGE = { modified: ['M', 'Modified'], added: ['A', 'Added'], deleted: ['D', 'Deleted'], renamed: ['R', 'Renamed'], untracked: ['N', 'New, not in git yet'], conflict: ['!', 'Merge conflict'] };
  const gitOn = !!state.me.git;
  const skip = new Set();   // files unticked for the next commit (anything new starts ticked)
  const msg = h('textarea', { class: 'commit-msg', rows: '3', placeholder: 'Commit message', 'aria-label': 'Commit message' });
  let last = null;          // the latest list: the diff page words Discard by the file's status
  let pushed = null;        // the latest push, kept on screen (with its pull request link) across refreshes
  let seq = 0, shown = '', cur = new URLSearchParams('changes=');
  const refresh = () => show(new URLSearchParams('changes='));
  const redraw = () => show(cur);
  const fail = (box, x) => { if (x.message !== 'unauthorized') { box.className = 'err'; box.textContent = x.message; } };

  const fileLabel = f => {
    const notes = loadNotes(id).filter(n => n.path === f.path).length;
    return [h('span', { class: `badge ${f.status}`, title: BADGE[f.status][1] }, BADGE[f.status][0]),
      h('span', { class: 'fname mono' }, f.path), f.from ? h('span', { class: 'fmeta' }, `was ${f.from}`) : null,
      notes ? h('span', { class: 'fmeta keep', title: `${plural(notes, 'comment')} for Claude` }, `💬 ${notes}`) : null];
  };

  // all comments in this chat, reviewed and sent to Claude as one message
  const sendReview = () => {
    const extra = h('textarea', { rows: '2', placeholder: 'Anything else to tell Claude? (optional)' });
    const err = h('div', { class: 'err' });
    const items = h('div', { class: 'list review-list' });
    const draw = () => {
      const list = loadNotes(id);
      if (!list.length) { close(); redraw(); return; }
      items.replaceChildren(...list.map((n, i) => h('div', { class: 'review-item' },
        h('div', { class: 'row' }, h('span', { class: 'grow mono small' }, `${n.path} · ${noteWhere(n)}`),
          h('button', { class: 'icon', 'aria-label': 'Remove this comment', onclick: () => { const l = loadNotes(id); l.splice(i, 1); saveNotes(id, l); draw(); } }, '×')),
        h('div', { class: 'review-code' }, n.code.trim() || ' '),
        h('div', { class: 'review-text' }, n.text))));
    };
    const go = h('button', { class: 'btn primary', onclick: async () => {
      go.disabled = true; err.textContent = '';
      try {
        await api('POST', `/api/sessions/${id}/message`, { text: reviewMessage(loadNotes(id), extra.value) });
        saveNotes(id, []);
        close();
        toast('Your comments are on their way to Claude');
        location.hash = `#/s/${id}`;
      } catch (x) { if (x.message !== 'unauthorized') err.textContent = x.message; go.disabled = false; }
    } }, 'Send to Claude');
    const clear = h('button', { class: 'btn danger', onclick: () => { saveNotes(id, []); close(); redraw(); } }, 'Clear all');
    const close = openSheet(`${plural(loadNotes(id).length, 'comment')} for Claude`, items, extra, err,
      h('div', { class: 'row' }, clear, h('span', { class: 'grow' }), go));
    draw();
  };
  const reviewBar = () => {
    const list = loadNotes(id);
    if (!list.length) return null;
    const files = new Set(list.map(n => n.path)).size;
    return h('div', { class: 'review-bar' },
      h('span', { class: 'grow' }, `💬 ${plural(list.length, 'comment')}`, files > 1 ? h('span', { class: 'muted' }, ` on ${files} files`) : null),
      h('button', { class: 'btn primary sm', onclick: () => sendReview() }, 'Review and send'));
  };

  const pushBox = d => {
    const out = h('div', { class: 'small muted' });
    const btn = h('button', { class: d.files.length ? 'btn' : 'btn primary', onclick: async () => {
      btn.disabled = true; btn.textContent = 'Pushing…'; out.className = 'small muted'; out.textContent = '';
      try {
        pushed = await api('POST', `/api/sessions/${id}/push`);
        toast(pushed.upToDate ? 'Already up to date' : `Pushed ${pushed.branch} to ${pushed.remote}`);
        refresh();
      } catch (x) { fail(out, x); btn.disabled = false; btn.textContent = 'Push'; }
    } }, 'Push');
    return h('div', { class: 'card git-card' }, ...[
      d.ahead > 0 && h('div', { class: 'row' },
        h('span', { class: 'grow' }, `⬆ ${plural(d.ahead, 'commit')} not pushed ${d.upstream ? `to ${d.upstream}` : 'yet'}`,
          d.behind ? h('span', { class: 'muted' }, ` · ${d.behind} on the remote to pull first`) : null), btn),
      pushed && h('div', { class: 'row' },
        h('span', { class: 'grow small muted' }, pushed.upToDate ? 'Everything was already pushed.' : `Pushed ${pushed.branch} to ${pushed.remote}.`),
        pushed.prUrl && h('a', { class: 'btn primary sm', href: pushed.prUrl, target: '_blank', rel: 'noopener noreferrer' }, `${pushed.prLabel} ↗`)),
      out].filter(Boolean));
  };

  const worktreeBox = d => {
    const out = h('div', { class: 'small muted' });
    const rm = !gitOn || d.files.length ? null : h('button', { class: 'btn danger sm', onclick: () => confirmSheet('Remove this worktree?', [
      `The folder .claude/worktrees/${d.worktree} is deleted. The branch ${d.branch} and its commits stay, so nothing committed is lost.`,
      d.ahead === 1 ? "Its commit isn't pushed yet; it stays on the branch, on the laptop." : d.ahead > 1 ? `Its ${d.ahead} commits aren't pushed yet; they stay on the branch, on the laptop.` : null].filter(Boolean),
    'Remove', async () => {
      const r = await api('POST', `/api/sessions/${id}/worktree/remove`);
      toast(`Removed the worktree; the branch ${r.branch || d.branch} is kept`, 5000);
      el.replaceChildren(h('div', { class: 'empty' }, `This session's worktree is removed. Its work is on the branch ${r.branch || d.branch}.`));
    }) }, 'Remove worktree');
    return h('div', { class: 'card git-card' },
      h('div', { class: 'row' }, h('span', { class: 'grow' }, '🌿 Its own worktree ', h('b', {}, d.worktree), ' on ', h('code', {}, d.branch)), rm),
      h('div', { class: 'small muted' }, d.files.length ? 'Commit or discard its changes, then the worktree can be removed.'
        : 'All committed. Removing the worktree keeps its branch and commits.'), out);
  };

  const renderList = d => {
    last = d;
    if (!d.git) return el.replaceChildren(h('div', { class: 'empty' }, `Nothing to show: ${d.reason}.`));
    const canCommit = gitOn && !d.detached && d.files.length > 0;
    for (const p of [...skip]) if (!d.files.some(f => f.path === p)) skip.delete(p);
    const picked = () => d.files.filter(f => !skip.has(f.path) && f.status !== 'conflict');
    let busy = false;
    const all = h('input', { type: 'checkbox', 'aria-label': 'Tick every file' });
    const boxes = [];
    const commitBtn = h('button', { class: 'btn primary' });
    const draftBtn = h('button', { class: 'btn' }, '✨ Write with Claude');
    const note = h('div', { class: 'small muted' });
    const sync = () => {
      const n = picked().length;
      commitBtn.textContent = busy === 'commit' ? 'Committing…' : `Commit ${plural(n, 'file')}`;
      commitBtn.disabled = draftBtn.disabled = !n || !!busy;
      all.checked = n > 0 && n === d.files.length;
      all.indeterminate = n > 0 && n < d.files.length;
    };
    const rows = d.files.map(f => {
      if (!canCommit) return h('a', { class: 'frow', href: link('diff', f.path) }, ...fileLabel(f));
      const box = h('input', { type: 'checkbox', 'aria-label': `Include ${f.path} in the commit`, disabled: f.status === 'conflict', onchange: () => { box.checked ? skip.delete(f.path) : skip.add(f.path); sync(); } });
      box.checked = !skip.has(f.path) && f.status !== 'conflict';
      boxes.push(box);
      return h('div', { class: 'frow pick' }, h('label', { class: 'fcheck' }, box), h('a', { class: 'frow-link', href: link('diff', f.path) }, ...fileLabel(f)));
    });
    all.addEventListener('change', () => {
      for (const f of d.files) all.checked ? skip.delete(f.path) : skip.add(f.path);
      for (const b of boxes) if (!b.disabled) b.checked = all.checked;
      sync();
    });
    draftBtn.addEventListener('click', async () => {
      busy = 'draft'; sync(); draftBtn.textContent = 'Writing…';
      note.className = 'small muted'; note.textContent = 'Claude is reading the changes…';
      try {
        const r = await api('POST', `/api/sessions/${id}/commit-message`, { paths: picked().map(f => f.path) });
        msg.value = r.message;
        note.textContent = 'Read it over and change anything you like, then commit.';
      } catch (x) { fail(note, x); }
      busy = false; draftBtn.textContent = '✨ Write with Claude'; sync();
    });
    commitBtn.addEventListener('click', async () => {
      if (!msg.value.trim()) { note.className = 'err'; note.textContent = 'Write a commit message first, or let Claude write one.'; msg.focus(); return; }
      busy = 'commit'; sync(); note.textContent = '';
      try {
        const r = await api('POST', `/api/sessions/${id}/commit`, { message: msg.value, paths: picked().map(f => f.path) });
        msg.value = ''; skip.clear(); pushed = null;
        toast(`Committed ${r.hash}: ${r.subject}`, 4000);
        refresh();
      } catch (x) { busy = false; fail(note, x); sync(); }
    });
    sync();
    const where = d.detached ? 'Detached HEAD' : `On ${d.branch}`;
    el.replaceChildren(...[
      h('div', { class: 'row small muted' }, canCommit ? h('label', { class: 'row' }, all) : null,
        h('span', { class: 'grow' }, d.files.length ? `${where} · ${d.files.length}${d.truncated ? '+' : ''} ${d.files.length === 1 ? 'file' : 'files'} changed since the last commit` : where),
        h('button', { class: 'btn sm', onclick: () => refresh() }, 'Refresh')),
      d.worktree && worktreeBox(d),
      rows.length ? h('div', { class: 'flist' }, ...rows) : h('div', { class: 'empty' }, 'No uncommitted changes.'),
      d.truncated && h('div', { class: 'small muted' }, 'Only the first 500 files are shown.'),
      canCommit && h('div', { class: 'card git-card' }, msg, h('div', { class: 'row' }, draftBtn, h('span', { class: 'grow' }), commitBtn), note),
      gitOn && d.detached && d.files.length > 0 && h('div', { class: 'small muted' }, 'Not on a branch, so committing from here is off. Check out a branch on the laptop first.'),
      gitOn && d.remotes > 0 && !d.detached && (d.ahead > 0 || pushed) && pushBox(d), reviewBar()].filter(Boolean));
  };

  // a comment on one line of the diff: added, changed or deleted in a sheet
  const editNote = (d, line, i) => {
    const list = loadNotes(id);
    const old = i == null ? null : list[i];
    const ta = h('textarea', { rows: '3', placeholder: 'What should Claude change or explain here?', 'aria-label': 'Comment' });
    ta.value = old?.text || '';
    const done = list2 => { saveNotes(id, list2); close(); redraw(); };
    const save = h('button', { class: 'btn primary', onclick: () => {
      const text = ta.value.trim();
      if (!text) return ta.focus();
      const l = loadNotes(id);
      if (old) l[i] = { ...old, text }; else l.push({ path: d.path, side: line.side, num: line.num, code: line.code, text, at: Date.now() });
      done(l);
    } }, old ? 'Save' : 'Add comment');
    const del = old ? h('button', { class: 'btn danger', onclick: () => { const l = loadNotes(id); l.splice(i, 1); done(l); } }, 'Delete') : null;
    const close = openSheet(`${d.path.split('/').pop()} · ${noteWhere(line)}`, h('div', { class: 'review-code' }, line.code || ' '), ta,
      h('div', { class: 'row' }, del, h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), save));
    ta.focus();
  };

  const renderDiff = d => {
    const keepX = el.querySelector('.fcode')?.scrollLeft || 0;
    const pre = h('pre', { class: 'diff' });
    const lines = [];       // the lines that can take a comment: { side: 'new' | 'old', num, code, el }
    let at = null, inHunk = false, widest = 1;
    for (const line of d.diff.split('\n')) {
      let cls = '', num = null, side = null;
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) { cls = 'd-hunk'; at = { old: +hunk[1], new: +hunk[2] }; inHunk = true; }
      else if (inHunk && line.startsWith('+')) { cls = 'd-add'; side = 'new'; num = at.new++; }
      else if (inHunk && line.startsWith('-')) { cls = 'd-del'; side = 'old'; num = at.old++; }
      else if (inHunk && line.startsWith(' ')) { side = 'new'; num = at.new++; at.old++; }
      else if (inHunk && line.startsWith('\\')) cls = 'd-meta'; // "\ No newline at end of file"
      else if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |Binary |old mode|new mode)/.test(line)) { cls = 'd-meta'; inHunk = false; }
      else if (line.startsWith('+')) cls = 'd-add';
      else if (line.startsWith('-')) cls = 'd-del';
      const s = document.createElement('span'); // one block per line, so added/removed colour spans the whole line
      s.className = cls || 'd-ctx';
      s.append(h('span', { class: 'ln' }, num == null ? '' : String(num)), line || ' ');
      if (num != null) {
        widest = Math.max(widest, String(num).length);
        s.classList.add('cm');
        s.dataset.i = String(lines.length);
        lines.push({ side, num, code: line.slice(1), el: s });
      }
      pre.append(s);
    }
    pre.style.setProperty('--ln-w', widest + 'ch');
    // comments under their lines: the same line if it still reads the same, else where that text went
    loadNotes(id).forEach((n, i) => {
      if (n.path !== d.path) return;
      const same = l => l.side === n.side && l.code === n.code;
      const line = lines.find(l => same(l) && l.num === n.num) || lines.find(same) || lines.find(l => l.side === n.side && l.num === n.num);
      const note = h('span', { class: 'd-note', 'data-n': String(i) }, '💬 ', n.text);
      if (line) { line.el.classList.add('has-note'); line.el.after(note); } else pre.append(note);
    });
    pre.addEventListener('click', e => {
      if (String(getSelection?.() || '')) return; // selecting text to copy, not tapping
      const note = e.target.closest('.d-note');
      if (note) { const n = loadNotes(id)[+note.dataset.n]; const line = n && (lines.find(l => l.side === n.side && l.num === n.num) || n); return n && editNote(d, line, +note.dataset.n); }
      const s = e.target.closest('span.cm');
      if (s) editNote(d, lines[+s.dataset.i]);
    });
    const info = last?.files?.find(f => f.path === d.path);
    const isNew = info ? ['untracked', 'added'].includes(info.status) : /^--- \/dev\/null$/m.test(d.diff);
    const name = d.path.split('/').pop();
    const discardBtn = gitOn && d.diff.trim() && info?.status !== 'conflict' ? h('button', { class: 'btn danger', onclick: () => confirmSheet(`Discard changes to ${name}?`, [
      isNew ? 'This file is new, so discarding deletes it.' : info?.status === 'renamed' ? `The rename is undone: it goes back to ${info.from}, as at the last commit.` : 'It goes back to how it was at the last commit.',
      "A copy of the file as it is now is kept in Handoff's data folder (discarded) for 30 days."],
    'Discard', async () => {
      await api('POST', `/api/sessions/${id}/discard`, { path: d.path });
      toast(`Discarded the changes to ${name}`);
      location.hash = link('changes', '');
    }) }, 'Discard') : null;
    const code = d.diff.trim() ? h('div', { class: 'fcode' }, pre) : null;
    el.replaceChildren(...[
      h('div', { class: 'row' }, h('a', { class: 'btn', href: link('changes', '') }, '← All changes'), h('span', { class: 'grow' }),
        h('a', { class: 'btn', href: `#/s/${id}?file=${encodeURIComponent(d.path)}` }, 'Open file'), discardBtn),
      h('div', { class: 'mono small diff-path' }, d.path),
      d.truncated && h('div', { class: 'notice' }, 'This diff is large: only the first 1 MB is shown.'),
      lines.length && h('div', { class: 'small muted' }, 'Tap a line to leave Claude a comment on it.'),
      code || h('div', { class: 'empty' }, 'No differences from the last commit.'),
      reviewBar()].filter(Boolean));
    if (code && keepX) code.scrollLeft = keepX;
  };

  const show = async params => {
    const my = ++seq;
    cur = params;
    const kind = params.has('diff') ? 'diff:' + params.get('diff') : 'list';
    if (kind !== shown) el.replaceChildren(h('div', { class: 'muted small' }, 'Loading…')); // a refresh keeps what is on screen
    shown = kind;
    try {
      if (params.has('diff')) { const d = await api('GET', `/api/sessions/${id}/diff?path=${encodeURIComponent(params.get('diff'))}`); if (my === seq) renderDiff(d); }
      else { const d = await api('GET', `/api/sessions/${id}/changes`); if (my === seq) renderList(d); }
    } catch (x) {
      if (my === seq && x.message !== 'unauthorized') el.replaceChildren(h('div', { class: 'row' }, h('a', { class: 'btn', href: link('changes', '') }, '← All changes')), h('div', { class: 'empty' }, x.message));
    }
  };
  return { el, show };
}

// ---------- overview: what a session has done (from GET /api/sessions/:id/activity) ----------
const duration = ms => {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  return hrs < 48 ? `${hrs} h ${m % 60} min` : `${Math.round(hrs / 24)} days`;
};
function overviewPanel(id, { getActivity, inProject }) {
  const el = h('div', { class: 'overview' });
  const section = (title, count, ...kids) => h('section', { class: 'ov-section' }, h('h2', {}, title, count != null ? h('span', { class: 'ov-count' }, String(count)) : null), ...kids);
  const render = () => {
    const a = getActivity();
    if (a.loading) return el.replaceChildren(h('div', { class: 'muted small' }, 'Loading…'));
    const stat = (n, label) => h('div', { class: 'ov-stat' }, h('b', {}, String(n)), h('span', {}, label));
    const files = a.files.map(x => {
      const rel = inProject(x.path), inside = rel !== x.path;
      const label = [h('span', { class: 'ficon' }, x.tool === 'Write' ? '📝' : '✏️'), h('span', { class: 'fname mono' }, rel), h('span', { class: 'fmeta' }, `${x.changes}× · ${ago(x.last)}`)];
      return state.me.files && inside ? h('a', { class: 'frow', href: `#/s/${id}?file=${encodeURIComponent(rel.replace(/\\/g, '/'))}` }, ...label) : h('div', { class: 'frow' }, ...label);
    });
    const commands = a.commands.map(c => h('div', { class: 'ov-cmd' },
      h('span', { class: 'ov-ok ' + (c.ok === false ? 'bad' : c.ok ? 'good' : ''), title: c.ok === false ? 'Failed' : c.ok ? 'Succeeded' : 'Running or no result' }, c.ok === false ? '✗' : c.ok ? '✓' : '…'),
      h('div', { class: 'grow' }, c.description ? h('div', { class: 'small' }, c.description) : null, h('code', { class: 'ov-cmdline' }, c.command)),
      h('span', { class: 'fmeta' }, ago(c.ts))));
    const agents = a.agents.map(x => h('button', { class: 'frow ov-agent', type: 'button', onclick: () => showSubagent(id, x.toolUseId, x, inProject) },
      h('span', { class: 'ficon' }, '🤖'),
      h('span', { class: 'fname' }, x.description || x.type, h('span', { class: 'small muted' }, ' · ' + x.type)),
      h('span', { class: 'chip ' + ({ done: 'idle', failed: 'error', running: 'running', background: 'running' }[x.status] || '') }, x.status === 'background' ? 'running' : x.status)));
    const todo = { completed: '✓', in_progress: '◐', pending: '○' };
    el.replaceChildren(...[
      h('div', { class: 'ov-stats' },
        stat(a.first ? duration(a.last - a.first) : '–', a.first ? `since ${new Date(a.first).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'time'),
        stat(a.prompts, a.prompts === 1 ? 'message from you' : 'messages from you'),
        stat(a.tools, a.tools === 1 ? 'tool call' : 'tool calls'),
        stat(a.files.length, a.files.length === 1 ? 'file changed' : 'files changed'),
        stat(a.commandCount, a.commandCount === 1 ? 'command' : 'commands')),
      a.plan && section('Plan', null, h('details', { class: 'tool ov-plan' }, h('summary', {}, h('b', {}, { approved: '✓ Approved', rejected: '↩ Sent back', pending: '… Waiting for approval' }[a.plan.status]), ' · ', ago(a.plan.ts)),
        h('div', { class: 'msg assistant plan-text' }, md(a.plan.text)))),
      a.todos.length && section('To-do list', `${a.todos.filter(x => x.status === 'completed').length}/${a.todos.length}`,
        h('ol', { class: 'todo-list ov-todos' }, ...a.todos.map(x => h('li', { class: x.status }, h('span', { class: 'todo-mark' }, todo[x.status] || '○'), h('span', {}, x.subject))))),
      section('Files changed', a.files.length, files.length ? h('div', { class: 'flist' }, ...files) : h('div', { class: 'empty' }, 'No files changed in this chat.')),
      section('Commands run', a.commandCount, commands.length ? h('div', { class: 'flist ov-cmds' }, ...commands) : h('div', { class: 'empty' }, 'No commands run in this chat.'),
        a.commandCount > commands.length ? h('div', { class: 'small muted' }, `The latest ${commands.length} are shown.`) : null),
      agents.length && section('Sub-agents', agents.length, h('div', { class: 'flist' }, ...agents))
    ].filter(Boolean));
  };
  return { el, render };
}

// ---------- sub-agent runs: what a sub-agent did, opened from its row in the chat or the overview ----------
async function showSubagent(sessionId, toolUseId, known = {}, rel = s => s) {
  const body = h('div', { class: 'ctx-msgs' }, h('div', { class: 'muted small' }, 'Loading…'));
  const meta = h('div', { class: 'small muted' }, [known.type, known.status].filter(Boolean).join(' · '));
  openSheet(known.description ? `🤖 ${known.description}` : '🤖 Sub-agent run', meta, body);
  try {
    const list = await api('GET', `/api/sessions/${sessionId}/agents`);
    const run = list.find(a => a.toolUseId && a.toolUseId === toolUseId) || (known.agentId && list.find(a => a.agentId === known.agentId));
    if (!run) return body.replaceChildren(h('div', { class: 'empty' }, 'This run\'s own messages aren\'t saved (older Claude Code versions keep only its result, shown in the chat).'));
    meta.textContent = [run.type || known.type, known.status, `updated ${ago(run.mtime)}`].filter(Boolean).join(' · ');
    const t = await api('GET', `/api/sessions/${sessionId}/agents/${run.agentId}`);
    body.replaceChildren(...[t.truncated ? h('div', { class: 'notice' }, 'A long run: only its latest part is shown.') : null, ...plainEvents(t.events, rel)].filter(Boolean));
  } catch (x) { body.replaceChildren(h('div', { class: 'empty' }, x.message)); }
}
// a read-only list of messages and tool calls (for sub-agent runs)
function plainEvents(events, rel = s => s) {
  const tools = new Map(), out = [];
  for (const e of events) {
    if (e.kind === 'user') out.push(e.text.length > 700
      ? h('details', { class: 'msg user prompt' }, h('summary', {}, e.text.slice(0, 220).trim() + '…'), h('div', { class: 'pre' }, e.text))
      : h('div', { class: 'msg user' }, e.text));
    else if (e.kind === 'assistant') out.push(h('div', { class: 'msg assistant' }, md(e.text)));
    else if (e.kind === 'system') out.push(h('div', { class: 'msg system', text: e.text }));
    else if (e.kind === 'tool_use' || e.kind === 'plan' || e.kind === 'question') {
      const d = h('details', { class: 'tool' }, h('summary', {}, h('span', { class: 'tsum' }, h('b', {}, e.name || e.kind), ' ', rel(e.summary || ''))), e.input ? h('pre', { text: e.input }) : null);
      tools.set(e.id, d); out.push(d);
    } else if (e.kind === 'tool_result') {
      const d = tools.get(e.toolUseId);
      if (d) { d.append(h('div', { class: 'label' }, e.isError ? 'error' : 'result'), h('pre', { text: e.text || '(empty)' })); if (e.isError) d.classList.add('err'); }
    }
  }
  return out.length ? out : [h('div', { class: 'empty' }, 'No messages yet.')];
}

// ---------- a chat's ⋯ menu ----------
function sessionActions(id, info, onRename) {
  const item = (label, fn) => h('button', { class: 'btn', onclick: () => { close(); fn(); } }, label);
  const close = openSheet(info.title || 'This chat',
    h('div', { class: 'list menu' },
      item('🖥 Preview the app…', () => showPreview(id))));
  return close;
}

// ---------- app preview: the dev server Claude is working on, opened on this device ----------
async function showPreview(sessionId) {
  const body = h('div', { class: 'list' }, h('div', { class: 'muted small' }, 'Looking for apps running on the computer…'));
  const close = openSheet('Preview an app', body);
  let d;
  try { d = await api('GET', `/api/preview${sessionId ? `?sessionId=${sessionId}` : ''}`); }
  catch (x) { return body.replaceChildren(h('div', { class: 'empty' }, x.message)); }
  if (!d.enabled) {
    return body.replaceChildren(h('div', { class: 'muted small' },
      'App preview is off. It needs its own address on your tunnel (for example preview.example.com): run ',
      h('code', {}, 'npm run setup:domain -- --preview preview.example.com'), ' on the computer, then restart Handoff.'));
  }
  const open = async port => {
    const w = window.open('', '_blank'); // opened during the tap, so the browser doesn't block it
    try {
      const r = await api('POST', '/api/preview', { port });
      if (w) w.location.href = r.url; else location.href = r.url;
      close();
    } catch (x) { w?.close(); toast(x.message, 5000); }
  };
  const byPort = new Map(d.ports.map(p => [p.port, p]));
  const row = (port, note) => {
    const p = byPort.get(port);
    return h('button', { class: 'card preview-port', onclick: () => open(port) },
      h('div', { class: 't' }, `localhost:${port}`, p?.title ? h('span', { class: 'muted' }, ` · ${p.title}`) : null),
      h('div', { class: 's' }, [note, p ? (p.process || 'running') : 'not running right now'].filter(Boolean).join(' · ')));
  };
  const mentioned = d.mentioned.map(p => row(p, 'mentioned in this chat'));
  const web = d.ports.filter(p => p.web && !d.mentioned.includes(p.port)).map(p => row(p.port, ''));
  const other = d.ports.filter(p => !p.web && !d.mentioned.includes(p.port));
  const portBox = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Port, e.g. 3000', 'aria-label': 'Port', maxlength: '5' });
  const go = () => { const n = Number(portBox.value.trim()); if (n) open(n); };
  portBox.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  body.replaceChildren(
    h('div', { class: 'muted small' }, `Opens on ${d.hostname}, behind its own sign-in, as if you were at the computer. Links you get here work once.`),
    ...(mentioned.length ? [h('div', { class: 'label' }, 'From this chat'), ...mentioned] : []),
    h('div', { class: 'label' }, 'Web apps running now'),
    ...(web.length ? web : [h('div', { class: 'muted small' }, 'None found. Start the dev server (or ask Claude to), then look again.')]),
    other.length ? h('details', { class: 'small' }, h('summary', { class: 'muted' }, `${other.length} other program${other.length === 1 ? '' : 's'} listening`),
      ...other.map(p => row(p.port, ''))) : null,
    h('div', { class: 'row' }, portBox, h('button', { class: 'btn primary', onclick: go }, 'Open')));
}

// ---------- quick replies: one tap sends a common answer; the list can be edited ----------
const QUICK_DEFAULT = ['Continue', 'Yes, go ahead', 'Run the tests', 'Explain that more simply', 'Summarize what you did'];
function editQuickReplies(onSave) {
  const box = h('textarea', { rows: '7', 'aria-label': 'Quick replies, one per line' });
  box.value = store.get('quickReplies', QUICK_DEFAULT).join('\n');
  const close = openSheet('Quick replies',
    h('div', { class: 'small muted' }, 'One per line. Tapping one sends it to Claude straight away.'), box,
    h('div', { class: 'row' },
      h('button', { class: 'btn ghost', onclick: () => { box.value = QUICK_DEFAULT.join('\n'); } }, 'Reset'), h('span', { class: 'grow' }),
      h('button', { class: 'btn primary', onclick: () => {
        store.set('quickReplies', box.value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 12));
        close(); onSave();
      } }, 'Save')));
}

async function sessionView(id, params = new URLSearchParams()) {
  setTop('Session', '#/');
  const gen = state.gen, stale = () => gen !== state.gen; // the user went elsewhere while this was loading
  let info = await api('GET', `/api/sessions/${id}`);
  if (stale()) return;
  setTop(info.title || 'Session', info.projectKey ? `#/p/${encodeURIComponent(info.projectKey)}` : '#/');
  state.activeProject = info.projectKey; markActive();

  const status = h('span', { class: 'chip' });
  const settings = h('div', { class: 'settings' });
  const stopBtn = h('button', { class: 'btn sm danger', hidden: true, title: 'End this run', onclick: async () => { await api('POST', `/api/sessions/${id}/stop`); toast('Stopped'); } }, 'Stop');
  const intBtn = h('button', { class: 'btn sm', hidden: true, title: 'Stop what Claude is doing now; the session stays open', onclick: async () => { await api('POST', `/api/sessions/${id}/interrupt`); toast('Interrupt sent'); } }, 'Interrupt');
  // search inside this chat (the whole transcript, not only what's loaded)
  const findBox = h('input', { type: 'search', class: 'find', placeholder: 'Search this chat…', 'aria-label': 'Search this chat' });
  const findList = h('div', { class: 'list' });
  const findPanel = h('div', { class: 'find-panel', hidden: true }, findBox, findList);
  let findTimer, findSeq = 0;
  const runFind = async () => {
    const q = findBox.value.trim(), my = ++findSeq, terms = termsOf(q);
    if (!q) return findList.replaceChildren();
    findList.replaceChildren(h('div', { class: 'muted small' }, 'Searching…'));
    try {
      const d = await api('GET', `/api/sessions/${id}/search?q=${encodeURIComponent(q)}`);
      if (my !== findSeq) return;
      const hits = d.results[0]?.hits || [];
      findList.replaceChildren(...[indexingNote(d),
        hits.length ? h('div', { class: 'small muted' }, `${hits.length}${hits.length === 200 ? '+' : ''} message${hits.length === 1 ? '' : 's'}, newest first. Tap one to see it in context.`) : h('div', { class: 'empty' }, 'Not found in this chat.'),
        ...hits.map(x => h('button', { class: 'hit card', onclick: () => showInContext(id, x.offset, terms) },
          h('span', { class: 'who' }, x.kind === 'user' ? 'You' : 'Claude'), x.ts ? h('span', { class: 'small muted' }, ' · ' + ago(Date.parse(x.ts))) : null, ' ', ...marked(plainSnippet(x.snippet), terms)))
      ].filter(Boolean));
    } catch (x) { if (my === findSeq) findList.replaceChildren(h('div', { class: 'empty' }, x.message)); }
  };
  findBox.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 350); });
  const openFind = q => { findPanel.hidden = false; if (q != null && q !== findBox.value) { findBox.value = q; runFind(); } findBox.focus({ preventScroll: true }); };
  const findBtn = state.me.search ? h('button', { class: 'icon', title: 'Search this chat', 'aria-label': 'Search this chat', onclick: () => { if (chat.hidden) location.hash = `#/s/${id}`; if (findPanel.hidden) { openFind(); scrollTo(0, 0); } else findPanel.hidden = true; } }, '🔍') : null;
  // alerts for this chat only (WhatsApp and phone notifications)
  let chatMuted = false;
  const muteBtn = alertsOn() ? h('button', { class: 'icon', onclick: async () => {
    try { await api('POST', '/api/notify/mute-session', { sessionId: id, muted: !chatMuted }); chatMuted = !chatMuted; muteLabel(); toast(chatMuted ? 'Alerts muted for this chat' : 'Alerts are on again for this chat'); }
    catch (x) { toast(x.message); }
  } }) : null;
  const muteLabel = () => {
    muteBtn.textContent = chatMuted ? '🔕' : '🔔';
    muteBtn.title = chatMuted ? 'Alerts for this chat are muted. Tap to turn them on again' : 'Alerts are on for this chat. Tap to mute this chat only';
    muteBtn.setAttribute('aria-label', muteBtn.title); muteBtn.setAttribute('aria-pressed', String(chatMuted));
  };
  if (muteBtn) { muteLabel(); api('GET', '/api/notify/prefs').then(pr => { chatMuted = pr.mutedSessions.includes(id); muteLabel(); }).catch(() => {}); }
  // Claude's to-do list for this chat: one line with progress and what it is doing now, which opens
  // into the whole checklist. Pinned with the header, so it stays in view.
  const todoBox = h('details', { class: 'todos', hidden: true });
  todoBox.open = store.get('todosOpen', false);
  todoBox.addEventListener('toggle', () => store.set('todosOpen', todoBox.open));
  let activity = { todos: [], plan: null, files: [], commands: [], commandCount: 0, agents: [], tools: 0, prompts: 0, first: 0, last: 0, loading: true };
  const renderTodos = list => {
    todoBox.hidden = !list.length;
    if (!list.length) return todoBox.replaceChildren();
    const done = list.filter(x => x.status === 'completed').length, now = list.find(x => x.status === 'in_progress');
    const bar = h('span', { class: 'todo-bar' }, h('span', {}));
    bar.firstChild.style.width = Math.round(done / list.length * 100) + '%';
    const mark = { completed: '✓', in_progress: '◐', pending: '○' };
    todoBox.replaceChildren(
      h('summary', {}, h('span', { class: 'todo-count' }, done === list.length ? `✓ All ${list.length} done` : `${done} of ${list.length} done`),
        h('span', { class: 'todo-now' }, now ? (now.activeForm || now.subject) : done === list.length ? '' : 'To-do list'), bar),
      h('ol', { class: 'todo-list' }, ...list.map(x => h('li', { class: x.status }, h('span', { class: 'todo-mark', 'aria-hidden': 'true' }, mark[x.status] || '○'), h('span', {}, x.subject)))));
  };
  // to-do list, plan and the rest of the overview come from the whole transcript on the server
  let actTimer = null;
  const loadActivity = async () => {
    try { activity = await api('GET', `/api/sessions/${id}/activity`); renderTodos(activity.todos); window.dispatchEvent(new Event('handoff-activity')); } catch { /* next change tries again */ }
  };
  const activitySoon = () => { clearTimeout(actTimer); actTimer = setTimeout(loadActivity, 700); };
  state.cleanup.push(() => clearTimeout(actTimer));
  // everything else this chat can do: preview its app, rename, pin, tag, archive, export, share
  const moreBtn = h('button', { class: 'icon', title: 'More', 'aria-label': 'More actions for this chat', onclick: () => sessionActions(id, info, t => { info.title = t; setTop(t || 'Session', info.projectKey ? `#/p/${encodeURIComponent(info.projectKey)}` : '#/'); }) }, '⋯');
  // pinned under the top bar, so status, actions and tabs stay in reach however far the chat scrolls
  const head = h('div', { class: 'session-head' },
    h('div', { class: 'session-bar' }, status, apiChip(info.via), h('div', { class: 'cwd mono', title: info.cwd || '' }, h('span', { dir: 'ltr' }, info.cwd || '')), findBtn, muteBtn, moreBtn, intBtn, stopBtn),
    settings, todoBox);
  const msgs = h('div', { id: 'msgs' });
  const working = h('div', { class: 'working', hidden: true }, h('span', { class: 'spinner' }), h('span', { class: 'wtext' }, 'Claude is working…'));
  const older = h('button', { class: 'btn', hidden: true }, 'Load older messages');

  // composer
  const ta = h('textarea', { rows: '1', placeholder: 'Message Claude…', enterkeyhint: 'send', 'aria-label': 'Message' });
  const picks = makePickers(info.run ? { model: info.run.model, effort: info.run.effort, mode: info.run.mode } : {});
  const send = h('button', { class: 'btn primary send', title: 'Send (Ctrl+Enter)', 'aria-label': 'Send' }, '↑');
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
    else if (isLive()) {
      notice.textContent = `Live in ${info.live.entrypoint === 'claude-desktop' ? 'Claude Desktop' : 'a terminal'}: messages go straight into it.`;
      notice.title = 'Your message shows on the laptop. Model, effort, mode and tool approvals stay as set there.';
    }
    notice.classList.toggle('live', isLive() && !forkBox.checked && !info.question);
    for (const el of picks.els) el.classList.toggle('off', isLive()); // the running laptop session keeps its own settings
  };
  forkBox.addEventListener('change', updateNotice);

  // transcript rendering (de-duplicated: events can arrive from the stream, the poller and the initial load)
  const tools = new Map(), questions = new Map(), plans = new Map(), quiet = new Set(), seen = new Set(), pending = [];
  // to-do bookkeeping shows in the header strip, so in the chat it is one quiet line, not a tool box
  const QUIET_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite', 'TaskList', 'TaskGet']);
  const todoLine = e => {
    let i = {};
    try { i = JSON.parse(e.input || '{}'); } catch { /* cut short */ }
    const name = id => activity.todos.find(x => x.id === String(id))?.subject || `to-do ${id}`;
    if (e.name === 'TaskCreate') return `☐ Added to the to-do list: ${i.subject || i.content || 'a step'}`;
    if (e.name === 'TaskUpdate') return i.status === 'completed' ? `☑ Done: ${name(i.taskId)}` : i.status === 'in_progress' ? `▸ Working on: ${name(i.taskId)}` : i.status === 'deleted' ? `✕ Dropped: ${name(i.taskId)}` : `✎ Updated: ${name(i.taskId)}`;
    if (e.name === 'TodoWrite') { const l = Array.isArray(i.todos) ? i.todos : []; return `☑ To-do list: ${l.filter(x => x.status === 'completed').length} of ${l.length} done`; }
    return '☐ Checked the to-do list';
  };
  // Claude's plan: shown in full, with approve / send back while it waits (for runs started here)
  const planCard = e => {
    const status = h('span', { class: 'chip' }, 'waiting');
    const actions = h('div', {});
    const card = h('div', { class: 'plancard' }, h('div', { class: 'plan-head' }, h('b', {}, '📋 Plan'), h('span', { class: 'grow' }), status),
      h('div', { class: 'msg assistant plan-text' }, md(e.text || '(empty plan)')), actions);
    card.settle = (approved, text) => {
      card.classList.add(approved ? 'approved' : 'rejected');
      status.className = 'chip ' + (approved ? 'idle' : 'error');
      status.textContent = approved ? 'approved' : 'sent back';
      actions.replaceChildren(...(!approved && text ? [h('div', { class: 'q-status' }, text.replace(/^.*?(the user said:?|changes to the plan:)\s*/is, '').slice(0, 400))] : []));
    };
    card.refresh = () => {
      if (card.classList.contains('approved') || card.classList.contains('rejected')) return;
      const p = [...state.perms.values()].find(x => x.sessionId === id && x.tool === 'ExitPlanMode');
      if ((p?.id || '') === card.permId) return; // unchanged: keep what is being typed
      card.permId = p?.id || '';
      if (p) actions.replaceChildren(planActions(p));
      else actions.replaceChildren(h('div', { class: 'q-status' }, info.live && !info.run ? 'Waiting for approval on the laptop.' : 'Waiting for approval.'));
    };
    card.refresh();
    return card;
  };
  const onPerms = () => { for (const c of plans.values()) c.refresh(); };
  window.addEventListener('handoff-perms', onPerms);
  state.cleanup.push(() => window.removeEventListener('handoff-perms', onPerms));
  const keyOf = e => e.uuid ? `${e.uuid}:${e.kind}:${e.id || e.toolUseId || ''}:${(e.text || '').length}` : null;
  const nearBottom = () => innerHeight + scrollY >= document.body.scrollHeight - 160;
  // tool rows name files inside the project by their path from the project folder
  const inProject = s => {
    const root = String(info.cwd || '').replace(/[\\/]+$/, '');
    return root && s.length > root.length && s.slice(0, root.length).toLowerCase() === root.toLowerCase() && /[\\/]/.test(s[root.length]) ? s.slice(root.length + 1) : s;
  };
  const render = (e) => {
    if (e.kind === 'user') {
      const t = e.text.trim();
      const i = pending.findIndex(p => p.text === t || (p.photos && (t === '📷 Photo' || t.startsWith(p.text))));
      if (i >= 0) { pending[i].el.remove(); pending.splice(i, 1); }
      return h('div', { class: 'msg user' }, e.text, e.remote ? h('div', { class: 'via' }, 'sent from Handoff') : null);
    }
    if (e.kind === 'assistant') return h('div', { class: 'msg assistant' + (e.error ? ' error' : '') }, md(e.text));
    if (e.kind === 'system') return h('div', { class: 'msg system', text: e.text });
    if (e.kind === 'plan') {
      const card = planCard(e);
      plans.set(e.id, card);
      return card;
    }
    if (e.kind === 'tool_use' && QUIET_TOOLS.has(e.name)) { quiet.add(e.id); return h('div', { class: 'msg system todo-line' }, todoLine(e)); }
    if (e.kind === 'question') {
      const card = questionCard(id, e, () => info.question = null);
      questions.set(e.id, card);
      return card;
    }
    if (e.kind === 'tool_use') {
      const isAgent = e.name === 'Agent' || e.name === 'Task';
      const open = isAgent ? h('button', { class: 'btn sm agent-open', type: 'button', onclick: ev => {
        ev.preventDefault(); ev.stopPropagation(); // don't fold the row open as well
        showSubagent(id, e.id, activity.agents.find(x => x.toolUseId === e.id) || {}, inProject);
      } }, 'View run') : null;
      const d = h('details', { class: 'tool' + (isAgent ? ' agent' : '') }, h('summary', {}, h('span', { class: 'tsum' }, h('b', {}, isAgent ? `🤖 ${e.name}` : e.name), ' ', inProject(e.summary || '')), open),
        h('div', { class: 'label' }, 'input'), h('pre', { text: e.input }));
      tools.set(e.id, d);
      return d;
    }
    if (e.kind === 'tool_result') {
      const q = questions.get(e.toolUseId);
      if (q) { answerQuestionCard(q, e.text); return null; } // the question was answered
      if (quiet.has(e.toolUseId)) return null;
      const plan = plans.get(e.toolUseId);
      if (plan) { plan.settle(!e.isError && /approved/i.test(e.text), e.text); return null; }
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
    if (!atTop && events.some(e => e.kind === 'tool_use' || e.kind === 'tool_result' || e.kind === 'plan')) activitySoon();
    for (const e of events) {
      const k = keyOf(e);
      if (k) { if (seen.has(k)) continue; seen.add(k); }
      const n = render(e);
      if (n) nodes.push(n);
    }
    if (!nodes.length) return;
    if (atTop) msgs.prepend(...nodes); else { msgs.append(...nodes); for (const p of pending) msgs.append(p.el); }
    if (stick && !chat.hidden) scrollTo(0, document.body.scrollHeight);
    else if (!atTop && !chat.hidden) { jump.textContent = '↓ New messages'; jump.hidden = false; }
  };
  // reading further up: a button back to the newest message (it says so when new ones came in)
  const jump = h('button', { class: 'btn sm jump', hidden: true, onclick: () => scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }) }, '↓ Latest');
  const onScroll = () => {
    if (chat.hidden) return;
    if (nearBottom()) { jump.hidden = true; jump.textContent = '↓ Latest'; }
    else if (innerHeight + scrollY < document.body.scrollHeight - innerHeight * 1.5) jump.hidden = false;
  };
  addEventListener('scroll', onScroll, { passive: true });
  state.cleanup.push(() => removeEventListener('scroll', onScroll));

  const photos = photoPicker();
  const doSend = async () => {
    const text = ta.value.trim();
    if (!text && !photos.count()) return;
    send.disabled = true;
    // show it right away; replaced by the real entry when the session records it
    const images = photos.take(), kept = photos.snapshot();
    const el = h('div', { class: 'msg user pending' }, text, images.length ? h('div', { class: 'thumbs' }, ...photos.previews().map(src => h('img', { src, alt: 'Photo' }))) : null, h('div', { class: 'via' }, 'sending…'));
    const p = { text, el, photos: images.length > 0 };
    pending.push(p); msgs.append(el); scrollTo(0, document.body.scrollHeight);
    ta.value = ''; ta.style.height = ''; photos.clear(); updateQuick();
    try {
      const body = { text, images, fork: forkBox.checked, ...(isLive() ? {} : picks.values()) };
      const r = await api('POST', `/api/sessions/${id}/message`, body);
      el.lastChild.textContent = r.delivered === 'live' ? 'delivered to your laptop' : 'sent';
      if (r.sessionId && r.sessionId !== id) { toast('Forked into a new session'); location.hash = `#/s/${r.sessionId}`; return; }
      refreshInfo();
    } catch (x) {
      el.classList.add('failed'); el.lastChild.textContent = 'not sent: ' + x.message;
      pending.splice(pending.indexOf(p), 1);
      ta.value = text; photos.restore(kept);
    }
    send.disabled = false;
  };
  send.addEventListener('click', doSend);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); } });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.4) + 'px'; });
  const quick = h('div', { class: 'quick', role: 'toolbar', 'aria-label': 'Quick replies' });
  const renderQuick = () => quick.replaceChildren(...store.get('quickReplies', QUICK_DEFAULT).map(q =>
    h('button', { class: 'chip-btn', type: 'button', onclick: () => { if (send.disabled) return; ta.value = q; doSend(); } }, q)),
    h('button', { class: 'chip-btn edit', type: 'button', title: 'Edit quick replies', 'aria-label': 'Edit quick replies', onclick: () => editQuickReplies(renderQuick) }, '✎'));
  // only while Claude is waiting for you and the box is empty: never mid-run, never over your own text
  let idleNow = true;
  const updateQuick = () => { quick.hidden = !idleNow || !!ta.value.trim() || !!info.question; };
  renderQuick();
  ta.addEventListener('input', updateQuick);
  // Chained prompts: "Then" queues what's typed; each step is sent when Claude has finished the one
  // before, even with this page closed
  const queueBox = h('div', { class: 'queue', hidden: true });
  const renderQueue = v => {
    queueBox.hidden = !v.steps.length;
    if (!v.steps.length) return queueBox.replaceChildren();
    const act = (method, url, body) => api(method, `/api/sessions/${id}/queue${url}`, body).then(renderQueue, x => toast(x.message));
    queueBox.replaceChildren(
      h('div', { class: 'row' }, h('b', { class: 'small' }, `Then, in order (${v.steps.length})`), h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: () => act('POST', '/pause', { paused: !v.paused }) }, v.paused ? '▶ Go on' : '⏸ Pause'),
        h('button', { class: 'btn sm danger', onclick: () => act('DELETE', '') }, 'Clear')),
      v.note || v.paused ? h('div', { class: 'small queue-note' }, v.note || 'Paused: no step is sent until you go on.') : null,
      h('ol', { class: 'queue-list' }, ...v.steps.map((s, i) => h('li', {},
        h('span', { class: 'queue-text', title: s.text }, s.text),
        i ? h('button', { class: 'icon sm', title: 'Move up', 'aria-label': 'Move up', onclick: () => act('POST', `/${s.id}/move`, { by: -1 }) }, '↑') : null,
        h('button', { class: 'icon sm', title: 'Remove this step', 'aria-label': 'Remove this step', onclick: () => act('DELETE', `/${s.id}`) }, '✕')))));
  };
  const onQueue = e => { if (e.detail.sessionId === id) renderQueue(e.detail); };
  window.addEventListener('handoff-queue', onQueue);
  state.cleanup.push(() => window.removeEventListener('handoff-queue', onQueue));
  api('GET', `/api/sessions/${id}/queue`).then(renderQueue).catch(() => {});
  const thenBtn = h('button', { class: 'btn sm', type: 'button', title: 'Send this after Claude finishes what it is doing (and after any steps already waiting)', onclick: async () => {
    const text = ta.value.trim();
    if (!text) { toast('Type the next step first, then tap Then.'); ta.focus(); return; }
    try {
      renderQueue(await api('POST', `/api/sessions/${id}/queue`, { text, ...picks.values() }));
      ta.value = ''; ta.style.height = ''; updateQuick();
    } catch (x) { toast(x.message); }
  } }, '⏭ Then');
  const composer = h('div', { class: 'composer' }, queueBox, notice, quick, photos.strip, photos.input,
    h('div', { class: 'input-row' }, photos.button, ta, send),
    h('div', { class: 'opts' }, ...picks.els, thenBtn, forkLabel));
  const chat = h('div', { class: 'chat' }, findPanel, older, msgs, working, jump, composer);

  // Chat / Files / Changes tabs; Files and Changes only when the server has the file browser turned on
  const files = state.me.files ? filesPanel(id) : null;
  const changes = state.me.files ? changesPanel(id) : null;
  const chatTab = h('button', { class: 'tab', role: 'tab', onclick: () => { location.hash = `#/s/${id}`; } }, 'Chat');
  const filesTab = h('button', { class: 'tab', role: 'tab', onclick: () => { location.hash = `#/s/${id}?dir=${encodeURIComponent(files.lastDir())}`; } }, 'Files');
  const changesTab = h('button', { class: 'tab', role: 'tab', onclick: () => { location.hash = `#/s/${id}?changes=`; } }, 'Changes');
  const overview = overviewPanel(id, { getActivity: () => activity, inProject });
  const overviewTab = h('button', { class: 'tab', role: 'tab', onclick: () => { location.hash = `#/s/${id}?overview=`; } }, 'Overview');
  const onActivity = () => { if (!overview.el.hidden) overview.render(); };
  window.addEventListener('handoff-activity', onActivity);
  state.cleanup.push(() => window.removeEventListener('handoff-activity', onActivity));
  const nav = p => {
    const tab = p.has('overview') ? 'overview' : files && (p.has('dir') || p.has('file')) ? 'files' : changes && (p.has('changes') || p.has('diff')) ? 'changes' : 'chat';
    chat.hidden = tab !== 'chat';
    if (chat.hidden) jump.hidden = true;
    overview.el.hidden = tab !== 'overview';
    todoBox.classList.toggle('away', tab === 'overview'); // the overview lists the to-dos itself
    if (files) { files.el.hidden = tab !== 'files'; changes.el.hidden = tab !== 'changes'; }
    for (const [name, b] of [['chat', chatTab], ['overview', overviewTab], ['files', filesTab], ['changes', changesTab]]) { b.classList.toggle('on', tab === name); b.setAttribute('aria-selected', String(tab === name)); }
    if (tab === 'overview') { overview.render(); loadActivity(); scrollTo(0, 0); }
    else if (tab === 'files') { files.show(p); scrollTo(0, 0); }
    else if (tab === 'changes') { changes.show(p); scrollTo(0, 0); }
    else if (p.has('find') && state.me.search) { openFind(p.get('find')); scrollTo(0, 0); }
    else scrollTo(0, document.body.scrollHeight);
  };

  head.append(h('div', { class: 'tabs', role: 'tablist' }, chatTab, overviewTab, ...(files ? [filesTab, changesTab] : [])));
  view.replaceChildren(head, overview.el, ...(files ? [files.el, changes.el] : []), chat);
  updateNotice();
  // moving between Chat, folders and files only changes the query part of the address: the router hands
  // those changes to nav() instead of rebuilding the page (the chat keeps its stream and scroll)
  state.sessionNav = { id, nav };
  state.cleanup.push(() => { state.sessionNav = null; });
  nav(params);

  const setStatus = () => {
    const r = state.runs.get(id);
    if (r) info.run = r;
    const live = info.live;
    const st = r ? r.status : live ? live.status : 'history';
    status.textContent = r ? `remote · ${st}` : live ? `${live.entrypoint === 'claude-desktop' ? 'desktop' : 'cli'} · ${st}` : 'history';
    status.className = `chip ${st}`;
    stopBtn.hidden = !r; intBtn.hidden = !r || r.status === 'idle';
    working.hidden = !['running', 'busy', 'waiting', 'starting'].includes(st);
    idleNow = working.hidden; updateQuick();
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
  const [t] = await Promise.all([api('GET', `/api/sessions/${id}/transcript`), loadActivity()]);
  if (stale()) return;
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
  if (!chat.hidden) scrollTo(0, document.body.scrollHeight);

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

// ---------- folder picker (New session) ----------
// The laptop's drives and folders (or only HANDOFF_ALLOWED_ROOTS), git projects marked with 🌿, and a new
// folder (optionally a new git repository) for a new project.
function pickFolder(start, onPick) {
  const list = h('div', { class: 'flist folder-list' });
  const where = h('div', { class: 'grow mono small folder-where' });
  const err = h('div', { class: 'err' });
  const use = h('button', { class: 'btn primary' }, 'Use this folder');
  const up = h('button', { class: 'btn sm', 'aria-label': 'Up one folder' }, '↑ Up');
  const newBtn = h('button', { class: 'btn' }, '＋ New folder');
  const name = h('input', { type: 'text', placeholder: 'Name of the new folder', 'aria-label': 'Name of the new folder', autocapitalize: 'off' });
  const gitBox = h('input', { type: 'checkbox' });
  gitBox.checked = true;
  const create = h('button', { class: 'btn primary sm' }, 'Create');
  const form = h('div', { class: 'list new-folder' }, name, h('div', { class: 'row' }, h('label', { class: 'row small grow' }, gitBox, 'Start a git repository in it'), create));
  form.hidden = true;
  let cur = null, seq = 0;
  const row = (icon, label, meta, onclick) => h('button', { class: 'frow', onclick },
    h('span', { class: 'ficon' }, icon), h('span', { class: 'fname' }, label), meta ? h('span', { class: meta === 'git' ? 'fmeta keep' : 'fmeta' }, meta) : null);
  const open = async p => {
    const my = ++seq;
    err.textContent = '';
    try {
      const d = await api('GET', '/api/folders' + (p ? `?path=${encodeURIComponent(p)}` : ''));
      if (my !== seq) return;
      cur = d;
      if (!d.path) {
        where.textContent = 'This computer';
        list.replaceChildren(...d.roots.map(r => row(r.kind === 'home' ? '🏠' : r.kind === 'drive' ? '💽' : r.git ? '🌿' : '📁', r.name,
          r.kind === 'home' ? r.path : r.git ? 'git' : '', () => open(r.path))));
      } else {
        where.textContent = d.path;
        list.replaceChildren(...(d.folders.length ? d.folders.map(x => row(x.git ? '🌿' : '📁', x.name, x.git ? 'git' : '', () => open(x.path)))
          : [h('div', { class: 'empty' }, 'No folders in here. Use this one, or make a new folder.')]),
          ...(d.truncated ? [h('div', { class: 'small muted folder-more' }, 'Only the first 1000 folders are shown.')] : []));
      }
      up.disabled = use.disabled = newBtn.disabled = !d.path;
      if (!d.path) form.hidden = true;
      use.textContent = d.path ? `Use ${d.name}` : 'Use this folder';
      list.scrollTop = 0;
    } catch (x) {
      if (my !== seq || x.message === 'unauthorized') return;
      if (!cur) return open(null); // a typed folder that doesn't exist: start from the drives
      err.textContent = x.message;
    }
  };
  up.addEventListener('click', () => open(cur?.parent ?? null));
  use.addEventListener('click', () => { if (cur?.path) { close(); onPick(cur); } });
  newBtn.addEventListener('click', () => { form.hidden = !form.hidden; if (!form.hidden) name.focus(); });
  create.addEventListener('click', async () => {
    if (!name.value.trim()) return name.focus();
    create.disabled = true; err.textContent = '';
    try {
      const r = await api('POST', '/api/folders', { parent: cur.path, name: name.value, git: gitBox.checked });
      name.value = ''; form.hidden = true;
      toast(`Made the folder ${r.name}${r.git ? ' (a new git repository)' : ''}`);
      await open(r.path);
    } catch (x) { if (x.message !== 'unauthorized') err.textContent = x.message; }
    create.disabled = false;
  });
  name.addEventListener('keydown', e => { if (e.key === 'Enter') create.click(); });
  const close = openSheet('Choose a folder', h('div', { class: 'row folder-bar' }, up, where), list, form, err,
    h('div', { class: 'row' }, newBtn, h('span', { class: 'grow' }), use));
  open(start || null);
}

async function newView(params) {
  setTop('New session', '#/');
  if (!state.projects.length) state.projects = await api('GET', '/api/projects').catch(() => []);
  const projects = state.projects.filter(p => !p.scratch && !/[\\/]\.claude[\\/]worktrees[\\/]/.test(p.cwd));
  const dl = h('datalist', { id: 'cwds' }, projects.map(p => h('option', { value: p.cwd })));
  const cwd = h('input', { type: 'text', list: 'cwds', placeholder: 'Folder, e.g. D:\\projects\\my-app', value: params.get('cwd') || '', 'aria-label': 'Project folder' });
  const ta = h('textarea', { rows: '5', placeholder: 'What should Claude do?' });
  const picks = makePickers();
  const photos = photoPicker();
  const err = h('div', { class: 'err' });
  let known = null; // the folder picked in the browser: { path, git }

  // its own worktree: a separate folder and branch made from the last commit (HANDOFF_GIT_ACTIONS)
  const wtBox = h('input', { type: 'checkbox' });
  const wtName = h('input', { type: 'text', placeholder: 'Name for it (optional; taken from the prompt)', 'aria-label': 'Worktree name', autocapitalize: 'off' });
  const wtNote = h('div', { class: 'small muted' });
  const syncWt = () => {
    const notGit = known && known.path === cwd.value.trim() && !known.git;
    wtBox.disabled = !!notGit;
    if (notGit) wtBox.checked = false;
    wtName.hidden = !wtBox.checked;
    wtNote.textContent = notGit ? "This folder isn't a git repository, so it can't have a worktree."
      : wtBox.checked ? 'Claude works in its own copy of the project, on a new branch (handoff/<name>) made from the last commit, so other sessions in this folder are not disturbed. Uncommitted changes are not copied.'
      : 'Its own copy of the project on a new branch, for running sessions side by side.';
  };
  wtBox.addEventListener('change', syncWt);
  cwd.addEventListener('input', () => { known = null; syncWt(); });
  syncWt();

  const browse = h('button', { class: 'btn', onclick: () => pickFolder(cwd.value.trim(), d => { cwd.value = d.path; known = d; syncWt(); ta.focus(); }) }, '📁 Browse');
  const recent = projects.slice(0, 8).map(p => h('button', { class: 'chip-btn', title: p.cwd, onclick: () => { cwd.value = p.cwd; known = null; syncWt(); ta.focus(); } }, p.name));

  const go = h('button', { class: 'btn primary', onclick: async () => {
    go.disabled = true; err.textContent = wtBox.checked ? 'Making the worktree and starting Claude…' : 'Starting Claude…';
    try {
      const r = await api('POST', '/api/sessions/new', { cwd: cwd.value.trim(), text: ta.value, images: photos.take(), ...picks.values(),
        worktree: wtBox.checked ? (wtName.value.trim() || true) : undefined });
      if (r.worktree) toast(`Claude is working in a new worktree, on ${r.worktree.branch}`, 5000);
      location.hash = `#/s/${r.sessionId}`;
    } catch (x) { err.textContent = x.message; go.disabled = false; }
  } }, 'Start session');
  view.replaceChildren(h('div', { class: 'list new-session' },
    h('div', { class: 'label' }, 'Project folder'), h('div', { class: 'row folder-row' }, cwd, browse), dl,
    recent.length ? h('div', { class: 'quick recent' }, ...recent) : null,
    ...(state.me.git ? [h('label', { class: 'row wt-toggle' }, wtBox, 'Work in a new worktree'), wtName, wtNote] : []),
    h('div', { class: 'label' }, 'Prompt'), ta, photos.strip, photos.input, h('div', { class: 'row' }, photos.button, h('span', { class: 'small muted' }, 'Attach photos (optional)')),
    h('div', { class: 'label' }, 'Model · effort · mode'),
    h('div', { class: 'row opts' }, ...picks.els),
    h('div', { class: 'row' }, h('span', { class: 'grow' }), go), err));
  (cwd.value ? ta : cwd).focus();
  if (params.get('shared') === '0') toast('Open Handoff once from the Home Screen; after that, sharing to it works', 6000);
  else if (params.has('shared')) takeShared(ta, photos);
}

// What another app shared to Handoff (kept by the service worker): into the prompt and photos, once.
async function takeShared(ta, photos) {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('handoff-share');
    const text = await (await cache.match('/shared/text'))?.text();
    const files = [];
    for (let i = 0; i < 4; i++) { const r = await cache.match(`/shared/photo/${i}`); if (r) files.push(await r.blob()); }
    for (const key of await cache.keys()) await cache.delete(key);
    if (text) ta.value = ta.value ? `${ta.value}\n${text}` : text;
    if (files.length) await photos.add(files);
    if (text || files.length) toast('Shared into a new session: pick the project folder, then start');
  } catch { /* nothing kept */ }
  history.replaceState(null, '', '#/new'); // a reload doesn't take it again
}

// ---------- router ----------
async function route() {
  if (!state.me) return;
  const [path, query] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query || '');
  const parts = (path || '/').split('/').filter(Boolean);
  // same session, other tab/folder/file: let the open session page switch without reloading
  if (parts[0] === 's' && parts[1] && state.sessionNav?.id === parts[1]) return state.sessionNav.nav(params);
  for (const fn of state.cleanup.splice(0)) fn(); // close the previous page's streams/timers
  runListeners = [];
  state.gen = (state.gen || 0) + 1;
  try {
    if (parts[0] === 'p' && parts[1]) await projectView(decodeURIComponent(parts[1]));
    else if (parts[0] === 's' && parts[1]) await sessionView(parts[1], params);
    else if (parts[0] === 'new') await newView(params);
    else if (parts[0] === 'api') await tryItView();
    else if (parts[0] === 'usage') await usageView(params);
    else await homeView();
  } catch (x) {
    if (x.message !== 'unauthorized') view.replaceChildren(h('div', { class: 'empty' }, 'Error: ' + x.message));
  }
}
addEventListener('hashchange', route);

async function boot() {
  try { state.me = await api('GET', '/api/me'); }
  catch { return; }
  showWhatsApp(state.me.whatsapp);
  if ('serviceWorker' in navigator) pushRegistration().catch(() => {}); // notifications, and "Share → Handoff"
  optionsReady(); // start fetching the model list early
  connectEvents();
  renderSide();
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

// The server restarted with a new version of this page or of its settings (e.g. the Files tab turned
// on): reload to pick it up. Not while that would lose typed text or a message on its way; then
// try again every few seconds.
const unsent = () => state.writes > 0 || [...document.querySelectorAll('textarea, input[type=text], input[type=search]')].some(e => e.value.trim());
function checkVersion(v) {
  if (!v || !state.me?.version || v === state.me.version || state.newVersion) return;
  state.newVersion = v;
  const reload = () => { if (unsent()) return false; location.reload(); return true; };
  if (!reload()) { toast('This page was updated. It reloads once your text is sent or cleared.', 6000); setInterval(reload, 3000); }
}
