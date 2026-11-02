import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// ---------- passwords (scrypt) ----------
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, SCRYPT);
  // ':'-separated so the hash can sit in a .env file without any $ expansion issues ('$' is still accepted)
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  if (typeof pw !== 'string' || !stored) return false;
  const [alg, N, r, p, saltB64, hashB64] = stored.split(/[:$]/);
  if (!hashB64) return false;
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length,
    { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(got, expected);
}

// ---------- TOTP (RFC 6238, SHA1, 30s, 6 digits) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function totpAt(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

let lastTotpCounter = -1; // replay protection: a code can be used only once

export function verifyTotp(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const counter = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) {
    const c = counter + d;
    const a = Buffer.from(totpAt(secret, c));
    if (crypto.timingSafeEqual(a, Buffer.from(String(code)))) {
      if (c <= lastTotpCounter) return false;
      lastTotpCounter = c;
      return true;
    }
  }
  return false;
}

export function _resetTotpReplay() { lastTotpCounter = -1; }

// ---------- login sessions ----------
const SESS_FILE = path.join(DATA_DIR, 'sessions.json');
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

export class SessionStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.map = new Map(); // sha256(token) -> {created, lastSeen, ip, ua}
    try {
      const raw = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
    } catch { /* none yet */ }
    this.prune();
  }
  persist() {
    try { fs.writeFileSync(SESS_FILE, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 }); } catch { /* ignore */ }
  }
  create(ip, ua) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.map.set(sha(token), { created: now, lastSeen: now, ip, ua: String(ua || '').slice(0, 200) });
    this.persist();
    return token;
  }
  check(token) {
    if (!token) return null;
    const key = sha(token);
    const s = this.map.get(key);
    if (!s) return null;
    const now = Date.now();
    if (now - s.lastSeen > this.cfg.sessionIdleHours * 3600e3 || now - s.created > this.cfg.sessionMaxDays * 86400e3) {
      this.map.delete(key); this.persist(); return null;
    }
    if (now - s.lastSeen > 60e3) { s.lastSeen = now; this.persist(); }
    return s;
  }
  destroy(token) { if (token && this.map.delete(sha(token))) this.persist(); }
  destroyAll() { this.map.clear(); this.persist(); }
  list() { return [...this.map.values()]; }
  prune() {
    for (const [k, s] of this.map) {
      const now = Date.now();
      if (now - s.lastSeen > this.cfg.sessionIdleHours * 3600e3 || now - s.created > this.cfg.sessionMaxDays * 86400e3) this.map.delete(k);
    }
    this.persist();
  }
}

// ---------- brute-force protection ----------
export class LoginLimiter {
  constructor({ perIp = 5, global = 20, windowMs = 15 * 60e3, lockMs = 15 * 60e3 } = {}) {
    Object.assign(this, { perIp, global, windowMs, lockMs });
    this.fails = new Map(); // ip -> [timestamps]
    this.globalFails = [];
    this.globalLockUntil = 0;
  }
  _recent(arr, now) { return arr.filter(t => now - t < this.windowMs); }
  blocked(ip, now = Date.now()) {
    if (now < this.globalLockUntil) return true;
    return this._recent(this.fails.get(ip) || [], now).length >= this.perIp;
  }
  fail(ip, now = Date.now()) {
    const arr = this._recent(this.fails.get(ip) || [], now); arr.push(now); this.fails.set(ip, arr);
    this.globalFails = this._recent(this.globalFails, now); this.globalFails.push(now);
    if (this.globalFails.length >= this.global) this.globalLockUntil = now + this.lockMs;
  }
  success(ip) { this.fails.delete(ip); }
}
