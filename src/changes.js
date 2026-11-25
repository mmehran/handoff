// Read-only git view of a session's folder for the Changes tab: what changed since the last commit
// (including files not added to git yet) and the diff of one file. git runs without a shell, with
// fixed arguments, and paths go through the same checks as the Files tab.
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { decodeText, TEXT_MAX } from './files.js';

const LIST_MAX = 500;
const DIFF_MAX = 1024 * 1024;

function git(cwd, args, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', '--no-pager', ...args],
      { timeout: 15000, maxBuffer, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function kindOf(xy) {
  if (xy === '??') return 'untracked';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflict';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('A')) return 'added';
  if (xy.includes('D')) return 'deleted';
  return 'modified';
}

// { git: false, reason } or { git: true, branch, files: [{ path, status, from? }], truncated }
export async function changes(files, cwd) {
  const root = files.root(cwd);
  let top;
  try { top = (await git(root, ['rev-parse', '--show-toplevel'])).trim(); }
  catch (e) { return { git: false, reason: e.code === 'ENOENT' ? 'git is not installed on the computer' : 'this folder is not in a git repository' }; }
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
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
  return { git: true, branch, files: list.slice(0, LIST_MAX), truncated: list.length > LIST_MAX };
}

// The diff of one file against the last commit. A file git doesn't track yet is shown as all added.
export async function diff(files, cwd, rel) {
  const { root, abs, rel: where } = files.check(cwd, rel);
  let text = '';
  try { text = await git(root, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--', abs], DIFF_MAX * 4); }
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
