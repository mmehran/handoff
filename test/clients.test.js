// The ready-made clients (clients/): the JavaScript client, the `handoff` command, and the Python
// client (where Python is installed), against a real server with the fake claude CLI. Also the
// public OpenAPI description and the Swagger page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-clients-')));
const home = path.join(tmp, 'claude');
process.env.HANDOFF_DATA_DIR = path.join(tmp, 'data');
process.env.HANDOFF_ENV_FILE = path.join(tmp, 'none.env');
process.env.FAKE_CLAUDE_HOME = home;
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });

const { loadConfig } = await import('../src/config.js');
const { createServer } = await import('../src/server.js');
const { Handoff, HandoffError, file } = await import('../clients/handoff.mjs');
const cfg = loadConfig();
Object.assign(cfg, { claudeHome: home, api: true, web: false, search: false, apiDir: path.join(tmp, 'chats'), maxConcurrentRuns: 6 });
const { server, core } = createServer(cfg, { claudePath: path.join(ROOT, 'test', 'fake-claude.js'), log: () => {} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { server.close(); await new Promise(r => setTimeout(r, 1500)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const k = core.keys.create({ name: 'Clients', scopes: ['read', 'chat', 'approve'], rateLimit: 600, maxTurns: 10 });

test('the JavaScript client: chat, continue, stream, sessions, select, errors', async () => {
  const h = new Handoff(url, k.key);
  const t = await h.chat('plain: hello', { session: 'new' });
  assert.equal(t.status, 'done');
  assert.equal(t.text, 'echo: plain: hello');
  const again = await h.chat('plain: again');
  assert.equal(again.sessionId, t.sessionId, 'the selected session continues');
  let text = '';
  for await (const ev of h.stream('/chat', { prompt: 'plain: streamed', session: 'new' })) if (ev.event === 'text') text += ev.data.text;
  assert.equal(text, 'echo: plain: streamed');
  const s = await h.sessions({ limit: 5 });
  assert.ok(s.sessions.some(x => x.id === t.sessionId));
  await h.select(t.sessionId);
  assert.equal((await h.selection()).session, t.sessionId);
  const withFile = await h.chat('read @notes.txt', { session: 'new', tools: 'none', files: [file('notes.txt', 'the note')] });
  assert.equal(withFile.status, 'done');
  await assert.rejects(new Handoff(url, 'hk_wrong').me(), e => e instanceof HandoffError && e.status === 401 && e.code === 'unauthorized');
  core.keys.bad.clear();
});

test('the handoff command', async () => {
  const env = { ...process.env, HANDOFF_URL: url, HANDOFF_KEY: k.key };
  // (spawned without blocking: the server it talks to runs in this same process)
  const cli = (...a) => new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(ROOT, 'clients', 'handoff-cli.mjs'), ...a], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; }); p.stderr.on('data', d => { stderr += d; });
    p.on('exit', status => resolve({ status, stdout, stderr }));
  });
  const ask = await cli('ask', 'plain: from the terminal', '--session', 'new');
  assert.equal(ask.status, 0, ask.stderr);
  assert.equal(ask.stdout.trim(), 'echo: plain: from the terminal');
  const streamed = await cli('ask', 'plain: streaming', '--session', 'new', '--stream');
  assert.equal(streamed.stdout.trim(), 'echo: plain: streaming');
  const list = await cli('sessions', '--limit', '3');
  assert.match(list.stdout, /[0-9a-f-]{36}\s+\w+/);
  const json = await cli('turns', '--json');
  assert.ok(JSON.parse(json.stdout).turns.length > 0);
  const help = await cli();
  assert.match(help.stdout, /handoff ask/);
});

test('the Python client, where Python is installed', async t => {
  const py = ['python3', 'python'].find(p => spawnSync(p, ['--version']).status === 0);
  if (!py) return t.skip('no Python here');
  const script = `import sys; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'clients'))})
from handoff import Handoff, file
h = Handoff(${JSON.stringify(url)}, ${JSON.stringify(k.key)})
t = h.chat("plain: from python", session="new")
print(t["text"])
print("".join(ev["data"]["text"] for ev in h.stream("/chat", {"prompt": "plain: py stream", "session": "new"}) if ev["event"] == "text"))
print(len(h.sessions(limit=3)["sessions"]))`;
  const r = await new Promise(resolve => {
    const p = spawn(py, ['-c', script]);
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('exit', code => resolve({ code, out, err }));
  });
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split(/\r?\n/);
  assert.equal(lines[0], 'echo: plain: from python');
  assert.equal(lines[1], 'echo: plain: py stream');
  assert.equal(lines[2], '3');
});

test('the OpenAPI description and the Swagger page are public; the page loads Swagger UI with its own CSP', async () => {
  const spec = await (await fetch(url + '/api/v1/openapi.json')).json();
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/chat'].post);
  assert.ok(spec.paths['/chat/completions'].post);
  const page = await fetch(url + '/api/v1/docs');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' https:\/\/cdn\.jsdelivr\.net\/npm\/swagger-ui-dist@5\.17\.14\//);
  const html = await page.text();
  assert.match(html, /swagger-ui-bundle\.js/);
  assert.doesNotMatch(html, /<script>/, 'no inline script');
  assert.match(await (await fetch(url + '/api/v1/docs.js')).text(), /SwaggerUIBundle\(\{ url: '\/api\/v1\/openapi\.json'/);
});
