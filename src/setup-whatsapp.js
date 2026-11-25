// Turning on WhatsApp alerts, shared by `npm run setup` (when you pick them) and `npm run setup:whatsapp`.
// Writes HANDOFF_WHATSAPP_ENABLED, HANDOFF_WHATSAPP_TO and a random HANDOFF_WHATSAPP_TOKEN (the shared
// secret between Handoff and the WhatsApp sender) into .env. The sender container reads the same .env.
import crypto from 'node:crypto';
import { updateEnvFile } from './config.js';

export const digits = s => String(s || '').replace(/\D/g, '');
export const validNumber = n => /^\d{8,15}$/.test(n);

// ask(prompt) -> the typed line, or null once input has ended. Asks until it gets a plausible number;
// Enter keeps the current one. '' if input ends first.
export async function askNumber(ask, current) {
  console.log('Which WhatsApp number should RECEIVE the notifications? Include the country code.');
  console.log('(The phone that SENDS them is linked in a later step by scanning a QR code; use a different number for it if you can.)');
  for (;;) {
    const value = await ask(`Number, e.g. +15551234567${current ? ` [Enter keeps +${current}]` : ''}: `);
    if (value === null) { process.stdout.write('\n'); return ''; }
    const n = digits(value) || current;
    if (validNumber(n)) return n;
    console.log('That doesn\'t look like a full number. Use the country code and number, 8 to 15 digits.');
  }
}

// saves the number; an existing token is kept, so a sender that is already running keeps working
export function saveWhatsApp(cfg, to) {
  const token = cfg.notify.token || crypto.randomBytes(24).toString('base64url');
  updateEnvFile({ HANDOFF_WHATSAPP_ENABLED: 'true', HANDOFF_WHATSAPP_TO: to, HANDOFF_WHATSAPP_TOKEN: token });
  return `WhatsApp alerts will go to +${to}.`;
}

export const whatsappNextSteps = cfg => [
  'docker compose up -d --build   (starts the WhatsApp sender)',
  `open ${cfg.notify.url}/qr and scan it with the phone that should SEND the alerts`,
  '   (WhatsApp > Settings > Linked devices > Link a device)'
];
