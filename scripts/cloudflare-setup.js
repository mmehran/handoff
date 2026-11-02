// One-time setup of a permanent Cloudflare Tunnel on your own hostname (e.g. claude.example.com).
// Safe to re-run. Creates (or reuses) a tunnel named "handoff", points the hostname at it, and
// writes HANDOFF_TUNNEL, HANDOFF_CLOUDFLARE_TUNNEL_TOKEN and HANDOFF_PUBLIC_HOSTNAME into .env.
//
// The Cloudflare API token is only used for these calls and is NEVER written to disk.
// It needs:  Account > Cloudflare Tunnel > Edit   and   Zone > DNS > Edit
//
//   npm run setup:domain                        (asks for everything)
//   npm run setup:domain -- --hostname claude.example.com --account <account id>
//   (or set CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID in the environment for this one command)
import readline from 'node:readline';
import { loadConfig, updateEnvFile } from '../src/config.js';

const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, a => r(a.trim())));
const askHidden = q => new Promise(r => {
  const write = rl._writeToOutput;
  rl._writeToOutput = s => { if (s.startsWith(q)) write.call(rl, q); else if (/\r?\n/.test(s)) write.call(rl, '\n'); };
  rl.question(q, a => { rl._writeToOutput = write; r(a.trim()); });
});

const hostname = (arg('--hostname') || await ask('Hostname to use (e.g. claude.example.com): ')).toLowerCase();
const account = arg('--account') || process.env.CLOUDFLARE_ACCOUNT_ID || await ask('Cloudflare account ID (dashboard > your domain > Overview, right side): ');
const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || await askHidden('Cloudflare API token (input hidden, not saved): ');
const tunnelName = arg('--name') || 'handoff';
rl.close();
if (!token || !/^[0-9a-f]{32}$/i.test(account) || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(hostname)) {
  console.error('Need a hostname like claude.example.com, a 32-character account ID and an API token.');
  process.exit(1);
}

async function cf(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await res.json();
  if (!j.success) throw new Error(`${method} ${path}: ${JSON.stringify(j.errors)}`);
  return j.result;
}

const cfg = loadConfig();

// 1) zone that owns the hostname (longest matching suffix)
const zones = await cf('GET', `/zones?per_page=50&account.id=${account}`);
const zone = zones.filter(z => hostname === z.name || hostname.endsWith('.' + z.name)).sort((a, b) => b.name.length - a.name.length)[0];
if (!zone) throw new Error(`no zone in this account covers ${hostname} (is the domain added to Cloudflare?)`);
console.log(`zone: ${zone.name}`);

// 2) tunnel (reuse by name)
let tunnel = (await cf('GET', `/accounts/${account}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(tunnelName)}`))[0];
if (!tunnel) {
  tunnel = await cf('POST', `/accounts/${account}/cfd_tunnel`, { name: tunnelName, config_src: 'cloudflare' });
  console.log(`created tunnel ${tunnel.name} (${tunnel.id})`);
} else console.log(`reusing tunnel ${tunnel.name} (${tunnel.id})`);

// 3) ingress: hostname -> local server; everything else 404
await cf('PUT', `/accounts/${account}/cfd_tunnel/${tunnel.id}/configurations`, {
  config: { ingress: [{ hostname, service: `http://127.0.0.1:${cfg.port}` }, { service: 'http_status:404' }] }
});
console.log(`ingress: ${hostname} -> http://127.0.0.1:${cfg.port}`);

// 4) DNS: proxied CNAME to the tunnel; never overwrite a record that points elsewhere
const target = `${tunnel.id}.cfargotunnel.com`;
const existing = await cf('GET', `/zones/${zone.id}/dns_records?name=${hostname}`);
if (!existing.length) {
  await cf('POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name: hostname, content: target, proxied: true, comment: 'Handoff tunnel' });
  console.log(`dns: created CNAME ${hostname} -> ${target}`);
} else if (existing.length === 1 && existing[0].type === 'CNAME' && existing[0].content.endsWith('.cfargotunnel.com')) {
  if (existing[0].content !== target) await cf('PATCH', `/zones/${zone.id}/dns_records/${existing[0].id}`, { content: target, proxied: true });
  console.log(`dns: CNAME ${hostname} -> ${target}`);
} else {
  throw new Error(`${hostname} already has DNS records that are not a tunnel (${existing.map(r => r.type + ' ' + r.content).join(', ')}); not touching them`);
}

// 5) run token for cloudflared
const runToken = await cf('GET', `/accounts/${account}/cfd_tunnel/${tunnel.id}/token`);
updateEnvFile({ HANDOFF_TUNNEL: 'cloudflare', HANDOFF_CLOUDFLARE_TUNNEL_TOKEN: runToken, HANDOFF_PUBLIC_HOSTNAME: hostname });
console.log(`\nSaved the tunnel settings to .env. Start with:  npm start\nPublic address: https://${hostname}`);
