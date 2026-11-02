// Turn on WhatsApp notifications: writes HANDOFF_WHATSAPP_ENABLED, HANDOFF_WHATSAPP_TO and a random
// HANDOFF_WHATSAPP_TOKEN (shared secret between Handoff and the WhatsApp sender) into .env.
// The sender container reads the same .env through docker-compose.yml.
//
//   npm run setup:whatsapp -- --to +15551234567
import crypto from 'node:crypto';
import { loadConfig, updateEnvFile } from '../src/config.js';

const i = process.argv.indexOf('--to');
const to = (i > 0 ? process.argv[i + 1] : '').replace(/\D/g, '');
if (!/^\d{8,15}$/.test(to)) {
  console.error('usage: npm run setup:whatsapp -- --to +<country code><number>   (the number that RECEIVES the messages)');
  process.exit(1);
}

const cfg = loadConfig();
const token = cfg.notify.token || crypto.randomBytes(24).toString('base64url'); // keep an existing token
updateEnvFile({ HANDOFF_WHATSAPP_ENABLED: 'true', HANDOFF_WHATSAPP_TO: to, HANDOFF_WHATSAPP_TOKEN: token });
console.log(`WhatsApp notifications will go to +${to}. Saved to .env.`);
console.log('\nNext:');
console.log('  1. docker compose up -d --build');
console.log(`  2. open ${cfg.notify.url}/qr and scan it with the phone that should SEND the messages`);
console.log('     (WhatsApp > Settings > Linked devices > Link a device)');
console.log('  3. restart Handoff (npm start, or npm run whatsapp-only)');
