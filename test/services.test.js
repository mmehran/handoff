// Turning the parts of Handoff on and off: what each combination needs, what starts, and what a
// server without the web app answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-services-')));
process.env.HANDOFF_DATA_DIR = path.join(tmp, 'data');
process.env.HANDOFF_ENV_FILE = path.join(tmp, 'no-such.env'); // never read a developer's real .env

const { loadConfig } = await import('../src/config.js');
const { checkServices, needsHttp, describeServices, enabledServices } = await import('../src/services.js');
const { createServer } = await import('../src/server.js');

const base = () => {
  const cfg = loadConfig();
  cfg.claudeHome = path.join(tmp, 'claude');
  return cfg;
};
const whatsapp = (cfg, on = true, complete = true) => {
  cfg.notify.enabled = on;
  cfg.notify.token = complete ? 'x'.repeat(30) : '';
  cfg.notify.to = complete ? '15551234567' : '';
  return cfg;
};

test('the web app is on by default; WhatsApp alerts only when turned on', () => {
  const cfg = base();
  assert.equal(cfg.web, true);
  assert.deepEqual(enabledServices(cfg).map(s => s.id), ['web']);
  assert.deepEqual(enabledServices(whatsapp(base())).map(s => s.id), ['web', 'whatsapp']);
});

test('every combination: what it needs, and whether anything listens on a port', () => {
  const cases = [
    // [web, whatsapp, password, whatsapp complete] -> errors, http, description
    { web: true, wa: false, pw: true, ok: true, http: true, text: 'web app' },
    { web: true, wa: false, pw: false, ok: false, error: /needs a password/ },
    { web: false, wa: true, pw: false, ok: true, http: false, text: 'WhatsApp alerts' },
    { web: false, wa: true, pw: false, complete: false, ok: false, error: /not set up/ },
    { web: true, wa: true, pw: true, ok: true, http: true, text: 'web app, WhatsApp alerts' },
    { web: false, wa: false, pw: true, ok: false, error: /Nothing to run/ }
  ];
  for (const c of cases) {
    const cfg = whatsapp(base(), c.wa, c.complete !== false);
    cfg.web = c.web;
    cfg.passwordHash = c.pw ? 'scrypt:1:1:1:x:y' : '';
    const { errors } = checkServices(cfg);
    const label = JSON.stringify(c);
    if (c.ok) {
      assert.deepEqual(errors, [], label);
      assert.equal(needsHttp(cfg), c.http, label);
      assert.equal(describeServices(cfg), c.text, label);
    } else {
      assert.match(errors.join('\n'), c.error, label);
    }
  }
});

test('half-set-up WhatsApp next to the web app is a warning, not a reason not to start', () => {
  const cfg = whatsapp(base(), true, false);
  cfg.passwordHash = 'scrypt:1:1:1:x:y';
  const { errors, warnings } = checkServices(cfg);
  assert.deepEqual(errors, []);
  assert.match(warnings.join('\n'), /not set up/);
});

test('without the web app, the server answers only the tunnel health check', async t => {
  const cfg = whatsapp(base());
  cfg.web = false;
  const { server, sessions, core } = createServer(cfg, { claudePath: 'claude', log: () => {} });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal(sessions, null, 'no sign-in without the web app');
  assert.equal(core.push, null, 'phone notifications come with the web app');
  assert.equal((await fetch(url + '/api/health')).status, 200);
  for (const p of ['/', '/index.html', '/api/me', '/api/projects', '/api/login']) {
    const r = await fetch(url + p, p === '/api/login' ? { method: 'POST' } : {});
    assert.equal(r.status, 404, p);
  }
});

test('without the web app, WhatsApp messages carry no links to it', () => {
  const cfg = whatsapp(base());
  cfg.web = false;
  cfg.publicHostname = 'claude.example.com';
  const { server, core } = createServer(cfg, { claudePath: 'claude', log: () => {} });
  try {
    assert.equal(core.notifier.cfg.publicHostname, '');
    assert.equal(cfg.publicHostname, 'claude.example.com', 'the settings themselves are left as they are');
  } finally { server.close(); }
});

// npm start, with what it prints and its exit code
function startHandoff(env) {
  return new Promise(resolve => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HANDOFF_')));
    const p = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
      env: { ...clean, HANDOFF_ENV_FILE: path.join(tmp, 'none.env'), HANDOFF_DATA_DIR: path.join(tmp, 'data'), HANDOFF_CLAUDE_HOME: path.join(tmp, 'claude'), ...env }
    });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => p.kill(), 10e3);
    p.on('exit', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

test('npm start with nothing turned on says how to choose, and stops', async () => {
  const r = await startHandoff({ HANDOFF_WEB: 'false' });
  assert.equal(r.code, 1);
  assert.match(r.out, /Nothing to run[\s\S]*npm run setup/);
});

test('npm start with the web app but no password says how to set one, or how to turn the web app off', async () => {
  const r = await startHandoff({});
  assert.equal(r.code, 1);
  assert.match(r.out, /needs a password[\s\S]*npm run setup[\s\S]*HANDOFF_WEB=false/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));
