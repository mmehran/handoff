// Laptop: the keep-awake setting is checked and kept, "while Claude works" follows the sessions, and
// the status answers even where the system can't report power details.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Laptop } from '../src/laptop.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-laptop-'));

test('keep awake: only known modes, kept across restarts; status works without power details', async () => {
  let working = false;
  // an unknown platform: no helper is started, so nothing on this machine is touched
  const l = new Laptop({ dataDir: dir, platform: 'other', isWorking: async () => working, interval: 1e9 });
  assert.equal(l.keepAwake().mode, 'off');
  assert.equal(l.keepAwake().supported, false);
  await assert.rejects(l.setMode('sometimes'), /keep awake/);
  const r = await l.setMode('working');
  assert.equal(r.mode, 'working');
  assert.equal(r.active, false);
  l.stop();
  const again = new Laptop({ dataDir: dir, platform: 'other', interval: 1e9 });
  assert.equal(again.keepAwake().mode, 'working');
  const s = await again.status();
  assert.equal(s.battery, null);
  assert.equal(typeof s.host.uptime, 'number');
  again.stop();
});

test('"while Claude works" wants the computer awake while a session works and for a while after', async () => {
  let working = true;
  const l = new Laptop({ dataDir: fs.mkdtempSync(path.join(dir, 'w-')), platform: 'other', isWorking: async () => working, interval: 1e9 });
  const held = [];
  l.hold = () => { held.push('hold'); l.helper = { since: Date.now(), kill() {} }; };
  l.release = () => { held.push('release'); l.helper = null; };
  await l.setMode('working');
  assert.deepEqual(held, ['hold']);
  working = false;
  await l.check();
  assert.deepEqual(held, ['hold'], 'still awake: Claude stopped only just now');
  l.lastWork = Date.now() - 11 * 60e3;
  await l.check();
  assert.deepEqual(held, ['hold', 'release']);
  await l.setMode('always');
  assert.deepEqual(held, ['hold', 'release', 'hold']);
  await l.setMode('off');
  assert.deepEqual(held, ['hold', 'release', 'hold', 'release']);
  l.stop();
});
