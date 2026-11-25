// Webhooks: with `webhook: "https://..."` on a send, Handoff POSTs the turn to that address when it
// needs an approval and when it ends (done, error, interrupted), so a program doesn't have to keep asking.
//
//   X-Handoff-Event:      turn.waiting_for_approval | turn.done | turn.error | turn.interrupted
//   X-Handoff-Signature:  t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the key's webhook secret>
//
// HTTPS only, no redirects followed, 10 s per try, 3 retries (after 5 s, 30 s and 2 min). Every address
// the name resolves to is checked when connecting (so a name can't switch to an internal address
// between a check and the request): loopback, private, link-local, CGNAT, multicast and IPv4-mapped
// forms of them are refused, so a webhook can never reach this computer's own services.
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import crypto from 'node:crypto';
import { apiErr } from './api-util.js';

const RETRIES = [5e3, 30e3, 120e3];
const TEXT_MAX = 100 * 1024;

const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]]) blocked.addSubnet(a, p, 'ipv6');

// an address a webhook may not reach
export function isPrivate(address) {
  const a = String(address).replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a) || /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(a);
  if (mapped) {
    const v4 = mapped[2] ? [parseInt(mapped[1], 16) >> 8, parseInt(mapped[1], 16) & 255, parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255].join('.') : mapped[1];
    return blocked.check(v4, 'ipv4');
  }
  const family = net.isIP(a);
  if (!family) return true;
  return blocked.check(a, family === 4 ? 'ipv4' : 'ipv6');
}

// checks a webhook address given on a send -> the URL, or throws a 400
export function checkWebhook(value, { allowLocal = false } = {}) {
  if (value == null || value === '') return null;
  let u;
  try { u = new URL(String(value)); } catch { throw apiErr(400, 'invalid_webhook', '"webhook" must be a full https:// address.'); }
  if (String(value).length > 2000) throw apiErr(400, 'invalid_webhook', '"webhook" is too long.');
  if (u.protocol !== 'https:' && !(allowLocal && u.protocol === 'http:')) throw apiErr(400, 'invalid_webhook', '"webhook" must use https://.');
  if (u.username || u.password) throw apiErr(400, 'invalid_webhook', '"webhook" can\'t carry a user name or password.');
  if (!allowLocal && (u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivate(u.hostname)))) {
    throw apiErr(400, 'invalid_webhook', '"webhook" can\'t point at this computer or a private network.');
  }
  return u.toString();
}

export function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

// one POST; resolves with the status code, rejects on a refused address, a timeout or a network error
export function deliver(url, body, headers, { allowLocal = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowLocal && net.isIP(host) && isPrivate(host)) return reject(new Error('the address is private'));
    const lookup = (hostname, options, cb) => dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!allowLocal && (!addrs.length || addrs.some(a => isPrivate(a.address)))) return cb(new Error(`${hostname} resolves to a private address`));
      if (options?.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST', lookup, timeout: 10e3,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Handoff-Webhooks/1', ...headers }
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('timeout', () => req.destroy(new Error('timed out after 10 s')));
    req.on('error', reject);
    req.end(body);
  });
}

// Sends a turn's webhooks as it needs an approval and when it ends.
export function addWebhooks(api, core) {
  const { turns } = api;
  const allowLocal = () => !!core.cfg.webhookTestAllowLocal; // set by the tests only
  api.checkWebhook = v => checkWebhook(v, { allowLocal: allowLocal() });

  const send = (t, event) => {
    if (!t.webhook) return;
    const view = turns.view(t);
    if (view.text?.length > TEXT_MAX) view.text = view.text.slice(0, TEXT_MAX);
    view.messages = view.messages?.map(m => m.slice(0, TEXT_MAX));
    const payload = JSON.stringify({ event: `turn.${event}`, sentAt: new Date().toISOString(), turn: view });
    const secret = core.keys.get(t.keyId)?.webhookSecret || t.key.webhookSecret;
    const attempt = async n => {
      let outcome;
      try {
        const status = await deliver(t.webhook, payload, { 'X-Handoff-Event': `turn.${event}`, 'X-Handoff-Signature': sign(secret, payload), 'X-Handoff-Delivery': `${t.id}.${event}.${n}` }, { allowLocal: allowLocal() });
        outcome = status >= 200 && status < 300 ? null : `answered ${status}`;
      } catch (e) { outcome = e.message; }
      core.audit(t.ip, 'api_webhook', { via: 'api', key: t.keyName, keyId: t.keyId, turnId: t.id, event, try: n + 1, error: outcome || undefined });
      const wait = core.cfg.webhookTestRetryMs ?? RETRIES[n]; // the tests retry sooner
      if (outcome && n < RETRIES.length) { const timer = setTimeout(() => attempt(n + 1), wait); timer.unref?.(); }
    };
    attempt(0);
  };

  turns.on('state', (t, name) => {
    if (t.status === 'waiting_for_approval' && t.pending?.id && t.hookedApproval !== t.pending.id) {
      t.hookedApproval = t.pending.id;
      send(t, 'waiting_for_approval');
    }
  });
  turns.on('finished', t => send(t, t.status));
}
