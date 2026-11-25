// Compare models: one prompt, 2-3 models, answers side by side; nothing saved, nothing changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-cmp-')));
const home = path.join(tmp, 'claude');
process.env.HANDOFF_DATA_DIR = path.join(tmp, 'data');
process.env.HANDOFF_ENV_FILE = path.join(tmp, 'none.env');
process.env.FAKE_CLAUDE_HOME = home;
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });

const { loadConfig } = await import('../src/config.js');
const { createServer } = await import('../src/server.js');
const cfg = loadConfig();
Object.assign(cfg, { claudeHome: home, api: true, web: false, search: false, apiDir: path.join(tmp, 'chats'), maxConcurrentRuns: 3 });
const { server, core } = createServer(cfg, { claudePath: path.join(ROOT, 'test', 'fake-claude.js'), log: () => {} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
test.after(async () => { server.close(); await new Promise(r => setTimeout(r, 1500)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const k = core.keys.create({ name: 'Compare', rateLimit: 600, maxTurns: 6 });
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${k.key}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* stream */ }
  return { status: r.status, body: json, text };
};
const files = () => fs.existsSync(path.join(home, 'projects')) ? fs.readdirSync(path.join(home, 'projects')).flatMap(d => fs.readdirSync(path.join(home, 'projects', d))) : [];

test('three models answer side by side, even with room for only two processes; nothing is saved', async () => {
  const before = files().length;
  const r = await call('POST', '/compare', { prompt: 'which is best?', models: ['opus', { model: 'sonnet', effort: 'high' }, 'haiku'], wait: 30 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.object, 'comparison');
  assert.equal(r.body.status, 'done');
  assert.deepEqual(r.body.answers.map(a => a.model), ['opus', 'sonnet', 'haiku']);
  assert.ok(r.body.answers.every(a => a.status === 'done' && a.text === 'echo: which is best?'), JSON.stringify(r.body.answers));
  assert.ok(r.body.answers.every(a => a.costUsd === 0.01));
  assert.equal(files().length, before, 'no transcript was saved');
  const again = await call('GET', `/compare/${r.body.id}`);
  assert.equal(again.body.id, r.body.id);
});

test('comparing inside a session leaves the session unchanged', async () => {
  const s = await call('POST', '/chat', { prompt: 'plain: base', session: 'new' });
  const file = fs.readdirSync(path.join(home, 'projects')).map(d => path.join(home, 'projects', d, s.body.sessionId + '.jsonl')).find(f => fs.existsSync(f));
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const r = await call('POST', '/compare', { prompt: 'and?', session: s.body.sessionId, models: ['opus', 'haiku'], wait: 30 });
  assert.equal(r.body.status, 'done', r.text);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash);
});

test('streams tag each event with its model; limits and wrong input are refused', async () => {
  const s = await call('POST', '/compare', { prompt: 'stream it', models: ['opus', 'haiku'], stream: true });
  assert.match(s.text, /event: text\ndata: \{"model":"opus"/);
  assert.match(s.text, /event: text\ndata: \{"model":"haiku"/);
  assert.match(s.text, /event: all_done/);
  assert.equal((await call('POST', '/compare', { prompt: 'x', models: ['opus'] })).status, 400);
  assert.equal((await call('POST', '/compare', { prompt: 'x', models: ['opus', 'haiku', 'sonnet', 'default'] })).status, 400);
  assert.equal((await call('POST', '/compare', { prompt: 'x', models: ['opus', 'haiku'], tools: 'all' })).status, 400);
  const tight = core.keys.create({ name: 'One at a time', maxTurns: 1, rateLimit: 600 });
  const r = await fetch(base + '/compare', { method: 'POST', headers: { Authorization: `Bearer ${tight.key}` }, body: JSON.stringify({ prompt: 'x', models: ['opus', 'haiku'] }) });
  assert.equal(r.status, 429);
});
