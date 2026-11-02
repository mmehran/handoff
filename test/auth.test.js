import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, base32Encode, base32Decode, totpAt, verifyTotp, _resetTotpReplay, LoginLimiter } from '../src/auth.js';

test('scrypt password hash verifies (and the older $-separated form still does)', () => {
  const h = hashPassword('correct horse battery');
  assert.ok(verifyPassword('correct horse battery', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('x', ''));
  assert.ok(!h.includes('$'), 'no $ so it is safe in .env and docker compose');
  assert.ok(verifyPassword('correct horse battery', h.replaceAll(':', '$')));
  assert.ok(!verifyPassword('x', 'scrypt:1'));
});

test('TOTP matches RFC 6238 SHA1 vectors', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  // RFC 6238 Appendix B (8-digit values, last 6 digits)
  assert.equal(totpAt(secret, Math.floor(59 / 30)), '287082');
  assert.equal(totpAt(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(totpAt(secret, Math.floor(1234567890 / 30)), '005924');
});

test('TOTP rejects replay and bad codes', () => {
  _resetTotpReplay();
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const now = Date.now();
  const code = totpAt(secret, Math.floor(now / 30000));
  assert.ok(verifyTotp(secret, code, now));
  assert.ok(!verifyTotp(secret, code, now), 'replay must fail');
  assert.ok(!verifyTotp(secret, 'abcdef', now));
});

test('login limiter blocks per IP and globally', () => {
  const l = new LoginLimiter({ perIp: 3, global: 5 });
  for (let i = 0; i < 3; i++) l.fail('a');
  assert.ok(l.blocked('a'));
  assert.ok(!l.blocked('b'));
  l.fail('b'); l.fail('c');
  assert.ok(l.blocked('z'), 'global lock after 5 failures');
});
