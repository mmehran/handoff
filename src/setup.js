// Interactive setup: password + optional TOTP 2FA. Writes HANDOFF_PASSWORD_HASH and
// HANDOFF_TOTP_SECRET into .env (created from .env.example if it doesn't exist yet).
import readline from 'node:readline';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { updateEnvFile, ENV_FILE, DATA_DIR } from './config.js';
import { hashPassword, generateTotpSecret, verifyTotp, _resetTotpReplay } from './auth.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, a => r(a.trim())));
// like ask(), but doesn't echo what is typed
const askHidden = q => new Promise(r => {
  const write = rl._writeToOutput;
  rl._writeToOutput = s => { if (s.startsWith(q)) write.call(rl, q); else if (/\r?\n/.test(s)) write.call(rl, '\n'); };
  rl.question(q, a => { rl._writeToOutput = write; r(a.trim()); });
});

console.log('\n=== Handoff setup ===\n');

let pw = await askHidden('New password (input hidden; leave empty to generate a strong one): ');
if (pw && pw !== await askHidden('Repeat password: ')) { console.log('Passwords do not match.'); process.exit(1); }
if (!pw) {
  pw = crypto.randomBytes(18).toString('base64url');
  console.log(`\n  Generated password: ${pw}\n  Save it in your password manager now.\n`);
} else if (pw.length < 12) {
  console.log('Password must be at least 12 characters.'); process.exit(1);
}
const passwordHash = hashPassword(pw);

let totpSecret = '';
const want2fa = (await ask('Enable 2FA with an authenticator app (Google/Microsoft Authenticator, Authy)? [Y/n]: ')).toLowerCase() !== 'n';
if (want2fa) {
  const secret = generateTotpSecret();
  console.log('\nAdd this account in your authenticator app ("enter a setup key", time-based):');
  console.log(`  Account: Handoff\n  Key:     ${secret.match(/.{1,4}/g).join(' ')}`);
  console.log(`  (or otpauth URI: otpauth://totp/Handoff?secret=${secret}&issuer=Handoff)\n`);
  for (let i = 0; i < 3; i++) {
    const code = await ask('Enter the 6-digit code shown in the app to confirm: ');
    _resetTotpReplay();
    if (verifyTotp(secret, code)) { totpSecret = secret; console.log('2FA enabled.'); break; }
    console.log('Code did not match, try again.');
  }
  if (!totpSecret) console.log('2FA not enabled (codes did not match).');
}

updateEnvFile({ HANDOFF_PASSWORD_HASH: passwordHash, HANDOFF_TOTP_SECRET: totpSecret });
// new credentials: sign out every device that was logged in with the old ones
fs.rmSync(path.join(DATA_DIR, 'sessions.json'), { force: true });
console.log('All previously signed-in devices have been signed out.');
console.log(`\nSaved to ${path.relative(process.cwd(), ENV_FILE) || ENV_FILE}. Start with:  npm start\n`);
rl.close();
