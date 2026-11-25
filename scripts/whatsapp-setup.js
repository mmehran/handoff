// Turn on WhatsApp notifications: writes HANDOFF_WHATSAPP_ENABLED, HANDOFF_WHATSAPP_TO and a random
// HANDOFF_WHATSAPP_TOKEN (shared secret between Handoff and the WhatsApp sender) into .env.
// The sender container reads the same .env through docker-compose.yml.
// (`npm run setup` does the same when you pick WhatsApp alerts there.)
//
//   npm run setup:whatsapp                          (asks for the number)
//   npm run setup:whatsapp -- --to +15551234567
import readline from 'node:readline';
import { loadConfig } from '../src/config.js';
import { digits, validNumber, askNumber, saveWhatsApp, whatsappNextSteps } from '../src/setup-whatsapp.js';

const USAGE = 'usage: npm run setup:whatsapp -- --to +<country code><number>   (the number that RECEIVES the messages)';

const cfg = loadConfig();
const i = process.argv.indexOf('--to');
let to = i > 0 ? digits(process.argv[i + 1]) : '';
if (i > 0 && !validNumber(to)) { console.error(USAGE); process.exit(1); }
if (!to) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator](); // buffers lines, so piped input works too
  const ask = async q => { process.stdout.write(q); const { value, done } = await lines.next(); return done ? null : value; };
  try { to = await askNumber(ask, cfg.notify.to); } finally { rl.close(); }
}
if (!to) { console.error(USAGE); process.exit(1); }

console.log(`${saveWhatsApp(cfg, to)} Saved to .env.`);
console.log('\nNext:');
whatsappNextSteps(cfg).forEach((s, n) => console.log(s.startsWith(' ') ? `  ${s}` : `  ${n + 1}. ${s}`));
console.log('  3. restart Handoff (npm start)');
