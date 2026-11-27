// Chained prompts: steps go out one at a time, each only when the chat is idle again; questions and
// busy chats make them wait, an error pauses the chain, and the steps survive a restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PromptQueue } from '../src/queue.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-queue-'));
const SID = '11111111-2222-4333-8444-555555555555';

// a chat Handoff runs: idle, busy or failed, as the test says
function setup({ live = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'q-'));
  const run = { status: 'idle', lastError: null, pending: new Set(), writesInFlight: 0 };
  const runner = { bySession: () => (live ? null : run), isIdle: r => r.status === 'idle' };
  let question = null;
  const store = { liveSessions: async () => (live ? [live] : []), pendingQuestion: async () => question };
  const sent = [];
  const q = new PromptQueue({
    store, runner, dataDir, interval: 1e9,
    deliver: async (id, step) => { sent.push(step.text); run.status = 'running'; } // a laptop session's registry catches up later, by itself
  });
  return { q, run, sent, setQuestion: v => { question = v; }, live, dataDir };
}
const settle = () => new Promise(r => setImmediate(r));

test('an idle chat gets the first step at once; the next waits until Claude is done', async () => {
  const { q, run, sent } = setup();
  q.add(SID, 'run the tests');
  q.add(SID, 'commit the changes');
  await settle(); await q.tick();
  assert.deepEqual(sent, ['run the tests']);
  await q.tick();
  assert.deepEqual(sent, ['run the tests'], 'still busy');
  run.status = 'idle';
  await q.tick();
  assert.deepEqual(sent, ['run the tests', 'commit the changes']);
  assert.equal(q.pending(SID), 0);
  q.stop();
});

test('a question from Claude holds the next step; an error pauses the chain until "go on"', async () => {
  const { q, run, sent, setQuestion } = setup();
  run.status = 'running';
  q.add(SID, 'one'); q.add(SID, 'two');
  run.status = 'idle';
  setQuestion({ toolUseId: 't' });
  await q.tick();
  assert.deepEqual(sent, [], 'waits for the answer');
  setQuestion(null);
  await q.tick();
  assert.deepEqual(sent, ['one']);
  await q.tick(); // Claude works on it
  run.status = 'idle'; run.lastError = 'boom';
  await q.tick();
  assert.deepEqual(sent, ['one']);
  assert.equal(q.view(SID).paused, true);
  assert.match(q.view(SID).note, /error/);
  q.pause(SID, false);
  await q.tick();
  assert.deepEqual(sent, ['one', 'two'], 'going on sends the next step despite the old error');
  q.stop();
});

test('a laptop session: "idle" right after sending only counts once it was seen busy (or after a grace)', async () => {
  const live = { sessionId: SID, status: 'idle', pid: 1 };
  const { q, sent } = setup({ live });
  q.add(SID, 'a'); q.add(SID, 'b');
  await settle(); await q.tick();
  assert.deepEqual(sent, ['a']);
  live.status = 'idle'; // the registry hasn't caught up yet
  await q.tick();
  assert.deepEqual(sent, ['a'], 'not sent: busy was never seen');
  live.status = 'busy'; await q.tick();
  live.status = 'idle'; await q.tick();
  assert.deepEqual(sent, ['a', 'b']);
  q.stop();
});

test('steps can be reordered and removed; they are kept on disk', async () => {
  const { q, run, dataDir } = setup();
  run.status = 'running';
  q.add(SID, 'x'); q.add(SID, 'y'); const v = q.add(SID, 'z');
  q.move(SID, v.steps[2].id, -1);
  assert.deepEqual(q.view(SID).steps.map(s => s.text), ['x', 'z', 'y']);
  q.remove(SID, v.steps[0].id);
  q.stop();
  const again = new PromptQueue({ store: {}, runner: {}, deliver: async () => {}, dataDir, interval: 1e9 });
  assert.deepEqual(again.view(SID).steps.map(s => s.text), ['z', 'y']);
  again.clear(SID);
  assert.equal(again.pending(SID), 0);
  again.stop();
  assert.throws(() => again.add(SID, '  '), /empty/);
});

test('a step that cannot be delivered goes back and pauses the chain', async () => {
  const { q, run } = setup();
  q.deliver = async () => { throw new Error('no such session'); };
  run.status = 'running';
  q.add(SID, 'p');
  run.status = 'idle';
  await q.tick();
  assert.equal(q.pending(SID), 1);
  assert.match(q.view(SID).note, /couldn't send/);
  q.stop();
});
