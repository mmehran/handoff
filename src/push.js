// Phone push notifications (Web Push), with no third-party code: VAPID signing (RFC 8292) and
// aes128gcm message encryption (RFC 8291) on node:crypto. A device opts in from the web app; its
// subscription and the server's key pair live in data/. Messages are encrypted for the device, so
// the push service (Google, Apple, Mozilla, Microsoft) only carries them and can't read them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { httpErr } from './runner.js';

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// The only places subscriptions may point: the browsers' own push services. Anything else (a local
// address, say) is refused, so a stored subscription can't make the server call arbitrary URLs.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/,
  /^push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];
export function pushEndpointAllowed(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some(re => re.test(u.hostname));
}

// RFC 8291: encrypt `payload` for a subscription (uaPublic = p256dh, authSecret = auth).
// asKeys and salt can be given for tests (the RFC's worked example); normally they're random.
export function encrypt(payload, uaPublic, authSecret, { asKeys, salt = crypto.randomBytes(16) } = {}) {
  const ecdh = crypto.createECDH('prime256v1');
  if (asKeys) ecdh.setPrivateKey(asKeys.privateKey); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export class PushService {
  constructor({ dataDir, contact, log = () => {}, fetchFn = fetch }) {
    this.keyFile = path.join(dataDir, 'push-keys.json');
    this.subFile = path.join(dataDir, 'push-subscriptions.json');
    this.contact = contact;
    this.log = log;
    this.fetch = fetchFn;
    this.keys = this.loadKeys();
    try { this.subs = JSON.parse(fs.readFileSync(this.subFile, 'utf8')); } catch { this.subs = []; }
  }

  // VAPID key pair (P-256), made on first use and kept in data/push-keys.json
  loadKeys() {
    try {
      const k = JSON.parse(fs.readFileSync(this.keyFile, 'utf8'));
      return { privateKey: crypto.createPrivateKey({ key: k.jwk, format: 'jwk' }), publicKey: k.publicKey };
    } catch { /* first run */ }
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const raw = b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
    fs.writeFileSync(this.keyFile, JSON.stringify({ jwk: privateKey.export({ format: 'jwk' }), publicKey: raw }), { mode: 0o600 });
    return { privateKey, publicKey: raw };
  }
  get publicKey() { return this.keys.publicKey; }
  has() { return this.subs.length > 0; }
  save() { fs.writeFileSync(this.subFile, JSON.stringify(this.subs, null, 2), { mode: 0o600 }); }

  subscribe(sub, ua = '') {
    const endpoint = String(sub?.endpoint || '');
    const p256dh = String(sub?.keys?.p256dh || ''), auth = String(sub?.keys?.auth || '');
    if (!pushEndpointAllowed(endpoint)) throw httpErr(400, 'that is not a browser push service address');
    if (unb64u(p256dh).length !== 65 || unb64u(auth).length !== 16) throw httpErr(400, 'invalid subscription keys');
    this.subs = this.subs.filter(s => s.endpoint !== endpoint);
    this.subs.push({ endpoint, keys: { p256dh, auth }, ua: String(ua).slice(0, 160), created: Date.now() });
    this.subs = this.subs.slice(-20); // a few devices; old ones drop off
    this.save();
  }
  unsubscribe(endpoint) {
    const before = this.subs.length;
    this.subs = this.subs.filter(s => s.endpoint !== endpoint);
    if (this.subs.length !== before) this.save();
  }

  // RFC 8292: a signed token per push service origin, valid for 12 hours
  vapid(endpoint) {
    const aud = new URL(endpoint).origin;
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: this.contact }));
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: this.keys.privateKey, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${head}.${claims}.${b64u(sig)}, k=${this.keys.publicKey}`;
  }

  // { title, body, url, tag } to every subscribed device (an approval also carries its permission id and
  // Allow / Deny buttons). Expired subscriptions are dropped.
  async send(msg, { urgent = false, only } = {}) {
    const payload = JSON.stringify({ title: msg.title, body: String(msg.body || '').slice(0, 1500), url: msg.url || '/', tag: msg.tag,
      permission: msg.permission, actions: Array.isArray(msg.actions) ? msg.actions.slice(0, 2) : undefined });
    const results = await Promise.all(this.subs.filter(s => !only || s.endpoint === only).map(async s => {
      try {
        const r = await this.fetch(s.endpoint, {
          method: 'POST', signal: AbortSignal.timeout(15000),
          headers: { Authorization: this.vapid(s.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: urgent ? 'high' : 'normal' },
          body: encrypt(payload, unb64u(s.keys.p256dh), unb64u(s.keys.auth))
        });
        if (r.status === 404 || r.status === 410) { this.unsubscribe(s.endpoint); return 'expired'; }
        if (!r.ok) { this.log(`[push] ${new URL(s.endpoint).hostname} said ${r.status}`); return 'failed'; }
        return 'sent';
      } catch (e) { this.log(`[push] could not reach ${new URL(s.endpoint).hostname}: ${e.message}`); return 'failed'; }
    }));
    return { sent: results.filter(x => x === 'sent').length, failed: results.filter(x => x === 'failed').length, expired: results.filter(x => x === 'expired').length };
  }
}
