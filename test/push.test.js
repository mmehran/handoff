import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encrypt, PushService, pushEndpointAllowed } from '../src/push.js';

const u = s => Buffer.from(s, 'base64url');

test('encryption matches the worked example in RFC 8291, byte for byte', () => {
  const body = encrypt('When I grow up, I want to be a watermelon',
    u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'), // UA public key
    u('BTBZMqHH6r4Tts7J_aSIgg'),                                                                   // auth secret
    { asKeys: { privateKey: u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') }, salt: u('DGv6ra1nlYgDCS1FRnbzlw') });
  assert.equal(body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('only real browser push services are accepted as destinations', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/QAB', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) assert.ok(pushEndpointAllowed(ok), ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.example/x', 'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com:8443/x', 'nonsense']) assert.ok(!pushEndpointAllowed(bad), bad);
});

test('subscribe, send (signed and encrypted for the device), drop expired devices', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-push-')));
  const calls = [];
  let status = 201;
  const svc = new PushService({ dataDir: dir, contact: 'https://h.example.com', fetchFn: async (url, opts) => { calls.push({ url, opts }); return { ok: status < 300, status }; } });
  // a device: its own key pair and auth secret, as a browser makes them
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  assert.throws(() => svc.subscribe({ ...sub, endpoint: 'https://127.0.0.1:7870/send' }), e => e.status === 400);
  svc.subscribe(sub, 'Test phone');
  assert.equal(svc.has(), true);

  const r = await svc.send({ title: '✅ Claude finished', body: 'Fix login bug · shop', url: '/#/s/abc', tag: 'abc:done' }, { urgent: true });
  assert.deepEqual(r, { sent: 1, failed: 0, expired: 0 });
  const { url, opts } = calls[0];
  assert.equal(url, sub.endpoint);
  assert.equal(opts.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(opts.headers.Urgency, 'high');

  // the VAPID token is signed with the server's key for the push service's origin
  const [, t, k] = /^vapid t=([^,]+), k=(\S+)$/.exec(opts.headers.Authorization);
  assert.equal(k, svc.publicKey);
  const [h, c, s] = t.split('.');
  const claims = JSON.parse(u(c));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'https://h.example.com');
  const pub = u(k);
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, u(s)));

  // the device can decrypt it (RFC 8291, receiving side)
  const body = opts.body;
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const hm = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const secret = ua.computeSecret(asPublic);
  const ikm = hm(hm(auth, secret), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hm(salt, ikm);
  const cek = hm(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hm(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  assert.equal(plain.at(-1), 2);
  assert.deepEqual(JSON.parse(plain.subarray(0, -1)), { title: '✅ Claude finished', body: 'Fix login bug · shop', url: '/#/s/abc', tag: 'abc:done' });

  // the keys survive a restart; a device the push service says is gone is removed
  assert.equal(new PushService({ dataDir: dir, contact: 'x' }).publicKey, svc.publicKey);
  status = 410;
  assert.deepEqual(await svc.send({ title: 'x' }), { sent: 0, failed: 0, expired: 1 });
  assert.equal(svc.has(), false);
  assert.equal(new PushService({ dataDir: dir, contact: 'x' }).has(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
