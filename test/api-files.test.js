// The API's files: attachments (JSON and multipart), @mentions, and the files, folders and git endpoints.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-files-')));
const home = path.join(tmp, 'claude');
process.env.HANDOFF_DATA_DIR = path.join(tmp, 'data');
process.env.HANDOFF_ENV_FILE = path.join(tmp, 'none.env');
process.env.FAKE_CLAUDE_HOME = home;

const { loadConfig } = await import('../src/config.js');
const { createServer } = await import('../src/server.js');

// a git project with one commit
const repo = path.join(tmp, 'work', 'repo');
fs.mkdirSync(repo, { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
fs.writeFileSync(path.join(repo, 'app.js'), 'console.log(1)\n');
git('add', '.'); git('commit', '-q', '-m', 'first');
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });

const cfg = loadConfig();
Object.assign(cfg, { claudeHome: home, api: true, web: false, search: false, fileBrowser: true, gitActions: true, apiUploadMb: 1, apiDir: path.join(tmp, 'api-chats'), maxConcurrentRuns: 6 });
const { server, core } = createServer(cfg, { claudePath: path.join(ROOT, 'test', 'fake-claude.js'), log: () => {} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
test.after(async () => { server.close(); await new Promise(r => setTimeout(r, 1500)); try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); } catch { /* the OS cleans temp */ } });

const full = core.keys.create({ name: 'Full', scopes: ['read', 'chat', 'approve', 'files', 'git'], modes: ['manual', 'plan', 'acceptEdits', 'auto', 'dontAsk'], rateLimit: 600, maxTurns: 10 });
const reader = core.keys.create({ name: 'Reader', scopes: ['read', 'chat'], tools: 'readOnly', projects: [repo], rateLimit: 600 });
async function call(key, method, p, body) {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${key}` }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: json, text };
}
const b64 = s => Buffer.from(s).toString('base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n');
const transcriptOf = id => { for (const d of fs.readdirSync(path.join(home, 'projects'))) { const f = path.join(home, 'projects', d, id + '.jsonl'); if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8'); } return ''; };
const uploads = dir => (fs.existsSync(path.join(dir, '.handoff-uploads')) ? fs.readdirSync(path.join(dir, '.handoff-uploads')).filter(n => n !== '.gitignore') : []);

test('a small text file goes straight into the prompt; with no tools a PDF goes in as a document', async () => {
  const r = await call(full.key, 'POST', '/chat', { prompt: 'read @notes.txt please', session: 'new', tools: 'none', files: [{ name: 'notes.txt', data: b64('remember the milk') }, { name: 'report.pdf', data: PDF.toString('base64') }] });
  assert.equal(r.body.status, 'done', r.text);
  const t = transcriptOf(r.body.sessionId);
  assert.match(t, /<file name=\\"notes.txt\\">\\nremember the milk/);
  assert.match(t, /\\"notes.txt\\" \(below\)/);
  assert.match(r.body.text, /\[document\]/, 'the PDF went in as a document block');
});

test('with tools, files are saved in the project (git-ignored) and named in the prompt; @name points at them', async () => {
  const big = 'x'.repeat(150 * 1024); // too big to put in the prompt
  const r = await call(full.key, 'POST', '/sessions', { prompt: 'summarise @big.log and @report.pdf', project: repo, tools: 'readOnly', files: [{ name: 'big.log', data: b64(big) }, { name: 'report.pdf', data: PDF.toString('base64') }] });
  assert.equal(r.body.status, 'done', r.text);
  const saved = uploads(repo);
  assert.equal(saved.length, 2);
  assert.ok(saved.some(n => /-big\.log$/.test(n)) && saved.some(n => /-report\.pdf$/.test(n)));
  const t = transcriptOf(r.body.sessionId);
  assert.match(t, /@\.handoff-uploads\/[^\s"]+-big\.log/);
  assert.match(t, /Attached, saved in this project: .*\(PDF, /);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '', 'git doesn\'t see them');
});

test('multipart uploads work like JSON', async () => {
  const form = new FormData();
  form.append('prompt', 'what is in the photo?');
  form.append('session', 'new');
  form.append('tools', 'none');
  form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'dot.png');
  const r = await call(full.key, 'POST', '/chat', form);
  assert.equal(r.body.status, 'done', r.text);
  assert.match(r.body.text, /\[image\]/);
});

test('files that can\'t be sent, and @paths outside the session\'s folder, are refused', async () => {
  const odd = await call(full.key, 'POST', '/chat', { prompt: 'x', session: 'new', files: [{ name: 'blob.bin', data: Buffer.from([0, 1, 2, 3, 255, 0]).toString('base64') }] });
  assert.equal(odd.status, 415);
  assert.equal(odd.body.error.code, 'unsupported_file');
  const docx = await call(full.key, 'POST', '/chat', { prompt: 'x', session: 'new', tools: 'none', files: [{ name: 'a.docx', data: Buffer.from([0x50, 0x4b, 3, 4, 0, 0]).toString('base64') }] });
  assert.equal(docx.status, 400);
  assert.equal(docx.body.error.code, 'needs_tools');
  const huge = await call(full.key, 'POST', '/chat', { prompt: 'x', session: 'new', files: [{ name: 'big.txt', data: b64('y'.repeat(1.2 * 1024 * 1024)) }] });
  assert.equal(huge.status, 413, 'HANDOFF_API_UPLOAD_MB is 1 here');
  for (const p of ['read @../../secret.txt', `read @${path.join(tmp, 'data', 'api-keys.json')}`, 'read @~/.ssh/id_rsa']) {
    const r = await call(full.key, 'POST', '/chat', { prompt: p, project: repo, session: 'new' });
    assert.equal(r.status, 400, p);
    assert.equal(r.body.error.code, 'mention_outside', p);
  }
  const fine = await call(full.key, 'POST', '/chat', { prompt: 'plain: look at @app.js and email me@example.com', project: repo, session: 'new' });
  assert.equal(fine.body.status, 'done', fine.text);
});

test('the project\'s files and changes need the "files" permission; folders need every project', async () => {
  const s = await call(full.key, 'POST', '/sessions', { prompt: 'plain: hi', project: repo });
  const id = s.body.sessionId;
  const list = await call(full.key, 'GET', `/sessions/${id}/files`);
  assert.equal(list.status, 200, list.text);
  assert.ok(list.body.entries.some(e => e.name === 'app.js'));
  const file = await call(full.key, 'GET', `/sessions/${id}/file?path=app.js`);
  assert.match(file.body.text, /console\.log/);
  fs.writeFileSync(path.join(repo, 'app.js'), 'console.log(2)\n');
  const ch = await call(full.key, 'GET', `/sessions/${id}/changes`);
  assert.ok(ch.body.files.some(f => f.path === 'app.js'));
  const d = await call(full.key, 'GET', `/sessions/${id}/diff?path=app.js`);
  assert.match(d.body.diff, /\+console\.log\(2\)/);
  assert.equal((await call(reader.key, 'GET', `/sessions/${id}/files`)).status, 403);
  assert.equal((await call(full.key, 'GET', '/folders')).status, 200);
  const r2 = core.keys.create({ name: 'Files, one project', scopes: ['read', 'files'], projects: [repo], rateLimit: 600 });
  assert.equal((await call(r2.key, 'GET', '/folders')).status, 403);
});

test('git through the API: commit and discard need the "git" permission', async () => {
  const s = await call(full.key, 'POST', '/sessions', { prompt: 'plain: commit it', project: repo });
  const id = s.body.sessionId;
  assert.equal((await call(reader.key, 'POST', `/sessions/${id}/commit`, { message: 'x' })).status, 403);
  const c = await call(full.key, 'POST', `/sessions/${id}/commit`, { message: 'Second', paths: ['app.js'] });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.body.subject, 'Second');
  fs.writeFileSync(path.join(repo, 'app.js'), 'oops\n');
  const dis = await call(full.key, 'POST', `/sessions/${id}/discard`, { path: 'app.js' });
  assert.equal(dis.status, 200, dis.text);
  assert.equal(fs.readFileSync(path.join(repo, 'app.js'), 'utf8').replace(/\r\n/g, '\n'), 'console.log(2)\n'); // git may restore Windows line endings
});

test('a new session in its own worktree', async () => {
  const r = await call(full.key, 'POST', '/sessions', { prompt: 'plain: on a branch', project: repo, worktree: 'api-branch' });
  assert.equal(r.body.status, 'done', r.text);
  const s = await call(full.key, 'GET', `/sessions/${r.body.sessionId}`);
  assert.match(s.body.cwd.replace(/\\/g, '/'), /\.claude\/worktrees\/api-branch/);
});
