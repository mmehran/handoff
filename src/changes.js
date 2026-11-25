// Git for a session's folder, for the Changes tab: what changed since the last commit (including files
// not added to git yet) and one file's diff; with HANDOFF_GIT_ACTIONS also commit, push and discard.
// git runs without a shell, with fixed arguments. Paths go through the same checks as the Files tab, and
// only files the Changes tab lists can be committed or discarded; they reach git as literal pathspecs
// (never patterns or options). git never asks for a password or opens a sign-in window: it fails instead.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { decodeText, TEXT_MAX } from './files.js';
import { httpErr } from './runner.js';

const LIST_MAX = 500;
const DIFF_MAX = 1024 * 1024;
const BACKUP_DAYS = 30;

const QUIET = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };

function git(cwd, args, { input, timeout = 15000, maxBuffer = 8 * 1024 * 1024, both = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', '--no-pager', ...args],
      { timeout, maxBuffer, windowsHide: true, encoding: 'utf8', env: { ...process.env, ...QUIET } },
      (err, stdout, stderr) => {
        if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
        resolve(both ? { stdout, stderr } : stdout);
      });
    p.stdin?.on('error', () => {});
    p.stdin?.end(input ?? '');
  });
}
const literal = ['--literal-pathspecs'];
const nul = list => list.join('\0') + '\0';

// one git command at a time per repository folder (two at once trip over git's index.lock)
const locks = new Map();
async function locked(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = prev.then(() => new Promise(r => { release = r; }));
  locks.set(key, mine);
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(key) === mine) locks.delete(key); }
}

// git's own words, shortened, for the page: "fatal: …" lines, or the last line it printed
function gitMessage(e) {
  if (e.code === 'ENOENT') return 'git is not installed on the computer';
  if (e.killed || e.signal) return 'git took too long and was stopped';
  const lines = String(e.stderr || e.stdout || e.message || '').split('\n').map(s => s.trim()).filter(Boolean);
  const main = lines.filter(l => /^(fatal|error):/i.test(l));
  return (main.length ? main : lines.slice(-2)).join(' ').replace(/^(fatal|error):\s*/i, '').slice(0, 400) || 'git failed';
}

function kindOf(xy) {
  if (xy === '??') return 'untracked';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflict';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('A')) return 'added';
  if (xy.includes('D')) return 'deleted';
  return 'modified';
}

const remotesOf = async root => (await git(root, ['remote']).catch(() => '')).split('\n').map(s => s.trim()).filter(Boolean);
const branchOf = async root => (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
const upstreamOf = async root => (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();

// How the branch stands against its remote: commits not pushed yet (and not pulled yet)
async function syncState(root, branch) {
  const remotes = await remotesOf(root);
  if (!branch) return { upstream: null, ahead: 0, behind: 0, remotes: remotes.length };
  const upstream = await upstreamOf(root);
  let ahead = 0, behind = 0;
  if (upstream) {
    const [b, a] = (await git(root, ['rev-list', '--left-right', '--count', '@{u}...HEAD']).catch(() => '0 0')).trim().split(/\s+/).map(Number);
    ahead = a || 0; behind = b || 0;
  } else if (remotes.length) {
    ahead = Number((await git(root, ['rev-list', '--count', 'HEAD', '--not', '--remotes']).catch(() => '0')).trim()) || 0;
  }
  return { upstream: upstream || null, ahead, behind, remotes: remotes.length };
}

// { git: false, reason } or { git: true, branch, detached, files: [{ path, status, from? }], truncated,
//   upstream, ahead, behind, remotes, worktree }
export async function changes(files, cwd) {
  const root = files.root(cwd);
  let top;
  try { top = (await git(root, ['rev-parse', '--show-toplevel'])).trim(); }
  catch (e) { return { git: false, reason: e.code === 'ENOENT' ? 'git is not installed on the computer' : 'this folder is not in a git repository' }; }
  const branch = await branchOf(root);
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  // -z: "XY path\0", and a rename adds "\0<old path>"; paths are relative to the repository root
  const parts = out.split('\0');
  const list = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const xy = p.slice(0, 2), file = p.slice(3);
    const from = xy.includes('R') || xy.includes('C') ? parts[++i] : undefined;
    const abs = path.resolve(top, file);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel) || files.denied(abs)) continue;
    const entry = { path: rel.split(path.sep).join('/'), status: kindOf(xy) };
    if (from) entry.from = path.relative(root, path.resolve(top, from)).split(path.sep).join('/');
    list.push(entry);
  }
  list.sort((a, b) => a.path.localeCompare(b.path));
  return {
    git: true, branch: branch || 'HEAD', detached: !branch, files: list.slice(0, LIST_MAX), truncated: list.length > LIST_MAX,
    ...(await syncState(root, branch)), worktree: worktreeName(path.resolve(top))
  };
}

// The diff of one file against the last commit. A file git doesn't track yet is shown as all added.
export async function diff(files, cwd, rel) {
  const { root, abs, rel: where } = files.check(cwd, rel);
  let text = '';
  try { text = await git(root, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--', abs], { maxBuffer: DIFF_MAX * 4 }); }
  catch { text = ''; } // e.g. no commits yet
  if (!text.trim()) {
    const tracked = await git(root, ['ls-files', '--error-unmatch', '--', abs]).then(() => true, () => false);
    if (!tracked) {
      let buf = null;
      try { buf = await fsp.readFile(abs); } catch { /* deleted meanwhile */ }
      const body = buf ? decodeText(buf.subarray(0, TEXT_MAX)) : '';
      if (buf && body == null) text = `Binary file ${where} (new, not in git yet)\n`;
      else if (buf) {
        const lines = body.split('\n');
        if (lines.at(-1) === '') lines.pop();
        text = `--- /dev/null\n+++ b/${where}\n@@ -0,0 +1,${lines.length} @@ (new file, not in git yet)\n` + lines.map(l => '+' + l).join('\n') + '\n';
      }
    }
  }
  const truncated = text.length > DIFF_MAX;
  return { path: where, diff: truncated ? text.slice(0, DIFF_MAX) : text, truncated };
}

// The listed files among `paths` (all of them when none are given). Anything else (hidden files,
// files outside the folder, files without changes) is never touched.
async function pick(files, cwd, paths) {
  const c = await changes(files, cwd);
  if (!c.git) throw httpErr(409, `nothing to do: ${c.reason}`);
  const listed = new Map(c.files.map(f => [f.path, f]));
  const want = Array.isArray(paths) ? paths.map(p => String(p)) : [...listed.keys()];
  const picked = [...new Set(want)].map(p => listed.get(p)).filter(Boolean);
  if (!picked.length) throw httpErr(400, Array.isArray(paths) && paths.length ? 'those files have no changes any more' : 'there are no changes to commit');
  if (picked.some(f => f.status === 'conflict')) throw httpErr(409, 'a file has a merge conflict: resolve it on the laptop (or ask Claude to) first');
  return { c, picked };
}

// Commit the chosen files (default: every listed file), with exactly these files and nothing else that
// happens to be staged. New files are added first. Returns the new commit.
export async function commit(files, cwd, { message, paths } = {}) {
  message = String(message ?? '').replace(/\r\n?/g, '\n').trim();
  if (!message) throw httpErr(400, 'write a commit message first');
  if (message.length > 20000) throw httpErr(413, 'the commit message is too long');
  const root = files.root(cwd);
  return locked(root, async () => {
    const { c, picked } = await pick(files, cwd, paths);
    if (c.detached) throw httpErr(409, 'not on a branch (detached HEAD): commit on the laptop');
    const added = picked.filter(f => f.status === 'untracked').map(f => f.path);
    const specs = [...new Set(picked.flatMap(f => [f.path, f.from].filter(Boolean)))];
    const msgFile = path.join(os.tmpdir(), `handoff-commit-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(msgFile, message + '\n');
    try {
      if (added.length) await git(root, [...literal, 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nul(added) });
      await git(root, [...literal, 'commit', '-q', '--cleanup=whitespace', '-F', msgFile, '--only', '--pathspec-from-file=-', '--pathspec-file-nul'],
        { input: nul(specs), timeout: 120000 }); // hooks may run
    } catch (e) {
      if (added.length) await git(root, [...literal, 'reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nul(added) }).catch(() => {});
      throw httpErr(409, `commit failed: ${gitMessage(e)}`);
    } finally { fs.rmSync(msgFile, { force: true }); }
    const [hash, subject] = (await git(root, ['log', '-1', '--format=%h%x00%s'])).trim().split('\0');
    return { ok: true, hash, subject, files: picked.length, branch: c.branch };
  });
}

// Push the current branch. A branch without an upstream is pushed to `origin` (or the only remote) and
// tracks it from then on. The hosting site's "open a pull request" link is passed on when it prints one.
export async function push(files, cwd) {
  const root = files.root(cwd);
  return locked(root, async () => {
    const branch = await branchOf(root);
    if (!branch) throw httpErr(409, 'not on a branch (detached HEAD): push from the laptop');
    const remotes = await remotesOf(root);
    if (!remotes.length) throw httpErr(409, 'this repository has no remote to push to');
    const upstream = await upstreamOf(root);
    let remote = upstream ? upstream.split('/')[0] : null, args = ['push'];
    if (!upstream) {
      const conf = async k => (await git(root, ['config', '--get', k]).catch(() => '')).trim();
      remote = (await conf(`branch.${branch}.pushRemote`)) || (await conf('remote.pushDefault')) ||
        (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '');
      if (!remote || !remotes.includes(remote)) throw httpErr(409, 'this repository has several remotes and none is the default: push from the laptop once');
      args = ['push', '--set-upstream', remote, branch];
    }
    let out;
    try { out = await git(root, args, { timeout: 120000, both: true }); }
    catch (e) {
      const t = String(e.stderr || '');
      if (/\[rejected\]|fetch first|non-fast-forward/i.test(t)) throw httpErr(409, "push refused: the remote has commits this branch doesn't. Pull them on the laptop (or ask Claude to pull and merge) first.");
      if (/authentication|could not read (username|password)|terminal prompts disabled|permission denied|403/i.test(t)) throw httpErr(409, "git couldn't sign in to the remote. Push once from the laptop so it remembers the sign-in, then try again.");
      throw httpErr(409, `push failed: ${gitMessage(e)}`);
    }
    const text = `${out.stderr}\n${out.stdout}`;
    const pr = pullRequestLink(text) || await compareLink(root, remote, branch);
    const upToDate = /Everything up-to-date/i.test(text);
    return { ok: true, branch, remote, upToDate, ...(pr || {}) };
  });
}

// "remote: https://github.com/o/r/pull/new/branch" and the like, as the hosting site printed it
export function pullRequestLink(text) {
  const view = text.match(/remote:\s+.*?(https:\/\/[^\s]+\/(?:pull|pull-requests|merge_requests)\/\d+)\b/);
  if (view) return { prUrl: view[1], prLabel: 'View pull request' };
  const open = text.match(/remote:\s+(https:\/\/[^\s]+(?:\/pull\/new\/|\/merge_requests\/new|\/pull-requests\/new)[^\s]*)/);
  return open ? { prUrl: open[1], prLabel: 'Open a pull request' } : null;
}

// GitHub doesn't print a link for every push: build its compare page for branches other than the default
async function compareLink(root, remote, branch) {
  const url = (await git(root, ['remote', 'get-url', remote]).catch(() => '')).trim();
  const m = url.match(/^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const head = (await git(root, ['symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`]).catch(() => '')).trim();
  const main = head ? head.slice(remote.length + 1) : '';
  if (branch === main || (!main && /^(main|master)$/.test(branch))) return null;
  return { prUrl: `https://github.com/${m[1]}/${m[2]}/compare/${encodeURIComponent(branch)}?expand=1`, prLabel: 'Open a pull request' };
}

// Throw away one file's changes: back to the last commit, or gone if it is new. A copy of the file as it
// was is kept first in `backupDir` (pruned after 30 days), so a wrong tap can be undone by hand.
export async function discard(files, cwd, rel, backupDir) {
  const { root, abs, rel: where } = files.check(cwd, rel);
  return locked(root, async () => {
    const { picked: [f] } = await pick(files, cwd, [where]);
    const from = f.from ? files.check(cwd, f.from) : null;
    let saved = null;
    try {
      if (fs.statSync(abs).isFile()) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dest = path.join(backupDir, stamp, path.basename(root), ...where.split('/'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(abs, dest);
        saved = dest;
      }
    } catch (e) { if (e.code !== 'ENOENT') throw httpErr(500, `couldn't keep a copy first, so nothing was discarded: ${e.message}`); }
    pruneBackups(backupDir);
    const inHead = p => git(root, ['cat-file', '-e', `HEAD:./${p}`]).then(() => true, () => false);
    try {
      for (const p of [where, from?.rel].filter(Boolean)) {
        if (await inHead(p)) await git(root, [...literal, 'restore', '--source=HEAD', '--staged', '--worktree', '--', p]);
        else {
          await git(root, [...literal, 'rm', '--cached', '-q', '-f', '--ignore-unmatch', '--', p]);
          if (p === where) await fsp.rm(abs, { force: true });
        }
      }
    } catch (e) { throw httpErr(409, `discard failed: ${gitMessage(e)}`); }
    return { ok: true, path: where, status: f.status, saved };
  });
}

function pruneBackups(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - BACKUP_DAYS * 86400e3;
  for (const n of names) {
    const p = path.join(dir, n);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true }); } catch { /* in use */ }
  }
}

// What Claude needs to write a commit message: the recent commit subjects (for the style) and the diff
// of the chosen files, cut down to a size a quick model reads in seconds.
export async function commitContext(files, cwd, paths) {
  const root = files.root(cwd);
  const { picked } = await pick(files, cwd, paths);
  const recent = (await git(root, ['log', '-8', '--format=%s']).catch(() => '')).trim();
  const tracked = picked.filter(f => f.status !== 'untracked').flatMap(f => [f.path, f.from].filter(Boolean)).slice(0, 80);
  let body = '';
  if (tracked.length) {
    const stat = await git(root, [...literal, 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--stat', '--', ...tracked]).catch(() => '');
    const d = await git(root, [...literal, 'diff', 'HEAD', '--no-color', '--no-ext-diff', '-U2', '--', ...tracked], { maxBuffer: 32 * 1024 * 1024 }).catch(() => '');
    body += stat + '\n' + d;
  }
  for (const f of picked.filter(x => x.status === 'untracked').slice(0, 8)) {
    let text = '';
    try { text = decodeText(fs.readFileSync(path.join(root, f.path)).subarray(0, 4000)) ?? '(binary file)'; } catch { /* gone */ }
    body += `\nNew file ${f.path}:\n${text.split('\n').slice(0, 40).join('\n')}\n`;
  }
  const more = picked.length > 88 ? `\n(and ${picked.length - 88} more files)` : '';
  return 'Write a git commit message for the changes below. Use the imperative mood and keep the first line under 72 characters. ' +
    'Add a short body (a blank line, then a few lines or bullets) only when the change needs explaining. ' +
    'Match the style of the recent commits. No Co-Authored-By or other trailers. ' +
    'Reply with only the commit message: no quotes, no code fences, nothing else.\n\n' +
    (recent ? `Recent commits:\n${recent}\n\n` : '') +
    `Files: ${picked.map(f => f.path).join(', ').slice(0, 4000)}${more}\n\n` + body.slice(0, 40000);
}

// ---------- worktrees ----------
// A new session can get its own git worktree: a separate folder with its own branch, made from the last
// commit, at <repository>/.claude/worktrees/<name> (where Claude Code keeps its own), so two sessions
// on one project don't edit the same files. The folder is left out of the main checkout's git status.
const WT_RE = /[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)[\\/]?$/;
export const worktreeName = dir => (String(dir || '').match(WT_RE) || [])[1] || null;

export function worktreeSlug(text) {
  const s = String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter(Boolean).slice(0, 5).join('-').slice(0, 40).replace(/-+$/, '');
  return s || `session-${new Date().toISOString().slice(0, 10)}`;
}

export async function createWorktree(cwd, name) {
  let top;
  try { top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(); }
  catch (e) { throw httpErr(400, e.code === 'ENOENT' ? 'git is not installed on the computer' : "that folder isn't in a git repository, so it can't have a worktree"); }
  top = path.resolve(top);
  if (worktreeName(top)) throw httpErr(400, 'that folder is already a worktree: start the session in the main project folder');
  const head = await git(top, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '');
  if (!head.trim()) throw httpErr(400, 'the repository has no commits yet, so there is nothing to start a worktree from');
  // the session keeps the same place inside the project as the folder that was picked
  const sub = path.relative(top, path.resolve(cwd));
  const base = worktreeSlug(name);
  return locked(top, async () => {
    const dir = path.join(top, '.claude', 'worktrees');
    let slug = base;
    for (let n = 2; fs.existsSync(path.join(dir, slug)) || await branchExists(top, `handoff/${slug}`); n++) slug = `${base}-${n}`;
    await excludeWorktrees(top);
    const wt = path.join(dir, slug);
    const branch = `handoff/${slug}`;
    fs.mkdirSync(dir, { recursive: true });
    try { await git(top, ['worktree', 'add', '-q', '-b', branch, wt, 'HEAD'], { timeout: 120000 }); }
    catch (e) { throw httpErr(409, `couldn't make the worktree: ${gitMessage(e)}`); }
    const folder = sub && !sub.startsWith('..') && !path.isAbsolute(sub) ? path.join(wt, sub) : wt;
    return { cwd: fs.existsSync(folder) ? folder : wt, worktree: wt, branch, from: (await git(top, ['log', '-1', '--format=%h %s']).catch(() => '')).trim() };
  });
}

const branchExists = (top, b) => git(top, ['show-ref', '--verify', '-q', `refs/heads/${b}`]).then(() => true, () => false);

// .claude/worktrees/ goes in the repository's own exclude list (never committed), so the main
// checkout's Changes tab doesn't show the worktrees as new files
async function excludeWorktrees(top) {
  let common = (await git(top, ['rev-parse', '--git-common-dir'])).trim();
  common = path.resolve(top, common);
  const file = path.join(common, 'info', 'exclude');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  if (/^\/?\.claude\/worktrees\/?\s*$/m.test(text)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text + (text && !text.endsWith('\n') ? '\n' : '') + '/.claude/worktrees/\n');
}

// Remove a session's worktree folder once its work is committed. Its branch is kept.
export async function removeWorktree(files, cwd) {
  const root = files.root(cwd);
  let top;
  try { top = path.resolve((await git(root, ['rev-parse', '--show-toplevel'])).trim()); }
  catch { throw httpErr(409, 'this folder is not in a git repository'); }
  const name = worktreeName(top);
  if (!name) throw httpErr(400, "this session's folder isn't a worktree");
  const c = await changes(files, top);
  if (c.files.length) throw httpErr(409, 'the worktree has uncommitted changes: commit or discard them first');
  const main = path.resolve(top, '..', '..', '..');
  const branch = await branchOf(top);
  try { await git(main, ['worktree', 'remove', top], { timeout: 60000 }); }
  catch (e) { throw httpErr(409, `couldn't remove the worktree: ${gitMessage(e)}`); }
  return { ok: true, name, branch: branch || null };
}

// A just-made worktree that its session couldn't start in: removed again, with its branch
export async function dropWorktree(wt) {
  const main = path.resolve(wt.worktree, '..', '..', '..');
  await git(main, ['worktree', 'remove', '--force', wt.worktree], { timeout: 60000 }).catch(() => {});
  await git(main, ['branch', '-D', wt.branch]).catch(() => {});
}

// Claude's reply as a commit message: without code fences, quotes or a "Commit message:" lead-in
export function tidyMessage(text) {
  let t = String(text || '').replace(/\r\n?/g, '\n').trim();
  t = t.replace(/^```[\w-]*\n([\s\S]*?)\n```$/, '$1').trim();
  t = t.replace(/^(here(?: is|'s) (?:a |the )?)?commit message:?\s*\n+/i, '').trim();
  if (/^(["'`])[\s\S]*\1$/.test(t) && !t.slice(1, -1).includes(t[0])) t = t.slice(1, -1).trim();
  return t.slice(0, 20000);
}
