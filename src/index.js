// npm start: runs the parts of Handoff turned on in .env, in any combination (see services.js):
//   the web app (HANDOFF_WEB, on by default) and WhatsApp alerts (HANDOFF_WHATSAPP_ENABLED).
// The HTTP server and the tunnel start only if a part needs them; with WhatsApp alerts alone,
// nothing listens on a port.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveClaudePath } from './config.js';
import { createServer } from './server.js';
import { createCore } from './core.js';
import { startTunnel, startNamedTunnel } from './tunnel.js';
import { logToFile } from './logfile.js';
import { checkServices, needsHttp, describeServices } from './services.js';
import { maskNumber } from './notify.js';

// overrides: { web } turns a part on or off for this run, whatever .env says
// logName: the file in data/ that --log-file writes to
export async function start({ web, logName = 'server.log' } = {}) {
  if (process.argv.includes('--log-file')) logToFile(logName);

  const cfg = loadConfig();
  if (web !== undefined) cfg.web = web;
  const { errors, warnings } = checkServices(cfg);
  if (errors.length) { for (const e of errors) console.error(e); process.exit(1); }
  for (const w of warnings) console.warn(`WARNING: ${w}`);

  const claudePath = resolveClaudePath(cfg);
  console.log(`Handoff: ${describeServices(cfg)}`);
  const stops = [];
  const shutdown = () => {
    console.log('shutting down');
    for (const s of stops) s();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (!needsHttp(cfg)) {
    // WhatsApp alerts on their own: watch the sessions on this computer; nothing listens
    const core = createCore(cfg, { claudePath });
    stops.push(() => core.stop());
    console.log(`Watching Claude Code sessions in ${cfg.claudeHome}`);
    if (cfg.tunnel !== 'none') console.log(`(HANDOFF_TUNNEL=${cfg.tunnel} is ignored: nothing here is reached from outside)`);
    await reportWhatsApp(core, cfg);
    setInterval(() => {}, 1 << 30); // the alerts' timers are unref'd; keep the process alive
    return;
  }

  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && cfg.host !== '::1') {
    console.warn(`WARNING: binding to ${cfg.host} exposes the server beyond this machine. Use a tunnel instead.`);
  }
  // --local: ignore HANDOFF_TUNNEL and stay on this machine (handy for a quick test)
  const tunnelKind = process.argv.includes('--local') ? 'none' : cfg.tunnel;
  if (!['none', 'quick', 'ngrok', 'cloudflare'].includes(tunnelKind)) {
    console.error(`HANDOFF_TUNNEL must be none, quick, ngrok or cloudflare (got "${tunnelKind}")`);
    process.exit(1);
  }
  if (tunnelKind === 'cloudflare' && !(cfg.tunnelToken && cfg.publicHostname)) {
    console.error('HANDOFF_TUNNEL=cloudflare needs HANDOFF_CLOUDFLARE_TUNNEL_TOKEN and HANDOFF_PUBLIC_HOSTNAME. Run:  npm run setup:domain');
    process.exit(1);
  }

  const { server, healthId, core } = createServer(cfg, { claudePath });
  let tunnel = null;
  stops.push(() => { tunnel?.stop(); server.close(); });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`Listening on http://${cfg.host}:${cfg.port}`);
    console.log(`claude CLI: ${claudePath}${cfg.web ? `   2FA: ${cfg.totpEnabled ? 'on' : 'OFF (run npm run setup to enable)'}` : ''}`);
    if (cfg.notify.enabled) reportWhatsApp(core, cfg);
    if (tunnelKind === 'none') return;
    if (cfg.web && !cfg.totpEnabled) console.warn('WARNING: exposing to the internet without 2FA. Strongly consider enabling it (npm run setup).');
    tunnel = tunnelKind === 'cloudflare'
      ? startNamedTunnel({ token: cfg.tunnelToken, hostname: cfg.publicHostname, port: cfg.port, healthId, log: console.log, protocol: cfg.tunnelProtocol })
      : startTunnel(tunnelKind === 'quick' ? 'cloudflared' : 'ngrok', cfg.port, console.log, { protocol: cfg.tunnelProtocol });
  });
}

// one line on whether WhatsApp alerts can be delivered right now
async function reportWhatsApp(core, cfg) {
  if (!core.notifier.on) return;
  const s = await core.notifier.status();
  console.log(s.connected
    ? `WhatsApp sender linked as ${s.me || '?'}; alerts go to ${maskNumber(cfg.notify.to)}`
    : `WhatsApp sender not reachable/linked at ${cfg.notify.url} (${s.error || 'open ' + cfg.notify.url + '/qr'}); will keep trying`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
