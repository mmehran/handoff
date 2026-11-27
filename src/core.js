// What every part of Handoff shares, whichever parts are turned on (see services.js):
// Claude Code's history (store), the processes Handoff runs (runner), alerts (notifier: WhatsApp and
// phone push), the audit log, and answering Claude's questions.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_DIR, ENV_FILE } from './config.js';
import { Store } from './store.js';
import { Runner, httpErr } from './runner.js';
import { injectMessage } from './inbox.js';
import { Notifier, buildAnswer } from './notify.js';
import { FileBrowser } from './files.js';
import { rotate } from './logfile.js';
import { SearchIndex } from './search.js';
import { PushService } from './push.js';
import { Activity } from './activity.js';
import { FolderPicker } from './folders.js';
import { needsHttp } from './services.js';
import { KeyStore } from './apikeys.js';
import { Usage, Limits } from './usage.js';

export function createCore(cfg, { claudePath, log = console.log } = {}) {
  const store = new Store(cfg);
  const runner = new Runner(cfg, claudePath);
  // 'whatsapp': the WhatsApp sender started or stopped being able to send
  const events = new EventEmitter();
  // something reachable from outside (the web app) can start Claude; WhatsApp on its own only
  // talks to sessions already open on the computer
  const canStart = needsHttp(cfg);

  const auditFile = path.join(DATA_DIR, 'audit.log');
  let auditWrites = 0;
  const audit = (ip, action, { text, ...detail } = {}) => {
    if (text !== undefined && cfg.auditText) detail.text = text;
    if (auditWrites++ % 200 === 0) rotate(auditFile); // past 5 MB: audit.log.1, so it can't grow forever
    fs.appendFile(auditFile, JSON.stringify({ t: new Date().toISOString(), ip, action, ...detail }) + '\n', () => {});
  };

  // Phone push notifications: each device opts in from the web app (menu -> Phone notifications),
  // so they come with the web app
  const push = cfg.web && cfg.push ? new PushService({
    dataDir: DATA_DIR, log,
    contact: cfg.pushContact || (cfg.publicHostname ? `https://${cfg.publicHostname}` : 'mailto:handoff@example.com')
  }) : null;

  // Alerts (approval needed / question / waiting / finished / error) to WhatsApp and to phones.
  // Without the web app there is nothing to open, so WhatsApp messages carry no links.
  const notifier = new Notifier(cfg.web ? cfg : { ...cfg, publicHostname: '' }, {
    push,
    store, runner, log,
    // replies typed on WhatsApp take the same path as taps in the web UI
    onAnswer: (sessionId, pick) => answerQuestion(sessionId, pick, 'whatsapp'),
    onApproval: (permId, allow) => runner.decide(permId, { allow, message: 'Denied from WhatsApp' }),
    onLinkChange: s => events.emit('whatsapp', s),
    prefsFile: path.join(DATA_DIR, 'notify.json') // projects and chats muted from the web app
  }).start();

  // Answer a pending AskUserQuestion. `picks` are option numbers (as shown in the UI and on
  // WhatsApp); `text` is a free-text answer. Delivered like any other prompt: straight into a
  // session running on the computer, or into our own process.
  async function answerQuestion(id, { picks = [], text = '' }, ip) {
    const q = await store.pendingQuestion(id);
    if (!q) throw httpErr(409, 'That question is no longer open.');
    const { chosen, free, prompt } = buildAnswer(q, { picks, text });

    const run = runner.bySession(id);
    const info = await store.sessionInfo(id);
    const live = !run && info?.live;
    if (live) await injectMessage(cfg.claudeHome, live, prompt);
    else if (run) runner.writeUser(run, prompt);
    else if (canStart) await runner.send({ sessionId: id, cwd: info?.cwd, text: prompt });
    else throw httpErr(409, 'That session is no longer running on the computer.');
    audit(ip, 'answer', { sessionId: id, toolUseId: q.toolUseId, picks, text: free.slice(0, 200) });
    // (a WhatsApp reply gets its own confirmation from the notifier, so don't send a second one)
    notifier.answered(id, ip === 'whatsapp' ? '' : chosen.join(' · ') || free);
    // a question open on the computer keeps its own picker; the answer waits in that session's queue
    return { ok: true, answered: chosen, delivered: live ? 'live' : 'remote', queuedBehindPicker: !!live };
  }

  // Files and Changes tabs. Never shown: Handoff's own secrets, Claude Code's login, the session inbox tokens.
  const files = new FileBrowser({
    deny: [ENV_FILE, DATA_DIR, path.join(cfg.claudeHome, '.credentials.json'), path.join(cfg.claudeHome, 'sessions')],
    allowedRoots: cfg.allowedRoots
  });
  const activity = new Activity(store);
  const folderPicker = new FolderPicker({ allowedRoots: cfg.allowedRoots });

  // Search across chats (on by default). Built in the background shortly after start and topped up
  // before every search; only kept when something can ask for it.
  const search = cfg.search && canStart ? new SearchIndex({ store, dir: path.join(DATA_DIR, 'search'), log }) : null;
  let searchTimer = null;
  if (search) {
    searchTimer = setTimeout(() => search.update()
      .then(n => n && log(`[search] index up to date (${n} chat${n === 1 ? '' : 's'} added or updated)`))
      .catch(e => log(`[search] ${e.message}`)), 15e3);
    searchTimer.unref?.();
  }

  // API keys (and what is remembered about their use); the web app manages them too
  const keys = new KeyStore({ cfg });

  // Usage page: tokens and cost from the transcripts, and the plan's limits as Claude Code reports them
  // on every run Handoff drives
  const usage = new Usage({ store, dataDir: DATA_DIR, log });
  const limits = new Limits({ dataDir: DATA_DIR });
  runner.on('rate_limit', info => limits.update(info));
  // the first count reads every transcript (can take half a minute): do it before anyone asks
  const usageTimer = cfg.web ? setTimeout(() => usage.update().catch(e => log(`[usage] ${e.message}`)), 30e3) : null;
  usageTimer?.unref?.();

  const stop = () => { clearTimeout(searchTimer); clearTimeout(usageTimer); runner.shutdown(); notifier.stop(); keys.flush(); };
  return { cfg, store, runner, push, notifier, events, audit, answerQuestion, files, activity, folderPicker, search, keys, usage, limits, stop, log };
}
