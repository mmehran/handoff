import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Notifier } from '../src/notify.js';

// messages are built (reading the transcript) asynchronously; let them go out
const settle = () => new Promise(r => setImmediate(r));

function setup(overrides = {}) {
  const sent = [];
  let live = [];
  const store = {
    liveSessions: () => live,
    sessionInfo: id => ({ title: 'Fix login bug', cwd: 'D:\\projects\\shop' }),
    readTranscript: () => ({ events: [{ kind: 'assistant', text: 'All tests pass now.' }] }),
    pendingQuestion: () => overrides.question ?? null
  };
  const runner = Object.assign(new EventEmitter(), { bySession: id => (id === 'ours' ? {} : null) });
  const cfg = { publicHostname: 'claude.example.com', notify: { enabled: true, token: 't'.repeat(30), to: '15551234567', events: { approval: true, waiting: true, done: true, error: true }, ...overrides } };
  const answers = [], approvals = [];
  const n = new Notifier(cfg, { store, runner, log: () => {}, send: async t => { sent.push(t); },
    onAnswer: async (id, pick) => { answers.push({ id, ...pick }); return { answered: ['Drink: Coffee'], queuedBehindPicker: true }; },
    onApproval: (id, allow) => { approvals.push({ id, allow }); return true; } });
  return { n, sent, runner, answers, approvals, setLive: l => { live = l; } };
}

test('desktop session: busy -> waiting -> idle sends "waiting" then "finished"', async () => {
  const { n, sent, setLive } = setup();
  setLive([{ sessionId: 'a', status: 'busy', cwd: 'D:\\projects\\shop' }]);
  await n.scan(); await settle(); // first scan only records state
  assert.equal(sent.length, 0);
  setLive([{ sessionId: 'a', status: 'waiting', waitingFor: 'permission to run Bash', cwd: 'D:\\projects\\shop' }]);
  await n.scan(); await settle();
  setLive([{ sessionId: 'a', status: 'idle', cwd: 'D:\\projects\\shop' }]);
  await n.scan(); await settle();
  assert.equal(sent.length, 2);
  assert.match(sent[0], /waiting for you/);
  assert.match(sent[0], /permission to run Bash/);
  assert.match(sent[1], /Claude finished/);
  assert.match(sent[1], /All tests pass now\./);
  assert.match(sent[1], /Project: shop/);
  assert.match(sent[1], /https:\/\/claude\.example\.com\/#\/s\/a/);
});

test('no message for sessions already idle at startup, or driven by the runner', async () => {
  const { n, sent, setLive } = setup();
  setLive([{ sessionId: 'a', status: 'idle' }, { sessionId: 'ours', status: 'busy' }]);
  await n.scan(); await settle();
  setLive([{ sessionId: 'a', status: 'idle' }, { sessionId: 'ours', status: 'idle' }]);
  await n.scan(); await settle();
  assert.equal(sent.length, 0);
});

test('runner events: approval request, finished turn and error', async () => {
  const { n, sent, runner } = setup();
  n.start(); n.stop();
  runner.emit('permission', { sessionId: 's1', tool: 'Bash', input: JSON.stringify({ command: 'npm test' }), cwd: 'D:\\x' });
  runner.emit('run', { sessionId: 's1', result: { isError: false, text: 'Done.' } });
  runner.emit('run', { sessionId: 's2', status: 'exited', lastError: 'claude exited with code 2' });
  await settle();
  assert.equal(sent.length, 3);
  assert.match(sent[0], /needs your approval[\s\S]*Tool: Bash — npm test/);
  assert.match(sent[1], /Claude finished[\s\S]*Done\./);
  assert.match(sent[2], /hit an error[\s\S]*code 2/);
});

test('throttles repeats per session and respects disabled event kinds', async () => {
  const { n, sent } = setup({ events: { done: false } });
  assert.ok(n.event('approval', 'x'));
  assert.equal(n.event('approval', 'x'), false, 'same kind within 20s is skipped');
  assert.equal(n.event('done', 'x'), false, 'disabled kind');
  await settle();
  assert.equal(sent.length, 1);
});

test('off when not configured', async () => {
  const { n, sent } = setup({ enabled: false });
  assert.equal(n.event('approval', 'x'), false);
  assert.equal(sent.length, 0);
});

// ---- questions and WhatsApp replies ----
const QUESTION = { toolUseId: 'tu1', questions: [{ header: 'Drink', question: 'Tea or coffee?', options: [
  { n: 1, label: 'Tea', description: 'green' }, { n: 2, label: 'Coffee', description: 'black' }] }] };

test('a waiting session with a question sends the options, numbered, once', async () => {
  const { n, sent, setLive } = setup({ question: QUESTION });
  setLive([{ sessionId: 'a', status: 'busy', cwd: 'D:\p' }]);
  await n.scan(); await settle();
  setLive([{ sessionId: 'a', status: 'waiting', cwd: 'D:\p' }]);
  await n.scan(); await settle();
  await n.scan(); await settle(); // still the same question: no repeat
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Claude is asking you/);
  assert.match(sent[0], /Tea or coffee\?/);
  assert.match(sent[0], /1\. \*Tea\*/);
  assert.match(sent[0], /2\. \*Coffee\*/);
  assert.match(sent[0], /Reply with the number/);
});

test('a WhatsApp reply of "2" answers the open question', async () => {
  const { n, sent, answers, setLive } = setup({ question: QUESTION });
  setLive([{ sessionId: 'a', status: 'busy' }]); await n.scan(); await settle();
  setLive([{ sessionId: 'a', status: 'waiting' }]); await n.scan(); await settle();
  await n.handleReply('2');
  assert.deepEqual(answers, [{ id: 'a', picks: [2], text: '' }]);
  assert.match(sent.at(-1), /Sent to Claude/);
  assert.match(sent.at(-1), /close it there/);   // tells the user the laptop picker still has to be closed
});

test('free text is forwarded as a typed answer, and replies with nothing open are refused', async () => {
  const { n, sent, answers, setLive } = setup({ question: QUESTION });
  setLive([{ sessionId: 'a', status: 'busy' }]); await n.scan(); await settle();
  setLive([{ sessionId: 'a', status: 'waiting' }]); await n.scan(); await settle();
  await n.handleReply('neither, just water');
  assert.deepEqual(answers, [{ id: 'a', picks: [], text: 'neither, just water' }]);
  n.openAsk = null;
  await n.handleReply('hello?');
  assert.match(sent.at(-1), /Nothing is waiting/);
});

test('yes / no answer a pending tool approval', async () => {
  const { n, runner, approvals, sent } = setup();
  n.start();   // wires the runner listeners
  runner.emit('permission', { id: 'p1', sessionId: 'a', tool: 'Bash', input: '{"command":"ls"}', cwd: 'D:\p' });
  await settle();
  assert.match(sent.at(-1), /Reply \*yes\* to allow/);
  await n.handleReply('yes');
  assert.deepEqual(approvals, [{ id: 'p1', allow: true }]);
  assert.match(sent.at(-1), /Allowed/);
  runner.emit('permission', { id: 'p2', sessionId: 'a', tool: 'Bash', input: '{}', cwd: 'D:\p' });
  await n.handleReply('no');
  assert.deepEqual(approvals.at(-1), { id: 'p2', allow: false });
  n.stop();
});

test('link check: an unlinked phone is reported at once, other problems only when seen twice', async () => {
  const http = await import('node:http');
  let status = { connected: true };
  const sender = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(status)); });
  await new Promise(r => sender.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${sender.address().port}`;
  const changes = [], logs = [];
  const n = new Notifier({ notify: { enabled: true, token: 't'.repeat(30), to: '15551234567', url } },
    { store: {}, runner: new EventEmitter(), log: l => logs.push(l), send: async () => {}, onLinkChange: s => changes.push(s.problem) });
  try {
    await n.checkLink();
    assert.deepEqual(n.linkState(), { enabled: true, connected: true, problem: null, qrUrl: `${url}/qr` });

    status = { connected: false, waitingForScan: true };            // logged out: say so right away
    await n.checkLink();
    assert.equal(n.linkState().problem, 'unlinked');
    assert.match(logs.at(-1), /unlinked\. Scan the QR at http:\/\/127\.0\.0\.1:\d+\/qr/);

    status = { connected: true };
    await n.checkLink();
    assert.equal(n.linkState().connected, true);
    assert.match(logs.at(-1), /connected again/);

    status = { connected: false, waitingForScan: false };           // reconnecting: fine once...
    await n.checkLink();
    assert.equal(n.linkState().connected, true);
    await n.checkLink();                                             // ...still down 30s later: a problem
    assert.equal(n.linkState().problem, 'offline');

    await new Promise(r => sender.close(r));                         // container stopped
    await n.checkLink();
    assert.equal(n.linkState().problem, 'offline', 'one failed check is not enough');
    await n.checkLink();
    assert.equal(n.linkState().problem, 'not-running');
    assert.deepEqual(changes, [null, 'unlinked', null, 'offline', 'not-running']);
  } finally { sender.close(); n.stop(); }
});

test('link check: off when WhatsApp is not set up; a delivered message clears a problem', async () => {
  const off = new Notifier({ notify: { enabled: false } }, { store: {}, runner: new EventEmitter(), log: () => {} });
  assert.deepEqual(off.linkState(), { enabled: false });
  const { n } = setup();
  const changes = [];
  n.onLinkChange = s => changes.push(s.problem);
  n.setProblem('unlinked');
  n.cfg.notify.url = 'http://127.0.0.1:9';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) }); // the sender accepted the message
  try { await n.sendWhatsApp('hi'); } finally { globalThis.fetch = realFetch; }
  assert.equal(n.linkState().connected, true);
  assert.deepEqual(changes, ['unlinked', null]);
});

test('phone numbers are masked in logs', async () => {
  const { maskNumber } = await import('../src/notify.js');
  assert.equal(maskNumber('923001234567'), '+92••••••4567');
  assert.equal(maskNumber('+1 555 123 4567'), '+15•••••4567');
  assert.equal(maskNumber('123'), '+•••');
  const logs = [];
  const n = new Notifier({ notify: { enabled: true, token: 't'.repeat(30), to: '923001234567', url: 'http://127.0.0.1:9' } },
    { store: { liveSessions: () => [] }, runner: new EventEmitter(), log: l => logs.push(l), send: async () => {} });
  n.start(); n.stop();
  assert.ok(logs.some(l => l.includes('+92••••••4567')));
  assert.ok(!logs.join('\n').includes('923001234567'));
});

test('quiet hours: parsed in local time, may span midnight', async () => {
  const { parseQuiet, inQuiet } = await import('../src/notify.js');
  const q = parseQuiet('23:00-07:00');
  const at = (h, m = 0) => new Date(2026, 10, 25, h, m);
  assert.equal(inQuiet(q, at(23, 30)), true);
  assert.equal(inQuiet(q, at(6, 59)), true);
  assert.equal(inQuiet(q, at(7, 0)), false);
  assert.equal(inQuiet(parseQuiet('13:00-14:00'), at(13, 30)), true);
  assert.equal(parseQuiet('25:00-07:00'), null);
  assert.equal(parseQuiet('soon'), null);
  assert.equal(inQuiet(null), false);
});

test('during quiet hours alerts are held (unless allowed), then one summary goes out', async () => {
  let clock = new Date(2026, 10, 25, 2, 0);
  const sent = [];
  const n = new Notifier({ publicHostname: 'h.example.com', notify: { enabled: true, token: 't'.repeat(30), to: '15551234567', quiet: '23:00-07:00', quietAllow: ['approval'] } },
    { store: { sessionInfo: async id => ({ title: `Chat ${id}`, cwd: 'D:\\work\\shop' }) }, runner: new EventEmitter(), log: () => {}, send: async t => { sent.push(t); }, now: () => clock });
  assert.equal(n.event('done', 'a'), false);
  assert.equal(n.event('waiting', 'b', { cwd: 'D:\\work\\api' }), false);
  assert.equal(n.event('done', 'c'), false);
  assert.ok(n.event('approval', 'd'), 'allowed kinds still go out');
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(n.prefs().held, 3);
  await n.flushHeld();
  assert.equal(sent.length, 1, 'still quiet: nothing more');
  clock = new Date(2026, 10, 25, 7, 1);
  await n.flushHeld(); await settle();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /While quiet hours were on \(23:00-07:00\)/);
  assert.match(sent[1], /⏳ Waiting for you: Chat b \(api\)/);
  assert.match(sent[1], /✅ Finished: Chat a \(shop\), Chat c \(shop\)/);
  assert.match(sent[1], /Open: https:\/\/h\.example\.com\//);
  assert.equal(n.prefs().held, 0);
});

test('muted projects send nothing, and the list is kept on disk', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const prefsFile = path.join(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-mute-'))), 'notify.json');
  const make = () => new Notifier({ notify: { enabled: true, token: 't'.repeat(30), to: '15551234567' } },
    { store: { sessionInfo: async () => null }, runner: new EventEmitter(), log: () => {}, send: async () => {}, prefsFile });
  const n = make();
  n.setMuted('D:\\Work\\Shop', true);
  assert.equal(n.event('done', 'a', { cwd: 'D:\\Work\\Shop' }), false);
  assert.ok(n.event('done', 'b', { cwd: 'D:\\Work\\Api' }));
  assert.equal(make().isMuted('D:\\Work\\Shop'), true, 'remembered after a restart');
  if (process.platform === 'win32') assert.equal(make().isMuted('d:\\work\\shop'), true, 'Windows folder names ignore case');
  n.setMuted('D:\\Work\\Shop', false);
  assert.equal(make().isMuted('D:\\Work\\Shop'), false);
});
