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
      state.me?.push ? h('button', { class: 'btn', onclick: () => { close(); showPushSettings(); } }, '🔔 Phone notifications…') : null,
      alertsOn() ? h('button', { class: 'btn', onclick: () => { close(); showAlertSettings(); } }, '🔕 Alert settings…') : null,
      state.me?.whatsapp?.enabled ? h('button', { class: 'btn', onclick: async () => {
        close();
        try { await api('POST', '/api/notify/test'); toast('Test WhatsApp message sent'); }
        catch (x) { toast('WhatsApp: ' + x.message, 6000); }
      } }, '💬 Send test WhatsApp') : null,
      h('button', { class: 'btn', onclick: async () => { await api('POST', '/api/logout'); location.reload(); } }, '↪ Sign out'),
      h('button', { class: 'btn danger', onclick: async () => { if (confirm('Sign out every device?')) { await api('POST', '/api/logout-all'); location.reload(); } } }, '⏻ Sign out all devices')));
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

// ---------- login ----------
function showLogin() {
  state.me = null;
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

function renderPerms() {
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

// ---------- search ----------
// Text with every search word highlighted (built as DOM nodes, never HTML).
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
  input.addEventListener('change', async () => {
    for (const f of [...input.files]) {
      if (photos.length >= 4) { toast('At most 4 photos per message'); break; }
      try { photos.push(await shrinkPhoto(f)); } catch { toast(`Couldn't read ${f.name} as a photo`); }
    }
    input.value = '';
    render();
  });
  return {
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
async function homeView() {
  setTop('Handoff');
  const live = h('div', { class: 'list' }, h('div', { class: 'muted small' }, 'Loading…'));
  const filter = h('input', { type: 'search', placeholder: 'Filter projects…' });
  const projList = h('div', { class: 'list' });
  // search across every chat; while it has text, its results take the place of the page
  const find = state.me.search ? h('input', { type: 'search', class: 'find', placeholder: 'Search all chats…', 'aria-label': 'Search all chats', value: state.homeFind || '' }) : null;
  const results = h('div', { class: 'list', hidden: true });
  const normal = h('div', {}, h('h2', {}, 'Live now'), live, h('h2', {}, 'Projects'), filter, projList);
  view.replaceChildren(
    h('div', { class: 'row' }, h('a', { href: '#/new', class: 'btn primary' }, '+ New session'), h('span', { class: 'grow' })),
    ...(find ? [find, results] : []), normal);
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
          h('div', { class: 't' }, ...marked(r.title, terms)),
          h('div', { class: 's' }, `${(r.cwd || r.projectKey).split(/[\\/]/).filter(Boolean).pop()} · ${ago(r.mtime)}${r.total ? ` · ${r.total} message${r.total === 1 ? '' : 's'}` : ''}`),
          ...r.hits.map(x => h('div', { class: 'hit' }, h('span', { class: 'who' }, x.kind === 'user' ? 'You' : 'Claude'), ' ', ...marked(x.snippet, terms)))));
        results.replaceChildren(...[indexingNote(d), ...(cards.length ? cards : [h('div', { class: 'empty' }, 'No chat contains all of those words.')])].filter(Boolean));
      } catch (x) { if (my === seq) results.replaceChildren(h('div', { class: 'empty' }, x.message)); }
    };
    find.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 350); });
    if (find.value) run();
  }

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

// ---------- changes (uncommitted git changes in the session's folder; read-only) ----------
// #/s/<id>?changes= lists the changed files, ?diff=<path> shows one file's diff.
function changesPanel(id) {
  const el = h('div', { class: 'files' });
  const link = (key, p) => `#/s/${id}?${key}=${encodeURIComponent(p)}`;
  const BADGE = { modified: ['M', 'Modified'], added: ['A', 'Added'], deleted: ['D', 'Deleted'], renamed: ['R', 'Renamed'], untracked: ['N', 'New, not in git yet'], conflict: ['!', 'Merge conflict'] };
  let seq = 0;

  const renderList = d => {
    if (!d.git) return el.replaceChildren(h('div', { class: 'empty' }, `Nothing to show: ${d.reason}.`));
    const rows = d.files.map(f => h('a', { class: 'frow', href: link('diff', f.path) },
      h('span', { class: `badge ${f.status}`, title: BADGE[f.status][1] }, BADGE[f.status][0]),
      h('span', { class: 'fname mono' }, f.path), f.from ? h('span', { class: 'fmeta' }, `was ${f.from}`) : null));
    el.replaceChildren(...[
      h('div', { class: 'row small muted' }, `${d.branch ? `On ${d.branch} · ` : ''}${d.files.length}${d.truncated ? '+' : ''} file${d.files.length === 1 ? '' : 's'} changed since the last commit`,
        h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => show(new URLSearchParams('changes=')) }, 'Refresh')),
      rows.length ? h('div', { class: 'flist' }, ...rows) : h('div', { class: 'empty' }, 'No uncommitted changes.'),
      d.truncated && h('div', { class: 'small muted' }, 'Only the first 500 files are shown.')].filter(Boolean));
  };

  const renderDiff = d => {
    const pre = h('pre', { class: 'diff' });
    for (const line of d.diff.split('\n')) {
      const cls = /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |Binary )/.test(line) ? 'd-meta'
        : line.startsWith('@@') ? 'd-hunk' : line.startsWith('+') ? 'd-add' : line.startsWith('-') ? 'd-del' : '';
      const s = document.createElement('span'); // one block per line, so added/removed colour spans the whole line
      s.className = cls || 'd-ctx'; s.textContent = line || ' '; pre.append(s);
    }
    el.replaceChildren(...[
      h('div', { class: 'row' }, h('a', { class: 'btn', href: link('changes', '') }, '← All changes'), h('span', { class: 'grow mono small' }, d.path),
        h('a', { class: 'btn', href: `#/s/${id}?file=${encodeURIComponent(d.path)}` }, 'Open file')),
      d.truncated && h('div', { class: 'notice' }, 'This diff is large: only the first 1 MB is shown.'),
      d.diff.trim() ? h('div', { class: 'fcode' }, pre) : h('div', { class: 'empty' }, 'No differences from the last commit.')].filter(Boolean));
  };

  const show = async params => {
    const my = ++seq;
    el.replaceChildren(h('div', { class: 'muted small' }, 'Loading…'));
    try {
      if (params.has('diff')) { const d = await api('GET', `/api/sessions/${id}/diff?path=${encodeURIComponent(params.get('diff'))}`); if (my === seq) renderDiff(d); }
      else { const d = await api('GET', `/api/sessions/${id}/changes`); if (my === seq) renderList(d); }
    } catch (x) {
      if (my === seq && x.message !== 'unauthorized') el.replaceChildren(h('div', { class: 'row' }, h('a', { class: 'btn', href: link('changes', '') }, '← All changes')), h('div', { class: 'empty' }, x.message));
    }
  };
  return { el, show };
}

async function sessionView(id, params = new URLSearchParams()) {
  setTop('Session', '#/');
  const gen = state.gen, stale = () => gen !== state.gen; // the user went elsewhere while this was loading
  let info = await api('GET', `/api/sessions/${id}`);
  if (stale()) return;
  setTop(info.title || 'Session', info.projectKey ? `#/p/${encodeURIComponent(info.projectKey)}` : '#/');

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
          h('span', { class: 'who' }, x.kind === 'user' ? 'You' : 'Claude'), x.ts ? h('span', { class: 'small muted' }, ' · ' + ago(Date.parse(x.ts))) : null, ' ', ...marked(x.snippet, terms)))
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
  // pinned under the top bar, so status, actions and tabs stay in reach however far the chat scrolls
  const head = h('div', { class: 'session-head' },
    h('div', { class: 'session-bar' }, status, h('div', { class: 'cwd mono', title: info.cwd || '' }, h('span', { dir: 'ltr' }, info.cwd || '')), findBtn, muteBtn, intBtn, stopBtn),
    settings);
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
  const tools = new Map(), questions = new Map(), seen = new Set(), pending = [];
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
    if (e.kind === 'question') {
      const card = questionCard(id, e, () => info.question = null);
      questions.set(e.id, card);
      return card;
    }
    if (e.kind === 'tool_use') {
      const d = h('details', { class: 'tool' }, h('summary', {}, h('b', {}, e.name), ' ', inProject(e.summary || '')), h('div', { class: 'label' }, 'input'), h('pre', { text: e.input }));
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
    ta.value = ''; ta.style.height = ''; photos.clear();
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
  const composer = h('div', { class: 'composer' }, notice, photos.strip, photos.input,
    h('div', { class: 'input-row' }, photos.button, ta, send),
    h('div', { class: 'opts' }, ...picks.els, forkLabel));
  const chat = h('div', { class: 'chat' }, findPanel, older, msgs, working, jump, composer);

  // Chat / Files / Changes tabs; Files and Changes only when the server has the file browser turned on
  const files = state.me.files ? filesPanel(id) : null;
  const changes = state.me.files ? changesPanel(id) : null;
  const chatTab = h('button', { class: 'tab', role: 'tab', onclick: () => { location.hash = `#/s/${id}`; } }, 'Chat');
  const filesTab = h('button', { class: 'tab', role: 'tab', onclick: () => { location.hash = `#/s/${id}?dir=${encodeURIComponent(files.lastDir())}`; } }, 'Files');
  const changesTab = h('button', { class: 'tab', role: 'tab', onclick: () => { location.hash = `#/s/${id}?changes=`; } }, 'Changes');
  const nav = p => {
    const tab = files && (p.has('dir') || p.has('file')) ? 'files' : changes && (p.has('changes') || p.has('diff')) ? 'changes' : 'chat';
    chat.hidden = tab !== 'chat';
    if (chat.hidden) jump.hidden = true;
    if (files) { files.el.hidden = tab !== 'files'; changes.el.hidden = tab !== 'changes'; }
    for (const [name, b] of [['chat', chatTab], ['files', filesTab], ['changes', changesTab]]) { b.classList.toggle('on', tab === name); b.setAttribute('aria-selected', String(tab === name)); }
    if (tab === 'files') { files.show(p); scrollTo(0, 0); }
    else if (tab === 'changes') { changes.show(p); scrollTo(0, 0); }
    else if (p.has('find') && state.me.search) { openFind(p.get('find')); scrollTo(0, 0); }
    else scrollTo(0, document.body.scrollHeight);
  };

  if (files) head.append(h('div', { class: 'tabs', role: 'tablist' }, chatTab, filesTab, changesTab));
  view.replaceChildren(head, ...(files ? [files.el, changes.el] : []), chat);
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

async function newView(params) {
  setTop('New session', '#/');
  if (!state.projects.length) state.projects = await api('GET', '/api/projects').catch(() => []);
  const dl = h('datalist', { id: 'cwds' }, state.projects.filter(p => !p.scratch).map(p => h('option', { value: p.cwd })));
  const cwd = h('input', { type: 'text', list: 'cwds', placeholder: 'Working directory, e.g. D:\\projects\\my-app', value: params.get('cwd') || '' });
  const ta = h('textarea', { rows: '5', placeholder: 'What should Claude do?' });
  const picks = makePickers();
  const photos = photoPicker();
  const err = h('div', { class: 'err' });
  const go = h('button', { class: 'btn primary', onclick: async () => {
    go.disabled = true; err.textContent = 'Starting Claude…';
    try {
      const r = await api('POST', '/api/sessions/new', { cwd: cwd.value.trim(), text: ta.value, images: photos.take(), ...picks.values() });
      location.hash = `#/s/${r.sessionId}`;
    } catch (x) { err.textContent = x.message; go.disabled = false; }
  } }, 'Start session');
  view.replaceChildren(h('div', { class: 'list' },
    h('div', { class: 'label' }, 'Project folder'), cwd, dl,
    h('div', { class: 'label' }, 'Prompt'), ta, photos.strip, photos.input, h('div', { class: 'row' }, photos.button, h('span', { class: 'small muted' }, 'Attach photos (optional)')),
    h('div', { class: 'label' }, 'Model · effort · mode'),
    h('div', { class: 'row opts' }, ...picks.els),
    h('div', { class: 'row' }, h('span', { class: 'grow' }), go), err));
  (cwd.value ? ta : cwd).focus();
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
  if (state.me.push && pushSupported()) pushRegistration().catch(() => {});
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
