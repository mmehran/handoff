// Stand-in for the `claude` CLI speaking the stream-json control protocol. Used by tests only.
// Writes its transcript under $FAKE_CLAUDE_HOME (a temp dir), never the real ~/.claude.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const resume = opt('--resume');
const fork = args.includes('--fork-session');
const sessionId = resume && !fork ? resume : crypto.randomUUID();
const home = process.env.FAKE_CLAUDE_HOME;
const dir = path.join(home, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, sessionId + '.jsonl');
if (resume && fork) {
  // copy history like the real CLI does
  for (const d of fs.readdirSync(path.join(home, 'projects'))) {
    const src = path.join(home, 'projects', d, resume + '.jsonl');
    if (fs.existsSync(src)) fs.copyFileSync(src, file);
  }
}
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const record = o => { const r = { ...o, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId, cwd: process.cwd() }; fs.appendFileSync(file, JSON.stringify(r) + '\n'); return r; };

let pending = null;
let initDone = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.type === 'control_request' && m.request.subtype === 'initialize') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
  } else if (m.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
  } else if (m.type === 'control_response') {
    pending?.(m.response.response); pending = null;
  } else if (m.type === 'user') {
    if (!initDone) { initDone = true; out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd() }); }
    turn(m.message.content);
  }
});

async function turn(text) {
  record({ type: 'user', message: { role: 'user', content: text } });
  const toolId = 'toolu_' + crypto.randomBytes(6).toString('hex');
  const a1 = record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Write', input: { file_path: 'out.txt', content: text } }] } });
  out(a1);
  out({ type: 'control_request', request_id: 'req1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'out.txt', content: text } } });
  const decision = await new Promise(r => { pending = r; });
  const allowed = decision.behavior === 'allow';
  const u = record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: allowed ? 'wrote out.txt' : 'denied: ' + decision.message, is_error: !allowed }] } });
  out(u);
  const a2 = record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `echo: **${text}** (${allowed ? 'allowed' : 'denied'})` }] } });
  out(a2);
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, num_turns: 1, session_id: sessionId });
}
