import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-search-test-'));
process.env.HANDOFF_DATA_DIR = path.join(tmp, 'data');
process.env.HANDOFF_ENV_FILE = path.join(tmp, 'no-such.env');
const { Store } = await import('../src/store.js');
const { SearchIndex } = await import('../src/search.js');

const home = path.join(tmp, 'claude-home');
const proj = path.join(home, 'projects', 'D--work-shop');
fs.mkdirSync(proj, { recursive: true });
const line = o => JSON.stringify(o) + '\n';
const user = (uuid, text) => line({ type: 'user', uuid, cwd: 'D:\\work\\shop', timestamp: '2026-11-20T10:00:00Z', message: { role: 'user', content: text } });
const reply = (uuid, text) => line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolOut = uuid => line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'zebra in tool output only' }] } });

const a = crypto.randomUUID(), b = crypto.randomUUID();
const fileA = path.join(proj, a + '.jsonl'), fileB = path.join(proj, b + '.jsonl');
fs.writeFileSync(fileB, user('b1', 'An older chat about the Login page') + reply('b2', 'Fixed the login form.'));
fs.utimesSync(fileB, new Date('2026-11-01'), new Date('2026-11-01'));
fs.writeFileSync(fileA, line({ type: 'custom-title', customTitle: 'Tunnel fixes' }) + user('a1', 'Why does the tunnel drop on the VPN?') +
  reply('a2', 'QUIC is blocked there; HTTP/2 works.') + toolOut('a3'));

const store = new Store({ claudeHome: home });
const idx = new SearchIndex({ store, dir: path.join(tmp, 'data', 'search') });

test('finds prompts and replies (all words, any case), newest chats first; tool output is not indexed', async () => {
  const r = await idx.search('LOGIN');
  assert.deepEqual(r.results.map(x => x.sessionId), [b]);
  assert.equal(r.results[0].total, 2);
  assert.equal(r.results[0].hits[0].kind, 'assistant'); // newest message first
  const both = await idx.search('quic http/2');
  assert.equal(both.results[0].sessionId, a);
  assert.match(both.results[0].hits[0].snippet, /QUIC is blocked/);
  assert.equal((await idx.search('quic login')).results.length, 0, 'every word must match');
  assert.equal((await idx.search('zebra')).results.length, 0);
  assert.deepEqual(r.indexing, { done: 2, total: 2 });
});

test('titles match too, and one session can be searched on its own', async () => {
  const t = await idx.search('tunnel fixes');
  assert.equal(t.results[0].sessionId, a);
  assert.equal(t.results[0].titleMatch, true);
  assert.equal(t.results[0].title, 'Tunnel fixes');
  const one = await idx.search('the', { sessionId: b });
  assert.deepEqual(one.results.map(x => x.sessionId), [b]);
});

test('new messages are picked up by reading only what was added; a rewritten transcript is indexed again', async () => {
  fs.appendFileSync(fileA, user('a4', 'Now add a giraffe to the logo'));
  assert.equal((await idx.search('giraffe')).results[0].sessionId, a);
  fs.writeFileSync(fileB, user('b9', 'Completely new content'));
  assert.equal((await idx.search('login')).results.length, 0);
  assert.equal((await idx.search('completely new')).results[0].sessionId, b);
});

test('a hit can be shown in context', async () => {
  const hit = (await idx.search('quic')).results[0].hits[0];
  const ctx = await store.readAround(a, hit.offset, 1);
  assert.deepEqual(ctx.events.map(e => [e.kind, !!e.hit]), [['user', false], ['assistant', true], ['tool_result', false]]);
  assert.equal((await store.readAround(crypto.randomUUID(), 0)), null);
});

test('the index survives a restart and deleted chats leave it', async () => {
  const again = new SearchIndex({ store, dir: path.join(tmp, 'data', 'search') });
  assert.equal(await again.update(), 0, 'nothing to re-read after a restart');
  fs.rmSync(fileB);
  assert.equal((await again.search('completely')).results.length, 0);
  assert.ok(!fs.existsSync(path.join(tmp, 'data', 'search', b + '.jsonl')));
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
