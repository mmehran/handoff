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

// For a session running on the laptop: save the photos in its project folder and return the text to
// add to the message. Old uploads (over a week) are cleared out on the way.
export async function saveForLiveSession(cwd, images) {
  const dir = path.join(cwd, UPLOAD_DIR);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, '.gitignore'), '# photos sent from Handoff; not part of the project\n*\n');
  try {
    for (const name of await fsp.readdir(dir)) {
      if (name === '.gitignore') continue;
      const st = await fsp.stat(path.join(dir, name));
      if (Date.now() - st.mtimeMs > KEEP_DAYS * 86400e3) await fsp.rm(path.join(dir, name), { force: true });
    }
  } catch { /* cleanup is best effort */ }
  const names = [];
  for (const img of images) {
    const name = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}.${EXT[img.media_type]}`;
    await fsp.writeFile(path.join(dir, name), img.bytes);
    names.push(`${UPLOAD_DIR}/${name}`);
  }
  return `\n\n(I attached ${names.length === 1 ? 'a photo' : `${names.length} photos`} from my phone: ${names.join(', ')}. Open ${names.length === 1 ? 'it' : 'them'} with the Read tool to see ${names.length === 1 ? 'it' : 'them'}.)`;
}
