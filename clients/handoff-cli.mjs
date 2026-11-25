#!/usr/bin/env node
// `handoff`: ask the Claude Code on your computer from another computer's terminal, through the
// Handoff API. One file next to handoff.mjs; Node 20+, no packages.
//
// Set HANDOFF_URL and HANDOFF_KEY, or put {"url": "...", "key": "hk_..."} in ~/.handoff.json. Then:
//   handoff ask "why does the build fail?" [--project shop] [--session new|latest|<id>] [--model haiku]
//               [--effort low] [--file report.pdf]... [--stream] [--plain] [--json]
//   handoff sessions [--project shop] [--limit 20]     handoff select <session id>
//   handoff turns                                     handoff approvals
//   handoff approve <approval id> yes|no              handoff models
//   handoff compare "prompt" opus haiku [sonnet]       handoff me
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Handoff, HandoffError, file } from './handoff.mjs';

const args = process.argv.slice(2);
const flags = {}, rest = [], files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--file') files.push(args[++i]);
  else if (a.startsWith('--')) { const name = a.slice(2); const next = args[i + 1]; if (next === undefined || next.startsWith('--')) flags[name] = true; else { flags[name] = next; i++; } }
  else rest.push(a);
}
const [cmd, ...words] = rest;
const usage = () => { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).slice(1, 14).map(l => l.slice(3)).join('\n')); process.exit(cmd ? 1 : 0); };
if (!cmd || flags.help) usage();

let conf = {};
try { conf = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.handoff.json'), 'utf8')); } catch { /* none */ }
const url = process.env.HANDOFF_URL || conf.url, key = process.env.HANDOFF_KEY || conf.key;
if (!url || !key) { console.error('Set HANDOFF_URL and HANDOFF_KEY, or write {"url": "...", "key": "hk_..."} to ~/.handoff.json'); process.exit(1); }
const h = new Handoff(url, key);
const opts = () => {
  const o = {};
  for (const k of ['project', 'session', 'model', 'effort', 'mode', 'tools', 'language', 'length']) if (typeof flags[k] === 'string') o[k] = flags[k];
  if (flags.plain) o.plain = true;
  if (files.length) o.files = files.map(f => file(path.basename(f), fs.readFileSync(f)));
  return o;
};
const out = v => console.log(flags.json ? JSON.stringify(v, null, 2) : v);

try {
  if (cmd === 'ask') {
    const prompt = words.join(' ') || (!process.stdin.isTTY ? fs.readFileSync(0, 'utf8') : '');
    if (!prompt.trim() && !files.length) usage();
    if (flags.stream) {
      let printed = false;
      for await (const ev of h.stream('/chat', { prompt, ...opts() })) {
        if (ev.event === 'text') { process.stdout.write(ev.data.text); printed = true; }
        else if (ev.event === 'tool') process.stderr.write(`\n• ${ev.data.tool}${ev.data.summary ? ': ' + ev.data.summary : ''}\n`);
        else if (ev.event === 'approval') process.stderr.write(`\nWaiting for your approval: ${ev.data.tool} (allow it on your phone, or: handoff approve ${ev.data.id} yes)\n`);
        else if (ev.event === 'done' || ev.event === 'error') {
          if (!printed) process.stdout.write(ev.data.text || '');
          process.stdout.write('\n');
          if (ev.data.error) { console.error(`⚠️ ${ev.data.error.message}`); process.exitCode = 1; }
        }
      }
    } else {
      const t = await h.chat(prompt, opts());
      if (flags.json) out(t);
      else {
        console.log(t.text || '');
        for (const w of t.warnings || []) console.error(`(${w})`);
        if (t.error) { console.error(`⚠️ ${t.error.message}`); process.exitCode = 1; }
      }
    }
  } else if (cmd === 'sessions') {
    const r = await h.sessions({ ...(flags.project ? { project: flags.project } : {}), limit: flags.limit || 20 });
    if (flags.json) out(r);
    else for (const s of r.sessions) console.log(`${s.id}  ${s.status.padEnd(7)} ${(s.project?.name || '').padEnd(18)} ${s.title}`);
  } else if (cmd === 'select') {
    out(await h.select(words[0]));
  } else if (cmd === 'turns') {
    const r = await h.turns({ limit: flags.limit || 20 });
    if (flags.json) out(r);
    else for (const t of r.turns) console.log(`${t.id}  ${t.status.padEnd(20)} ${t.prompt}`);
  } else if (cmd === 'approvals') {
    const r = await h.approvals();
    if (flags.json) out(r);
    else if (!r.approvals.length) console.log('Nothing is waiting for approval.');
    else for (const a of r.approvals) console.log(`${a.id}  ${a.tool}  ${String(a.input).replace(/\s+/g, ' ').slice(0, 80)}`);
  } else if (cmd === 'approve') {
    out(await h.approve(words[0], /^(y|yes|allow|ok)$/i.test(words[1] || 'yes')));
  } else if (cmd === 'models') {
    const r = await h.models();
    if (flags.json) out(r);
    else for (const m of r.data) console.log(`${m.id.padEnd(30)} ${m.efforts.join(', ')}`);
  } else if (cmd === 'compare') {
    const [prompt, ...models] = words;
    const c = await h.compare(prompt, models, opts());
    if (flags.json) out(c);
    else for (const a of c.answers) console.log(`\n=== ${a.model} (${(a.durationMs / 1000).toFixed(1)} s${a.costUsd != null ? `, $${a.costUsd.toFixed(4)}` : ''})\n${a.text || a.error?.message || ''}`);
  } else if (cmd === 'me') {
    out(await h.me());
  } else usage();
} catch (e) {
  console.error(e instanceof HandoffError ? `⚠️ ${e.message} (${e.code})` : `⚠️ ${e.message}`);
  process.exit(1);
}
