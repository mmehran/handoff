import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv, updateEnvFile } from '../src/config.js';
import { hashPassword, verifyPassword } from '../src/auth.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-config-'));

test('parseEnv: comments, export, quotes, inline comments', () => {
  const env = parseEnv([
    '# a comment',
    'A=plain value   # trailing comment',
    "export B='lit$eral # not a comment'",
    'C="two\\nlines \\"quoted\\""',
    'D=',
    '  E = spaced  ',
    'not a line',
    'F=a#b'
  ].join('\r\n'));
  assert.deepEqual(env, { A: 'plain value', B: 'lit$eral # not a comment', C: 'two\nlines "quoted"', D: '', E: 'spaced', F: 'a#b' });
});

test('updateEnvFile keeps comments, replaces keys in place, quotes when needed, round-trips', () => {
  const file = path.join(tmp, 'a.env');
  fs.writeFileSync(file, '# header\nHANDOFF_PORT=1\n# HANDOFF_TUNNEL=quick\nOTHER=keep\n');
  const hash = hashPassword('a long test password');
  updateEnvFile({ HANDOFF_PORT: 2, HANDOFF_TUNNEL: 'cloudflare', HANDOFF_PASSWORD_HASH: hash }, file);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# header\nHANDOFF_PORT=2\nHANDOFF_TUNNEL=cloudflare\nOTHER=keep\nHANDOFF_PASSWORD_HASH='scrypt:/);
  const env = parseEnv(text);
  assert.equal(env.HANDOFF_PASSWORD_HASH, hash);
  assert.ok(verifyPassword('a long test password', env.HANDOFF_PASSWORD_HASH));
  assert.throws(() => updateEnvFile({ X: "it's" }, file), /quotes/);
});

test('updateEnvFile creates .env from .env.example the first time', () => {
  const file = path.join(tmp, 'new.env');
  updateEnvFile({ HANDOFF_TOTP_SECRET: 'ABC' }, file);
  const env = parseEnv(fs.readFileSync(file, 'utf8'));
  assert.equal(env.HANDOFF_TOTP_SECRET, 'ABC');
  assert.equal(env.HANDOFF_PORT, '7860', 'rest of the template is kept');
});

test('loadConfig reads the .env file; real environment variables win', async () => {
  const file = path.join(tmp, 'load.env');
  fs.writeFileSync(file, [
    'HANDOFF_PORT=9999', 'HANDOFF_TOTP_SECRET=\'abcd efgh\'', 'HANDOFF_TUNNEL=Quick',
    'HANDOFF_PUBLIC_HOSTNAME=https://claude.example.com/', 'HANDOFF_WHATSAPP_ENABLED=yes',
    'HANDOFF_WHATSAPP_TO=+1 (555) 123-4567', 'HANDOFF_WHATSAPP_EVENTS=done, error', 'HANDOFF_WHATSAPP_PORT=7999',
    `HANDOFF_ALLOWED_ROOTS=${[path.join(tmp, 'a'), path.join(tmp, 'b')].join(path.delimiter)}`,
    `HANDOFF_DATA_DIR=${path.join(tmp, 'data')}`, 'HANDOFF_MAX_RUNS=5'
  ].join('\n'));
  process.env.HANDOFF_ENV_FILE = file;
  process.env.HANDOFF_MAX_RUNS = '1';
  const { loadConfig, DATA_DIR } = await import('../src/config.js?load'); // fresh module instance
  const cfg = loadConfig();
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.maxConcurrentRuns, 1, 'process.env overrides the file');
  assert.equal(cfg.totpSecret, 'ABCDEFGH');
  assert.equal(cfg.totpEnabled, true);
  assert.equal(cfg.tunnel, 'quick');
  assert.equal(cfg.publicHostname, 'claude.example.com');
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.allowBypassPermissions, false);
  assert.deepEqual(cfg.allowedRoots, [path.join(tmp, 'a'), path.join(tmp, 'b')]);
  assert.equal(DATA_DIR, path.join(tmp, 'data'));
  assert.deepEqual(cfg.notify, {
    enabled: true, url: 'http://127.0.0.1:7999', token: '', to: '15551234567',
    events: { approval: false, question: false, waiting: false, done: true, error: true }
  });
  assert.equal(process.env.HANDOFF_PORT, undefined, 'the file is not copied into process.env');
});
