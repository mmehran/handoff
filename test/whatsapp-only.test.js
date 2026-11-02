// WhatsApp-only mode end to end: a fake WhatsApp sender, a fake "desktop" session (registry entry,
// transcript and messaging inbox in a temp ~/.claude) and the real src/whatsapp-only.js process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-wa-'));
const home = path.join(tmp, 'claude');
const work = path.join(tmp, 'work');
const projKey = work.replace(/[^A-Za-z0-9]/g, '-');
const sessionId = crypto.randomUUID();
fs.mkdirSync(path.join(home, 'projects', projKey), { recursive: true });
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
fs.mkdirSync(work, { recursive: true });

const waitFor = async (what, fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`timed out waiting for ${what}`);
};

test('WhatsApp-only: a desktop question goes out, a numbered reply is delivered into the session', async t => {
  // the desktop session's messaging inbox
  const inboxPath = process.platform === 'win32' ? String.raw`\\.\pipe\handoff-wa-` + crypto.randomUUID() : path.join(tmp, 'inbox.sock');
  const delivered = [];
  const inbox = net.createServer(c => { let b = ''; c.on('data', d => { b += d; }); c.on('end', () => delivered.push(...b.split('\n').filter(Boolean).map(l => JSON.parse(l)))); });
  await new Promise(r => inbox.listen(inboxPath, r));
  const peerToken = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(home, 'sessions', `${process.pid}.${'cd'.repeat(32)}.key`), JSON.stringify({ peerToken }));
  const registry = status => fs.writeFileSync(path.join(home, 'sessions', `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId, cwd: work, status, entrypoint: 'claude-desktop', name: 'Drinks', messagingSocketPath: inboxPath }));
  registry('busy');

  // fake WhatsApp sender
  const token = 'x'.repeat(30), sent = [], replies = [];
  const sender = http.createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${token}`;
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/status') return send(200, { connected: true, me: '15550000000' });
    if (!ok) return send(401, { error: 'unauthorized' });
    if (req.url.startsWith('/inbox')) return send(200, { now: Date.now(), messages: replies.splice(0) });
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => { sent.push(JSON.parse(body)); send(200, { ok: true }); });
  });
  await new Promise(r => sender.listen(0, '127.0.0.1', r));

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'whatsapp-only.js')], {
    env: { ...process.env, HANDOFF_ENV_FILE: path.join(tmp, 'none.env'), HANDOFF_DATA_DIR: path.join(tmp, 'data'), HANDOFF_CLAUDE_HOME: home,
      HANDOFF_WHATSAPP_ENABLED: 'true', HANDOFF_WHATSAPP_TO: '+1 555 123 4567', HANDOFF_WHATSAPP_TOKEN: token,
      HANDOFF_WHATSAPP_URL: `http://127.0.0.1:${sender.address().port}`, HANDOFF_PUBLIC_HOSTNAME: 'claude.example.com' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  t.after(() => { child.kill(); sender.close(); inbox.close(); });

  await waitFor('startup', () => /linked as 15550000000/.test(out));
  // Claude asks a question in the desktop app
  fs.writeFileSync(path.join(home, 'projects', projKey, sessionId + '.jsonl'), JSON.stringify({
    type: 'assistant', uuid: 'q', timestamp: new Date().toISOString(), cwd: work, message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: { questions: [{ header: 'Drink', question: 'Tea or coffee?',
        options: [{ label: 'Tea', description: 'green' }, { label: 'Coffee', description: 'black' }] }] } }] } }) + '\n');
  registry('waiting');

  const q = await waitFor('the question on WhatsApp', () => sent.find(m => /Claude is asking you/.test(m.text)));
  assert.equal(q.to, '15551234567');
  assert.match(q.text, /Tea or coffee\?[\s\S]*1\. \*Tea\*[\s\S]*2\. \*Coffee\*/);
  assert.doesNotMatch(q.text, /claude\.example\.com/, 'no web UI in this mode, so no links');

  // someone else's message is ignored; the owner's "2" answers
  replies.push({ from: '19999999999', text: '1', at: Date.now() }, { from: '15551234567', text: '2', at: Date.now() });
  await waitFor('delivery into the session', () => delivered.length >= 2);
  assert.deepEqual(delivered[0], { type: 'auth', token: peerToken });
  assert.equal(delivered[1].type, 'user');
  assert.match(delivered[1].message.content, /^My answers — Drink: Coffee/);
  await waitFor('the confirmation', () => sent.find(m => /Sent to Claude/.test(m.text)));
  assert.equal(sent.filter(m => /Answer sent/.test(m.text)).length, 0, 'one confirmation, not two');
});
