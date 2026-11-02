// End-to-end test: real HTTP server + fake claude CLI, against a throwaway ~/.claude in a temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
const home = path.join(tmp, 'claude-home');
const work = path.join(tmp, 'work');
fs.mkdirSync(work, { recursive: true });
process.env.HANDOFF_DATA_DIR = path.join(tmp, 'data');
process.env.HANDOFF_ENV_FILE = path.join(tmp, 'no-such.env'); // never read a developer's real .env
process.env.FAKE_CLAUDE_HOME = home;

const { loadConfig } = await import('../src/config.js');
const { createServer } = await import('../src/server.js');
const { hashPassword, base32Encode, totpAt, _resetTotpReplay } = await import('../src/auth.js');

// a pre-existing "desktop" session that is currently live
const desktopId = crypto.randomUUID();
const projKey = work.replace(/[^A-Za-z0-9]/g, '-');
fs.mkdirSync(path.join(home, 'projects', projKey, desktopId), { recursive: true });
const desktopFile = path.join(home, 'projects', projKey, desktopId + '.jsonl');
fs.writeFileSync(desktopFile, [
  { type: 'user', uuid: 'u1', cwd: work, sessionId: desktopId, message: { role: 'user', content: 'hello from desktop <system-reminder>hidden</system-reminder>' } },
  { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }] } },
  { type: 'assistant', uuid: 'a2', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent noise' }] } }
].map(o => JSON.stringify(o)).join('\n') + '\n');
fs.writeFileSync(path.join(home, 'projects', projKey, desktopId, 'custom-title.json'), JSON.stringify({ customTitle: 'Desktop task' }));
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
// fake messaging inbox of the "desktop" process (same protocol as Claude Code's)
const peerToken = crypto.randomBytes(16).toString('hex');
const inboxPath = process.platform === 'win32' ? String.raw`\\.\pipe\handoff-test-` + crypto.randomUUID() : path.join(tmp, 'inbox.sock');
const inboxLines = [];
const inbox = net.createServer(c => {
  let buf = '';
  c.on('data', d => { buf += d; });
  c.on('end', () => inboxLines.push(...buf.split('\n').filter(Boolean).map(l => JSON.parse(l))));
});
await new Promise(r => inbox.listen(inboxPath, r));
fs.writeFileSync(path.join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: desktopId, cwd: work, status: 'idle', entrypoint: 'claude-desktop', name: 'Desktop task', messagingSocketPath: inboxPath }));
fs.writeFileSync(path.join(home, 'sessions', `${process.pid}.${'ab'.repeat(32)}.key`), JSON.stringify({ peerToken }));
const desktopHash = () => crypto.createHash('sha256').update(fs.readFileSync(desktopFile)).digest('hex');
const originalHash = desktopHash();

const cfg = loadConfig();
cfg.claudeHome = home;
cfg.passwordHash = hashPassword('test-password-123');
const secret = base32Encode(crypto.randomBytes(20));
cfg.totpSecret = secret; cfg.totpEnabled = true;
const stub = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.js');
const { server, runner } = createServer(cfg, { claudePath: stub, log: () => {} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = '';

async function req(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Handoff': '1', Cookie: cookie, ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

// Minimal SSE reader collecting events until predicate matches.
function sseWait(url, pred, timeout = 10000) {
  const ac = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ac.abort(); reject(new Error('sse timeout ' + url)); }, timeout);
    fetch(base + url, { headers: { Cookie: cookie }, signal: ac.signal }).then(async res => {
      const dec = new TextDecoder(); let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /event: (.*)/.exec(block)?.[1]; const data = /data: (.*)/.exec(block)?.[1];
          if (ev && data && pred(ev, JSON.parse(data))) { clearTimeout(timer); ac.abort(); resolve(JSON.parse(data)); return; }
        }
      }
    }).catch(e => { if (e.name !== 'AbortError') reject(e); });
  });
}

test.after(() => { inbox.close(); runner.shutdown(); server.close(); server.closeAllConnections?.(); });

test('static page has strict security headers; API requires auth', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal((await req('GET', '/api/projects')).status, 401);
  assert.equal((await fetch(base + '/..%2f..%2fpackage.json')).status !== 200, true);
});

test('login: wrong password/2FA rejected, CSRF guarded, correct login sets cookie', async () => {
  assert.equal((await req('POST', '/api/login', { password: 'nope', code: '000000' })).status, 401);
  assert.equal((await req('POST', '/api/login', { password: 'test-password-123', code: '000000' })).status, 401);
  assert.equal((await req('POST', '/api/login', { password: 'x' }, { 'X-Handoff': '' })).status, 403);
  assert.equal((await req('POST', '/api/login', { password: 'x' }, { Origin: 'https://evil.example' })).status, 403);
  _resetTotpReplay();
  const r = await req('POST', '/api/login', { password: 'test-password-123', code: totpAt(secret, Math.floor(Date.now() / 30000)) });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Strict/);
  cookie = sc.split(';')[0];
  assert.equal((await req('GET', '/api/me')).status, 200);
});

test('browse projects, sessions, transcript, live sessions (no secrets leaked)', async () => {
  const p = await req('GET', '/api/projects');
  assert.equal(p.json.length, 1);
  assert.equal(p.json[0].cwd, work);
  assert.equal(p.json[0].live, 1);
  const s = await req('GET', `/api/projects/${encodeURIComponent(projKey)}/sessions`);
  assert.equal(s.json[0].title, 'Desktop task');
  assert.equal((await req('GET', '/api/projects/..%2F..%2Fetc/sessions')).status, 404);
  const t = await req('GET', `/api/sessions/${desktopId}/transcript`);
  const kinds = t.json.events.map(e => e.kind);
  assert.deepEqual(kinds, ['user', 'assistant', 'tool_use', 'tool_result']);
  assert.equal(t.json.events[0].text, 'hello from desktop');
  const live = await req('GET', '/api/live');
  assert.equal(live.json.live[0].sessionId, desktopId);
  assert.ok(!JSON.stringify(live.json).includes(peerToken));
  assert.ok(!JSON.stringify(live.json).includes('pipe'));
});

let forkId;
test('a session open on the laptop gets the message live via its inbox; fork leaves the original untouched', async () => {
  const r0 = await req('POST', `/api/sessions/${desktopId}/message`, { text: 'live from phone' });
  assert.equal(r0.status, 200, JSON.stringify(r0.json));
  assert.equal(r0.json.delivered, 'live');
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(inboxLines, [{ type: 'auth', token: peerToken }, { type: 'user', message: { role: 'user', content: 'live from phone' } }]);
  const perm = sseWait('/api/events', ev => ev === 'permission');
  const r = await req('POST', `/api/sessions/${desktopId}/message`, { text: 'from phone', mode: 'default', fork: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  forkId = r.json.sessionId;
  assert.notEqual(forkId, desktopId, 'must fork, not resume in place');
  const p = await perm;
  assert.equal(p.tool, 'Write');
  const tail = sseWait(`/api/sessions/${forkId}/stream?from=0`, (ev, d) => ev === 'msg' && d.kind === 'assistant' && d.text.includes('allowed'));
  assert.equal((await req('POST', `/api/permissions/${p.id}`, { allow: true })).status, 200);
  const msg = await tail;
  assert.match(msg.text, /echo: \*\*from phone\*\* \(allowed\)/);
  assert.equal(desktopHash(), originalHash, 'desktop transcript must be untouched');
});

test('a session not running anywhere is resumed in place (same id)', async () => {
  fs.rmSync(path.join(home, 'sessions', `${process.pid}.json`)); // desktop closed it
  await req('POST', `/api/sessions/${forkId}/stop`);
  await new Promise(r => setTimeout(r, 300));
  const perm = sseWait('/api/events', ev => ev === 'permission');
  const r = await req('POST', `/api/sessions/${desktopId}/message`, { text: 'resume me' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.sessionId, desktopId);
  const p = await perm;
  await req('POST', `/api/permissions/${p.id}`, { allow: true });
  await new Promise(r => setTimeout(r, 300));
  assert.match(fs.readFileSync(desktopFile, 'utf8'), /resume me/);
  forkId = desktopId;
});

test('follow-up reuses the running process; deny is relayed', async () => {
  const perm = sseWait('/api/events', ev => ev === 'permission');
  const r = await req('POST', `/api/sessions/${forkId}/message`, { text: 'second', mode: 'default' });
  assert.equal(r.json.sessionId, forkId);
  const p = await perm;
  const tail = sseWait(`/api/sessions/${forkId}/stream?from=0`, (ev, d) => ev === 'msg' && d.kind === 'assistant' && d.text.includes('denied'));
  await req('POST', `/api/permissions/${p.id}`, { allow: false, message: 'no' });
  await tail;
});

test('new session in a folder; validation of inputs', async () => {
  assert.equal((await req('POST', '/api/sessions/new', { cwd: path.join(tmp, 'nope'), text: 'x' })).status, 400);
  assert.equal((await req('POST', '/api/sessions/new', { cwd: work, text: 'x', mode: 'bypassPermissions' })).status, 403);
  assert.equal((await req('POST', '/api/sessions/new', { cwd: work, text: 'x', model: 'a b; rm' })).status, 400);
  const perm = sseWait('/api/events', ev => ev === 'permission');
  const r = await req('POST', '/api/sessions/new', { cwd: work, text: 'brand new' });
  assert.equal(r.status, 200);
  const p = await perm;
  await req('POST', `/api/permissions/${p.id}`, { allow: true });
  assert.ok(fs.existsSync(path.join(home, 'projects', projKey, r.json.sessionId + '.jsonl')));
  assert.equal((await req('POST', `/api/sessions/${r.json.sessionId}/stop`)).json.ok, true);
});

test('options list models/efforts/modes; effort and mode are validated', async () => {
  const o = await req('GET', '/api/options');
  assert.equal(o.status, 200);
  assert.ok(o.json.models.length > 0);
  assert.deepEqual(o.json.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(o.json.modes.includes('auto') && o.json.modes.includes('manual'));
  assert.equal(o.json.defaultMode, 'manual');
  assert.equal((await req('POST', '/api/sessions/new', { cwd: work, text: 'x', effort: 'turbo' })).status, 400);
  assert.equal((await req('POST', '/api/sessions/new', { cwd: work, text: 'x', mode: 'yolo' })).status, 400);
  const since = await req('GET', `/api/sessions/${desktopId}/since?from=0`);
  assert.ok(since.json.events.length > 0 && since.json.end > 0);
});

test('logout invalidates the cookie', async () => {
  await req('POST', '/api/logout');
  assert.equal((await req('GET', '/api/me')).status, 401);
});

// ---- AskUserQuestion: visible in the UI data, answerable from the phone ----
const askId = crypto.randomUUID();                       // its own session, independent of the tests above
const askFile = path.join(home, 'projects', projKey, askId + '.jsonl');
const askPid = process.pid;

test('sign in again (the logout test above cleared the cookie)', async () => {
  _resetTotpReplay();
  const r = await req('POST', '/api/login', { password: 'test-password-123', code: totpAt(secret, Math.floor(Date.now() / 30000)) });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
});

test('a pending question is reported, rendered and answerable; answering it is queued to the laptop', async () => {
  fs.writeFileSync(askFile, [
    { type: 'user', uuid: 'au', timestamp: new Date().toISOString(), cwd: work, message: { role: 'user', content: 'plan the phone setup' } },
    { type: 'assistant', uuid: 'aq', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions: [
      { header: 'Call voice', question: 'Which do you allow?', multiSelect: false, options: [
        { label: 'Root the gateway', description: 'root phone A' }, { label: 'Helper device', description: 'raspberry pi' }] },
      { header: 'OTP apps', question: 'How to handle them?', options: [
        { label: 'Keep on gateway', description: 'stay on A' }, { label: 'Classify first', description: 'probe them' }] }
    ] } }] } }
  ].map(o => JSON.stringify(o) + '\n').join(''));
  fs.writeFileSync(path.join(home, 'sessions', `${askPid}.json`), JSON.stringify({
    pid: askPid, sessionId: askId, cwd: work, status: 'waiting', entrypoint: 'claude-desktop',
    name: 'Phone setup', messagingSocketPath: inboxPath }));

  // the session page and the live list both surface it, with options numbered 1..4
  const info = await req('GET', `/api/sessions/${askId}`);
  assert.equal(info.json.question.toolUseId, 'toolu_q');
  assert.deepEqual(info.json.question.questions.flatMap(q => q.options.map(o => o.n)), [1, 2, 3, 4]);
  assert.equal(info.json.question.questions[1].options[1].label, 'Classify first');
  const live = await req('GET', '/api/live');
  assert.equal(live.json.live.find(l => l.sessionId === askId).question.toolUseId, 'toolu_q');

  // the transcript renders it as a question card rather than a raw tool call
  const t = await req('GET', `/api/sessions/${askId}/transcript`);
  const card = t.json.events.filter(e => e.kind === 'question').pop();
  assert.equal(card.id, 'toolu_q');
  assert.equal(card.questions[0].options[0].label, 'Root the gateway');

  // answering picks one option per question and delivers it into the live session
  inboxLines.length = 0;
  const a = await req('POST', `/api/sessions/${askId}/answer`, { picks: [1, 4] });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.deepEqual(a.json.answered, ['Call voice: Root the gateway', 'OTP apps: Classify first']);
  assert.equal(a.json.queuedBehindPicker, true);
  await new Promise(r => setTimeout(r, 300));
  const sent = inboxLines.find(l => l.type === 'user')?.message.content;
  assert.match(sent, /Root the gateway/);
  assert.match(sent, /Classify first/);

  assert.equal((await req('POST', `/api/sessions/${askId}/answer`, { picks: [] })).status, 400);
});

test('answering a question that is already answered is rejected', async () => {
  fs.appendFileSync(askFile, JSON.stringify({ type: 'user', uuid: 'qr1', timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_q', content: 'Your questions have been answered.' }] } }) + '\n');
  const info = await req('GET', `/api/sessions/${askId}`);
  assert.equal(info.json.question, null);
  const a = await req('POST', `/api/sessions/${askId}/answer`, { picks: [1] });
  assert.equal(a.status, 409);
});
