// Organise and share: Handoff's own title, pin, tags and archive per chat (Claude's files untouched),
// Markdown export, and read-only share links that expire, show only that chat, and can be removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-organise-')));
const home = path.join(tmp, 'claude-home');
process.env.HANDOFF_DATA_DIR = path.join(tmp, 'data');
process.env.HANDOFF_ENV_FILE = path.join(tmp, 'no-such.env');
process.env.FAKE_CLAUDE_HOME = home;

const { loadConfig } = await import('../src/config.js');
const { createServer } = await import('../src/server.js');
const { hashPassword } = await import('../src/auth.js');
const { toMarkdown, SessionMeta } = await import('../src/organise.js');

const work = path.join(tmp, 'my-project');
fs.mkdirSync(work, { recursive: true });
const key = work.replace(/[^A-Za-z0-9]/g, '-');
fs.mkdirSync(path.join(home, 'projects', key), { recursive: true });
const id = crypto.randomUUID(), other = crypto.randomUUID();
const file = path.join(home, 'projects', key, id + '.jsonl');
const line = o => JSON.stringify({ timestamp: '2026-11-27T10:00:00Z', cwd: work, ...o });
fs.writeFileSync(file, [
  line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Fix the login bug' } }),
  line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Found it in **auth.js**.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
  line({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'secret-ish test output' }] } })
].join('\n') + '\n');
fs.writeFileSync(path.join(home, 'projects', key, other + '.jsonl'), line({ type: 'user', uuid: 'o1', message: { role: 'user', content: 'another chat' } }) + '\n');
const before = fs.readFileSync(file, 'utf8');

const cfg = loadConfig();
cfg.claudeHome = home;
cfg.passwordHash = hashPassword('test-password-123');
cfg.totpEnabled = false;
cfg.publicHostname = 'handoff.test';
const stub = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.js');
const { server } = createServer(cfg, { claudePath: stub, log: () => {} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = '';
const req = async (method, url, body, headers = {}) => {
  const r = await fetch(base + url, { method, headers: { 'X-Handoff': '1', Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json, headers: r.headers };
};
test.after(() => { server.closeAllConnections(); server.close(); });

test('sign in', async () => {
  const r = await req('POST', '/api/login', { password: 'test-password-123' });
  cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal(r.status, 200);
});

test('rename, pin, tag and archive show in lists and the chat; Claude\'s transcript is untouched', async () => {
  const r = await req('POST', `/api/sessions/${id}/meta`, { title: '  Login   bug ', pinned: true, tags: ['Bug', '#client-x', 'bug', ''] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.tags, ['bug', 'client-x']);
  const s = (await req('GET', `/api/sessions/${id}`)).json;
  assert.equal(s.title, 'Login bug');
  assert.equal(s.claudeTitle, 'Fix the login bug');
  assert.ok(s.pinned);
  const list = (await req('GET', `/api/projects/${encodeURIComponent(key)}/sessions`)).json;
  assert.equal(list.find(x => x.id === id).title, 'Login bug');
  const m = (await req('GET', '/api/meta')).json;
  assert.equal(m.pinned[0].id, id);
  assert.deepEqual(m.tags.map(t => t.tag), ['bug', 'client-x']);
  await req('POST', `/api/sessions/${id}/meta`, { archived: true, pinned: false, title: '' });
  const after = (await req('GET', `/api/sessions/${id}`)).json;
  assert.equal(after.title, 'Fix the login bug', 'a blank title goes back to Claude\'s');
  assert.ok(after.archived);
  assert.equal((await req('GET', '/api/meta')).json.pinned.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal((await req('POST', `/api/sessions/${id}/meta`, { tags: 'nope' })).status, 400);
  assert.equal((await req('POST', '/api/sessions/00000000-0000-4000-8000-000000000000/meta', { pinned: true })).status, 404);
});

test('export: a Markdown file, tool calls only when asked', async () => {
  const r = await req('GET', `/api/sessions/${id}/export`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/markdown/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename\*=UTF-8''Fix%20the%20login%20bug\.md/);
  assert.match(r.json, /^# Fix the login bug/);
  assert.match(r.json, /## You · /);
  assert.match(r.json, /Found it in \*\*auth\.js\*\*/);
  assert.doesNotMatch(r.json, /npm test|secret-ish/);
  const withTools = await req('GET', `/api/sessions/${id}/export?tools=1&format=json`);
  assert.match(withTools.json.markdown, /🔧 \*\*Bash\*\*/);
  assert.match(withTools.json.markdown, /secret-ish test output/);
  assert.equal((await fetch(`${base}/api/sessions/${id}/export`)).status, 401, 'not without signing in');
});

let link = '';
test('a share link shows that one chat to anyone, read-only, until it is removed', async () => {
  assert.equal((await req('POST', `/api/sessions/${id}/share`, { hours: 5 })).status, 400);
  const r = await req('POST', `/api/sessions/${id}/share`, { hours: 24 });
  assert.equal(r.status, 200);
  assert.match(r.json.url, /^https:\/\/handoff\.test\/share\/[A-Za-z0-9_-]{32}$/);
  link = r.json.url.split('/share/')[1];
  assert.equal(r.json.hash, undefined);
  // stored as a hash only
  assert.ok(!fs.readFileSync(path.join(tmp, 'data', 'shares.json'), 'utf8').includes(link));
  const anon = await fetch(`${base}/api/share/${link}`);
  assert.equal(anon.status, 200);
  const d = await anon.json();
  assert.equal(d.title, 'Fix the login bug');
  assert.equal(d.project, 'my-project');
  assert.doesNotMatch(d.markdown, /secret-ish/);
  assert.ok(!JSON.stringify(d).includes(work), 'no folder path');
  const page = await fetch(`${base}/share/${link}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex');
  // nothing else opens with it
  assert.equal((await fetch(`${base}/api/sessions/${other}`)).status, 401);
  assert.equal((await fetch(`${base}/api/share/${'x'.repeat(32)}`)).status, 404);
  const mine = (await req('GET', `/api/shares?sessionId=${id}`)).json;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].views, 1);
  assert.equal((await req('DELETE', `/api/shares/${mine[0].id}`)).status, 200);
  assert.equal((await fetch(`${base}/api/share/${link}`)).status, 404);
});

test('signing out everywhere with "revoke" removes share links too', async () => {
  const r = await req('POST', `/api/sessions/${id}/share`, { hours: 1 });
  const t = r.json.url.split('/share/')[1];
  assert.equal((await fetch(`${base}/api/share/${t}`)).status, 200);
  await req('POST', '/api/logout-all', { revokeKeys: true });
  assert.equal((await fetch(`${base}/api/share/${t}`)).status, 404);
});

test('Markdown: questions as numbered options, plans, and code fences that survive backticks', () => {
  const md = toMarkdown({ title: 'T', project: 'p', at: 0, tools: true, events: [
    { kind: 'question', questions: [{ question: 'Which?', options: [{ n: 1, label: 'A', description: 'first' }, { n: 2, label: 'B' }] }] },
    { kind: 'plan', text: 'Step one' },
    { kind: 'tool_result', text: 'has ``` inside' }
  ] });
  assert.match(md, /\*\*Which\?\*\*\n\n1\. A — first\n2\. B/);
  assert.match(md, /\*\*Plan\*\*\n\nStep one/);
  assert.match(md, /````\nhas ``` inside\n````/);
  const meta = new SessionMeta({ dataDir: path.join(tmp, 'meta-only') });
  assert.deepEqual(meta.set('x', { tags: Array.from({ length: 15 }, (_, i) => 't' + i) }).tags.length, 10);
});
