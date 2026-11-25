// API keys from a terminal on this computer (the web app has the same under menu → API access).
// A running Handoff picks up changes at once; no restart needed.
//
//   node scripts/api-key.js create --name "iPhone shortcut" [--preset phone|automation|chat]
//        [--scopes read,chat,approve,files,git] [--projects "D:\code\shop;D:\code\api"] [--tools all|readOnly|none]
//        [--modes manual,plan,acceptEdits] [--mode manual] [--model haiku] [--effort low] [--plain]
//        [--language Urdu] [--length brief] [--alerts] [--rate 30] [--turns 2] [--budget 5] [--expires 90]
//   node scripts/api-key.js list
//   node scripts/api-key.js revoke <id | first characters | name>
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { KeyStore, PRESETS } from '../src/apikeys.js';

const [cmd, ...rest] = process.argv.slice(2);
const opt = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true) : undefined; };
const list = v => (typeof v === 'string' ? v.split(/[,;]/).map(s => s.trim()).filter(Boolean) : undefined);
const cfg = loadConfig();
const keys = new KeyStore({ cfg });
const when = t => (t ? new Date(t).toLocaleString() : 'never');

function usage(code = 1) {
  console.log('usage: node scripts/api-key.js create --name "<name>" [--preset ' + Object.keys(PRESETS).join('|') + '] [options]');
  console.log('       node scripts/api-key.js list');
  console.log('       node scripts/api-key.js revoke <id | first characters | name>');
  console.log('See the top of scripts/api-key.js for every option, and docs/api.md.');
  process.exit(code);
}

try {
  if (cmd === 'create') {
    const projects = opt('projects') === true ? undefined : opt('projects');
    const { key, record: k } = keys.create({
      name: opt('name') === true ? '' : opt('name'),
      preset: opt('preset') === true ? undefined : opt('preset'),
      scopes: list(opt('scopes')), tools: opt('tools') === true ? undefined : opt('tools'),
      projects: projects ? projects.split(path.delimiter === ';' ? /;/ : /[;:]/).map(s => s.trim()).filter(Boolean) : undefined,
      modes: list(opt('modes')), defaultMode: opt('mode') === true ? undefined : opt('mode'),
      defaults: { model: opt('model') === true ? undefined : opt('model'), effort: opt('effort') === true ? undefined : opt('effort'), plain: opt('plain') === true || undefined, language: opt('language') === true ? undefined : opt('language'), length: opt('length') === true ? undefined : opt('length') },
      alerts: opt('alerts') === true, rateLimit: opt('rate'), maxTurns: opt('turns'), dailyBudgetUsd: opt('budget'), expiresDays: opt('expires')
    });
    console.log(`\nAPI key "${k.name}" (${k.id}) — shown only now, so copy it somewhere safe:\n\n  ${key}\n`);
    console.log(`Scopes: ${k.scopes.join(', ')}   Tools: ${k.tools}   Modes: ${k.modes.join(', ')} (default ${k.defaultMode})`);
    console.log(`Projects: ${k.projects ? k.projects.join(', ') : 'all'}   Expires: ${k.expiresAt ? when(k.expiresAt) : 'never'}`);
    console.log(`Webhook secret (to check webhooks it sends): ${k.webhookSecret}`);
    if (!cfg.api) console.log('\nThe API is off in this Handoff: set HANDOFF_API=true in .env (or npm run setup) and restart it.');
    console.log('\nTry it:  curl -H "Authorization: Bearer <key>" ' + (cfg.publicHostname ? `https://${cfg.publicHostname}` : `http://127.0.0.1:${cfg.port}`) + '/api/v1/me\n');
  } else if (cmd === 'list') {
    const all = keys.list();
    if (!all.length) console.log('No API keys yet. Make one with: node scripts/api-key.js create --name "my laptop"');
    for (const k of all) {
      console.log(`${k.id}  ${k.prefix}…  ${k.name}${k.expired ? '  (expired)' : ''}`);
      console.log(`    scopes ${k.scopes.join(',')} · tools ${k.tools} · projects ${k.projects ? k.projects.length : 'all'} · last used ${when(k.lastUsedAt)}${k.lastIp ? ` from ${k.lastIp}` : ''} · today ${k.today.turns} turns, $${k.today.costUsd.toFixed(2)}`);
    }
  } else if (cmd === 'revoke') {
    const k = keys.find(rest[0]);
    if (!k) { console.error(`No key matches "${rest[0] || ''}". See: node scripts/api-key.js list`); process.exit(1); }
    keys.revoke(k.id);
    console.log(`Revoked "${k.name}" (${k.id}). Programs using it get "unauthorized" from now on.`);
  } else usage(cmd ? 1 : 0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
