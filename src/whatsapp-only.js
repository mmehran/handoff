// WhatsApp-only mode: no web UI, no password, no tunnel, nothing listening.
// Watches every Claude Code session on this machine (Claude Desktop, terminal, IDE) and sends a
// WhatsApp message when one needs approval/input, asks a question, finishes or fails.
// Replying with an option number (or text) answers a question straight into the session.
//
//   npm run whatsapp-only            (needs HANDOFF_WHATSAPP_* in .env: npm run setup:whatsapp)
import { EventEmitter } from 'node:events';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Notifier, buildAnswer } from './notify.js';
import { injectMessage } from './inbox.js';
import { logToFile } from './logfile.js';

if (process.argv.includes('--log-file')) logToFile('whatsapp-only.log');

const cfg = loadConfig();
const { notify } = cfg;
if (!notify.enabled || !notify.token || !notify.to) {
  console.error('WhatsApp is not set up. Run:  npm run setup:whatsapp -- --to +<country code><number>');
  console.error('(it fills in HANDOFF_WHATSAPP_ENABLED, HANDOFF_WHATSAPP_TOKEN and HANDOFF_WHATSAPP_TO in .env)');
  process.exit(1);
}

const store = new Store(cfg);
// nothing is started by this mode, so there are no runner events; the notifier only scans the registry
const runner = Object.assign(new EventEmitter(), { bySession: () => null });

const notifier = new Notifier({ ...cfg, publicHostname: '' }, { // no web UI, so no "Open:" links
  store, runner,
  onAnswer: async (sessionId, pick) => {
    const q = store.pendingQuestion(sessionId);
    if (!q) throw new Error('That question is no longer open.');
    const { chosen, prompt } = buildAnswer(q, pick);
    const live = store.sessionInfo(sessionId)?.live;
    if (!live) throw new Error('That session is no longer running on the laptop.');
    await injectMessage(cfg.claudeHome, live, prompt);
    notifier.answered(sessionId, '');
    return { answered: chosen, queuedBehindPicker: true };
  }
}).start();

const status = await notifier.status();
console.log(`Handoff (WhatsApp only) watching ${cfg.claudeHome}`);
console.log(status.connected
  ? `WhatsApp sender linked as ${status.me || '?'}; notifications go to +${notify.to}`
  : `WhatsApp sender not reachable/linked at ${notify.url} (${status.error || 'open ' + notify.url + '/qr'}); will keep trying`);

const shutdown = () => { notifier.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 1 << 30); // the notifier's timers are unref'd; keep the process alive
