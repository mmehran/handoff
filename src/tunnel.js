// Starts a public HTTPS tunnel to the loopback server. Prefers cloudflared (no account needed),
// falls back to ngrok (needs `ngrok config add-authtoken ...` once).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Also check the usual install folders: a terminal opened before `winget install` has a stale PATH.
const KNOWN = process.platform === 'win32' ? [
  path.join(process.env['ProgramFiles(x86)'] || '', 'cloudflared', 'cloudflared.exe'),
  path.join(process.env.ProgramFiles || '', 'cloudflared', 'cloudflared.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ngrok.exe')
] : [];

function which(bin) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const hit = out.split(/\r?\n/).find(Boolean);
    if (hit) return hit;
  } catch { /* not on PATH */ }
  return KNOWN.find(p => path.basename(p, '.exe') === bin && fs.existsSync(p)) || null;
}

// Permanent Cloudflare Tunnel on your own hostname (set up by scripts/cloudflare-setup.js), with a watchdog.
// cloudflared reconnects by itself, and only opens its /ready endpoint once its connections are up —
// which can take minutes on a slow network right after waking — so the watchdog must not kill it early:
//  - a new cloudflared gets 90s to register its first connection (seen in its log); if it doesn't,
//    restart it and allow longer next time (up to 5 min)
//  - once connected: restart only if /ready has failed continuously for 30s
//  - cloudflared exited -> start again (5s, backing off to 60s if it keeps crashing)
//  - a 5s tick arriving >20s late means the laptop slept, or the machine was too busy to run timers:
//    a connected tunnel gets a public check at once and is restarted if that misses; a cloudflared still
//    connecting is left to its grace period (restarting it on every stall of a busy machine means it never connects)
//  - every 60s fetch https://<hostname>/api/health and check it reaches *this* server; 3 misses -> restart
//  - protocol 'auto': cloudflared uses QUIC (UDP). Some networks and VPNs break it: connections time out
//    ("no recent network activity") or never come up. Then use HTTP/2 (TCP) for 6 hours, and try QUIC again.
// bin, spawnFn and fetchFn are there for tests.
export function startNamedTunnel({ token, hostname, port, healthId, log, protocol = 'auto', bin = which('cloudflared'), spawnFn = spawn, fetchFn = fetch }) {
  if (!bin) { log('[tunnel] cloudflared not found. Install it: winget install --id Cloudflare.cloudflared'); return null; }
  const metrics = '127.0.0.1:20241';
  const urlFile = path.join(DATA_DIR, 'public-url.txt');
  try { fs.writeFileSync(urlFile, `https://${hostname}\n`); } catch { /* ignore */ }
  log(`\n  Public URL (cloudflare tunnel): https://${hostname}\n`);

  const GRACE = 90e3, MAX_GRACE = 300e3, DOWN_LIMIT = 30e3;
  let proc = null, startedAt = 0, nextStart = 0, backoff = 5e3, grace = GRACE;
  let connected = false, downSince = 0, publicFails = 0, lastTick = Date.now(), stopped = false;
  const QUIC_ERRORS = 3, QUIC_WINDOW = 10 * 60e3, HTTP2_FOR = 6 * 3600e3;
  let http2Until = protocol === 'http2' ? Infinity : 0, quicErrors = [];
  const onHttp2 = () => Date.now() < http2Until;
  const useHttp2 = (why) => {
    if (protocol !== 'auto' || onHttp2()) return false;
    http2Until = Date.now() + HTTP2_FOR; quicErrors = [];
    log(`[tunnel] ${why}; switching cloudflared from QUIC to HTTP/2 for the next ${HTTP2_FOR / 3600e3} hours`);
    return true;
  };

  const launch = (why) => {
    const proto = onHttp2() ? 'http2' : protocol === 'quic' ? 'quic' : 'auto';
    log(`[tunnel] starting cloudflared (${why}${proto === 'http2' ? ', HTTP/2' : ''}); allowing ${grace / 1000}s to connect`);
    startedAt = Date.now(); connected = false; downSince = 0;
    proc = spawnFn(bin, ['tunnel', '--no-autoupdate', '--metrics', metrics, '--protocol', proto, 'run'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TUNNEL_TOKEN: token }
    });
    const p = proc;
    const scan = d => {
      if (p !== proc) return;
      for (const line of String(d).split('\n')) {
        if (/Registered tunnel connection/.test(line) && !connected) {
          connected = true; grace = GRACE;
          const loc = /location=(\S+)/.exec(line)?.[1] || '?';
          log(`[tunnel] connected to Cloudflare (${loc}) after ${Math.round((Date.now() - startedAt) / 1000)}s`);
        } else if (/\bERR\b/.test(line)) {
          log(`[tunnel] ${line.trim().slice(0, 300)}`);
          if (/quic|no recent network activity/i.test(line) && !onHttp2()) {
            const now = Date.now();
            quicErrors = quicErrors.filter(t => now - t < QUIC_WINDOW).concat(now);
            if (quicErrors.length >= QUIC_ERRORS && useHttp2(`QUIC failed ${quicErrors.length} times in ${QUIC_WINDOW / 60e3} minutes`)) {
              setImmediate(() => { if (p === proc) restart('QUIC keeps failing'); });
            }
          }
        }
      }
    };
    p.stdout.on('data', scan);
    p.stderr.on('data', scan);
    p.on('error', e => log(`[tunnel] cloudflared failed to start: ${e.message}`));
    p.on('exit', code => {
      if (p !== proc) return;
      proc = null;
      if (stopped) return;
      // crashed quickly again? back off a little (5s -> 60s); a long healthy run resets it
      backoff = Date.now() - startedAt > 120e3 ? 5e3 : Math.min(backoff * 2, 60e3);
      nextStart = Date.now() + backoff;
      log(`[tunnel] cloudflared exited (${code}); restarting in ${backoff / 1000}s`);
    });
  };
  const restart = (why) => {
    log(`[tunnel] ${why}; restarting cloudflared`);
    const old = proc; proc = null;
    old?.kill();
    nextStart = 0;
    launch(why);
  };

  const tick = async () => {
    if (stopped) return;
    const now = Date.now();
    const late = now - lastTick > 20e3;
    if (late) log(`[tunnel] watchdog was paused for ${Math.round((now - lastTick) / 1000)}s (laptop asleep, or machine too busy)`);
    lastTick = now;
    if (!proc) { if (now >= nextStart) launch('watchdog'); return; }
    if (!connected) {
      // A late tick alone doesn't restart a cloudflared that is still connecting: only its grace period
      // counts, and a long sleep runs past that anyway.
      if (now - startedAt > grace) {
        const waited = grace;
        grace = Math.min(grace * 2, MAX_GRACE); // network is slow: be more patient next time
        useHttp2('QUIC did not connect'); // in case it's the protocol and not the network
        restart(`not connected after ${waited / 1000}s`);
      }
      return;
    }
    if (late) return publicCheck(1); // keep it if https://<hostname> still reaches us, else restart at once
    let ok = false;
    try { ok = (await fetchFn(`http://${metrics}/ready`, { signal: AbortSignal.timeout(3000) })).ok; } catch { /* down */ }
    if (ok) { if (downSince) log('[tunnel] connection back'); downSince = 0; return; }
    if (!downSince) { downSince = now; log('[tunnel] lost connection to Cloudflare; waiting for cloudflared to reconnect'); }
    else if (now - downSince > DOWN_LIMIT) restart(`no connection to Cloudflare for ${DOWN_LIMIT / 1000}s`);
  };
  const publicCheck = async (limit = 3) => {
    const p = proc;
    if (stopped || !p || !connected) return;
    try {
      const r = await fetchFn(`https://${hostname}/api/health`, { signal: AbortSignal.timeout(10000), headers: { 'Cache-Control': 'no-cache' } });
      const j = await r.json();
      if (j.id !== healthId) throw new Error('reached a different server');
      if (publicFails) log('[tunnel] public check OK again');
      publicFails = 0;
    } catch (e) {
      if (stopped || p !== proc) return; // stopped or restarted meanwhile
      publicFails++;
      log(`[tunnel] public check failed (${publicFails}/${limit}): ${e.message}`);
      if (publicFails >= limit) { publicFails = 0; restart('https://' + hostname + ' unreachable'); }
    }
  };

  launch('startup');
  const t1 = setInterval(tick, 5e3);
  const t2 = setInterval(publicCheck, 60e3);
  return { stop() { stopped = true; clearInterval(t1); clearInterval(t2); proc?.kill(); } };
}

// Quick (random-URL) tunnel. Returns { stop() }. If the tunnel process dies (network drop, sleep), it is restarted with backoff;
// a quick tunnel then gets a new URL, which is written to data/public-url.txt again.
export function startTunnel(kind, port, log, { protocol = 'auto' } = {}) {
  const target = `http://127.0.0.1:${port}`;
  const order = kind === 'auto' ? ['cloudflared', 'ngrok'] : [kind];
  for (const k of order) {
    const bin = which(k);
    if (!bin) continue;
    const args = k === 'cloudflared'
      ? ['tunnel', '--url', target, '--no-autoupdate', ...(protocol !== 'auto' ? ['--protocol', protocol] : [])]
      : ['http', target, '--log', 'stdout', '--log-format', 'json'];
    let proc = null, stopped = false, delay = 30e3, timer = null;
    const launch = () => {
      const startedAt = Date.now();
      if (k === 'cloudflared') fs.rmSync(path.join(DATA_DIR, 'public-url.txt'), { force: true }); // old quick-tunnel URL is dead
      proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let announced = false, gone = 0;
      const scan = d => {
        const s = String(d);
        for (const line of s.split('\n')) if (/\bERR\b|failed|"lvl":"(eror|crit)"/i.test(line)) log(`[tunnel] ${line.trim().slice(0, 300)}`);
        // Cloudflare expired this quick tunnel (e.g. after sleep); cloudflared would retry it forever,
        // so kill it and let the exit handler start a fresh tunnel with a new URL.
        if (/Tunnel not found/i.test(s) && ++gone >= 2) {
          log('[tunnel] Cloudflare dropped this tunnel; getting a new one');
          fs.rmSync(path.join(DATA_DIR, 'public-url.txt'), { force: true });
          proc.kill();
        }
        // api.trycloudflare.com is cloudflared's control endpoint (shows up in errors), not a tunnel URL
        const m = s.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/) || s.match(/"url":"(https:\/\/[^"]+)"/);
        if (m && !announced) {
          announced = true;
          const url = m[1] || m[0];
          log(`\n  Public URL (${k}): ${url}\n  Open it on your phone and sign in.\n`);
          try { fs.writeFileSync(path.join(DATA_DIR, 'public-url.txt'), url + '\n'); } catch { /* ignore */ }
        }
      };
      proc.stdout.on('data', scan);
      proc.stderr.on('data', scan);
      proc.on('error', e => log(`[tunnel] ${k} failed to start: ${e.message}`));
      proc.on('exit', code => {
        log(`[tunnel] ${k} exited (${code})`);
        if (stopped) return;
        if (Date.now() - startedAt > 5 * 60e3) delay = 30e3; // it ran fine for a while: reset backoff
        log(`[tunnel] restarting in ${delay / 1000}s`);
        timer = setTimeout(launch, delay);
        delay = Math.min(delay * 2, 10 * 60e3);
      });
      log(`[tunnel] starting ${k} -> ${target}`);
    };
    launch();
    return { stop() { stopped = true; clearTimeout(timer); proc?.kill(); } };
  }
  log('[tunnel] neither cloudflared nor ngrok found on PATH. Install one:\n' +
      '  winget install --id Cloudflare.cloudflared   (recommended, no account)\n' +
      '  winget install --id Ngrok.Ngrok              (then: ngrok config add-authtoken <token>)');
  return null;
}
