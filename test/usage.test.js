// Usage page: tokens and estimated cost added up from transcripts (each reply once, sub-agents
// included, only new lines read again), and the plan's limits as Claude Code reports them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-usage-')));
const home = path.join(tmp, 'claude-home');
process.env.HANDOFF_DATA_DIR = path.join(tmp, 'data');
process.env.HANDOFF_ENV_FILE = path.join(tmp, 'no-such.env');
process.env.FAKE_CLAUDE_HOME = home;

const { Store } = await import('../src/store.js');
const { Usage, Limits, costOf, priceOf } = await import('../src/usage.js');
const { Runner } = await import('../src/runner.js');
const { loadConfig } = await import('../src/config.js');

const work = path.join(tmp, 'work');
fs.mkdirSync(work, { recursive: true });
const key = work.replace(/[^A-Za-z0-9]/g, '-');
const dir = path.join(home, 'projects', key);
fs.mkdirSync(dir, { recursive: true });
const id = crypto.randomUUID();
const file = path.join(dir, id + '.jsonl');
const now = Date.now();
const reply = (msgId, model, u, ts = now, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), requestId: 'req_' + msgId, cwd: work, message: { id: msgId, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: u }, ...extra });
const u1 = { input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 10000, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 2000 } };
fs.writeFileSync(file, [
  JSON.stringify({ type: 'user', timestamp: new Date(now).toISOString(), cwd: work, message: { role: 'user', content: 'hi' } }),
  // one reply written as three lines with the same id: counted once
  reply('m1', 'claude-opus-5-5', u1), reply('m1', 'claude-opus-5-5', u1), reply('m1', 'claude-opus-5-5', u1),
  // an old one, outside a 7-day range
  reply('m0', 'claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 0 }, now - 20 * 86400e3)
].join('\n') + '\n');
// a sub-agent's run counts for its session
fs.mkdirSync(path.join(dir, id, 'subagents'), { recursive: true });
fs.writeFileSync(path.join(dir, id, 'subagents', 'agent-abc.jsonl'), reply('s1', 'claude-haiku-5-5', { input_tokens: 1e6, output_tokens: 1e6 }) + '\n');

const store = new Store({ claudeHome: home });
const usage = new Usage({ store, dataDir: path.join(tmp, 'data') });

test('prices: list prices per model, cache writes at 1.25x / 2x input, fast mode at 2x', () => {
  assert.deepEqual(priceOf('claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0.2 });
  assert.equal(priceOf('some-other-model'), null);
  // 1000 in, 2000 out, 2000 5m writes, 1000 1h writes, 10000 reads on Opus 5.5
  const c = costOf('claude-opus-5-5', [1000, 2000, 2000, 1000, 10000, 1]);
  assert.equal(Math.round(c * 1e6), Math.round((1000 * 4 + 2000 * 20 + 2000 * 5 + 1000 * 8 + 10000 * 0.2)));
  assert.equal(costOf('claude-opus-5-5', [1e6, 0, 0, 0, 0, 1], true), 8);
});

test('the report adds each reply once, sub-agents included, by day, project, session and model', async () => {
  const r = await usage.report({ days: 7, now });
  assert.equal(r.totals.today.tokens.replies, 2, 'the main reply once, plus the sub-agent');
  assert.equal(r.totals.range.tokens.input, 1000 + 1e6);
  assert.equal(r.totals.range.tokens.cacheWrite, 3000);
  const opus = r.byModel.find(m => m.model === 'claude-opus-5-5');
  assert.ok(Math.abs(opus.cost - 0.064) < 1e-6, `opus cost ${opus.cost}`);
  assert.ok(Math.abs(r.byModel.find(m => m.model === 'claude-haiku-5-5').cost - 0.6) < 1e-9);
  assert.equal(r.byDay.length, 7);
  assert.equal(r.bySession[0].id, id);
  assert.equal(r.byProject[0].key, key);
  assert.ok(!r.byModel.some(m => m.model === 'claude-sonnet-5-5'), 'the 20-day-old reply is outside 7 days');
  assert.equal((await usage.report({ days: 30, now })).byModel.find(m => m.model === 'claude-sonnet-5-5').cost, 2);
});

test('only new lines are read again, and the totals survive a restart', async () => {
  fs.appendFileSync(file, reply('m2', 'claude-opus-5-5', { input_tokens: 500, output_tokens: 0 }) + '\n' + '{"type":"assistant","partial line');
  assert.equal(await usage.update(), 1);
  assert.equal(await usage.update(), 0, 'nothing changed');
  const again = new Usage({ store, dataDir: path.join(tmp, 'data') });
  const r = await again.report({ days: 7, now });
  assert.equal(r.totals.today.tokens.input, 1000 + 500 + 1e6);
});

test('limits: windows from rate_limit_event, a passed reset shows as started again', () => {
  const l = new Limits({ dataDir: path.join(tmp, 'limits-a') });
  const s = Math.floor(now / 1000);
  l.update({ status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 0.3, resetsAt: s + 99, unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: s - 10 }, seven_day: { utilization: 0.9, resetsAt: s + 86400, status: 'allowed_warning' } } }, now);
  const v = l.view(now);
  assert.equal(v.windows.seven_day.utilization, 0.9);
  assert.equal(v.windows.seven_day.resetsAt, (s + 86400) * 1000);
  assert.equal(v.windows.seven_day_opus.utilization, 0.3);
  assert.equal(v.windows.five_hour.utilization, 0);
  assert.equal(v.windows.five_hour.reset, true);
  assert.equal(new Limits({ dataDir: path.join(tmp, 'limits-a') }).view(now).windows.seven_day.utilization, 0.9, 'kept on disk');
});

test('"Check now" runs one tiny request and reads the limits Claude Code reports', async () => {
  const cfg = loadConfig();
  cfg.claudeHome = home;
  const stub = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.js');
  const runner = new Runner(cfg, stub);
  const l = new Limits({ dataDir: path.join(tmp, 'limits-b') });
  runner.on('rate_limit', info => l.update(info));
  const info = await runner.checkLimits();
  assert.equal(info.unifiedWindows.five_hour.utilization, 0.42);
  assert.equal(l.view().windows.seven_day.status, 'allowed_warning');
  runner.shutdown();
});
