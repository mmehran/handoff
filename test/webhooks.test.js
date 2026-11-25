// Webhooks: signed calls to a program's own address as a turn needs approval and when it ends; and the
// checks that keep them away from this computer's own services.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-hooks-')));
process.env.HANDOFF_DATA_DIR = path.join(tmp, 'data');
process.env.HANDOFF_ENV_FILE = path.join(tmp, 'none.env');
process.env.FAKE_CLAUDE_HOME = path.join(tmp, 'claude');
fs.mkdirSync(path.join(tmp, 'claude', 'sessions'), { recursive: true });

const { isPrivate, checkWebhook, deliver, sign } = await import('../src/webhooks.js');
const { loadConfig } = await import('../src/config.js');
const { createServer } = await import('../src/server.js');

test('private, loopback, link-local and mapped addresses are refused; public ones are fine', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '100.64.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '::']) assert.equal(isPrivate(a), true, a);
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivate(a), false, a);
});

test('a webhook address must be https, public and carry no password', () => {
  assert.equal(checkWebhook('https://example.com/hook'), 'https://example.com/hook');
  assert.equal(checkWebhook(undefined), null);
  for (const bad of ['http://example.com/hook', 'https://localhost/hook', 'https://127.0.0.1/hook', 'https://[::1]/hook', 'https://user:pw@example.com/', 'ftp://example.com', 'not a url']) {
    assert.throws(() => checkWebhook(bad), e => e.code === 'invalid_webhook', bad);
  }
});

test('delivering refuses private addresses, also when a name only resolves to one', async () => {
  await assert.rejects(deliver('https://127.0.0.1:9/x', '{}', {}), /private/);
  await assert.rejects(deliver('https://localhost:9/x', '{}', {}), /private address/);
});

test('redirects are not followed', async t => {
  const srv = http.createServer((req, res) => { res.writeHead(302, { Location: 'http://127.0.0.1:1/' }); res.end(); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  assert.equal(await deliver(`http://127.0.0.1:${srv.address().port}/`, '{}', {}, { allowLocal: true }), 302);
});

test('end to end: a signed call when a turn needs approval and when it ends, retried after a failure', async t => {
  const cfg = loadConfig();
  Object.assign(cfg, { claudeHome: path.join(tmp, 'claude'), api: true, web: false, search: false, apiDir: path.join(tmp, 'chats'), webhookTestAllowLocal: true, webhookTestRetryMs: 100 });
  const { server, core } = createServer(cfg, { claudePath: path.join(ROOT, 'test', 'fake-claude.js'), log: () => {} });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const k = core.keys.create({ name: 'Hooks', scopes: ['read', 'chat', 'approve'], rateLimit: 600 });
  const got = [];
  let failNext = 1;
  const hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      if (failNext-- > 0) { res.writeHead(500); return res.end(); }
      got.push({ headers: req.headers, body });
      res.writeHead(204); res.end();
    });
  });
  await new Promise(r => hook.listen(0, '127.0.0.1', r));
  t.after(async () => { hook.close(); server.close(); await new Promise(r => setTimeout(r, 1000)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
  const api = `http://127.0.0.1:${server.address().port}/api/v1`;
  const url = `http://127.0.0.1:${hook.address().port}/hook`;
  const r = await (await fetch(api + '/chat', { method: 'POST', headers: { Authorization: `Bearer ${k.key}` }, body: JSON.stringify({ prompt: 'write it', session: 'new', webhook: url, wait: 2 }) })).json();
  assert.equal(r.status, 'waiting_for_approval');
  const waitFor = async fn => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(res => setTimeout(res, 50)); return fn(); };
  assert.ok(await waitFor(() => got.find(g => g.headers['x-handoff-event'] === 'turn.waiting_for_approval')), 'the approval call arrived (after one retry)');
  await fetch(api + `/approvals/${r.pending.id}`, { method: 'POST', headers: { Authorization: `Bearer ${k.key}` }, body: JSON.stringify({ allow: true }) });
  const done = await waitFor(() => got.find(g => g.headers['x-handoff-event'] === 'turn.done'));
  assert.ok(done, 'the "done" call arrived');
  const payload = JSON.parse(done.body);
  assert.equal(payload.turn.id, r.id);
  assert.equal(payload.turn.status, 'done');
  const [, ts] = /t=(\d+)/.exec(done.headers['x-handoff-signature']);
  assert.equal(done.headers['x-handoff-signature'], sign(k.record.webhookSecret, done.body, Number(ts)), 'signed with the key\'s webhook secret');
  const expected = crypto.createHmac('sha256', k.record.webhookSecret).update(`${ts}.${done.body}`).digest('hex');
  assert.ok(done.headers['x-handoff-signature'].endsWith(expected));
  const bad = await fetch(api + '/chat', { method: 'POST', headers: { Authorization: `Bearer ${k.key}` }, body: JSON.stringify({ prompt: 'x', webhook: 'ftp://nope' }) });
  assert.equal(bad.status, 400);
});
