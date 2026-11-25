// Commit, push and discard from the Changes tab, and sessions in their own worktree, on throwaway
// repositories (the "remote" is a bare repository in the same temp folder).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FileBrowser } from '../src/files.js';
import { changes, commit, push, discard, commitContext, tidyMessage, pullRequestLink, createWorktree, removeWorktree, worktreeSlug, worktreeName } from '../src/changes.js';

// commits made by the code under test need an author, whatever the machine's git config says
Object.assign(process.env, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-git-')));
const remote = path.join(tmp, 'remote.git');
const repo = path.join(tmp, 'repo');
const backups = path.join(tmp, 'backups');
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const read = rel => fs.readFileSync(path.join(repo, rel), 'utf8');
const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: repo, stdio: 'pipe', encoding: 'utf8' }).trim();

execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
fs.mkdirSync(repo);
git('init', '-q', '-b', 'main');
git('config', 'core.autocrlf', 'false');
write('a.txt', 'one\n'); write('b.txt', 'two\n'); write('keep.txt', 'keep\n'); write('old.txt', 'old\n'); write('.env', 'SECRET=1\n');
git('add', '-A'); git('commit', '-q', '-m', 'first');
git('remote', 'add', 'origin', remote);

const fb = new FileBrowser({ deny: [path.join(repo, '.env')] });

test('commits only the chosen files, new ones included, and nothing else that was staged', async () => {
  write('a.txt', 'one!\n'); write('b.txt', 'two!\n'); write('new file.md', '# new\n');
  git('add', 'b.txt'); // staged, but not chosen: stays out of the commit
  const r = await commit(fb, repo, { message: 'Change a and add a note\n\nBody line.', paths: ['a.txt', 'new file.md', 'not-changed.txt'] });
  assert.equal(r.files, 2);
  assert.equal(r.subject, 'Change a and add a note');
  assert.equal(git('show', '--format=', '--name-only', 'HEAD').split('\n').sort().join(','), 'a.txt,new file.md');
  assert.equal(git('log', '-1', '--format=%B'), 'Change a and add a note\n\nBody line.');
  assert.deepEqual((await changes(fb, repo)).files.map(f => f.path), ['b.txt']);
});

test('commit refuses an empty message, files without changes, and hidden files', async () => {
  await assert.rejects(commit(fb, repo, { message: '  ', paths: ['b.txt'] }), e => e.status === 400);
  await assert.rejects(commit(fb, repo, { message: 'x', paths: ['keep.txt'] }), e => e.status === 400);
  write('.env', 'SECRET=2\n');
  await assert.rejects(commit(fb, repo, { message: 'x', paths: ['.env'] }), e => e.status === 400);
  git('checkout', '--', '.env');
});

test('push: a branch without an upstream gets one, then plain pushes; the counts follow', async () => {
  let c = await changes(fb, repo);
  assert.equal(c.upstream, null);
  assert.ok(c.ahead >= 2);
  const r = await push(fb, repo);
  assert.equal(r.branch, 'main');
  assert.equal(r.remote, 'origin');
  c = await changes(fb, repo);
  assert.equal(c.upstream, 'origin/main');
  assert.equal(c.ahead, 0);
  await commit(fb, repo, { message: 'Change b', paths: ['b.txt'] });
  assert.equal((await changes(fb, repo)).ahead, 1);
  await push(fb, repo);
  assert.equal(execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8' }).trim(), 'Change b');
});

test('the hosting site\'s pull request link is picked out of the push output', () => {
  assert.deepEqual(pullRequestLink("remote: Create a pull request for 'fix' on GitHub by visiting:\nremote:      https://github.com/o/r/pull/new/fix\n"),
    { prUrl: 'https://github.com/o/r/pull/new/fix', prLabel: 'Open a pull request' });
  assert.deepEqual(pullRequestLink('remote: View merge request for fix:\nremote:   https://gitlab.com/o/r/-/merge_requests/12\n'),
    { prUrl: 'https://gitlab.com/o/r/-/merge_requests/12', prLabel: 'View pull request' });
  assert.equal(pullRequestLink('To github.com:o/r.git\n   abc..def  main -> main\n'), null);
});

test('discard: back to the last commit, a new file gone, a rename undone; a copy is kept each time', async () => {
  write('keep.txt', 'mistake\n');
  let r = await discard(fb, repo, 'keep.txt', backups);
  assert.equal(read('keep.txt'), 'keep\n');
  assert.equal(fs.readFileSync(r.saved, 'utf8'), 'mistake\n');

  write('scratch.txt', 'not in git\n');
  r = await discard(fb, repo, 'scratch.txt', backups);
  assert.ok(!fs.existsSync(path.join(repo, 'scratch.txt')));
  assert.equal(fs.readFileSync(r.saved, 'utf8'), 'not in git\n');

  git('mv', 'old.txt', 'renamed.txt');
  await discard(fb, repo, 'renamed.txt', backups);
  assert.equal(read('old.txt'), 'old\n');
  assert.ok(!fs.existsSync(path.join(repo, 'renamed.txt')));

  fs.rmSync(path.join(repo, 'keep.txt'));
  await discard(fb, repo, 'keep.txt', backups);
  assert.equal(read('keep.txt'), 'keep\n');
  assert.deepEqual((await changes(fb, repo)).files, []);

  await assert.rejects(discard(fb, repo, 'keep.txt', backups), e => e.status === 400); // no changes
  await assert.rejects(discard(fb, repo, '../outside.txt', backups), e => e.status === 403);
  await assert.rejects(discard(fb, repo, '.env', backups), e => e.status === 403);
});

test('what Claude gets to write a commit message, and how its answer is tidied', async () => {
  write('a.txt', 'one, again\n'); write('fresh.js', 'export const x = 1;\n');
  const p = await commitContext(fb, repo, ['a.txt', 'fresh.js']);
  assert.match(p, /Recent commits:\nChange b/);
  assert.match(p, /^\+one, again$/m);
  assert.match(p, /New file fresh\.js:\nexport const x = 1;/);
  assert.match(p, /No Co-Authored-By/);
  assert.equal(tidyMessage('```\nFix the thing\n\nWhy.\n```'), 'Fix the thing\n\nWhy.');
  assert.equal(tidyMessage('Commit message:\n\n"Fix it"'), 'Fix it');
  assert.equal(tidyMessage('Fix "quoted" word'), 'Fix "quoted" word');
  git('checkout', '--', 'a.txt'); fs.rmSync(path.join(repo, 'fresh.js'));
});

test('a session in its own worktree: new folder and branch, kept out of the main git status, removed when clean', async () => {
  assert.equal(worktreeSlug('Fix the login bug, please!'), 'fix-the-login-bug-please');
  assert.match(worktreeSlug('???'), /^session-\d{4}-\d{2}-\d{2}$/);
  const wt = await createWorktree(repo, 'Fix the login bug');
  assert.equal(wt.branch, 'handoff/fix-the-login-bug');
  assert.equal(wt.cwd, path.join(repo, '.claude', 'worktrees', 'fix-the-login-bug'));
  assert.equal(worktreeName(wt.cwd), 'fix-the-login-bug');
  assert.equal(fs.readFileSync(path.join(wt.cwd, 'a.txt'), 'utf8'), 'one!\n');
  assert.deepEqual((await changes(fb, repo)).files, [], 'the worktree folder is not a change in the main checkout');
  assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/\.claude\/worktrees\/$/m);

  const again = await createWorktree(repo, 'Fix the login bug');
  assert.equal(again.branch, 'handoff/fix-the-login-bug-2');
  await assert.rejects(createWorktree(wt.cwd, 'nested'), e => e.status === 400);

  const c = await changes(fb, wt.cwd);
  assert.equal(c.worktree, 'fix-the-login-bug');
  assert.equal(c.branch, 'handoff/fix-the-login-bug');

  fs.writeFileSync(path.join(wt.cwd, 'a.txt'), 'changed in the worktree\n');
  await assert.rejects(removeWorktree(fb, wt.cwd), e => e.status === 409);
  await commit(fb, wt.cwd, { message: 'Work in the worktree' });
  assert.equal(read('a.txt'), 'one!\n', 'the main checkout is untouched');
  const r = await removeWorktree(fb, wt.cwd);
  assert.equal(r.branch, 'handoff/fix-the-login-bug');
  assert.ok(!fs.existsSync(wt.cwd));
  assert.equal(git('log', '-1', '--format=%s', 'handoff/fix-the-login-bug'), 'Work in the worktree', 'the branch is kept');
  await assert.rejects(removeWorktree(fb, repo), e => e.status === 400);
  await removeWorktree(fb, again.cwd);
});

test('a folder outside git cannot get a worktree', async () => {
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  await assert.rejects(createWorktree(plain, 'x'), e => e.status === 400);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));
