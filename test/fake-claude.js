// Stand-in for the `claude` CLI speaking the stream-json control protocol. Used by tests only.
// Writes its transcript under $FAKE_CLAUDE_HOME (a temp dir), never the real ~/.claude.
//
// Like the real CLI: one turn at a time (prompts sent meanwhile wait), `system/init` before every
// turn, a running total in total_cost_usd, and these options:
//   --help                       lists the options below (Handoff checks which ones exist)
//   --replay-user-messages       echoes each prompt back with its uuid and isReplay
//   --include-partial-messages   sends the answer's text in stream_event pieces first
//   --no-session-persistence     writes no transcript
//   --json-schema <schema>       answers with structured_output
//   --tools <list>               limited tools: answers straight away (as does a prompt starting "plain:")
// Otherwise a turn asks to use Write and waits for the decision. Prompt prefixes for tests:
//   slow:<ms>:   waits that long before answering (an interrupt ends the turn early)
//   limit:       fails like a plan's usage limit       signout:   fails like a signed-out CLI
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
if (args.includes('--help')) {
  process.stdout.write(['Usage: claude [options]', '  --add-dir <directories...>', '  --allowedTools <tools...>', '  --append-system-prompt <prompt>',
    '  --disallowedTools <tools...>', '  --include-partial-messages', '  --json-schema <schema>', '  --max-budget-usd <amount>',
    '  --no-session-persistence', '  --replay-user-messages', '  --settings <file-or-json>', '  --strict-mcp-config', '  --tools <tools...>', ''].join('\n'));
  process.exit(0);
}
// a one-off question (-p --output-format text): read it all, answer with a fenced "commit message"
const oneShot = opt('--output-format') === 'text';
if (oneShot) {
  let input = '';
  process.stdin.setEncoding('utf8').on('data', d => { input += d; }).on('end', () => {
    process.stdout.write('```\nFake commit message\n\nRead ' + input.length + ' characters' + (args.includes('--tools') ? ', no tools' : '') + '.\n```\n');
  });
}
// a plain prompt with stream-json output (Handoff's limit check): report the plan's limits, answer, exit
const limitCheck = opt('--output-format') === 'stream-json' && !opt('--input-format');
if (limitCheck) {
  process.stdin.resume().on('end', () => {
    const now = Math.floor(Date.now() / 1000);
    process.stdout.write(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: now + 3600, rateLimitType: 'five_hour', utilization: 0.42,
      unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: now + 3600, status: 'allowed' }, seven_day: { utilization: 0.8, resetsAt: now + 3 * 86400, status: 'allowed_warning' } } } }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }) + '\n');
  });
}
const resume = opt('--resume');
const fork = args.includes('--fork-session');
const persist = !args.includes('--no-session-persistence');
const replay = args.includes('--replay-user-messages');
const partial = args.includes('--include-partial-messages');
const schema = opt('--json-schema');
const noTools = args.includes('--tools'); // limited tools (none, or read only): no Write to ask about
const sessionId = resume && !fork ? resume : crypto.randomUUID();
const home = process.env.FAKE_CLAUDE_HOME;
const dir = path.join(home, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, sessionId + '.jsonl');
if (resume && fork && persist) {
  // copy history like the real CLI does
  for (const d of fs.readdirSync(path.join(home, 'projects'))) {
    const src = path.join(home, 'projects', d, resume + '.jsonl');
    if (fs.existsSync(src)) fs.copyFileSync(src, file);
  }
}
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const record = o => { const r = { ...o, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId, cwd: process.cwd() }; if (persist) fs.appendFileSync(file, JSON.stringify(r) + '\n'); return r; };

let pending = null;      // the permission decision a turn waits for
let abort = null;        // ends the running turn early (interrupt)
let totalCost = 0;
const queue = [];
let busy = false;
const rl = oneShot || limitCheck ? null : readline.createInterface({ input: process.stdin });
rl?.on('line', line => {
  const m = JSON.parse(line);
  if (m.type === 'control_request' && m.request.subtype === 'interrupt') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    abort?.();
  } else if (m.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
  } else if (m.type === 'control_response') {
    pending?.(m.response.response); pending = null;
  } else if (m.type === 'user') {
    queue.push(m);
    next();
  }
});

async function next() {
  if (busy || !queue.length) return;
  busy = true;
  const m = queue.shift();
  try { await turn(m); } finally { busy = false; next(); }
}

const textOf = c => (typeof c === 'string' ? c : (c || []).map(b => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' '));

function finish(text, { isError = false, subtype = 'success' } = {}) {
  totalCost = Math.round((totalCost + 0.01) * 100) / 100;
  out({ type: 'result', subtype, is_error: isError, result: text, total_cost_usd: totalCost, num_turns: 1, session_id: sessionId,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    ...(schema && !isError ? { structured_output: JSON.parse(text) } : {}) });
}

function say(text) {
  if (partial) {
    const half = Math.ceil(text.length / 2);
    for (const piece of [text.slice(0, half), text.slice(half)]) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }, session_id: sessionId });
  }
  out(record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }));
}

async function turn(m) {
  const content = m.message.content;
  const text = textOf(content);
  out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd() });
  if (replay) out({ type: 'user', message: m.message, uuid: m.uuid || crypto.randomUUID(), isReplay: true, session_id: sessionId, parent_tool_use_id: null });
  record({ type: 'user', message: { role: 'user', content } });
  let aborted = false;
  const stopped = new Promise(r => { abort = () => { aborted = true; pending?.({ behavior: 'deny', message: 'Interrupted' }); pending = null; r(); }; });

  const slow = /^slow:(\d+):/.exec(text);
  if (slow) await Promise.race([new Promise(r => setTimeout(r, Number(slow[1]))), stopped]);
  if (aborted) { abort = null; return finish('', { isError: true, subtype: 'error_during_execution' }); }
  if (/^(slow:\d+:)?limit:/.test(text)) { abort = null; say('You\'ve hit your limit · resets 6pm'); return finish('You\'ve hit your limit · resets 6pm', { isError: true }); }
  if (/^(slow:\d+:)?signout:/.test(text)) { abort = null; return finish('Not logged in · Please run /login', { isError: true }); }

  if (noTools || /^(slow:\d+:)?plain:/.test(text) || schema) {
    const answer = schema ? JSON.stringify({ answer: `echo: ${text}` }) : `echo: ${text}`;
    say(answer);
    abort = null;
    return finish(answer);
  }

  const toolId = 'toolu_' + crypto.randomBytes(6).toString('hex');
  const a1 = record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Write', input: { file_path: 'out.txt', content: text } }] } });
  out(a1);
  out({ type: 'control_request', request_id: 'req1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'out.txt', content: text } } });
  const decision = await new Promise(r => { pending = r; });
  if (aborted) { abort = null; return finish('', { isError: true, subtype: 'error_during_execution' }); }
  const allowed = decision.behavior === 'allow';
  const u = record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: allowed ? 'wrote out.txt' : 'denied: ' + decision.message, is_error: !allowed }] } });
  out(u);
  const final = `echo: **${text}** (${allowed ? 'allowed' : 'denied'})`;
  say(final);
  abort = null;
  finish(final);
}
