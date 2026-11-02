// Deliver a prompt into a Claude Code session that is already running on this machine
// (Claude Desktop or a terminal), using Claude Code's own local messaging inbox:
//   ~/.claude/sessions/<pid>.json         -> messagingSocketPath (named pipe / unix socket)
//   ~/.claude/sessions/<pid>.<hash>.key   -> peerToken used to authenticate
// Protocol (as documented in the CLI's own debug log): an {type:'auth'} line, then {type:'user'} lines.
// The token is only read at send time and never leaves this process.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { httpErr } from './runner.js';

function findInbox(claudeHome, pid) {
  const dir = path.join(claudeHome, 'sessions');
  let reg;
  try { reg = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), 'utf8')); } catch { return null; }
  const sock = reg.messagingSocketPath;
  if (typeof sock !== 'string' || !(sock.startsWith('\\\\.\\pipe\\') || path.isAbsolute(sock))) return null;
  const keyRe = new RegExp(`^${pid}\\.[0-9a-f]{64}\\.key$`);
  const keyName = fs.readdirSync(dir).find(f => keyRe.test(f));
  if (!keyName) return null;
  let token;
  try { token = JSON.parse(fs.readFileSync(path.join(dir, keyName), 'utf8')).peerToken; } catch { return null; }
  if (!/^[0-9a-f]{32}$/.test(token || '')) return null;
  return { sock, token };
}

export function injectMessage(claudeHome, live, text) {
  if (!Number.isInteger(live.pid)) throw httpErr(400, 'invalid session process');
  const inbox = findInbox(claudeHome, live.pid);
  if (!inbox) throw httpErr(409, 'this running session has no messaging inbox (update Claude Code or reopen the session); tick Fork instead');
  return new Promise((resolve, reject) => {
    const c = net.connect(inbox.sock);
    const timer = setTimeout(() => { c.destroy(); reject(httpErr(504, 'timed out delivering to the running session')); }, 5000);
    c.on('connect', () => {
      c.end(JSON.stringify({ type: 'auth', token: inbox.token }) + '\n' +
            JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    });
    c.on('close', hadErr => { clearTimeout(timer); if (!hadErr) resolve(); });
    c.on('error', e => { clearTimeout(timer); reject(httpErr(502, `could not reach the running session: ${e.code || e.message}`)); });
  });
}
