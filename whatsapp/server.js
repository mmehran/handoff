// Minimal WhatsApp sender for Handoff, built on the open-source Baileys library
// (WhatsApp Web multi-device protocol). Link once by scanning the QR at /qr with the phone
// whose number should SEND the notifications. Session keys persist in /data/auth.
//
//   GET  /qr      page with the current QR code (auto-refreshes; says "Linked" when done)
//   GET  /status  { connected, me }
//   GET  /inbox?since=<ms>  { now, messages:[{from,text,at}] }  replies from ALLOWED_TO (Bearer token)
//   POST /send    { to, text }   Authorization: Bearer <WA_TOKEN>; `to` must be in ALLOWED_TO
//   POST /logout  unlink this device                         (Bearer token)
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import pino from 'pino';
import * as Baileys from '@whiskeysockets/baileys';

// CommonJS package: pick the socket factory whichever way the interop exposes it
const makeWASocket = Baileys.makeWASocket || Baileys.default?.makeWASocket || Baileys.default?.default || Baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = { ...Baileys.default, ...Baileys };

const PORT = 3000;
const AUTH_DIR = '/data/auth';
const TOKEN = process.env.WA_TOKEN || '';
const ALLOWED = (process.env.ALLOWED_TO || '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
if (TOKEN.length < 24) { console.error('WA_TOKEN missing or too short'); process.exit(1); }
if (!ALLOWED.length) { console.error('ALLOWED_TO is empty'); process.exit(1); }

const logger = pino({ level: 'warn' });
let sock = null, qr = null, connected = false, me = null, retry = 0;
const inbox = [];   // replies waiting to be picked up by Handoff

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use built-in default */ }
  sock = makeWASocket({ auth: state, logger, version, browser: Browsers.appropriate('Handoff'), markOnlineOnConnect: false, syncFullHistory: false });
  sock.ev.on('creds.update', saveCreds);
  // Incoming replies from the allowed number(s). Kept in memory only; Handoff drains
  // them by polling /inbox, so nothing inbound has to be exposed to the internet.
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages || []) {
      if (msg.key?.fromMe) continue;
      const from = String(msg.key?.remoteJid || '').split('@')[0].replace(/\D/g, '');
      if (!ALLOWED.includes(from)) continue;
      const m = msg.message || {};
      const text = m.conversation || m.extendedTextMessage?.text ||
        m.buttonsResponseMessage?.selectedDisplayText || m.listResponseMessage?.title || '';
      if (!text.trim()) continue;
      inbox.push({ id: msg.key.id, from, text: text.slice(0, 4000), at: Date.now() });
      if (inbox.length > 200) inbox.splice(0, inbox.length - 200);
      console.log(`[wa] reply from +${from}: ${text.slice(0, 60)}`);
    }
  });
  sock.ev.on('connection.update', async (u) => {
    if (u.qr) {
      qr = u.qr;
      console.log('[wa] new QR code: open http://127.0.0.1:7870/qr on the laptop and scan it');
      console.log(await QRCode.toString(u.qr, { type: 'terminal', small: true }));
    }
    if (u.connection === 'open') {
      connected = true; qr = null; retry = 0;
      me = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
      console.log(`[wa] linked and connected as +${me}`);
    }
    if (u.connection === 'close') {
      connected = false;
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('[wa] unlinked from the phone; clearing session, a new QR will be shown');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        me = null;
      }
      const wait = Math.min(30, 2 ** Math.min(retry++, 5)) * 1000;
      console.log(`[wa] connection closed (${code ?? 'unknown'}); reconnecting in ${wait / 1000}s`);
      setTimeout(() => connect().catch(e => console.error('[wa] connect failed', e.message)), wait);
    }
  });
}

const authed = req => {
  const h = String(req.headers.authorization || '');
  const a = Buffer.from(h), b = Buffer.from(`Bearer ${TOKEN}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((resolve, reject) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 64 * 1024) { reject(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); } });
});

http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET' && req.url === '/status') return json(res, 200, { connected, me, waitingForScan: !!qr });
    if (req.method === 'GET' && req.url.startsWith('/inbox')) {
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
      const since = Number(new URL(req.url, 'http://x').searchParams.get('since')) || 0;
      const messages = inbox.filter(m => m.at > since);
      return json(res, 200, { now: Date.now(), messages });
    }
    if (req.method === 'GET' && req.url === '/qr') {
      const body = connected
        ? `<h1>✅ Linked</h1><p>Sending as +${me}. You can close this page.</p>`
        : qr
          ? `<h1>Link WhatsApp</h1><p>On the phone that should <b>send</b> notifications: WhatsApp → Settings → Linked devices → Link a device, then scan:</p><img alt="QR code" src="${await QRCode.toDataURL(qr, { width: 360, margin: 2 })}"><p class="m">The code refreshes about every 20 seconds; this page updates by itself.</p>`
          : '<h1>Starting…</h1><p>Waiting for WhatsApp to provide a QR code.</p>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'" });
      return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Handoff · WhatsApp</title><style>body{font:16px system-ui;max-width:440px;margin:40px auto;padding:0 16px;text-align:center;background:#14161a;color:#e6e8eb}img{background:#fff;padding:8px;border-radius:12px;max-width:100%}.m{color:#9aa1ab;font-size:13px}</style>${body}`);
    }
    if (req.method === 'POST' && req.url === '/send') {
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
      if (!connected) return json(res, 503, { error: 'WhatsApp not linked/connected' });
      const { to, text } = await readBody(req);
      const num = String(to || '').replace(/\D/g, '');
      if (!ALLOWED.includes(num)) return json(res, 403, { error: 'recipient not allowed' });
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) return json(res, 400, { error: 'bad text' });
      const r = await sock.sendMessage(`${num}@s.whatsapp.net`, { text });
      return json(res, 200, { ok: true, id: r?.key?.id });
    }
    if (req.method === 'POST' && req.url === '/logout') {
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
      await sock?.logout().catch(() => {});
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[wa] request failed', e.message);
    json(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`[wa] listening on :${PORT}; allowed recipients: ${ALLOWED.map(n => '+' + n).join(', ')}`));

connect().catch(e => { console.error('[wa] startup failed', e); process.exit(1); });
