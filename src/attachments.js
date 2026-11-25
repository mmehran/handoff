// Photos attached to a prompt from the phone. Sessions Handoff runs get them as real image blocks
// (Claude Code's stream input supports that). Sessions open on the laptop are reached through their
// local inbox, which takes text, so there the photo is saved in the project folder under
// .handoff-uploads/ (ignored by git through its own .gitignore) and the message names the file;
// inside the project folder, Claude can open it without asking for permission on the laptop.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { httpErr } from './runner.js';

export const MAX_IMAGES = 4;
const MAX_BYTES = 5 * 1024 * 1024; // per image, as Claude accepts
const TYPES = {
  'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/gif': [0x47, 0x49, 0x46], 'image/webp': [0x52, 0x49, 0x46, 0x46]
};
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
const KEEP_DAYS = 7;
export const UPLOAD_DIR = '.handoff-uploads';

// [{ media_type, data (base64) }] from a request body -> checked list (the bytes must match the type)
export function parseImages(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw httpErr(400, 'images must be a list');
  if (list.length > MAX_IMAGES) throw httpErr(400, `at most ${MAX_IMAGES} photos per message`);
  return list.map(img => {
    const type = String(img?.media_type || '');
    const magic = TYPES[type];
    if (!magic) throw httpErr(415, 'photos must be JPEG, PNG, GIF or WebP');
    const data = String(img.data || '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw httpErr(400, 'photo is not valid base64');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > MAX_BYTES) throw httpErr(413, 'each photo must be under 5 MB');
    if (!magic.every((b, i) => bytes[i] === b)) throw httpErr(415, 'that file is not the image type it claims to be');
    return { media_type: type, data, bytes };
  });
}

// Claude Code message content: the text plus image blocks
export const imageContent = (text, images) => [
  ...(text ? [{ type: 'text', text }] : []),
  ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } }))
];

// Names Handoff gives the files it saves: <date>-<8 hex>[-<original name>].<ext>. Only such files are
// ever cleaned up.
const OURS = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}(-[A-Za-z0-9._-]{1,100})?$/;

// The project's .handoff-uploads folder, made safe to write into: a real folder inside the project
// (not a link to somewhere else), git-ignored, with files of ours over a week old cleared out.
export async function uploadsDir(cwd) {
  const dir = path.join(cwd, UPLOAD_DIR);
  try {
    const st = await fsp.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw httpErr(409, `${UPLOAD_DIR} in this project is not a plain folder, so nothing is saved there`);
  } catch (e) {
    if (e.status) throw e;
    await fsp.mkdir(dir, { recursive: true });
  }
  const [real, realCwd] = await Promise.all([fsp.realpath(dir), fsp.realpath(cwd)]);
  const rel = path.relative(realCwd, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw httpErr(409, `${UPLOAD_DIR} in this project points outside it, so nothing is saved there`);
  await fsp.writeFile(path.join(dir, '.gitignore'), '# files sent from Handoff; not part of the project\n*\n');
  try {
    for (const name of await fsp.readdir(dir)) {
      if (!OURS.test(name.replace(/\.[A-Za-z0-9]{1,10}$/, ''))) continue;
      const st = await fsp.lstat(path.join(dir, name));
      if (st.isFile() && Date.now() - st.mtimeMs > KEEP_DAYS * 86400e3) await fsp.rm(path.join(dir, name), { force: true });
    }
  } catch { /* cleanup is best effort */ }
  return dir;
}

// Saves files ({ bytes, name?, ext }) there; -> their paths inside the project (forward slashes)
export async function saveUploads(cwd, files) {
  const dir = await uploadsDir(cwd);
  const out = [];
  for (const f of files) {
    const stem = f.name ? String(f.name).replace(/\.[A-Za-z0-9]{1,10}$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) : '';
    const name = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}${stem ? '-' + stem : ''}.${f.ext}`;
    await fsp.writeFile(path.join(dir, name), f.bytes, { flag: 'wx' }); // never through an existing file or link
    out.push(`${UPLOAD_DIR}/${name}`);
  }
  return out;
}

// For a session running on the laptop: save the photos in its project folder and return the text to
// add to the message. Old uploads (over a week) are cleared out on the way.
export async function saveForLiveSession(cwd, images) {
  const names = await saveUploads(cwd, images.map(img => ({ bytes: img.bytes, ext: EXT[img.media_type] })));
  return `\n\n(I attached ${names.length === 1 ? 'a photo' : `${names.length} photos`} from my phone: ${names.join(', ')}. Open ${names.length === 1 ? 'it' : 'them'} with the Read tool to see ${names.length === 1 ? 'it' : 'them'}.)`;
}
