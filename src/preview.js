// App preview (HANDOFF_PREVIEW_HOSTNAME): the dev server Claude is working on (localhost:3000, a Vite
// or Next.js app, ...) opened from a phone through the tunnel.
//
// It has its own hostname (e.g. preview.example.com) rather than a path on Handoff's: an app served from
// Handoff's own origin could use the signed-in cookie to drive Handoff, and most dev servers only work
// at the root of a site anyway (/@vite/client, /_next/...). The web app hands out a one-time link; the
// preview host turns it into its own cookie, which picks the port. Everything on that host is then
// passed to 127.0.0.1:<port> (or [::1]), WebSockets included, so live reload keeps working.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { httpErr } from './runner.js';

const COOKIE = 'handoff_preview';
const TICKET_MS = 2 * 60e3;          // a link from the web app works once, within 2 minutes
const SESSION_MS = 12 * 3600e3;      // then the preview stays open for 12 hours
const NEVER = new Set([2375, 2376]); // Docker's API: never reachable through here
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

export class Preview {
  constructor(cfg, { log = console.log } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.tickets = new Map();  // ticket -> { port, exp }
    this.sessions = new Map(); // cookie token -> { port, exp }
    this.family = new Map();   // port -> '127.0.0.1' | '::1', whichever answered last
    this.ownPort = 0;          // the port Handoff itself listens on (set once it does)
  }

  get enabled() { return !!this.cfg.previewHostname; }
  get origin() { return `https://${this.cfg.previewHostname}`; }

  // a request for the preview host (cloudflared passes the visitor's Host header through)
  isPreviewHost(req) {
    if (!this.enabled) return false;
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    return host === this.cfg.previewHostname;
  }

  checkPort(port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw httpErr(400, 'Pick a port from 1024 to 65535.');
    const wa = Number(String(this.cfg.whatsapp?.url || '').match(/:(\d+)$/)?.[1]);
    if (p === this.cfg.port || p === this.ownPort || p === wa || NEVER.has(p)) throw httpErr(400, `Port ${p} can't be previewed.`);
    return p;
  }

  // the web app's "Open" button: a one-time link to the preview host
  ticket(port) {
    if (!this.enabled) throw httpErr(404, 'App preview is turned off (HANDOFF_PREVIEW_HOSTNAME).');
    port = this.checkPort(port);
    this.sweep();
    const t = crypto.randomBytes(24).toString('base64url');
    this.tickets.set(t, { port, exp: Date.now() + TICKET_MS });
    return { port, url: `${this.origin}/__handoff/enter?t=${t}` };
  }

  clear() { this.tickets.clear(); this.sessions.clear(); } // "sign out all devices"

  sweep() {
    const now = Date.now();
    for (const m of [this.tickets, this.sessions]) for (const [k, v] of m) if (v.exp < now) m.delete(k);
  }

  session(req) {
    const token = cookieOf(req.headers.cookie, COOKIE);
    const s = token && this.sessions.get(token);
    if (!s || s.exp < Date.now()) return null;
    return s;
  }

  // ---------- requests on the preview host ----------
  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__handoff/enter') return this.enter(req, res, url);
    const s = this.session(req);
    if (!s) return page(res, 401, 'Open this preview from Handoff', `Previews open from a session in Handoff: tap ⋯ → <b>Preview app</b>.${this.cfg.publicHostname ? ` <a href="https://${this.cfg.publicHostname}/">Go to Handoff</a>` : ''}`);
    this.forward(req, res, s.port);
  }

  enter(req, res, url) {
    const t = url.searchParams.get('t') || '';
    const tk = this.tickets.get(t);
    this.tickets.delete(t);
    if (!tk || tk.exp < Date.now()) return page(res, 403, 'This preview link has expired', 'Links from Handoff work once, for 2 minutes. Open the preview from Handoff again.');
    this.sweep();
    if (this.sessions.size > 200) this.sessions.delete(this.sessions.keys().next().value);
    const token = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(token, { port: tk.port, exp: Date.now() + SESSION_MS });
    res.writeHead(303, {
      'Set-Cookie': `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`,
      Location: '/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'
    });
    res.end();
  }

  // what the dev server sees: a visit to http://localhost:<port>, as if made on the computer
  headersFor(req, port) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith('cf-') && k !== 'cdn-loop') headers[k] = v;
    const local = `http://localhost:${port}`;
    headers.host = `localhost:${port}`;
    const cookie = stripCookie(req.headers.cookie, COOKIE);
    if (cookie) headers.cookie = cookie; else delete headers.cookie;
    for (const k of ['origin', 'referer']) if (typeof headers[k] === 'string') headers[k] = headers[k].replace(this.origin, local);
    headers['x-forwarded-host'] = this.cfg.previewHostname;
    headers['x-forwarded-proto'] = 'https';
    return headers;
  }

  forward(req, res, port, families = this.order(port)) {
    const host = families[0];
    const up = http.request({ host, port, method: req.method, path: req.url, headers: this.headersFor(req, port) }, r => {
      this.family.set(port, host);
      const headers = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) headers[k] = v;
      if (typeof headers.location === 'string') headers.location = headers.location.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}`), '') || '/';
      if (headers['set-cookie']) headers['set-cookie'] = [].concat(headers['set-cookie']).map(c => c.replace(/;\s*domain=[^;]*/i, ''));
      res.writeHead(r.statusCode || 502, headers);
      r.pipe(res);
    });
    up.on('error', e => {
      if (res.headersSent) return res.destroy();
      if (e.code === 'ECONNREFUSED' && families.length > 1) return this.forward(req, res, port, families.slice(1));
      page(res, 502, `Nothing is answering on port ${port}`, `Start the dev server on the computer (or ask Claude to), and this page tries again by itself.`, 3);
    });
    req.pipe(up);
  }

  order(port) { return this.family.get(port) === '::1' ? ['::1', '127.0.0.1'] : ['127.0.0.1', '::1']; }

  // WebSockets (live reload): the same check, then the raw connection is passed through
  upgrade(req, socket, head) {
    const s = this.session(req);
    if (!s) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    const headers = this.headersFor(req, s.port);
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade;
    const tryHost = families => {
      const up = net.connect({ host: families[0], port: s.port }, () => {
        up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).flatMap(([k, v]) => [].concat(v).map(x => `${k}: ${x}`)).join('\r\n')}\r\n\r\n`);
        if (head?.length) up.write(head);
        socket.pipe(up).pipe(socket);
        // one side gone: close the other too, or it stays open forever
        // (an upgraded socket is half-open: 'end' alone would never close it)
        for (const ev of ['end', 'close']) { up.on(ev, () => socket.destroy()); socket.on(ev, () => up.destroy()); }
      });
      up.on('error', e => {
        if (e.code === 'ECONNREFUSED' && families.length > 1) return tryHost(families.slice(1));
        socket.destroy();
      });
      socket.on('error', () => up.destroy());
    };
    tryHost(this.order(s.port));
  }

  // ---------- which dev servers are running ----------
  // Ports something on this computer listens on (loopback or every address), with the program's name
  // and, for ones that answer HTTP, the page title. Handoff's own ports are left out.
  async ports() {
    const found = await listening().catch(() => []);
    const out = [];
    for (const f of found) {
      try { this.checkPort(f.port); } catch { continue; }
      if (!out.some(o => o.port === f.port)) out.push(f);
    }
    out.sort((a, b) => a.port - b.port);
    await Promise.all(out.slice(0, 40).map(async p => Object.assign(p, await probe(p.port))));
    return out.filter(p => p.web).concat(out.filter(p => !p.web));
  }
}

// ports the session's transcript mentions (http://localhost:5173, 127.0.0.1:3000), newest first
export function mentionedPorts(text) {
  const seen = [];
  for (const m of String(text).matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{4,5})\b/g)) {
    const p = Number(m[1]);
    const i = seen.indexOf(p);
    if (i >= 0) seen.splice(i, 1);
    seen.unshift(p);
  }
  return seen.slice(0, 8);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (e, out) => e ? reject(e) : resolve(String(out))));
}

async function listening() {
  if (process.platform === 'win32') {
    const [ns, tl] = await Promise.all([run('netstat', ['-ano', '-p', 'TCP']).then(a => run('netstat', ['-ano', '-p', 'TCPv6']).then(b => a + b, () => a)), run('tasklist', ['/fo', 'csv', '/nh']).catch(() => '')]);
    const names = new Map();
    for (const line of tl.split(/\r?\n/)) { const c = line.match(/^"([^"]*)","(\d+)"/); if (c) names.set(Number(c[2]), c[1].replace(/\.exe$/i, '')); }
    const out = [];
    for (const line of ns.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (!m || !localAddr(m[1])) continue;
      out.push({ port: Number(m[2]), pid: Number(m[3]), process: names.get(Number(m[3])) || '' });
    }
    return out;
  }
  const text = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
  const out = [];
  let pid = 0, name = '';
  for (const line of text.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'c') name = line.slice(1);
    else if (line[0] === 'n') {
      const m = line.slice(1).match(/^(.*):(\d+)$/);
      if (m && localAddr(m[1])) out.push({ port: Number(m[2]), pid, process: name });
    }
  }
  return out;
}

const localAddr = a => ['0.0.0.0', '127.0.0.1', '[::]', '[::1]', '*', '::', '::1', 'localhost'].includes(a.replace(/%.*$/, ''));

// does it answer HTTP, and with what page title?
function probe(port) {
  const once = host => new Promise(resolve => {
    const r = http.get({ host, port, path: '/', headers: { host: `localhost:${port}`, accept: 'text/html' }, timeout: 1200 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; if (body.length > 32768) res.destroy(); });
      const done = () => resolve({ web: true, status: res.statusCode, title: (body.match(/<title[^>]*>([^<]{0,120})/i)?.[1] || '').trim() });
      res.on('end', done); res.on('close', done);
    });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve(null));
  });
  return once('127.0.0.1').then(r => r || once('::1')).then(r => r || { web: false });
}

function cookieOf(h = '', name) {
  for (const part of String(h).split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); }
  return '';
}

function stripCookie(h = '', name) {
  return String(h || '').split(';').map(s => s.trim()).filter(s => s && !s.startsWith(name + '=')).join('; ');
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function page(res, status, title, html, refresh = 0) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Robots-Tag': 'noindex' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<title>${esc(title)}</title><style>body{font:16px system-ui;max-width:440px;margin:15vh auto;padding:0 16px;color:#1d1f23;background:#f6f5f2}@media(prefers-color-scheme:dark){body{color:#e6e8eb;background:#14161a}a{color:#e8916f}}h1{font-size:20px}</style><h1>${esc(title)}</h1><p>${html}</p>`);
}
