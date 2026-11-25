// npm run setup, typed into like a person would (one line at a time).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from '../src/config.js';
import { verifyPassword } from '../src/auth.js';

const script = fileURLToPath(new URL('../src/setup.js', import.meta.url));
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-setup-')));

function run(envFile, lines, args = []) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HANDOFF_')));
  Object.assign(env, { HANDOFF_ENV_FILE: envFile, HANDOFF_DATA_DIR: path.join(tmp, 'data') });
  return new Promise(resolve => {
    const p = spawn(process.execPath, [script, ...args], { env });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('exit', code => resolve({ code, out, saved: parseEnv(fs.readFileSync(envFile, 'utf8')) }));
    lines.forEach((l, i) => setTimeout(() => p.stdin.write(l + '\n'), 300 * (i + 1)));
    setTimeout(() => p.stdin.end(), 300 * (lines.length + 2));
  });
}

test('a forgotten password can be reset while keeping the 2FA already set up', async () => {
  const file = path.join(tmp, 'keep.env');
  fs.writeFileSync(file, 'HANDOFF_PASSWORD_HASH=scrypt:old\nHANDOFF_TOTP_SECRET=JBSWY3DPEHPK3PXP\n');
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'data', 'sessions.json'), '{"x":{}}');
  // Enter, Enter: keep the parts as they are (the web app, no WhatsApp)
  const r = await run(file, ['', '', 'a brand new password', 'a brand new password', '']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2FA unchanged/);
  assert.equal(r.saved.HANDOFF_WEB, 'true');
  assert.ok(verifyPassword('a brand new password', r.saved.HANDOFF_PASSWORD_HASH));
  assert.equal(r.saved.HANDOFF_TOTP_SECRET, 'JBSWY3DPEHPK3PXP');
  assert.ok(!fs.existsSync(path.join(tmp, 'data', 'sessions.json')), 'every device is signed out');
  assert.match(r.out, /autostart\.ps1 restart/);
});

test('2FA can be turned off on purpose; a first setup is not asked about keeping it', async () => {
  const file = path.join(tmp, 'off.env');
  fs.writeFileSync(file, 'HANDOFF_TOTP_SECRET=JBSWY3DPEHPK3PXP\n');
  const r = await run(file, ['', '', 'another long password', 'another long password', 'n', 'n']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.saved.HANDOFF_TOTP_SECRET, '');
  const first = path.join(tmp, 'first.env');
  fs.writeFileSync(first, '');
  const f = await run(first, ['y', 'n', 'a third long password', 'a third long password', 'n']);
  assert.doesNotMatch(f.out, /Keep the 2FA/);
  assert.ok(verifyPassword('a third long password', f.saved.HANDOFF_PASSWORD_HASH));
});

test('WhatsApp alerts only: no password is asked, the web app is turned off, the number is saved', async () => {
  const file = path.join(tmp, 'wa.env');
  fs.writeFileSync(file, '');
  const r = await run(file, ['n', 'y', '+1 555 123 4567']);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /password/i);
  assert.equal(r.saved.HANDOFF_WEB, 'false');
  assert.equal(r.saved.HANDOFF_WHATSAPP_ENABLED, 'true');
  assert.equal(r.saved.HANDOFF_WHATSAPP_TO, '15551234567');
  assert.ok(r.saved.HANDOFF_WHATSAPP_TOKEN.length >= 24);
  assert.match(r.out, /Handoff will run: WhatsApp alerts\./);
  assert.match(r.out, /docker compose up -d --build/);
});

test('choosing neither part asks again; turning WhatsApp off keeps its number and token for later', async () => {
  const file = path.join(tmp, 'switch.env');
  fs.writeFileSync(file, 'HANDOFF_WHATSAPP_ENABLED=true\nHANDOFF_WHATSAPP_TO=15551234567\nHANDOFF_WHATSAPP_TOKEN=existing-token-that-is-long-enough\n');
  const r = await run(file, ['n', 'n', 'y', 'n', 'a fourth long password', 'a fourth long password', 'n']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Pick at least one/);
  assert.equal(r.saved.HANDOFF_WEB, 'true');
  assert.equal(r.saved.HANDOFF_WHATSAPP_ENABLED, 'false');
  assert.equal(r.saved.HANDOFF_WHATSAPP_TO, '15551234567');
  assert.equal(r.saved.HANDOFF_WHATSAPP_TOKEN, 'existing-token-that-is-long-enough');
  assert.match(r.out, /Handoff will run: web app\./);
});

test('--services skips the questions; WhatsApp already set up is kept as it is', async () => {
  const file = path.join(tmp, 'flag.env');
  fs.writeFileSync(file, 'HANDOFF_WHATSAPP_TO=15551234567\nHANDOFF_WHATSAPP_TOKEN=existing-token-that-is-long-enough\n');
  const r = await run(file, ['a fifth long password', 'a fifth long password', 'n'], ['--services', 'web,whatsapp']);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /Use the web app\?/);
  assert.match(r.out, /stay set up for \+15551234567/);
  assert.equal(r.saved.HANDOFF_WEB, 'true');
  assert.equal(r.saved.HANDOFF_WHATSAPP_ENABLED, 'true');
  assert.ok(verifyPassword('a fifth long password', r.saved.HANDOFF_PASSWORD_HASH));

  fs.writeFileSync(path.join(tmp, 'bad.env'), '');
  const bad = await run(path.join(tmp, 'bad.env'), [], ['--services', 'web,fax']);
  assert.equal(bad.code, 1);
  assert.deepEqual(bad.saved, {});
});

test('stopping halfway (input ends) changes nothing', async () => {
  const file = path.join(tmp, 'stop.env');
  fs.writeFileSync(file, 'HANDOFF_PASSWORD_HASH=scrypt:old\n');
  const r = await run(file, ['y', 'n']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /nothing was changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'HANDOFF_PASSWORD_HASH=scrypt:old\n');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
