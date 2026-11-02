import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from '../src/config.js';

const script = fileURLToPath(new URL('../scripts/whatsapp-setup.js', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-wa-setup-'));

// Runs the setup script against its own .env, with `input` as what the user types.
function run(envFile, args, input = '') {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HANDOFF_')));
  Object.assign(env, { HANDOFF_ENV_FILE: envFile, HANDOFF_DATA_DIR: path.join(tmp, 'data') });
  const r = spawnSync(process.execPath, [script, ...args], { env, input, encoding: 'utf8' });
  return { ...r, saved: fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {} };
}

test('setup:whatsapp asks for the number when --to is missing, and asks again if it is wrong', () => {
  const file = path.join(tmp, 'ask.env');
  const r = run(file, [], 'abc\n+1 (555) 123-4567\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RECEIVE the notifications/);
  assert.match(r.stdout, /doesn't look like a full number/);
  assert.equal(r.saved.HANDOFF_WHATSAPP_ENABLED, 'true');
  assert.equal(r.saved.HANDOFF_WHATSAPP_TO, '15551234567');
  assert.ok(r.saved.HANDOFF_WHATSAPP_TOKEN.length >= 24);
});

test('setup:whatsapp: Enter keeps the current number and the token', () => {
  const file = path.join(tmp, 'keep.env');
  fs.writeFileSync(file, 'HANDOFF_WHATSAPP_TO=15551234567\nHANDOFF_WHATSAPP_TOKEN=existing-token-that-is-long-enough\n');
  const r = run(file, [], '\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Enter keeps \+15551234567/);
  assert.equal(r.saved.HANDOFF_WHATSAPP_TO, '15551234567');
  assert.equal(r.saved.HANDOFF_WHATSAPP_TOKEN, 'existing-token-that-is-long-enough');
});

test('setup:whatsapp: --to skips the question; a bad --to or no answer is an error', () => {
  const ok = run(path.join(tmp, 'flag.env'), ['--to', '+44 7700 900123']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stdout, /RECEIVE the notifications/);
  assert.equal(ok.saved.HANDOFF_WHATSAPP_TO, '447700900123');

  const bad = run(path.join(tmp, 'bad.env'), ['--to', '123']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage:/);
  assert.deepEqual(bad.saved, {});

  const none = run(path.join(tmp, 'none.env'), [], '');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /usage:/);
  assert.deepEqual(none.saved, {});
});
