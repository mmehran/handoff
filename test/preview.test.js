// App preview: a one-time link from the web app opens a dev server on the computer through the
// preview hostname, with its own cookie; WebSockets pass through; nothing gets in without the link.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-preview-')));
process.env.HANDOFF_DATA_DIR = path.join(tmp, 'data');
process.env.HANDOFF_ENV_FILE = path.join(tmp, 'no-such.env');

const { loadConfig } = await import('../src/config.js');
const { createServer } = await import('../src/server.js');
const { hashPassword } = await import('../src/auth.js');
const { mentionedPorts } = await import('../src/preview.js');

// the "dev server": echoes what it was asked, sets a cookie, redirects, and answers WebSocket upgrades
const seen = [];
const app = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers });
  if (req.url === '/go') { res.writeHead(302, { Location: `http://localhost:${app.address().port}/there` }); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'app=1; Domain=localhost; Path=/' });
  res.end(`<title>My app</title>path=${req.url}`);
});
app.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  socket.on('data', d => socket.write('echo:' + d));
});
await new Promise(r => app.listen(0, '127.0.0.1', r));
const appPort = app.address().port;

const cfg = loadConfig();
cfg.claudeHome = path.join(tmp, 'claude-home');
cfg.passwordHash = hashPassword('test-password-123');
cfg.totpEnabled = false;
cfg.previewHostname = 'preview.test';
cfg.publicHostname = 'handoff.test';
const stub = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.js');
const { server } = createServer(cfg, { claudePath: stub, log: () => {} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
let cookie = '';

// fetch can't set Host, so requests to the preview host go through http.request
function raw(pathname, { host = 'preview.test', headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, agent: false, headers: { host, ...headers } }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject); r.end();
  });
}
const web = (method, url, body) => fetch(`http://127.0.0.1:${port}${url}`, {
  method, headers: { 'X-Handoff': '1', Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined
}).then(async r => ({ status: r.status, json: await r.json().catch(() => null), headers: r.headers }));

test.after(() => { server.closeAllConnections(); server.close(); app.closeAllConnections(); app.close(); });

test('sign in to the web app', async () => {
  const r = await web('POST', '/api/login', { password: 'test-password-123' });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await web('GET', '/api/me')).json.preview, true);
});

test('the preview host lets nobody in without a link, and serves none of Handoff', async () => {
  const r = await raw('/');
  assert.equal(r.status, 401);
  assert.match(r.body, /Open this preview from Handoff/);
  assert.equal((await raw('/api/me')).status, 401);
  assert.equal((await raw('/__handoff/enter?t=made-up')).status, 403);
  // and Handoff's own cookie means nothing there
  assert.equal((await raw('/', { headers: { cookie } })).status, 401);
});

test('a link is only handed out to someone signed in, for allowed ports', async () => {
  const anon = await fetch(`http://127.0.0.1:${port}/api/preview`, { method: 'POST', headers: { 'X-Handoff': '1', 'Content-Type': 'application/json' }, body: '{"port":3000}' });
  assert.equal(anon.status, 401);
  for (const bad of [80, 70000, port, 2375, 'x']) assert.equal((await web('POST', '/api/preview', { port: bad })).status, 400, `port ${bad}`);
});

let previewCookie = '';
test('the link opens the app, once; the app sees a local visit; redirects and cookies are fixed up', async () => {
  const t = await web('POST', '/api/preview', { port: appPort });
  assert.equal(t.status, 200);
  assert.match(t.json.url, /^https:\/\/preview\.test\/__handoff\/enter\?t=/);
  const enterPath = new URL(t.json.url).pathname + new URL(t.json.url).search;
  const e = await raw(enterPath);
  assert.equal(e.status, 303);
  assert.equal(e.headers.location, '/');
  previewCookie = e.headers['set-cookie'][0].split(';')[0];
  assert.match(e.headers['set-cookie'][0], /HttpOnly/);
  assert.equal((await raw(enterPath)).status, 403, 'a link works once');

  const r = await raw('/page?x=1', { headers: { cookie: `${previewCookie}; theirs=2`, origin: 'https://preview.test' } });
  assert.equal(r.status, 200);
  assert.match(r.body, /path=\/page\?x=1/);
  assert.equal(r.headers['content-security-policy'], undefined, "Handoff's own headers aren't added");
  assert.doesNotMatch(r.headers['set-cookie'][0], /Domain/i);
  const got = seen.at(-1).headers;
  assert.equal(got.host, `localhost:${appPort}`);
  assert.equal(got.origin, `http://localhost:${appPort}`);
  assert.equal(got.cookie, 'theirs=2', 'the preview cookie is not passed on');

  const g = await raw('/go', { headers: { cookie: previewCookie } });
  assert.equal(g.status, 302);
  assert.equal(g.headers.location, '/there');
});

test('WebSockets (live reload) pass through', async () => {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise(r => sock.on('connect', r));
  sock.write(`GET /ws HTTP/1.1\r\nHost: preview.test\r\nCookie: ${previewCookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  let buf = '';
  await new Promise(r => sock.on('data', d => { buf += d; if (buf.includes('\r\n\r\n')) r(); }));
  assert.match(buf, /^HTTP\/1\.1 101/);
  sock.write('hi');
  await new Promise(r => sock.on('data', d => { buf += d; if (buf.includes('echo:hi')) r(); }));
  sock.destroy();
});

test('a stopped dev server gets a page that retries; the finder lists running apps', async () => {
  const t = await web('POST', '/api/preview', { port: 1029 });
  const e = await raw(new URL(t.json.url).pathname + new URL(t.json.url).search);
  const c = e.headers['set-cookie'][0].split(';')[0];
  const r = await raw('/', { headers: { cookie: c } });
  assert.equal(r.status, 502);
  assert.match(r.body, /Nothing is answering on port 1029/);
  assert.match(r.body, /http-equiv="refresh"/);

  const list = await web('GET', '/api/preview');
  assert.equal(list.status, 200);
  const mine = list.json.ports.find(p => p.port === appPort);
  if (mine) { assert.equal(mine.web, true); assert.equal(mine.title, 'My app'); } // netstat/lsof may be missing on a CI runner
  assert.ok(!list.json.ports.some(p => p.port === port), "Handoff's own port is never offered");
});

test('signing out everywhere closes previews too', async () => {
  assert.equal((await raw('/', { headers: { cookie: previewCookie } })).status, 200);
  await web('POST', '/api/logout-all', {});
  assert.equal((await raw('/', { headers: { cookie: previewCookie } })).status, 401);
});

test('ports mentioned in a chat are found, newest first', () => {
  assert.deepEqual(mentionedPorts('Server at http://localhost:5173/ and 127.0.0.1:3000, then localhost:5173 again; not localhost:80'), [5173, 3000]);
});
