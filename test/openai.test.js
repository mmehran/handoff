// The OpenAI-compatible endpoint: completions with and without streaming, continuing a conversation
// by its last reply (as chat apps resend the whole history), and what isn't supported.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-oai-')));
const home = path.join(tmp, 'claude');
process.env.HANDOFF_DATA_DIR = path.join(tmp, 'data');
process.env.HANDOFF_ENV_FILE = path.join(tmp, 'none.env');
process.env.FAKE_CLAUDE_HOME = home;
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });

const { loadConfig } = await import('../src/config.js');
const { createServer } = await import('../src/server.js');
const cfg = loadConfig();
Object.assign(cfg, { claudeHome: home, api: true, web: false, search: false, apiDir: path.join(tmp, 'chats'), maxConcurrentRuns: 6 });
const { server, core } = createServer(cfg, { claudePath: path.join(ROOT, 'test', 'fake-claude.js'), log: () => {} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
test.after(async () => { server.close(); await new Promise(r => setTimeout(r, 1500)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const k = core.keys.create({ name: 'Chat app', preset: 'chat', rateLimit: 600, maxTurns: 10 });
const complete = async (body, headers = {}) => {
  const r = await fetch(base + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${k.key}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* stream */ }
  return { status: r.status, body: json, text };
};
const transcriptOf = id => { for (const d of fs.readdirSync(path.join(home, 'projects'))) { const f = path.join(home, 'projects', d, id + '.jsonl'); if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8'); } return ''; };

let firstSession, firstReply;
test('a completion, in the OpenAI shape', async () => {
  const r = await complete({ model: 'default', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hello there' }] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.object, 'chat.completion');
  assert.equal(r.body.choices[0].message.role, 'assistant');
  assert.equal(r.body.choices[0].message.content, 'echo: hello there');
  assert.equal(r.body.choices[0].finish_reason, 'stop');
  assert.ok(r.body.usage.total_tokens > 0);
  assert.ok(r.body.handoff.sessionId);
  firstSession = r.body.handoff.sessionId;
  firstReply = r.body.choices[0].message.content;
});

test('the whole history sent again continues the same session with only the new message', async () => {
  const r = await complete({ model: 'default', messages: [
    { role: 'system', content: 'Be brief. Today is a different day.' },
    { role: 'user', content: 'hello there' }, { role: 'assistant', content: `  ${firstReply}\n` }, { role: 'user', content: 'and now?' }] });
  assert.equal(r.body.handoff.sessionId, firstSession);
  assert.equal(r.body.choices[0].message.content, 'echo: and now?');
  assert.doesNotMatch(transcriptOf(firstSession), /Earlier in this conversation/);
});

test('an edited or regenerated history starts a new session, with the earlier messages in its first prompt', async () => {
  const r = await complete({ model: 'default', messages: [{ role: 'user', content: 'hello there' }, { role: 'assistant', content: 'something else entirely' }, { role: 'user', content: 'again' }] });
  assert.notEqual(r.body.handoff.sessionId, firstSession);
  assert.match(transcriptOf(r.body.handoff.sessionId), /Earlier in this conversation:[\s\S]*Assistant: something else entirely[\s\S]*Now:\\nagain/);
  const h = await complete({ model: 'default', messages: [{ role: 'user', content: 'pinned' }] }, { 'X-Handoff-Session': firstSession });
  assert.equal(h.body.handoff.sessionId, firstSession, 'X-Handoff-Session picks the session');
});

test('streaming: chunks, then [DONE]', async () => {
  const r = await complete({ model: 'default', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'stream me' }] });
  const datas = r.text.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
  assert.equal(datas.at(-1), '[DONE]');
  const chunks = datas.slice(0, -1).map(d => JSON.parse(d));
  assert.ok(chunks.every(c => c.object === 'chat.completion.chunk'));
  assert.equal(chunks.map(c => c.choices[0]?.delta?.content || '').join(''), 'echo: stream me');
  assert.ok(chunks.some(c => c.choices[0]?.finish_reason === 'stop'));
  assert.ok(chunks.at(-1).usage, 'usage at the end when asked for');
  assert.doesNotMatch(r.text, /^event:/m, 'no named events (the OpenAI SDK would choke)');
  assert.doesNotMatch(r.text, /^retry:/m);
});

test('photos as data: URLs; what isn\'t supported is said plainly', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const img = await complete({ model: 'default', messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }] });
  assert.match(img.body.choices[0].message.content, /\[image\]/);
  for (const [body, code] of [
    [{ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f' } }] }, 'tools_not_supported'],
    [{ messages: [{ role: 'user', content: 'x' }], n: 2 }, 'n_not_supported'],
    [{ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] }, 'image_url_not_data'],
    [{ messages: [{ role: 'assistant', content: 'x' }] }, 'invalid_messages'],
    [{ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }, 'unknown_model'],
    [{ messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'extreme' }, 'invalid_effort']
  ]) {
    const r = await complete(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error.code, code);
    assert.ok(r.body.error.message);
  }
  const effort = await complete({ model: 'opus', reasoning_effort: 'high', messages: [{ role: 'user', content: 'deep' }] });
  assert.equal(effort.status, 200, effort.text);
});

test('a request repeated while it is still being answered joins that answer', async () => {
  const body = { model: 'default', messages: [{ role: 'user', content: 'slow:600:plain: once please' }] };
  const [a, b] = await Promise.all([complete(body), new Promise(r => setTimeout(r, 150)).then(() => complete(body))]);
  assert.equal(a.body.handoff.turnId, b.body.handoff.turnId);
  assert.equal(transcriptOf(a.body.handoff.sessionId).split('once please').length - 1, 2, 'one prompt, one answer');
});

test('GET /models works for OpenAI clients', async () => {
  const r = await fetch(base + '/models', { headers: { Authorization: `Bearer ${k.key}` } });
  const j = await r.json();
  assert.equal(j.object, 'list');
  assert.ok(j.data.every(m => m.object === 'model' && m.id));
});
