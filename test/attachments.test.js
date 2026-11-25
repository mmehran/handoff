import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseImages, imageContent, saveForLiveSession, UPLOAD_DIR } from '../src/attachments.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]).toString('base64');

test('photos are checked: type, real image bytes, size, count', () => {
  assert.deepEqual(parseImages(undefined), []);
  const [p] = parseImages([{ media_type: 'image/png', data: png }]);
  assert.equal(p.media_type, 'image/png');
  assert.equal(p.bytes.length, 11);
  assert.throws(() => parseImages([{ media_type: 'image/png', data: jpg }]), e => e.status === 415, 'bytes must match the type');
  assert.throws(() => parseImages([{ media_type: 'image/svg+xml', data: png }]), e => e.status === 415);
  assert.throws(() => parseImages([{ media_type: 'image/png', data: 'not base64!' }]), e => e.status === 400);
  assert.throws(() => parseImages(Array(5).fill({ media_type: 'image/png', data: png })), e => e.status === 400);
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024)]).toString('base64');
  assert.throws(() => parseImages([{ media_type: 'image/jpeg', data: huge }]), e => e.status === 413);
});

test('image blocks for Claude Code: the text, then each photo', () => {
  const imgs = parseImages([{ media_type: 'image/jpeg', data: jpg }]);
  assert.deepEqual(imageContent('what is this?', imgs), [
    { type: 'text', text: 'what is this?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpg } }
  ]);
  assert.equal(imageContent('', imgs).length, 1);
});

test('for a session on the laptop, photos are saved in the project, ignored by git, and named in the message', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-uploads-'));
  const dir = path.join(cwd, UPLOAD_DIR);
  fs.mkdirSync(dir);
  const old = path.join(dir, 'old.jpg');
  fs.writeFileSync(old, 'x');
  fs.utimesSync(old, new Date(Date.now() - 8 * 86400e3), new Date(Date.now() - 8 * 86400e3));
  const note = await saveForLiveSession(cwd, parseImages([{ media_type: 'image/png', data: png }, { media_type: 'image/jpeg', data: jpg }]));
  const files = fs.readdirSync(dir).filter(n => n !== '.gitignore');
  assert.equal(files.length, 2, 'the week-old upload is gone');
  assert.match(note, /2 photos from my phone: \.handoff-uploads\/\S+\.png, \.handoff-uploads\/\S+\.jpg\. Open them with the Read tool/);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\*$/m);
  assert.deepEqual([...fs.readFileSync(path.join(dir, files.find(n => n.endsWith('.png'))))].slice(0, 4), [0x89, 0x50, 0x4e, 0x47]);
  fs.rmSync(cwd, { recursive: true, force: true });
});
