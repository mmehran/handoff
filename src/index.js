import { loadConfig, resolveClaudePath } from './config.js';
import { createServer } from './server.js';
import { startTunnel, startNamedTunnel } from './tunnel.js';
import { logToFile } from './logfile.js';

if (process.argv.includes('--log-file')) logToFile('server.log');

const cfg = loadConfig();
if (!cfg.passwordHash) {
  console.error('No password configured (HANDOFF_PASSWORD_HASH). Run:  npm run setup');
  process.exit(1);
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

const claudePath = resolveClaudePath(cfg);
const { server, healthId } = createServer(cfg, { claudePath });
let tunnel = null;

server.listen(cfg.port, cfg.host, () => {
  console.log(`Handoff listening on http://${cfg.host}:${cfg.port}`);
  console.log(`claude CLI: ${claudePath}   2FA: ${cfg.totpEnabled ? 'on' : 'OFF (run npm run setup to enable)'}`);
  if (tunnelKind === 'none') return;
  if (!cfg.totpEnabled) console.warn('WARNING: exposing to the internet without 2FA. Strongly consider enabling it (npm run setup).');
  tunnel = tunnelKind === 'cloudflare'
    ? startNamedTunnel({ token: cfg.tunnelToken, hostname: cfg.publicHostname, port: cfg.port, healthId, log: console.log })
    : startTunnel(tunnelKind === 'quick' ? 'cloudflared' : 'ngrok', cfg.port, console.log);
});

const shutdown = () => {
  console.log('shutting down');
  tunnel?.stop();
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
