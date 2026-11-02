// Turn on WhatsApp notifications: writes HANDOFF_WHATSAPP_ENABLED, HANDOFF_WHATSAPP_TO and a random
// HANDOFF_WHATSAPP_TOKEN (shared secret between Handoff and the WhatsApp sender) into .env.
// The sender container reads the same .env through docker-compose.yml.
//
//   npm run setup:whatsapp                          (asks for the number)
//   npm run setup:whatsapp -- --to +15551234567
import crypto from 'node:crypto';
import readline from 'node:readline';
import { loadConfig, updateEnvFile } from '../src/config.js';

const USAGE = 'usage: npm run setup:whatsapp -- --to +<country code><number>   (the number that RECEIVES the messages)';
const digits = s => String(s || '').replace(/\D/g, '');
const valid = n => /^\d{8,15}$/.test(n);

// Asks until it gets a plausible number. Enter keeps the current one. '' if input ends first.
async function askNumber(current) {
  console.log('Which WhatsApp number should RECEIVE the notifications? Include the country code.');
  console.log('(The phone that SENDS them is linked in a later step by scanning a QR code; use a different number for it if you can.)');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator](); // buffers lines, so piped input works too
  try {
    for (;;) {
      process.stdout.write(`Number, e.g. +15551234567${current ? ` [Enter keeps +${current}]` : ''}: `);
      const { value, done } = await lines.next();
      if (done) { process.stdout.write('\n'); return ''; }
      const n = digits(value) || current;
      if (valid(n)) return n;
      console.log('That doesn\'t look like a full number. Use the country code and number, 8 to 15 digits.');
    }
  } finally { rl.close(); }
}

const cfg = loadConfig();
const i = process.argv.indexOf('--to');
let to = i > 0 ? digits(process.argv[i + 1]) : '';
if (i > 0 && !valid(to)) { console.error(USAGE); process.exit(1); }
if (!to) to = await askNumber(cfg.notify.to);
if (!to) { console.error(USAGE); process.exit(1); }

const token = cfg.notify.token || crypto.randomBytes(24).toString('base64url'); // keep an existing token
updateEnvFile({ HANDOFF_WHATSAPP_ENABLED: 'true', HANDOFF_WHATSAPP_TO: to, HANDOFF_WHATSAPP_TOKEN: token });
console.log(`WhatsApp notifications will go to +${to}. Saved to .env.`);
console.log('\nNext:');
console.log('  1. docker compose up -d --build');
console.log(`  2. open ${cfg.notify.url}/qr and scan it with the phone that should SEND the messages`);
console.log('     (WhatsApp > Settings > Linked devices > Link a device)');
console.log('  3. restart Handoff (npm start, or npm run whatsapp-only)');
