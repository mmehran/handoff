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
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-uploads-')));
  const dir = path.join(cwd, UPLOAD_DIR);
  fs.mkdirSync(dir);
  const weekAgo = new Date(Date.now() - 8 * 86400e3);
  const old = path.join(dir, '2026-01-01-0a1b2c3d.jpg'); // one Handoff saved
  fs.writeFileSync(old, 'x');
  fs.utimesSync(old, weekAgo, weekAgo);
  const mine = path.join(dir, 'my-notes.txt'); // someone else's: never deleted
  fs.writeFileSync(mine, 'x');
  fs.utimesSync(mine, weekAgo, weekAgo);
  const note = await saveForLiveSession(cwd, parseImages([{ media_type: 'image/png', data: png }, { media_type: 'image/jpeg', data: jpg }]));
  const files = fs.readdirSync(dir).filter(n => n !== '.gitignore' && n !== 'my-notes.txt');
  assert.equal(files.length, 2, 'the week-old upload is gone');
  assert.ok(fs.existsSync(mine), 'files Handoff didn\'t name are left alone');
  assert.match(note, /2 photos from my phone: \.handoff-uploads\/\S+\.png, \.handoff-uploads\/\S+\.jpg\. Open them with the Read tool/);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\*$/m);
  assert.deepEqual([...fs.readFileSync(path.join(dir, files.find(n => n.endsWith('.png'))))].slice(0, 4), [0x89, 0x50, 0x4e, 0x47]);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('nothing is saved through a .handoff-uploads that is a link to somewhere else', async t => {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-uploads-')));
  const elsewhere = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-elsewhere-')));
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(elsewhere, { recursive: true, force: true }); });
  try { fs.symlinkSync(elsewhere, path.join(cwd, UPLOAD_DIR), 'junction'); } catch { return t.skip('links can\'t be made here'); }
  await assert.rejects(saveForLiveSession(cwd, parseImages([{ media_type: 'image/png', data: png }])), /not a plain folder|points outside/);
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was written through the link');
});
