// Watchdog of the named tunnel, with a fake cloudflared, a fake fetch and a mocked clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-tunnel-'));
process.env.HANDOFF_DATA_DIR = tmp; // public-url.txt goes here
process.env.HANDOFF_ENV_FILE = path.join(tmp, 'no-such.env'); // never read a developer's real .env
const { startNamedTunnel } = await import('../src/tunnel.js');

const flush = () => new Promise(r => setImmediate(r));

function start(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const procs = [], logs = [];
  const net = { publicId: 'us' }; // what https://<hostname>/api/health answers; null = unreachable
  const spawnFn = (bin, args) => {
    const p = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, args });
    p.kill = () => { p.killed = true; setImmediate(() => p.emit('exit', null)); };
    p.connect = () => p.stderr.emit('data', 'INF Registered tunnel connection connIndex=0 location=tst01\n');
    procs.push(p);
    return p;
  };
  const fetchFn = async url => {
    if (url.endsWith('/ready')) return { ok: true };
    if (!net.publicId) throw new TypeError('fetch failed');
    return { json: async () => ({ id: net.publicId }) };
  };
  const tunnel = startNamedTunnel({ token: 't', hostname: 'h.example.com', port: 1, healthId: 'us', log: l => logs.push(l), bin: 'cloudflared', spawnFn, fetchFn, protocol: t.protocol || 'auto' });
  t.after(() => tunnel.stop());
  return {
    procs, logs, net,
    // timers run every 5s, as on a responsive machine
    async run(ms) { for (let i = 0; i < ms; i += 5e3) { t.mock.timers.tick(5e3); await flush(); } await flush(); },
    // no timer runs for `ms` (asleep, or too busy), then they all catch up at once
    async pause(ms) { t.mock.timers.setTime(Date.now() + ms); t.mock.timers.tick(0); await flush(); await flush(); }
  };
}

test('stalls do not restart a cloudflared that is still connecting', async t => {
  const w = start(t);
  await w.run(5e3);
  for (let i = 0; i < 3; i++) await w.pause(25e3); // each of these used to restart it
  assert.equal(w.procs.length, 1);
  assert.match(w.logs.join('\n'), /watchdog was paused for 25s/);
  w.procs[0].connect();
  await w.pause(25e3); // connected, and the public URL still reaches us: keep it
  assert.equal(w.procs.length, 1);
  assert.ok(!w.procs[0].killed);
});

test('a cloudflared that never connects is restarted after its grace period', async t => {
  const w = start(t);
  await w.run(95e3);
  assert.equal(w.procs.length, 2);
  assert.ok(w.procs[0].killed);
  assert.match(w.logs.join('\n'), /not connected after 90s; restarting/);
});

test('after a sleep, a tunnel that no longer reaches us is restarted at once', async t => {
  const w = start(t);
  w.procs[0].connect();
  await w.run(10e3);
  w.net.publicId = null; // its connections died while the laptop slept
  await w.pause(10 * 60e3);
  assert.equal(w.procs.length, 2);
  assert.ok(w.procs[0].killed);
  assert.match(w.logs.join('\n'), /public check failed \(1\/1\)[^]*unreachable; restarting cloudflared/);
});

test('QUIC failing on this network: switch cloudflared to HTTP/2', async t => {
  const w = start(t);
  assert.deepEqual(w.procs[0].args.slice(-3), ['--protocol', 'auto', 'run']);
  w.procs[0].connect();
  const quicErr = 'ERR Serve tunnel error error="accept stream listener error: failed to accept QUIC stream: timeout: no recent network activity"\n';
  w.procs[0].stderr.emit('data', quicErr);
  w.procs[0].stderr.emit('data', quicErr);
  await w.run(5e3);
  assert.equal(w.procs.length, 1, 'two errors are not enough');
  w.procs[0].stderr.emit('data', quicErr);
  await w.run(5e3);
  assert.equal(w.procs.length, 2);
  assert.ok(w.procs[0].killed);
  assert.deepEqual(w.procs[1].args.slice(-3), ['--protocol', 'http2', 'run']);
  assert.match(w.logs.join('\n'), /switching cloudflared from QUIC to HTTP\/2 for the next 6 hours/);
});

test('a cloudflared that never connects gets HTTP/2 on its next try', async t => {
  const w = start(t);
  await w.run(95e3);
  assert.equal(w.procs.length, 2);
  assert.deepEqual(w.procs[1].args.slice(-3), ['--protocol', 'http2', 'run']);
});

test('HANDOFF_TUNNEL_PROTOCOL=quic is kept as chosen', async t => {
  t.protocol = 'quic';
  const w = start(t);
  await w.run(95e3);
  assert.deepEqual(w.procs.map(p => p.args.at(-2)), ['quic', 'quic']);
  assert.doesNotMatch(w.logs.join('\n'), /HTTP\/2/);
});
