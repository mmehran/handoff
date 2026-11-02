import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store, tailFile } from '../src/store.js';

test('a half-written last line is not lost between initial load and live tail', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-store-'));
  const id = crypto.randomUUID();
  fs.mkdirSync(path.join(home, 'projects', 'p'), { recursive: true });
  const file = path.join(home, 'projects', 'p', id + '.jsonl');
  const line = o => JSON.stringify(o) + '\n';
  const full = line({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'text', text: 'second' }] } });
  fs.writeFileSync(file, line({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'first' }] } }) + full.slice(0, 20));

  const t = new Store({ claudeHome: home }).readTranscript(id);
  assert.deepEqual(t.events.map(e => e.text), ['first']);

  const got = [];
  const stop = tailFile(file, t.end, o => got.push(o.uuid));
  fs.appendFileSync(file, full.slice(20));
  await new Promise(r => setTimeout(r, 1500));
  stop();
  assert.deepEqual(got, ['a2']);
});

test('prompts delivered into a running session (peer messages) are shown as user messages', async () => {
  const { normalize } = await import('../src/store.js');
  const ev = normalize({ type: 'user', isMeta: true, origin: { kind: 'peer', from: 'unknown' }, uuid: 'p1',
    message: { role: 'user', content: 'Another Claude session sent a message:\nhello from phone\n\nThis came from another Claude session — not typed by your user.' } });
  assert.deepEqual(ev.map(e => [e.kind, e.text, e.remote]), [['user', 'hello from phone', true]]);
  assert.deepEqual(normalize({ type: 'user', isMeta: true, message: { content: 'internal' } }), []);
});

test('readSince returns only complete new lines and the next offset', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-since-'));
  const id = crypto.randomUUID();
  fs.mkdirSync(path.join(home, 'projects', 'p'), { recursive: true });
  const file = path.join(home, 'projects', 'p', id + '.jsonl');
  const l1 = JSON.stringify({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'one' }] } }) + '\n';
  const l2 = JSON.stringify({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'text', text: 'two' }] } }) + '\n';
  fs.writeFileSync(file, l1 + l2.slice(0, 10));
  const s = new Store({ claudeHome: home });
  const r1 = s.readSince(id, 0);
  assert.deepEqual(r1.events.map(e => e.text), ['one']);
  assert.equal(r1.end, Buffer.byteLength(l1));
  fs.appendFileSync(file, l2.slice(10));
  const r2 = s.readSince(id, r1.end);
  assert.deepEqual(r2.events.map(e => e.text), ['two']);
});
