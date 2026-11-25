import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileBrowser, kindOf, decodeText, TEXT_MAX, IMAGE_MAX } from '../src/files.js';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-files-')));
const proj = path.join(tmp, 'proj');
const outside = path.join(tmp, 'outside');
for (const d of [path.join(proj, 'src', 'deep'), path.join(proj, 'secret-data'), outside]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(proj, 'README.md'), '# hi\n');
fs.writeFileSync(path.join(proj, 'src', 'app.js'), 'console.log(1);\n');
fs.writeFileSync(path.join(proj, 'src', 'file10.txt'), 'ten');
fs.writeFileSync(path.join(proj, 'src', 'file9.txt'), 'nine');
fs.writeFileSync(path.join(proj, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
fs.writeFileSync(path.join(proj, 'clip.mp4'), Buffer.alloc(16));
fs.writeFileSync(path.join(proj, 'blob.dat'), Buffer.from([1, 2, 0, 3, 0, 4]));
fs.writeFileSync(path.join(proj, '.env'), 'SECRET=1\n');
fs.writeFileSync(path.join(proj, 'secret-data', 'sessions.json'), '{}');
fs.writeFileSync(path.join(outside, 'passwords.txt'), 'nope');
// a folder link that points out of the project (a junction on Windows needs no admin rights)
fs.symlinkSync(outside, path.join(proj, 'escape'), 'junction');

const fb = new FileBrowser({ deny: [path.join(proj, '.env'), path.join(proj, 'secret-data')] });

test('kinds: images, text-like files, and never-previewed types', () => {
  assert.equal(kindOf('a.PNG'), 'image');
  assert.equal(kindOf('icon.svg'), 'image');
  assert.equal(kindOf('main.ts'), 'text');
  assert.equal(kindOf('mod.mts'), 'text');
  assert.equal(kindOf('Makefile'), 'text');
  assert.equal(kindOf('movie.mp4'), 'other');
  assert.equal(kindOf('archive.zip'), 'other');
});

test('a folder lists folders first, in natural order, without hidden files or links out of the project', () => {
  const root = fb.list(proj, '');
  assert.equal(root.folder, 'proj');
  assert.equal(root.path, '');
  assert.deepEqual(root.entries.map(e => e.name), ['src', 'blob.dat', 'clip.mp4', 'logo.png', 'README.md']);
  assert.deepEqual(root.entries.map(e => e.kind), [undefined, 'text', 'other', 'image', 'text']);
  const src = fb.list(proj, 'src');
  assert.equal(src.path, 'src');
  assert.deepEqual(src.entries.map(e => e.name), ['deep', 'app.js', 'file9.txt', 'file10.txt']);
});

test('nothing outside the project folder can be listed or read', () => {
  for (const p of ['..', '../outside/passwords.txt', 'src/../../outside', 'escape', 'escape/passwords.txt', outside, path.join(outside, 'passwords.txt'), 'C:/Windows/win.ini']) {
    assert.throws(() => fb.read(proj, p), e => [400, 403, 404].includes(e.status), p);
  }
  assert.throws(() => fb.list(proj, 'escape'), e => e.status === 403);
  assert.equal(fb.read(proj, '/src/app.js').path, 'src/app.js'); // a leading slash means the project root
});

test('denied files and folders are hidden and refused', () => {
  assert.throws(() => fb.read(proj, '.env'), e => e.status === 403);
  assert.throws(() => fb.list(proj, 'secret-data'), e => e.status === 403);
  assert.throws(() => fb.read(proj, 'secret-data/sessions.json'), e => e.status === 403);
});

test('text is returned; binary files and unsupported types are not', () => {
  const f = fb.read(proj, 'src/app.js');
  assert.equal(f.kind, 'text');
  assert.equal(f.text, 'console.log(1);\n');
  assert.equal(f.folder, 'proj');
  assert.equal(fb.read(proj, 'blob.dat').kind, 'other');
  assert.equal(fb.read(proj, 'blob.dat').text, undefined);
  assert.equal(fb.read(proj, 'clip.mp4').text, undefined);
  assert.throws(() => fb.read(proj, 'src'), e => e.status === 400);
  assert.throws(() => fb.list(proj, 'README.md'), e => e.status === 400);
});

test('long text is cut at 1 MB; UTF-16 and UTF-8 BOM files decode', () => {
  fs.writeFileSync(path.join(proj, 'big.log'), 'x'.repeat(TEXT_MAX + 10));
  const big = fb.read(proj, 'big.log');
  assert.equal(big.text.length, TEXT_MAX);
  assert.equal(big.truncated, true);
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x68, 0, 0x69, 0])), 'hi');
  assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6b])), 'ok');
});

test('images: details from read(), bytes from image(); too-large images and non-images are refused', () => {
  const r = fb.read(proj, 'logo.png');
  assert.equal(r.kind, 'image');
  assert.equal(r.text, undefined);
  const img = fb.image(proj, 'logo.png');
  assert.equal(img.type, 'image/png');
  assert.equal(img.size, 7);
  assert.throws(() => fb.image(proj, 'src/app.js'), e => e.status === 415);
  const huge = path.join(proj, 'huge.jpg');
  fs.closeSync(fs.openSync(huge, 'w')); fs.truncateSync(huge, IMAGE_MAX + 1); // sparse, takes no space
  assert.equal(fb.read(proj, 'huge.jpg').tooLarge, true);
  assert.throws(() => fb.image(proj, 'huge.jpg'), e => e.status === 413);
});

test('allowed folders: a project outside them is refused', () => {
  const limited = new FileBrowser({ allowedRoots: [outside] });
  assert.throws(() => limited.list(proj, ''), e => e.status === 403);
  assert.equal(limited.list(outside, '').entries[0].name, 'passwords.txt');
  assert.throws(() => fb.list(path.join(tmp, 'gone'), ''), e => e.status === 404);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
