import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Notifier } from '../src/notify.js';

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

test('desktop session: busy -> waiting -> idle sends "waiting" then "finished"', () => {
  const { n, sent, setLive } = setup();
  setLive([{ sessionId: 'a', status: 'busy', cwd: 'D:\\projects\\shop' }]);
  n.scan(); // first scan only records state
  assert.equal(sent.length, 0);
  setLive([{ sessionId: 'a', status: 'waiting', waitingFor: 'permission to run Bash', cwd: 'D:\\projects\\shop' }]);
  n.scan();
  setLive([{ sessionId: 'a', status: 'idle', cwd: 'D:\\projects\\shop' }]);
  n.scan();
  assert.equal(sent.length, 2);
  assert.match(sent[0], /waiting for you/);
  assert.match(sent[0], /permission to run Bash/);
  assert.match(sent[1], /Claude finished/);
  assert.match(sent[1], /All tests pass now\./);
  assert.match(sent[1], /Project: shop/);
  assert.match(sent[1], /https:\/\/claude\.example\.com\/#\/s\/a/);
});

test('no message for sessions already idle at startup, or driven by the runner', () => {
  const { n, sent, setLive } = setup();
  setLive([{ sessionId: 'a', status: 'idle' }, { sessionId: 'ours', status: 'busy' }]);
  n.scan();
  setLive([{ sessionId: 'a', status: 'idle' }, { sessionId: 'ours', status: 'idle' }]);
  n.scan();
  assert.equal(sent.length, 0);
});

test('runner events: approval request, finished turn and error', () => {
  const { n, sent, runner } = setup();
  n.start(); n.stop();
  runner.emit('permission', { sessionId: 's1', tool: 'Bash', input: JSON.stringify({ command: 'npm test' }), cwd: 'D:\\x' });
  runner.emit('run', { sessionId: 's1', result: { isError: false, text: 'Done.' } });
  runner.emit('run', { sessionId: 's2', status: 'exited', lastError: 'claude exited with code 2' });
  assert.equal(sent.length, 3);
  assert.match(sent[0], /needs your approval[\s\S]*Tool: Bash — npm test/);
  assert.match(sent[1], /Claude finished[\s\S]*Done\./);
  assert.match(sent[2], /hit an error[\s\S]*code 2/);
});

test('throttles repeats per session and respects disabled event kinds', () => {
  const { n, sent } = setup({ events: { done: false } });
  assert.ok(n.event('approval', 'x'));
  assert.equal(n.event('approval', 'x'), false, 'same kind within 20s is skipped');
  assert.equal(n.event('done', 'x'), false, 'disabled kind');
  assert.equal(sent.length, 1);
});

test('off when not configured', () => {
  const { n, sent } = setup({ enabled: false });
  assert.equal(n.event('approval', 'x'), false);
  assert.equal(sent.length, 0);
});

// ---- questions and WhatsApp replies ----
const QUESTION = { toolUseId: 'tu1', questions: [{ header: 'Drink', question: 'Tea or coffee?', options: [
  { n: 1, label: 'Tea', description: 'green' }, { n: 2, label: 'Coffee', description: 'black' }] }] };

test('a waiting session with a question sends the options, numbered, once', () => {
  const { n, sent, setLive } = setup({ question: QUESTION });
  setLive([{ sessionId: 'a', status: 'busy', cwd: 'D:\p' }]);
  n.scan();
  setLive([{ sessionId: 'a', status: 'waiting', cwd: 'D:\p' }]);
  n.scan();
  n.scan(); // still the same question: no repeat
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Claude is asking you/);
  assert.match(sent[0], /Tea or coffee\?/);
  assert.match(sent[0], /1\. \*Tea\*/);
  assert.match(sent[0], /2\. \*Coffee\*/);
  assert.match(sent[0], /Reply with the number/);
});

test('a WhatsApp reply of "2" answers the open question', async () => {
  const { n, sent, answers, setLive } = setup({ question: QUESTION });
  setLive([{ sessionId: 'a', status: 'busy' }]); n.scan();
  setLive([{ sessionId: 'a', status: 'waiting' }]); n.scan();
  await n.handleReply('2');
  assert.deepEqual(answers, [{ id: 'a', picks: [2], text: '' }]);
  assert.match(sent.at(-1), /Sent to Claude/);
  assert.match(sent.at(-1), /close it there/);   // tells the user the laptop picker still has to be closed
});

test('free text is forwarded as a typed answer, and replies with nothing open are refused', async () => {
  const { n, sent, answers, setLive } = setup({ question: QUESTION });
  setLive([{ sessionId: 'a', status: 'busy' }]); n.scan();
  setLive([{ sessionId: 'a', status: 'waiting' }]); n.scan();
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
  assert.match(sent.at(-1), /Reply \*yes\* to allow/);
  await n.handleReply('yes');
  assert.deepEqual(approvals, [{ id: 'p1', allow: true }]);
  assert.match(sent.at(-1), /Allowed/);
  runner.emit('permission', { id: 'p2', sessionId: 'a', tool: 'Bash', input: '{}', cwd: 'D:\p' });
  await n.handleReply('no');
  assert.deepEqual(approvals.at(-1), { id: 'p2', allow: false });
  n.stop();
});
