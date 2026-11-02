// Every setting comes from environment variables, or from a .env file in the project folder
// (copy .env.example to .env). Real environment variables win over the file.
// The file is parsed here and kept out of process.env, so none of these values (password hash,
// tokens) leak into the `claude` processes this app starts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_FILE = process.env.HANDOFF_ENV_FILE ? path.resolve(process.env.HANDOFF_ENV_FILE) : path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

// KEY=value per line. '#' starts a comment; 'single quotes' are literal (no escapes, no $ expansion,
// same as Docker Compose); "double quotes" understand \n; `export KEY=value` is accepted.
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith("'")) {
      const end = v.indexOf("'", 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else if (v.startsWith('"')) {
      const q = /^"((?:[^"\\]|\\.)*)"/.exec(v);
      v = (q ? q[1] : v.slice(1)).replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1');
    } else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

export function readEnvFile(file = ENV_FILE) {
  try { return parseEnv(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

const ENV = { ...readEnvFile(), ...process.env };
export const DATA_DIR = path.resolve(ROOT, ENV.HANDOFF_DATA_DIR || 'data');

const str = (k, d = '') => (ENV[k] ?? '').trim() === '' ? d : String(ENV[k]).trim();
const num = (k, d) => { const n = Number(str(k)); return str(k) !== '' && Number.isFinite(n) ? n : d; };
const bool = (k, d = false) => { const v = str(k).toLowerCase(); return v ? ['1', 'true', 'yes', 'on'].includes(v) : d; };
const list = (k, sep) => str(k).split(sep).map(s => s.trim()).filter(Boolean);

export const NOTIFY_EVENTS = ['approval', 'question', 'waiting', 'done', 'error'];

export function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const totpSecret = str('HANDOFF_TOTP_SECRET').replace(/\s+/g, '').toUpperCase();
  const events = list('HANDOFF_WHATSAPP_EVENTS', ',');
  return {
    host: str('HANDOFF_HOST', '127.0.0.1'),       // never bind publicly; the tunnel is the only way in
    port: num('HANDOFF_PORT', 7860),
    claudeHome: path.resolve(str('HANDOFF_CLAUDE_HOME', path.join(os.homedir(), '.claude'))),
    claudePath: str('HANDOFF_CLAUDE_PATH'),         // auto-detected when empty
    claudeOauthToken: str('CLAUDE_CODE_OAUTH_TOKEN'), // optional, from `claude setup-token`; only for processes we start
    passwordHash: str('HANDOFF_PASSWORD_HASH'),
    totpSecret,
    totpEnabled: !!totpSecret,
    sessionIdleHours: num('HANDOFF_LOGIN_IDLE_HOURS', 24),
    sessionMaxDays: num('HANDOFF_LOGIN_MAX_DAYS', 7),
    defaultPermissionMode: str('HANDOFF_DEFAULT_MODE', 'manual'),
    allowBypassPermissions: bool('HANDOFF_ALLOW_BYPASS'),
    allowedRoots: list('HANDOFF_ALLOWED_ROOTS', path.delimiter).map(p => path.resolve(p)), // empty = any folder
    maxConcurrentRuns: num('HANDOFF_MAX_RUNS', 3),
    idleKillMinutes: num('HANDOFF_IDLE_KILL_MINUTES', 15),
    permissionTimeoutMinutes: num('HANDOFF_PERMISSION_TIMEOUT_MINUTES', 30),
    tunnel: str('HANDOFF_TUNNEL', 'none').toLowerCase(), // none | quick | ngrok | cloudflare
    tunnelToken: str('HANDOFF_CLOUDFLARE_TUNNEL_TOKEN'),
    publicHostname: str('HANDOFF_PUBLIC_HOSTNAME').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase(),
    notify: {
      enabled: bool('HANDOFF_WHATSAPP_ENABLED'),
      url: str('HANDOFF_WHATSAPP_URL', `http://127.0.0.1:${num('HANDOFF_WHATSAPP_PORT', 7870)}`).replace(/\/+$/, ''),
      token: str('HANDOFF_WHATSAPP_TOKEN'),
      to: str('HANDOFF_WHATSAPP_TO').replace(/\D/g, ''),
      events: Object.fromEntries(NOTIFY_EVENTS.map(k => [k, !events.length || events.includes(k)]))
    }
  };
}

// Set (or add) keys in .env, keeping every other line and comment as it is.
// Creates .env from .env.example the first time. Values are single-quoted when needed.
export function updateEnvFile(updates, file = ENV_FILE) {
  let text = '';
  if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
  else if (fs.existsSync(ENV_EXAMPLE)) text = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(updates)) {
    const val = String(v ?? '');
    if (val.includes("'") || /[\r\n]/.test(val)) throw new Error(`${k}: value can't contain quotes or newlines`);
    const line = `${k}=${/^[A-Za-z0-9_.,:/@+-]*$/.test(val) ? val : `'${val}'`}`;
    const i = lines.findIndex(l => new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=`).test(l));
    if (i >= 0) { lines[i] = line; continue; }
    // replace a commented-out example (# KEY=...) if there is one, else append
    const j = lines.findIndex(l => new RegExp(`^\\s*#\\s*${k}\\s*=`).test(l));
    if (j >= 0) lines[j] = line;
    else { if (lines.at(-1) === '') lines.pop(); lines.push(line, ''); }
  }
  fs.writeFileSync(file, lines.join(eol), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* not supported on this filesystem */ }
}

export function resolveClaudePath(cfg) {
  if (cfg.claudePath) return cfg.claudePath;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split(/\r?\n/).filter(Boolean);
    return lines.find(l => /\.exe$/i.test(l)) || lines[0] || 'claude';
  } catch {
    return 'claude';
  }
}
