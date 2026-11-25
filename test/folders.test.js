// The New session folder picker: drives or allowed folders, folders only, and making a new folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FolderPicker } from '../src/folders.js';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-folders-')));
const allowed = path.join(tmp, 'projects');
for (const d of ['projects/shop/.git', 'projects/blog', 'projects/.hidden', 'projects/node_modules', 'outside']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
fs.writeFileSync(path.join(allowed, 'notes.txt'), 'a file, not a folder');

test('without allowed folders: the home folder and the drives', () => {
  const roots = new FolderPicker().roots();
  assert.equal(roots[0].kind, 'home');
  assert.ok(roots.some(r => r.kind === 'drive'));
});

test('folders only, sorted, git projects marked, hidden and noise folders left out', () => {
  const p = new FolderPicker();
  const l = p.list(allowed);
  assert.deepEqual(l.folders.map(f => f.name), ['blog', 'shop']);
  assert.equal(l.folders.find(f => f.name === 'shop').git, true);
  assert.equal(l.parent, tmp);
  assert.throws(() => p.list('relative/path'), e => e.status === 400);
  assert.throws(() => p.list(path.join(tmp, 'nope')), e => e.status === 404);
});

test('with allowed folders: those are the top, and nothing outside them is listed', () => {
  const p = new FolderPicker({ allowedRoots: [allowed] });
  assert.deepEqual(p.roots().map(r => r.path), [allowed]);
  assert.equal(p.list(allowed).parent, null);
  assert.equal(p.list(path.join(allowed, 'blog')).parent, allowed);
  assert.throws(() => p.list(path.join(tmp, 'outside')), e => e.status === 403);
  assert.throws(() => p.list(tmp), e => e.status === 403);
});

test('a new folder, optionally a git repository; bad names and existing folders are refused', async () => {
  const p = new FolderPicker({ allowedRoots: [allowed] });
  const made = await p.make(allowed, 'new app', { git: true });
  assert.equal(made.path, path.join(allowed, 'new app'));
  assert.equal(made.git, true);
  assert.equal((await p.make(allowed, 'plain')).git, false);
  for (const bad of ['', '..', 'a/b', 'a\\b', 'con', 'x:', 'trailing.']) await assert.rejects(p.make(allowed, bad), e => e.status === 400, bad);
  await assert.rejects(p.make(allowed, 'blog'), e => e.status === 409);
  await assert.rejects(p.make(path.join(tmp, 'outside'), 'x'), e => e.status === 403);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));
