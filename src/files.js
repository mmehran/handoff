// Read-only file browser for a session's project folder (HANDOFF_FILE_BROWSER=true).
// Every path is resolved inside that folder with symlinks and junctions followed, so nothing outside
// it can be listed or read. Handoff's own .env and data folder are never shown, even when a session
// runs in the Handoff folder itself. Text is returned as JSON; images are streamed as they are.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { httpErr } from './runner.js';

const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
};
// never previewed: video, audio, archives, executables and compiled code, documents, fonts, databases
const UNSUPPORTED = new Set(('mp4 m4v mov avi mkv webm wmv flv mpg mpeg 3gp m2ts ' + // not .ts/.mts: those are TypeScript
  'mp3 wav flac ogg oga opus m4a aac wma mid midi ' +
  'zip 7z rar gz tgz bz2 xz zst tar jar war ear nupkg whl ' +
  'exe dll so dylib bin obj o a lib pdb class pyc pyo wasm node msi dmg iso img apk ipa deb rpm ' +
  'pdf doc docx xls xlsx ppt pptx odt ods odp rtf psd ai sketch fig xcf heic tif tiff raw cr2 nef ' +
  'ttf otf woff woff2 eot sqlite sqlite3 db mdb accdb parquet pkl npy h5 onnx pt ckpt safetensors').split(' ').map(e => '.' + e));

export const TEXT_MAX = 1024 * 1024;        // longer text files are cut off here
export const IMAGE_MAX = 20 * 1024 * 1024;  // larger images aren't shown
const LIST_MAX = 2000;                      // entries per folder
export const DOWNLOAD_MAX = 100 * 1024 * 1024;
const FIND_SKIP = new Set(['.git', 'node_modules']); // never searched by name: huge, and rarely what you want

// 'image' | 'text' (a guess; confirmed when the file is opened) | 'other' (can't be previewed)
export function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  return IMAGE_TYPES[ext] ? 'image' : UNSUPPORTED.has(ext) ? 'other' : 'text';
}

const real = p => { try { return fs.realpathSync.native(p); } catch { return null; } };
const same = process.platform === 'win32' ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
function within(child, root) {
  if (same(child, root)) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return same(child.slice(0, prefix.length), prefix);
}

export class FileBrowser {
  // deny: files/folders that are never shown. allowedRoots: if set, only folders inside them.
  constructor({ deny = [], allowedRoots = [] } = {}) {
    this.deny = deny.map(p => real(p) || path.resolve(p));
    this.allowedRoots = allowedRoots.map(p => real(p) || path.resolve(p));
  }

  denied(abs) { return this.deny.some(d => within(abs, d)); }

  root(cwd) {
    const r = cwd && path.isAbsolute(cwd) ? real(cwd) : null;
    if (!r || !fs.statSync(r).isDirectory()) throw httpErr(404, 'the project folder no longer exists');
    if (this.allowedRoots.length && !this.allowedRoots.some(a => within(r, a))) throw httpErr(403, 'this folder is outside the allowed folders');
    return r;
  }

  // Like resolve(), for a path that may no longer exist (a deleted file in the Changes tab):
  // checked by its name, without following links.
  check(cwd, rel = '') {
    const root = this.root(cwd);
    rel = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.includes('\0') || /^[a-zA-Z]:/.test(rel)) throw httpErr(400, 'bad path');
    const abs = path.resolve(root, rel);
    if (!within(abs, root)) throw httpErr(403, 'that is outside the project folder');
    if (this.denied(real(abs) || abs)) throw httpErr(403, 'this file is hidden');
    return { root, abs, rel: path.relative(root, abs).split(path.sep).join('/') };
  }

  // Files and folders whose name contains q, anywhere in the project, nearest first. Links are not
  // followed, .git and node_modules are skipped, and the walk stops after `budget` entries.
  async find(cwd, q, { limit = 200, budget = 30000 } = {}) {
    const root = this.root(cwd);
    const needle = String(q || '').toLowerCase().trim();
    const results = [];
    let seen = 0, truncated = false;
    const queue = needle ? [''] : [];
    while (queue.length && !truncated) {
      const rel = queue.shift();
      let entries = [];
      try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
      for (const d of entries) {
        if (++seen > budget || results.length >= limit) { truncated = true; break; }
        const child = rel ? `${rel}/${d.name}` : d.name;
        if (d.isSymbolicLink() || this.denied(path.join(root, child))) continue;
        const dir = d.isDirectory();
        if (d.name.toLowerCase().includes(needle)) results.push(dir ? { path: child, type: 'dir' } : { path: child, type: 'file', kind: kindOf(d.name) });
        if (dir && !FIND_SKIP.has(d.name)) queue.push(child);
      }
    }
    return { folder: path.basename(root) || root, results, truncated };
  }

  download(cwd, rel) {
    const { abs, rel: where } = this.resolve(cwd, rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw httpErr(400, 'not a file');
    if (st.size > DOWNLOAD_MAX) throw httpErr(413, 'file too large to download (over 100 MB)');
    return { abs, path: where, name: path.basename(abs), size: st.size };
  }

  // rel: a path inside the folder, '/'-separated. Returns the real absolute path, checked.
  resolve(cwd, rel = '') {
    const root = this.root(cwd);
    rel = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (rel.includes('\0') || /^[a-zA-Z]:/.test(rel)) throw httpErr(400, 'bad path');
    const abs = real(path.resolve(root, rel));
    if (!abs) throw httpErr(404, 'not found');
    if (!within(abs, root)) throw httpErr(403, 'that is outside the project folder');
    if (this.denied(abs)) throw httpErr(403, 'this file is hidden');
    return { root, abs, rel: path.relative(root, abs).split(path.sep).join('/') };
  }

  list(cwd, rel) {
    const { root, abs, rel: where } = this.resolve(cwd, rel);
    if (!fs.statSync(abs).isDirectory()) throw httpErr(400, 'not a folder');
    const entries = [];
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      let target = path.join(abs, d.name);
      if (d.isSymbolicLink()) { target = real(target); if (!target || !within(target, root)) continue; } // links out of the folder are left out
      if (this.denied(target)) continue;
      let st;
      try { st = fs.statSync(target); } catch { continue; }
      if (st.isDirectory()) entries.push({ name: d.name, type: 'dir', mtime: st.mtimeMs });
      else if (st.isFile()) entries.push({ name: d.name, type: 'file', size: st.size, mtime: st.mtimeMs, kind: kindOf(d.name) });
    }
    entries.sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { folder: path.basename(root) || root, path: where, entries: entries.slice(0, LIST_MAX), truncated: entries.length > LIST_MAX };
  }

  // Text comes back in `text`. Images only get their details here; the bytes come from image().
  read(cwd, rel) {
    const { root, abs, rel: where } = this.resolve(cwd, rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw httpErr(400, 'not a file');
    const out = { folder: path.basename(root) || root, path: where, name: path.basename(abs), size: st.size, mtime: st.mtimeMs, kind: kindOf(abs) };
    if (out.kind === 'image') return { ...out, tooLarge: st.size > IMAGE_MAX };
    if (out.kind === 'other') return out;
    const buf = Buffer.alloc(Math.min(st.size, TEXT_MAX));
    const fd = fs.openSync(abs, 'r');
    let n;
    try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    const text = decodeText(buf.subarray(0, n));
    if (text == null) return { ...out, kind: 'other' };
    return { ...out, text, truncated: st.size > TEXT_MAX };
  }

  image(cwd, rel) {
    const { abs, rel: where } = this.resolve(cwd, rel);
    const st = fs.statSync(abs);
    const type = IMAGE_TYPES[path.extname(abs).toLowerCase()];
    if (!st.isFile() || !type) throw httpErr(415, 'not an image');
    if (st.size > IMAGE_MAX) throw httpErr(413, 'image too large to show');
    return { abs, path: where, name: path.basename(abs), size: st.size, type };
  }
}

// UTF-8 (with or without BOM) or UTF-16 with a BOM. null = binary, can't be shown as text.
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return null;
  const text = new TextDecoder('utf-8').decode(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf);
  const sample = text.slice(0, 8192);
  const bad = sample.length - sample.replaceAll('�', '').length;
  return bad > sample.length * 0.1 ? null : text;
}
