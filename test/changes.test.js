// Changes tab (git status + diff), find by name, and download, on a throwaway git repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FileBrowser } from '../src/files.js';
import { changes, diff } from '../src/changes.js';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-changes-')));
const repo = path.join(tmp, 'repo');
const sub = path.join(repo, 'app');
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const git = (...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd: repo, stdio: 'pipe' });

write('app/src/main.js', 'export const a = 1;\nexport const b = 2;\n');
write('app/old-name.txt', 'moving\n');
write('app/gone.txt', 'bye\n');
write('app/.env', 'SECRET=1\n');
write('top.txt', 'outside the session folder\n');
git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'first');
write('app/src/main.js', 'export const a = 1;\nexport const b = 3;\n');      // modified
write('app/new file.md', '# New\nhello\n');                                   // untracked, with a space
fs.rmSync(path.join(repo, 'app/gone.txt'));                                   // deleted
git('mv', 'app/old-name.txt', 'app/new-name.txt');                            // renamed
write('app/.env', 'SECRET=2\n');                                              // denied: never listed
write('top.txt', 'changed, but outside the session folder\n');
write('app/node_modules/pkg/refund.js', 'skip me\n');
write('app/src/payments/refund.js', 'x\n');

const fb = new FileBrowser({ deny: [path.join(sub, '.env')] });

test('lists what changed in the session folder only, with each kind of change', async () => {
  const c = await changes(fb, sub);
  assert.equal(c.git, true);
  assert.ok(c.branch);
  const byPath = Object.fromEntries(c.files.map(f => [f.path, f]));
  assert.equal(byPath['src/main.js'].status, 'modified');
  assert.equal(byPath['new file.md'].status, 'untracked');
  assert.equal(byPath['gone.txt'].status, 'deleted');
  assert.equal(byPath['new-name.txt'].status, 'renamed');
  assert.equal(byPath['new-name.txt'].from, 'old-name.txt');
  assert.ok(!byPath['.env'], 'denied files are left out');
  assert.ok(!c.files.some(f => f.path.includes('top.txt')), 'nothing from outside the session folder');
});

test('diffs: changed lines, a new file as all added, a deleted file, and no escaping', async () => {
  assert.match((await diff(fb, sub, 'src/main.js')).diff, /^-export const b = 2;$[\s\S]*^\+export const b = 3;$/m);
  const added = await diff(fb, sub, 'new file.md');
  assert.match(added.diff, /new file, not in git yet[\s\S]*^\+# New$/m);
  assert.match((await diff(fb, sub, 'gone.txt')).diff, /^-bye$/m);
  await assert.rejects(diff(fb, sub, '../top.txt'), e => e.status === 403);
  await assert.rejects(diff(fb, sub, '.env'), e => e.status === 403);
});

test('a folder that is not in git says so', async () => {
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  assert.deepEqual(await changes(fb, plain), { git: false, reason: 'this folder is not in a git repository' });
});

test('find by name: nearest first, skips node_modules and denied files', async () => {
  const r = await fb.find(sub, 'REFUND');
  assert.deepEqual(r.results.map(x => x.path), ['src/payments/refund.js']);
  assert.equal(r.folder, 'app');
  assert.deepEqual((await fb.find(sub, 'env')).results, []);
  assert.deepEqual((await fb.find(sub, '')).results, []);
  const limited = await fb.find(sub, 'e', { budget: 3 });
  assert.equal(limited.truncated, true);
});

test('download: any file inside the folder, nothing outside it', () => {
  const d = fb.download(sub, 'src/main.js');
  assert.equal(d.name, 'main.js');
  assert.throws(() => fb.download(sub, '../top.txt'), e => e.status === 403);
  assert.throws(() => fb.download(sub, '.env'), e => e.status === 403);
  assert.throws(() => fb.download(sub, 'src'), e => e.status === 400);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
