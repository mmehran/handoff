// Interactive setup. First: which parts of Handoff to use (the web app, WhatsApp alerts, or both).
// Then only what those need: a password and optional 2FA for the web app, the receiving number for
// WhatsApp alerts. Writes .env (created from .env.example the first time); nothing is written if you
// stop halfway. Run it again any time to change the parts, or when you forgot the password: the 2FA
// already set up can stay as it is.
//
//   npm run setup
//   npm run setup -- --services web,whatsapp      (skips the "which parts" questions)
import readline from 'node:readline';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { updateEnvFile, readEnvFile, loadConfig, ENV_FILE, DATA_DIR } from './config.js';
import { hashPassword, generateTotpSecret, verifyTotp, _resetTotpReplay } from './auth.js';
import { askNumber, saveWhatsApp, whatsappNextSteps } from './setup-whatsapp.js';
import { describeServices, SERVICES } from './services.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let ended = false;
rl.on('close', () => { ended = true; });
// the typed line, or null once input has ended
const ask = q => new Promise(r => {
  if (ended) return r(null);
  const onClose = () => r(null);
  rl.once('close', onClose);
  rl.question(q, a => { rl.off('close', onClose); r(a.trim()); });
});
// like ask(), but doesn't echo what is typed
const askHidden = q => new Promise(r => {
  if (ended) return r(null);
  const write = rl._writeToOutput;
  const onClose = () => { rl._writeToOutput = write; r(null); };
  rl.once('close', onClose);
  rl._writeToOutput = s => { if (s.startsWith(q)) write.call(rl, q); else if (/\r?\n/.test(s)) write.call(rl, '\n'); };
  rl.question(q, a => { rl.off('close', onClose); rl._writeToOutput = write; r(a.trim()); });
});
const yesNo = async (q, def) => {
  for (;;) {
    const a = await ask(`${q} [${def ? 'Y/n' : 'y/N'}]: `);
    if (a === null) return null;
    if (!a) return def;
    if (/^y(es)?$/i.test(a)) return true;
    if (/^no?$/i.test(a)) return false;
    console.log('Please answer y or n.');
  }
};
const stopped = () => { console.log('\nSetup stopped: nothing was changed.'); process.exit(1); };

console.log('\n=== Handoff setup ===\n');
const cfg = loadConfig();

// ---------- which parts ----------
let web = cfg.web, whatsapp = cfg.notify.enabled;
const flag = process.argv.indexOf('--services');
if (flag > 0) {
  const ids = String(process.argv[flag + 1] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const known = SERVICES.map(s => s.id);
  if (!ids.length || ids.some(id => !known.includes(id))) {
    console.error(`usage: npm run setup -- --services ${known.join(',')}   (one or more of: ${known.join(', ')})`);
    process.exit(1);
  }
  web = ids.includes('web');
  whatsapp = ids.includes('whatsapp');
} else {
  console.log('Handoff has two parts. Use either one, or both:');
  console.log('  Web app          browse and drive Claude Code from your phone or any browser, with phone notifications');
  console.log('  WhatsApp alerts  a WhatsApp message when a session needs you; reply to answer (needs Docker)\n');
  for (;;) {
    web = await yesNo('Use the web app?', cfg.web);
    if (web === null) stopped();
    whatsapp = await yesNo('Use WhatsApp alerts?', cfg.notify.enabled);
    if (whatsapp === null) stopped();
    if (web || whatsapp) break;
    console.log('Pick at least one of them.\n');
  }
}
const updates = { HANDOFF_WEB: web ? 'true' : 'false' };

// ---------- the web app: password and 2FA ----------
if (web) {
  console.log('\nThe web app needs a password to sign in.');
  let pw = await askHidden('New password (input hidden; leave empty to generate a strong one): ');
  if (pw === null) stopped();
  if (pw) {
    const again = await askHidden('Repeat password: ');
    if (again === null) stopped();
    if (pw !== again) { console.log('Passwords do not match.'); process.exit(1); }
  }
  if (!pw) {
    pw = crypto.randomBytes(18).toString('base64url');
    console.log(`\n  Generated password: ${pw}\n  Save it in your password manager now.\n`);
  } else if (pw.length < 12) {
    console.log('Password must be at least 12 characters.'); process.exit(1);
  }
  updates.HANDOFF_PASSWORD_HASH = hashPassword(pw);

  let totpSecret = '';
  const current = String(readEnvFile().HANDOFF_TOTP_SECRET || '').replace(/\s+/g, '').toUpperCase();
  const keep = current && await yesNo('Keep the 2FA you already set up (same codes in your authenticator app)?', true);
  if (keep === null) stopped();
  if (keep) {
    totpSecret = current;
    console.log('2FA unchanged.');
  } else {
    const want = await yesNo('Enable 2FA with an authenticator app (Google/Microsoft Authenticator, Authy)?', true);
    if (want === null) stopped();
    if (want) {
      const secret = generateTotpSecret();
      console.log('\nAdd this account in your authenticator app ("enter a setup key", time-based):');
      console.log(`  Account: Handoff\n  Key:     ${secret.match(/.{1,4}/g).join(' ')}`);
      console.log(`  (or otpauth URI: otpauth://totp/Handoff?secret=${secret}&issuer=Handoff)\n`);
      for (let i = 0; i < 3; i++) {
        const code = await ask('Enter the 6-digit code shown in the app to confirm: ');
        if (code === null) stopped();
        _resetTotpReplay();
        if (verifyTotp(secret, code)) { totpSecret = secret; console.log('2FA enabled.'); break; }
        console.log('Code did not match, try again.');
      }
      if (!totpSecret) console.log('2FA not enabled (codes did not match).');
    }
  }
  updates.HANDOFF_TOTP_SECRET = totpSecret;
}

// ---------- WhatsApp alerts: the receiving number ----------
let waTo = '';
if (whatsapp) {
  if (cfg.notify.to && cfg.notify.token) {
    console.log(`\nWhatsApp alerts stay set up for +${cfg.notify.to} (npm run setup:whatsapp changes the number).`);
    updates.HANDOFF_WHATSAPP_ENABLED = 'true';
  } else {
    console.log('');
    waTo = await askNumber(ask, cfg.notify.to);
    if (!waTo) stopped();
  }
} else {
  updates.HANDOFF_WHATSAPP_ENABLED = 'false'; // the number and token stay, for turning them on again later
}
rl.close();

// ---------- save ----------
if (waTo) console.log(saveWhatsApp(cfg, waTo));
updateEnvFile(updates);
if (web) {
  // new credentials: sign out every device that was logged in with the old ones
  fs.rmSync(path.join(DATA_DIR, 'sessions.json'), { force: true });
  console.log('All previously signed-in devices have been signed out.');
}
const now = { ...cfg, web, notify: { ...cfg.notify, enabled: whatsapp } };
console.log(`\nSaved to ${path.relative(process.cwd(), ENV_FILE) || ENV_FILE}. Handoff will run: ${describeServices(now)}.`);
console.log('\nNext:');
if (web) {
  // read back: a first setup has just made .env from .env.example, with its own tunnel setting
  const saved = { ...readEnvFile(), ...process.env };
  const tunnel = String(saved.HANDOFF_TUNNEL || 'none').trim().toLowerCase();
  const host = String(saved.HANDOFF_PUBLIC_HOSTNAME || '').trim();
  console.log(tunnel === 'none'
    ? '- The web app is reachable on this computer only (HANDOFF_TUNNEL=none). To reach it from your phone, set HANDOFF_TUNNEL=quick, or run npm run setup:domain for your own domain.'
    : tunnel === 'quick'
      ? '- The web app gets a new https://<random>.trycloudflare.com address on every start (HANDOFF_TUNNEL=quick). For a permanent one on your own domain: npm run setup:domain'
      : `- The web app is reached through HANDOFF_TUNNEL=${tunnel}${host ? ` at https://${host}` : ''}.`);
}
if (whatsapp && waTo) for (const s of whatsappNextSteps(cfg)) console.log(s.startsWith(' ') ? `  ${s}` : `- ${s}`);
console.log('- Start Handoff (or restart it) to use it:  npm start');
console.log('  If it starts automatically:  powershell -ExecutionPolicy Bypass -File scripts\\autostart.ps1 restart   (Windows)');
console.log('                               sh scripts/autostart.sh restart   (Linux, macOS)\n');
