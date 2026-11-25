// The folder picker on the New session page: the computer's drives (or HANDOFF_ALLOWED_ROOTS when set),
// the folders inside a folder (folders only, never files), and making a new folder for a new project.
// Paths are absolute and resolved with links followed; nothing outside the allowed folders is listed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { httpErr } from './runner.js';

const LIST_MAX = 1000;
// never listed: system folders, and folders that are only noise when picking a project
const SKIP = new Set(['$recycle.bin', 'system volume information', '$windows.~bt', '$windows.~ws', '$sysreset', 'recovery', 'config.msi', 'node_modules', '__pycache__']);
const BAD_NAME = /[<>:"/\\|?*\u0000-\u001f]|^\.+$|[. ]$|^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

const real = p => { try { return fs.realpathSync.native(p); } catch { return null; } };
const same = process.platform === 'win32' ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
function within(child, root) {
  if (same(child, root)) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return same(child.slice(0, prefix.length), prefix);
}
const isGit = dir => { try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; } };

export class FolderPicker {
  constructor({ allowedRoots = [] } = {}) {
    this.allowedRoots = allowedRoots.map(p => real(p) || path.resolve(p));
  }

  // Where browsing starts: the allowed folders, or every drive plus the home folder
  roots() {
    if (this.allowedRoots.length) return this.allowedRoots.filter(r => fs.existsSync(r)).map(r => ({ name: r, path: r, kind: 'root', git: isGit(r) }));
    const home = os.homedir();
    const list = [{ name: 'Home', path: home, kind: 'home', git: isGit(home) }];
    if (process.platform === 'win32') {
      for (let c = 65; c <= 90; c++) {
        const d = `${String.fromCharCode(c)}:\\`;
        try { if (fs.statSync(d).isDirectory()) list.push({ name: `${String.fromCharCode(c)}:`, path: d, kind: 'drive', git: false }); } catch { /* no such drive */ }
      }
    } else {
      list.push({ name: '/', path: '/', kind: 'drive', git: false });
      for (const base of ['/Volumes', '/mnt', '/media']) {
        try { for (const e of fs.readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) list.push({ name: path.join(base, e.name), path: path.join(base, e.name), kind: 'drive', git: false }); } catch { /* none */ }
      }
    }
    return list;
  }

  check(dir) {
    if (typeof dir !== 'string' || !dir.trim() || dir.includes('\0') || !path.isAbsolute(dir.trim())) throw httpErr(400, 'pick a full folder path');
    const r = real(path.resolve(dir.trim()));
    let st = null;
    try { st = r && fs.statSync(r); } catch { /* gone */ }
    if (!st || !st.isDirectory()) throw httpErr(404, "that folder doesn't exist");
    if (this.allowedRoots.length && !this.allowedRoots.some(a => within(r, a))) throw httpErr(403, 'that folder is outside the allowed folders (HANDOFF_ALLOWED_ROOTS)');
    return r;
  }

  // The folders inside `dir`, and where "up" goes (null at the top: a drive, or an allowed folder)
  list(dir) {
    const r = this.check(dir);
    let entries;
    try { entries = fs.readdirSync(r, { withFileTypes: true }); }
    catch (e) { throw httpErr(e.code === 'EPERM' || e.code === 'EACCES' ? 403 : 500, e.code === 'EPERM' || e.code === 'EACCES' ? "the computer doesn't let Handoff look inside this folder" : `can't read this folder: ${e.message}`); }
    const folders = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.has(e.name.toLowerCase())) continue;
      const p = path.join(r, e.name);
      let dirLike = e.isDirectory();
      if (!dirLike && e.isSymbolicLink()) { try { dirLike = fs.statSync(p).isDirectory(); } catch { /* broken link */ } }
      if (dirLike) folders.push(e.name);
    }
    folders.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    const up = path.dirname(r);
    const top = up === r || (this.allowedRoots.length && this.allowedRoots.some(a => same(a, r)));
    return {
      path: r, name: path.basename(r) || r, parent: top ? null : up, git: isGit(r),
      folders: folders.slice(0, LIST_MAX).map(name => ({ name, path: path.join(r, name), git: isGit(path.join(r, name)) })),
      truncated: folders.length > LIST_MAX
    };
  }

  // A new folder inside `parent`, optionally a new git repository (so it can have worktrees later)
  async make(parent, name, { git = false } = {}) {
    const r = this.check(parent);
    name = String(name ?? '').trim();
    if (!name || name.length > 120 || BAD_NAME.test(name)) throw httpErr(400, 'that is not a usable folder name');
    const dir = path.join(r, name);
    try { fs.mkdirSync(dir); }
    catch (e) { throw httpErr(e.code === 'EEXIST' ? 409 : 403, e.code === 'EEXIST' ? 'a folder with that name is already there' : `couldn't make the folder: ${e.message}`); }
    if (git) {
      await new Promise(res => execFile('git', ['init', '-q', dir], { windowsHide: true, timeout: 30000 }, () => res()));
    }
    return { path: dir, name, git: isGit(dir) };
  }
}
