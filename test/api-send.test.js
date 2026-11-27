// The API's sending side: prompts in, answers out, with the fake claude CLI and a fake session "open
// on the laptop" (its inbox writes the reply into the transcript and flips its registry status).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-send-')));
const home = path.join(tmp, 'claude');
process.env.HANDOFF_DATA_DIR = path.join(tmp, 'data');
process.env.HANDOFF_ENV_FILE = path.join(tmp, 'none.env');
process.env.FAKE_CLAUDE_HOME = home;

const { loadConfig } = await import('../src/config.js');
const { createServer } = await import('../src/server.js');
const { stripMarkdown, classifyError } = await import('../src/turns.js');

const work = path.join(tmp, 'work', 'shop');
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
const projDir = path.join(home, 'projects', work.replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(projDir, { recursive: true });

const cfg = loadConfig();
Object.assign(cfg, { claudeHome: home, api: true, web: true, passwordHash: 'x', publicHostname: 'claude.example.com', search: false, maxConcurrentRuns: 3, apiDir: path.join(tmp, 'api-chats') });
const { server, core, api } = createServer(cfg, { claudePath: path.join(ROOT, 'test', 'fake-claude.js'), log: () => {} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
test.after(async () => {
  server.close();
  await new Promise(r => setTimeout(r, 1500)); // the fake claude processes end
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may still hold a file: the OS cleans temp */ }
});

const full = core.keys.create({ name: 'Full', scopes: ['read', 'chat', 'approve', 'files', 'git'], modes: ['manual', 'plan', 'acceptEdits', 'auto', 'dontAsk'], rateLimit: 600, maxTurns: 10 });
const phone = core.keys.create({ name: 'Phone', preset: 'phone', rateLimit: 600 });
async function call(key, method, p, body, headers = {}) {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${key}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: json, text, headers: r.headers };
}
const transcriptOf = id => { for (const d of fs.readdirSync(path.join(home, 'projects'))) { const f = path.join(home, 'projects', d, id + '.jsonl'); if (fs.existsSync(f)) return f; } return null; };
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

let first;
test('/chat: a new session answers, becomes the selected one, and the next /chat continues it', async () => {
  const r = await call(full.key, 'POST', '/chat', { prompt: 'plain: hello' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.status, 'done');
  assert.equal(r.body.text, 'echo: plain: hello');
  assert.equal(r.body.delivered, 'new');
  assert.ok(r.body.sessionId);
  assert.equal(r.body.usage.costUsd, 0.01);
  assert.equal(r.body.webUrl, `https://claude.example.com/#/s/${r.body.sessionId}`);
  first = r.body.sessionId;
  assert.equal(core.keys.get(full.record.id).selection, first);
  const again = await call(full.key, 'POST', '/chat', { prompt: 'plain: again' });
  assert.equal(again.body.sessionId, first, 'the selected session continues');
  assert.equal(again.body.text, 'echo: plain: again');
  assert.equal(again.body.usage.costUsd, 0.01, 'each turn\'s own cost, not the process\'s running total');
  assert.ok(fs.readFileSync(transcriptOf(first), 'utf8').includes('plain: again'));
  const sessions = await call(full.key, 'GET', '/sessions?via=api');
  assert.ok(sessions.body.sessions.some(s => s.id === first && s.via?.key === 'Full'));
});

test('plain text answers, language and length notes, and plain: true', async () => {
  const r = await fetch(base + '/chat', { method: 'POST', headers: { Authorization: `Bearer ${full.key}`, Accept: 'text/plain' }, body: JSON.stringify({ prompt: 'plain: hi', language: 'Urdu', length: 'brief' }) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/plain/);
  assert.equal((await r.text()).trim(), 'echo: plain: hi\n\n(Answer in Urdu. Keep it brief.)');
  assert.equal(stripMarkdown('**bold** and `code` and [a link](https://x.y)\n# Title\n- item'), 'bold and code and a link (https://x.y)\nTitle\n- item');
});

let approvalTurn;
test('an approval: the turn waits, the key can see and allow it, and the answer arrives', async () => {
  const r = await call(full.key, 'POST', '/sessions', { prompt: 'write the file', project: work, wait: 2 });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.body.status, 'waiting_for_approval');
  assert.equal(r.body.pending.tool, 'Write');
  assert.equal(r.headers.get('location'), `/api/v1/turns/${r.body.id}`);
  approvalTurn = r.body.id;
  const list = await call(full.key, 'GET', '/approvals');
  const p = list.body.approvals.find(a => a.id === r.body.pending.id);
  assert.ok(p);
  assert.equal(p.turnId, r.body.id);
  assert.equal(p.via, 'Full');
  const tooMuch = await call(phone.key, 'POST', `/approvals/${p.id}`, { allow: true });
  assert.equal(tooMuch.status, 403, 'the phone key has no "approve" permission');
  const always = await call(full.key, 'POST', `/approvals/${p.id}`, { allow: true, alwaysMode: 'bypassPermissions' });
  assert.equal(always.status, 403);
  assert.equal((await call(full.key, 'POST', `/approvals/${p.id}`, { allow: true })).status, 200);
  const done = await call(full.key, 'GET', `/turns/${r.body.id}?wait=10`);
  assert.equal(done.body.status, 'done');
  assert.equal(done.body.text, 'echo: **write the file** (allowed)');
  assert.deepEqual(done.body.steps, [{ tool: 'Write', summary: 'out.txt' }]);
  assert.deepEqual(done.body.filesChanged, ['out.txt']);
});

test('plain: true takes the Markdown out of the answer', async () => {
  const r = await call(full.key, 'POST', '/sessions', { prompt: 'again', project: work, plain: true, wait: 2 });
  await call(full.key, 'POST', `/approvals/${r.body.pending.id}`, { allow: true });
  const done = await call(full.key, 'GET', `/turns/${r.body.id}?wait=10`);
  assert.equal(done.body.text, 'echo: again (allowed)');
});

test('stream: the answer in pieces, then the finished turn', async () => {
  const r = await fetch(base + '/chat', { method: 'POST', headers: { Authorization: `Bearer ${full.key}` }, body: JSON.stringify({ prompt: 'plain: streamed', session: 'new', stream: true }) });
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const body = await r.text();
  const pieces = [...body.matchAll(/event: text\ndata: (.*)\n/g)].map(m => JSON.parse(m[1]).text).join('');
  assert.equal(pieces, 'echo: plain: streamed');
  assert.match(body, /event: done\ndata: .*"status":"done"/);
});

test('two prompts sent at once to one session each get their own answer', async () => {
  const s = await call(full.key, 'POST', '/sessions', { prompt: 'plain: start', project: work });
  const id = s.body.sessionId;
  const [a, b] = await Promise.all([
    call(full.key, 'POST', `/sessions/${id}/messages`, { prompt: 'slow:300:plain: first' }),
    call(full.key, 'POST', `/sessions/${id}/messages`, { prompt: 'plain: second' })
  ]);
  assert.equal(a.body.text, 'echo: slow:300:plain: first');
  assert.equal(b.body.text, 'echo: plain: second');
  // a wide margin: the whole suite runs in parallel, and a busy machine is slow to start the turn
  const busy = call(full.key, 'POST', `/sessions/${id}/messages`, { prompt: 'slow:2000:plain: busy' });
  await new Promise(r => setTimeout(r, 400));
  const fail = await call(full.key, 'POST', `/sessions/${id}/messages`, { prompt: 'plain: now', ifBusy: 'fail' });
  assert.equal(fail.status, 409);
  assert.equal(fail.body.error.code, 'session_busy');
  await busy;
});

test('a one-off (save: false) and asking without a trace leave nothing behind', async () => {
  const selected = core.keys.get(full.record.id).selection;
  const before = fs.readdirSync(path.join(home, 'projects')).flatMap(d => fs.readdirSync(path.join(home, 'projects', d))).length;
  const r = await call(full.key, 'POST', '/chat', { prompt: 'plain: one-off', save: false });
  assert.equal(r.body.status, 'done');
  assert.equal(r.body.sessionId, null);
  assert.equal(r.body.webUrl, null);
  const after = fs.readdirSync(path.join(home, 'projects')).flatMap(d => fs.readdirSync(path.join(home, 'projects', d))).length;
  assert.equal(after, before, 'no transcript was saved');
  assert.equal(core.keys.get(full.record.id).selection, selected, 'and the selection is left alone');
  const hash = sha(transcriptOf(first));
  const ask = await call(full.key, 'POST', `/sessions/${first}/ask`, { prompt: 'what did I say?' });
  assert.equal(ask.body.status, 'done', ask.text);
  assert.equal(ask.body.sessionId, null);
  assert.equal(sha(transcriptOf(first)), hash, 'the session is unchanged');
  const wide = await call(full.key, 'POST', `/sessions/${first}/ask`, { prompt: 'x', tools: 'all' });
  assert.equal(wide.status, 400);
});

test('a limited key answers in its own copy of a session, and keeps using that copy', async () => {
  const hash = sha(transcriptOf(first));
  const a = await call(phone.key, 'POST', `/sessions/${first}/messages`, { prompt: 'plain: from my phone' });
  assert.equal(a.body.status, 'done', a.text);
  assert.equal(a.body.delivered, 'fork');
  assert.notEqual(a.body.sessionId, first);
  assert.match(a.body.warnings.join(' '), /own copy/);
  assert.equal(sha(transcriptOf(first)), hash, 'the original is left as it is');
  const b = await call(phone.key, 'POST', `/sessions/${first}/messages`, { prompt: 'plain: and again' });
  assert.equal(b.body.sessionId, a.body.sessionId, 'the same copy continues');
  assert.equal(b.body.delivered, 'handoff');
});

test('the web app takes a session back from a limited API process (restarted, never two at once)', async () => {
  const a = await call(phone.key, 'POST', '/chat', { prompt: 'plain: phone session', session: 'new', project: work });
  assert.equal(a.body.status, 'done', a.text);
  const before = core.runner.bySession(a.body.sessionId);
  assert.ok(before?.limits, 'the phone key\'s process runs with its limits');
  // what the web app's message route does
  await core.runner.send({ sessionId: a.body.sessionId, cwd: work, text: 'plain: from the web app' });
  const after = core.runner.bySession(a.body.sessionId);
  assert.notEqual(after.runId, before.runId);
  assert.equal(after.limits, null, 'back to normal settings');
  assert.equal(before.status, 'exited', 'the old process ended before the new one started');
  assert.equal([...core.runner.runs.values()].filter(r => r.sessionId === a.body.sessionId && r.status !== 'exited').length, 1);
});

test('settings only a new process can take are refused on a session in use; models and efforts are checked', async () => {
  const r = await call(full.key, 'POST', `/sessions/${first}/messages`, { prompt: 'x', system: 'be brief' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'start_only');
  const m = await call(full.key, 'POST', '/chat', { prompt: 'x', model: 'gpt-4' });
  assert.equal(m.status, 400);
  assert.equal(m.body.error.code, 'unknown_model');
  assert.ok(m.body.error.models.includes('opus'));
  const e = await call(full.key, 'POST', '/chat', { prompt: 'plain: effort', session: 'new', model: 'haiku', effort: 'high' });
  assert.equal(e.body.status, 'done');
  assert.match(e.body.warnings.join(' '), /doesn't take the effort level/);
  const s = await call(full.key, 'POST', '/chat', { prompt: 'capital?', session: 'new', schema: { type: 'object' } });
  assert.deepEqual(s.body.json, { answer: 'echo: capital?' });
});

test('Claude\'s own failures: a usage limit and a signed-out CLI say what they are', async () => {
  const lim = await call(full.key, 'POST', '/chat', { prompt: 'limit: x', session: 'new', tools: 'none' });
  assert.equal(lim.body.status, 'error');
  assert.equal(lim.body.error.code, 'claude_limit');
  assert.match(lim.body.error.message, /resets 6pm/);
  const text = await fetch(base + '/chat', { method: 'POST', headers: { Authorization: `Bearer ${full.key}` }, body: JSON.stringify({ prompt: 'limit: y', session: 'new', tools: 'none', format: 'text' }) });
  assert.equal(text.status, 429);
  const out = await call(full.key, 'POST', '/chat', { prompt: 'signout: x', session: 'new', tools: 'none' });
  assert.equal(out.body.error.code, 'claude_signed_out');
  assert.equal((await call(full.key, 'GET', '/health')).body.claudeSignedIn, false);
  await call(full.key, 'POST', '/chat', { prompt: 'plain: ok', session: 'new' });
  assert.equal((await call(full.key, 'GET', '/health')).body.claudeSignedIn, true);
  assert.equal(classifyError('Failed to authenticate. API Error: 401 Invalid bearer token').code, 'claude_signed_out');
});

test('timeouts, cancelling and stopping', async () => {
  const t = await call(full.key, 'POST', '/chat', { prompt: 'slow:5000:plain: long', session: 'new', timeout: 1, wait: 10 });
  assert.equal(t.body.status, 'interrupted', t.text);
  assert.match(t.body.warnings.join(' '), /timed out/);
  const s = await call(full.key, 'POST', '/sessions', { prompt: 'plain: base', project: work });
  const id = s.body.sessionId;
  const running = call(full.key, 'POST', `/sessions/${id}/messages`, { prompt: 'slow:1500:plain: busy', wait: 10 });
  await new Promise(r => setTimeout(r, 200));
  const queued = await call(full.key, 'POST', `/sessions/${id}/messages`, { prompt: 'plain: waiting', wait: 0 });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.status, 'queued');
  assert.deepEqual(queued.body.queue, { ahead: 1 });
  const cancelled = await call(full.key, 'DELETE', `/turns/${queued.body.id}`);
  assert.equal(cancelled.body.status, 'interrupted');
  const stop = await call(full.key, 'POST', `/sessions/${id}/stop`);
  assert.equal(stop.body.ok, true);
  const ended = await running;
  assert.ok(['interrupted', 'error'].includes(ended.body.status), ended.text);
});

test('the same request twice (Idempotency-Key) sends the prompt once', async () => {
  const h = { 'Idempotency-Key': 'abc-123' };
  const a = await call(full.key, 'POST', '/chat', { prompt: 'plain: only once', session: 'new' }, h);
  const b = await call(full.key, 'POST', '/chat', { prompt: 'plain: only once', session: 'new' }, h);
  assert.equal(a.body.id, b.body.id);
  assert.equal(fs.readFileSync(transcriptOf(a.body.sessionId), 'utf8').split('only once').length - 1, 2, 'one prompt and one answer');
});

test('selection: pick a session; a deleted one starts a new session with a warning', async () => {
  assert.equal((await call(full.key, 'PUT', '/selection', { session: first })).status, 200);
  assert.equal((await call(full.key, 'GET', '/selection')).body.session, first);
  const tmpSession = await call(full.key, 'POST', '/sessions', { prompt: 'plain: to delete', project: work });
  await call(full.key, 'PUT', '/selection', { session: tmpSession.body.sessionId });
  core.runner.stop(tmpSession.body.sessionId);
  await new Promise(r => setTimeout(r, 300));
  fs.rmSync(transcriptOf(tmpSession.body.sessionId));
  const r = await call(full.key, 'POST', '/chat', { prompt: 'plain: where am I?' });
  assert.equal(r.body.status, 'done', r.text);
  assert.match(r.body.warnings.join(' '), /no longer exists/);
  assert.notEqual(r.body.sessionId, tmpSession.body.sessionId);
});

test('turns: listed per key, and a turn from before a restart says where its answer is', async () => {
  const list = await call(full.key, 'GET', '/turns?limit=200');
  assert.ok(list.body.turns.length >= 10);
  assert.ok(list.body.turns.every(t => t.id.startsWith('turn_')));
  assert.equal((await call(phone.key, 'GET', `/turns/${approvalTurn}`)).status, 404, 'another key\'s turn is not visible');
  // forget the turn, as a restart would; its note on disk still says it was running
  core.keys.turns[approvalTurn].status = 'running';
  api.turns.turns.delete(approvalTurn);
  const lost = await call(full.key, 'GET', `/turns/${approvalTurn}`);
  assert.equal(lost.status, 200);
  assert.equal(lost.body.status, 'lost');
  assert.match(lost.body.messagesUrl, /\/messages$/);
  assert.equal((await call(full.key, 'GET', '/turns/turn_nonexistent1')).status, 404);
});

test('budget and turns at once are per key', async () => {
  const k = core.keys.create({ name: 'Tight', dailyBudgetUsd: 0.01, maxTurns: 1 });
  assert.equal((await call(k.key, 'POST', '/chat', { prompt: 'plain: one', session: 'new' })).body.status, 'done');
  const over = await call(k.key, 'POST', '/chat', { prompt: 'plain: two', session: 'new' });
  assert.equal(over.status, 402);
  assert.equal(over.body.error.code, 'budget_exceeded');
});

test('the API keeps a place free for the web app: idle API processes make room', async () => {
  const runs = () => core.runner.list().filter(r => r.via);
  for (let i = 0; i < 4; i++) {
    const r = await call(full.key, 'POST', '/chat', { prompt: `plain: room ${i}`, session: 'new' });
    assert.equal(r.body.status, 'done', r.text);
    await new Promise(res => setTimeout(res, 200));
    assert.ok(runs().length <= 2, `at most HANDOFF_MAX_RUNS - 1 API processes (${runs().length})`);
  }
});

test('a session open on the laptop: the prompt goes into its inbox and the answer is read from its transcript', async t => {
  const id = crypto.randomUUID();
  const file = path.join(projDir, id + '.jsonl');
  const rec = o => fs.appendFileSync(file, JSON.stringify({ uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd: work, sessionId: id, ...o }) + '\n');
  rec({ type: 'user', message: { role: 'user', content: 'earlier on the laptop' } });
  const pipe = process.platform === 'win32' ? String.raw`\\.\pipe\handoff-laptop-` + crypto.randomUUID() : path.join(tmp, 'laptop.sock');
  const token = crypto.randomBytes(16).toString('hex');
  const reg = status => fs.writeFileSync(path.join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id, cwd: work, status, entrypoint: 'claude-desktop', name: 'Laptop chat', messagingSocketPath: pipe }));
  fs.writeFileSync(path.join(home, 'sessions', `${process.pid}.${'ef'.repeat(32)}.key`), JSON.stringify({ peerToken: token }));
  reg('idle');
  const inbox = net.createServer(c => {
    let buf = '';
    c.on('data', d => { buf += d; });
    c.on('end', () => {
      const msg = buf.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(m => m.type === 'user');
      reg('busy');
      setTimeout(() => {
        rec({ type: 'user', isMeta: true, origin: { kind: 'peer' }, message: { role: 'user', content: `Another Claude session sent a message:\n${msg.message.content}` } });
        rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Answered on the laptop' }] } });
        setTimeout(() => reg('idle'), 300);
      }, 300);
    });
  });
  await new Promise(r => inbox.listen(pipe, r));
  t.after(() => { inbox.close(); fs.rmSync(path.join(home, 'sessions', `${process.pid}.json`), { force: true }); });
  const r = await call(full.key, 'POST', `/sessions/${id}/messages`, { prompt: 'hello laptop', model: 'opus', wait: 15 });
  assert.equal(r.body.status, 'done', r.text);
  assert.equal(r.body.delivered, 'laptop');
  assert.equal(r.body.text, 'Answered on the laptop');
  assert.match(r.body.warnings.join(' '), /can't be changed for a session open on the computer/);
  const limited = await call(phone.key, 'POST', `/sessions/${id}/messages`, { prompt: 'plain: from the phone key' });
  assert.equal(limited.body.delivered, 'fork', 'a limited key never writes into the laptop session');
});
