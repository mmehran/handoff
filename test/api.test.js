// The API (/api/v1): keys, sign-in with a key, limits, scopes and project limits, and the reading
// endpoints. A real server against a throwaway ~/.claude and the fake claude CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-api-')));
const home = path.join(tmp, 'claude');
const envFile = path.join(tmp, 'test.env');
fs.writeFileSync(envFile, '');
process.env.HANDOFF_DATA_DIR = path.join(tmp, 'data');
process.env.HANDOFF_ENV_FILE = envFile;
process.env.FAKE_CLAUDE_HOME = home;

const { loadConfig, parseEnv } = await import('../src/config.js');
const { createServer } = await import('../src/server.js');
const { hashPassword } = await import('../src/auth.js');

// two projects: A (two sessions, one long) and B (one session)
const workA = path.join(tmp, 'work', 'alpha'), workB = path.join(tmp, 'work', 'beta');
const keyOf = dir => dir.replace(/[^A-Za-z0-9]/g, '-');
const sid = () => crypto.randomUUID();
const s1 = sid(), s2 = sid(), s3 = sid();
const LONG = 'L'.repeat(30000);
function transcript(dir, id, lines, mtime) {
  fs.mkdirSync(path.join(home, 'projects', keyOf(dir)), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(home, 'projects', keyOf(dir), id + '.jsonl');
  fs.writeFileSync(f, lines.map((o, i) => JSON.stringify({ uuid: `${id}-${i}`, timestamp: new Date(2026, 0, 1, 0, i).toISOString(), cwd: dir, sessionId: id, ...o })).join('\n') + '\n');
  fs.utimesSync(f, mtime / 1000, mtime / 1000);
}
const many = [];
for (let i = 0; i < 30; i++) {
  many.push({ type: 'user', message: { role: 'user', content: `question ${i}` } });
  many.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: i === 29 ? LONG : `answer ${i}` }, { type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'ls' } }] } });
}
transcript(workA, s1, many, Date.now() - 1000);
transcript(workA, s2, [{ type: 'user', message: { role: 'user', content: 'Fix the billing bug' } }, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } }], Date.now() - 2000);
transcript(workB, s3, [{ type: 'user', message: { role: 'user', content: 'Beta work' } }], Date.now() - 3000);
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });

const cfg = loadConfig();
cfg.claudeHome = home;
cfg.passwordHash = hashPassword('the-test-password-1');
cfg.totpEnabled = false; cfg.totpSecret = '';
cfg.api = true;
cfg.publicHostname = 'claude.example.com';
cfg.apiCors = ['https://allowed.example'];
cfg.search = false;
const stub = path.join(ROOT, 'test', 'fake-claude.js');
const { server, core } = createServer(cfg, { claudePath: stub, log: () => {} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); });

// the web app's side (cookie + X-Handoff), for managing keys
let cookie = '';
async function web(method, p, body) {
  const r = await fetch(base + p, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-Handoff': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
// the API's side (a key)
async function call(key, method, p, body, headers = {}) {
  const r = await fetch(base + '/api/v1' + p, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, headers: r.headers };
}
const makeKey = async (o) => {
  const r = await web('POST', '/api/keys', { password: 'the-test-password-1', ...o });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

test('sign in to the web app (to manage keys)', async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Handoff': '1' }, body: JSON.stringify({ password: 'the-test-password-1' }) });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
});

let full; // a key with every permission
test('making a key needs the password again; the key is shown once and only its hash is kept', async () => {
  const no = await web('POST', '/api/keys', { name: 'x' });
  assert.equal(no.status, 401);
  full = await makeKey({ name: 'Full', scopes: ['read', 'chat', 'approve', 'files', 'git'], modes: ['manual', 'plan', 'acceptEdits', 'auto', 'dontAsk'] });
  assert.match(full.key, /^hk_[A-Za-z0-9_-]{43}$/);
  assert.equal(full.record.full, true);
  assert.equal(full.record.hash, undefined);
  const disk = fs.readFileSync(path.join(tmp, 'data', 'api-keys.json'), 'utf8');
  assert.ok(!disk.includes(full.key), 'the key itself is not on disk');
  assert.ok(disk.includes(crypto.createHash('sha256').update(full.key).digest('hex')));
  const list = await web('GET', '/api/keys');
  assert.equal(list.body.keys.length, 1);
  assert.equal(list.body.enabled, true);
  assert.ok(list.body.presets.phone);
});

test('health is public; everything else needs a key, sent either way; cookies count for nothing', async () => {
  const h = await call(null, 'GET', '/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.api, 'v1');
  const none = await call(null, 'GET', '/me');
  assert.equal(none.status, 401);
  assert.equal(none.body.error.code, 'unauthorized');
  const withCookie = await fetch(base + '/api/v1/me', { headers: { Cookie: cookie } });
  assert.equal(withCookie.status, 401, 'a signed-in browser is not a key');
  const me = await call(full.key, 'GET', '/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.key.name, 'Full');
  assert.match(me.body.key.webhookSecret, /^whsec_/);
  const alt = await fetch(base + '/api/v1/me', { headers: { 'X-Api-Key': full.key } });
  assert.equal(alt.status, 200);
  const nf = await call(full.key, 'GET', '/nope');
  assert.equal(nf.status, 404);
  assert.equal(nf.body.error.code, 'not_found');
});

test('models: the OpenAI list shape, with effort levels', async () => {
  const r = await call(full.key, 'GET', '/models');
  assert.equal(r.status, 200);
  assert.equal(r.body.object, 'list');
  assert.ok(r.body.data.some(m => m.id === 'opus' && m.object === 'model' && m.efforts.includes('high')));
  assert.deepEqual(r.body.tools, ['all', 'readOnly', 'none']);
});

test('projects and sessions: newest first, paging, title filter, details', async () => {
  const p = await call(full.key, 'GET', '/projects');
  assert.deepEqual(p.body.projects.map(x => x.name).sort(), ['alpha', 'beta']);
  const all = await call(full.key, 'GET', '/sessions');
  assert.deepEqual(all.body.sessions.map(s => s.id), [s1, s2, s3]);
  assert.equal(all.body.sessions[0].status, 'saved');
  assert.equal(all.body.sessions[0].webUrl, `https://claude.example.com/#/s/${s1}`);
  const page1 = await call(full.key, 'GET', '/sessions?limit=2');
  assert.equal(page1.body.sessions.length, 2);
  assert.ok(page1.body.next);
  const page2 = await call(full.key, 'GET', `/sessions?limit=2&before=${page1.body.next}`);
  assert.deepEqual(page2.body.sessions.map(s => s.id), [s3]);
  const q = await call(full.key, 'GET', '/sessions?q=billing');
  assert.deepEqual(q.body.sessions.map(s => s.id), [s2]);
  const byProject = await call(full.key, 'GET', '/sessions?project=beta');
  assert.deepEqual(byProject.body.sessions.map(s => s.id), [s3]);
  const one = await call(full.key, 'GET', `/sessions/${s2}`);
  assert.equal(one.body.title, 'Fix the billing bug');
  assert.equal(one.body.project.name, 'alpha');
  assert.deepEqual(one.body.pending.approvals, []);
});

test('messages: the chat view keeps long answers whole and pages without losing or repeating any', async () => {
  const last = await call(full.key, 'GET', `/sessions/${s1}/messages?limit=10`);
  assert.equal(last.status, 200);
  assert.equal(last.body.messages.length, 10);
  assert.equal(last.body.messages.at(-1).role, 'assistant');
  assert.equal(last.body.messages.at(-1).text.length, LONG.length, 'not cut at 20,000 characters');
  const seen = [...last.body.messages];
  let before = last.body.before;
  while (before != null) {
    const r = await call(full.key, 'GET', `/sessions/${s1}/messages?limit=10&before=${before}`);
    seen.unshift(...r.body.messages);
    before = r.body.before;
  }
  assert.equal(seen.length, 60);
  assert.deepEqual(seen.slice(0, 2).map(m => m.text), ['question 0', 'answer 0']);
  const events = await call(full.key, 'GET', `/sessions/${s1}/messages?format=events&limit=3`);
  assert.ok(events.body.messages.some(e => e.kind === 'tool_use'));
});

test('scopes and project limits: a key only sees what it may', async () => {
  const chatOnly = await makeKey({ name: 'Chat only', scopes: ['chat'] });
  const r = await call(chatOnly.key, 'GET', '/projects');
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'forbidden_scope');
  const alphaOnly = await makeKey({ name: 'Alpha', scopes: ['read'], projects: [workA] });
  assert.equal(alphaOnly.record.full, false);
  const p = await call(alphaOnly.key, 'GET', '/projects');
  assert.deepEqual(p.body.projects.map(x => x.name), ['alpha']);
  const s = await call(alphaOnly.key, 'GET', '/sessions');
  assert.deepEqual(s.body.sessions.map(x => x.id).sort(), [s1, s2].sort());
  const hidden = await call(alphaOnly.key, 'GET', `/sessions/${s3}`);
  assert.equal(hidden.status, 404, 'a session outside the key\'s projects looks like it does not exist');
  const msgs = await call(alphaOnly.key, 'GET', `/sessions/${s3}/messages`);
  assert.equal(msgs.status, 404);
  const bad = await web('POST', '/api/keys', { password: 'the-test-password-1', name: 'x', projects: [workA], modes: ['auto'] });
  assert.equal(bad.status, 400, 'auto mode only for keys with every project');
});

test('rate limit per key, with Retry-After', async () => {
  const slow = await makeKey({ name: 'Slow', rateLimit: 2 });
  assert.equal((await call(slow.key, 'GET', '/me')).status, 200);
  assert.equal((await call(slow.key, 'GET', '/me')).status, 200);
  const third = await call(slow.key, 'GET', '/me');
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'rate_limited');
  assert.ok(Number(third.headers.get('retry-after')) >= 1);
});

test('CORS only for listed websites', async () => {
  const ok = await fetch(base + '/api/v1/me', { method: 'OPTIONS', headers: { Origin: 'https://allowed.example', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://allowed.example');
  const no = await fetch(base + '/api/v1/me', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(no.status, 403);
  assert.equal(no.headers.get('access-control-allow-origin'), null);
});

test('keys made in a terminal work at once; revoked keys stop at once', async () => {
  const env = { ...process.env, HANDOFF_ENV_FILE: envFile, HANDOFF_DATA_DIR: path.join(tmp, 'data') };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'api-key.js'), 'create', '--name', 'From terminal', '--preset', 'phone'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const key = r.stdout.match(/hk_[A-Za-z0-9_-]{43}/)[0];
  const me = await call(key, 'GET', '/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.key.defaults.model, 'haiku');
  assert.equal(me.body.key.tools, 'readOnly');
  const list = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'api-key.js'), 'list'], { env, encoding: 'utf8' });
  assert.match(list.stdout, /From terminal/);
  const rv = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'api-key.js'), 'revoke', 'From terminal'], { env, encoding: 'utf8' });
  assert.equal(rv.status, 0, rv.stderr);
  assert.equal((await call(key, 'GET', '/me')).status, 401);
  const viaWeb = await makeKey({ name: 'To revoke' });
  assert.equal((await web('DELETE', `/api/keys/${viaWeb.record.id}`)).status, 200);
  assert.equal((await call(viaWeb.key, 'GET', '/me')).status, 401);
});

test('turning the API off and on from the web app needs the password, and takes effect at once', async () => {
  assert.equal((await web('POST', '/api/api-enabled', { on: false })).status, 401);
  const off = await web('POST', '/api/api-enabled', { on: false, password: 'the-test-password-1' });
  assert.equal(off.status, 200);
  const r = await call(full.key, 'GET', '/me');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'api_off');
  assert.equal(parseEnv(fs.readFileSync(envFile, 'utf8')).HANDOFF_API, 'false');
  await web('POST', '/api/api-enabled', { on: true, password: 'the-test-password-1' });
  assert.equal((await call(full.key, 'GET', '/me')).status, 200);
});

test('wrong keys: five from one address block that address for a while', async () => {
  core.keys.bad.clear(); // the revoked keys tried above count as wrong ones too
  for (let i = 0; i < 5; i++) assert.equal((await call('hk_wrong' + i, 'GET', '/me')).status, 401);
  const blocked = await call(full.key, 'GET', '/me');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'too_many_wrong_keys');
  core.keys.bad.clear();
  assert.equal((await call(full.key, 'GET', '/me')).status, 200);
});

test('"sign out everywhere" can revoke every API key too', async () => {
  const r = await web('POST', '/api/logout-all', { revokeKeys: true });
  assert.equal(r.status, 200);
  assert.ok(r.body.revokedKeys >= 1);
  assert.equal((await call(full.key, 'GET', '/me')).status, 401);
});
