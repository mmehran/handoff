// The API's files: what's attached to a prompt, and the project's files, changes and git.
//
// Attaching: JSON `files: [{ name, data (base64) }]` and `images: [{ media_type, data }]`, or a
// multipart/form-data upload (file parts, the other fields as text, or all of them as JSON in a
// `json` field). Photos go to Claude as images. Small text files go straight into the prompt. Other
// files are saved in the session's folder under .handoff-uploads/ (git-ignored, cleared after a week)
// and named in the prompt, for Claude's Read tool; with no tools, a PDF goes in as a document.
// `@name` in the prompt points at an attached file; an @path outside the session's folder is refused,
// as Claude Code reads @paths straight into the prompt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { saveUploads } from './attachments.js';
import { changes, diff, commit as gitCommit, push as gitPush, discard as gitDiscard, commitContext, tidyMessage, removeWorktree } from './changes.js';
import { json } from './http-util.js';
import { apiErr, isWithin } from './api-util.js';

const MAX_FILES = 10, MAX_TOTAL = 50 * 1024 * 1024, PHOTO_MAX = 5 * 1024 * 1024, INLINE_MAX = 100 * 1024;
const IMAGES = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/gif': [0x47, 0x49, 0x46], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
// files that aren't text but are fine to hand to Claude (it opens them with its tools)
const BINARY_OK = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|zip|gz|tgz|tar|7z|sqlite|db|parquet|ipynb|mp3|wav|m4a|mp4|mov|heic|bmp|tiff?|ico|svgz|woff2?|ttf|otf)$/i;
const NUMBERS = new Set(['wait', 'timeout', 'maxBudgetUsd']);
const BOOLEANS = new Set(['plain', 'save', 'fork', 'stream', 'select', 'allow']);
const size = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function kindOf(f) {
  for (const [type, magic] of Object.entries(IMAGES)) {
    if (magic.every((b, i) => f.bytes[i] === b)) return f.bytes.length <= PHOTO_MAX ? { kind: 'image', type, ext: IMAGE_EXT[type] } : { kind: 'binary', ext: IMAGE_EXT[type] };
  }
  if (f.bytes.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf', ext: 'pdf' };
  const ext = (/\.([A-Za-z0-9]{1,10})$/.exec(f.name || '') || [])[1]?.toLowerCase();
  const head = f.bytes.subarray(0, 8192);
  if (!head.includes(0)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(f.bytes); return { kind: 'text', ext: ext || 'txt' }; } catch { /* not UTF-8 */ }
  }
  if (ext && BINARY_OK.test('.' + ext)) return { kind: 'binary', ext };
  throw apiErr(415, 'unsupported_file', `"${f.name || 'a file'}" isn't text, a PDF, a photo or a known document type, so it wasn't sent.`);
}

export function addFiles(api, core) {
  const { cfg, files, folderPicker, audit, runner } = core;
  const { route, sessionFor } = api;
  const maxBytes = () => Math.max(1, Number(cfg.apiUploadMb) || 20) * 1024 * 1024;

  // multipart/form-data -> the same body as JSON, with the file parts in _uploads
  api.readMultipart = async (req, ct, limit) => {
    let n = 0; const chunks = [];
    for await (const c of req) { n += c.length; if (n > limit) throw apiErr(413, 'too_large', `The upload is larger than ${Math.round(limit / 1048576)} MB.`); chunks.push(c); }
    let form;
    try { form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': ct } }).formData(); }
    catch { throw apiErr(400, 'invalid_request', 'That multipart upload couldn\'t be read.'); }
    const b = {}, uploads = [];
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') {
        if (name === 'json' || name === 'data') {
          try { Object.assign(b, JSON.parse(value)); } catch { throw apiErr(400, 'invalid_json', `The "${name}" field must be JSON.`); }
        } else b[name] = NUMBERS.has(name) ? Number(value) : BOOLEANS.has(name) ? value === 'true' || value === '1' : value;
      } else {
        uploads.push({ name: value.name || name, bytes: Buffer.from(await value.arrayBuffer()) });
      }
    }
    b._uploads = uploads;
    return b;
  };

  // the files of a prompt, checked
  function collect(b) {
    const list = [...(b._uploads || [])];
    if (b.files != null) {
      if (!Array.isArray(b.files)) throw apiErr(400, 'invalid_request', '"files" is a list of { name, data (base64) }.');
      for (const f of b.files) {
        const data = String(f?.data || '').replace(/^data:[^;,]*;base64,/, '');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw apiErr(400, 'invalid_request', `"${f?.name || 'a file'}": "data" must be base64.`);
        list.push({ name: String(f.name || 'file').slice(0, 200), bytes: Buffer.from(data, 'base64') });
      }
    }
    if (list.length > MAX_FILES) throw apiErr(400, 'too_many_files', `At most ${MAX_FILES} files a message.`);
    let total = 0;
    for (const f of list) {
      if (!f.bytes.length) throw apiErr(400, 'invalid_request', `"${f.name}" is empty.`);
      if (f.bytes.length > maxBytes()) throw apiErr(413, 'too_large', `"${f.name}" is larger than ${cfg.apiUploadMb || 20} MB.`);
      total += f.bytes.length;
    }
    if (total > MAX_TOTAL) throw apiErr(413, 'too_large', 'The files add up to more than 50 MB.');
    return list.map(f => ({ ...f, name: path.basename(String(f.name).replace(/\\/g, '/')) || 'file', ...kindOf(f) }));
  }

  // @tokens in the prompt that look like paths: inside the session's folder only
  function checkMentions(text, cwd, names) {
    for (const m of String(text).matchAll(/(^|\s)@([^\s"'`<>]+)/g)) {
      const token = m[2].replace(/[),.;:!?]+$/, '');
      if (names.has(token)) continue;
      if (!/[\\/]|^\.|^~|^[A-Za-z]:/.test(token)) continue; // @someone, not a path
      const p = token.startsWith('~') ? path.join(os.homedir(), token.slice(1)) : path.resolve(cwd, token);
      if (!isWithin(p, cwd)) throw apiErr(400, 'mention_outside', `@${token} points outside the session's folder, so it wasn't sent.`);
    }
  }

  // -> { text, blocks, note, laptopNote } for the prompt (see api-send.js prepare)
  api.attachments = async (ctx, b, { target, fork, tools, text }) => {
    const list = collect(b);
    const cwd = target.cwd;
    checkMentions(text, cwd, new Set(list.map(f => f.name)));
    if (!list.length) return { text, blocks: [], note: '', laptopNote: '' };
    const blocks = [], inline = [], toSave = [], forLaptop = [];
    for (const f of list) {
      if (f.kind === 'image') { blocks.push({ type: 'image', source: { type: 'base64', media_type: f.type, data: f.bytes.toString('base64') } }); forLaptop.push(f); continue; }
      if (f.kind === 'pdf' && tools === 'none') { blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.bytes.toString('base64') }, title: f.name }); forLaptop.push(f); continue; }
      if (f.kind === 'text' && f.bytes.length <= INLINE_MAX) { inline.push(f); if (tools === 'none') { forLaptop.push(f); continue; } }
      if (tools === 'none' && f.kind !== 'text') throw apiErr(400, 'needs_tools', `"${f.name}" needs Claude's Read tool to open: send it with "tools": "readOnly" (or "all").`);
      toSave.push(f);
    }
    const saved = toSave.length ? await saveUploads(cwd, toSave) : [];
    const where = new Map(toSave.map((f, i) => [f.name, saved[i]]));
    // @name -> where it was saved (or "below", when it's in the prompt itself)
    text = String(text).replace(/(^|\s)@([^\s"'`<>]+)/g, (all, pre, token) => {
      const t = token.replace(/[),.;:!?]+$/, ''), rest = token.slice(t.length);
      if (where.has(t)) return `${pre}@${where.get(t)}${rest}`;
      if (inline.some(f => f.name === t)) return `${pre}"${t}" (below)${rest}`;
      return all;
    });
    let note = inline.map(f => `\n\n<file name="${f.name.replace(/"/g, '')}">\n${f.bytes.toString('utf8')}\n</file>`).join('');
    if (saved.length) note += `\n\n(Attached, saved in this project: ${toSave.map((f, i) => `${saved[i]} (${f.kind === 'pdf' ? 'PDF' : f.kind}, ${size(f.bytes.length)})`).join(', ')}. Open ${saved.length === 1 ? 'it' : 'them'} with the Read tool.)`;
    // a session open on the computer takes text only: what went as images or documents is saved too
    let laptopNote = '';
    if (target.live && !fork && forLaptop.length) {
      const more = await saveUploads(cwd, forLaptop);
      laptopNote = `\n\n(Also attached, saved in this project: ${more.join(', ')}. Open ${more.length === 1 ? 'it' : 'them'} with the Read tool.)`;
    }
    return { text, blocks, note, laptopNote };
  };

  // ---------- the project's files and changes (scope "files"; the file browser must be on) ----------
  const folder = async (ctx, id) => {
    if (!cfg.fileBrowser) throw apiErr(404, 'files_off', 'The file browser is turned off in this Handoff (HANDOFF_FILE_BROWSER).');
    const s = await sessionFor(ctx.key, id);
    if (!s.cwd) throw apiErr(404, 'session_not_found', 'No such session.');
    return s.cwd;
  };
  const q = (ctx, k) => ctx.url.searchParams.get(k);
  const ev = (ctx, action, detail) => audit(ctx.ip, action, { via: 'api', key: ctx.key.name, keyId: ctx.key.id, ...detail });
  route('GET', '/sessions/([0-9a-f-]{36})/files', 'files', async (req, res, ctx, m) => json(res, 200, files.list(await folder(ctx, m[1]), q(ctx, 'path'))));
  route('GET', '/sessions/([0-9a-f-]{36})/file', 'files', async (req, res, ctx, m) => {
    const f = files.read(await folder(ctx, m[1]), q(ctx, 'path'));
    ev(ctx, 'file_view', { sessionId: m[1], path: f.path });
    json(res, 200, f);
  });
  route('GET', '/sessions/([0-9a-f-]{36})/download', 'files', async (req, res, ctx, m) => {
    const f = files.download(await folder(ctx, m[1]), q(ctx, 'path'));
    ev(ctx, 'file_download', { sessionId: m[1], path: f.path });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.size, 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}` });
    fs.createReadStream(f.abs).on('error', () => res.destroy()).pipe(res);
  });
  route('GET', '/sessions/([0-9a-f-]{36})/find', 'files', async (req, res, ctx, m) => json(res, 200, await files.find(await folder(ctx, m[1]), String(q(ctx, 'q') || '').slice(0, 200))));
  route('GET', '/sessions/([0-9a-f-]{36})/changes', 'files', async (req, res, ctx, m) => json(res, 200, await changes(files, await folder(ctx, m[1]))));
  route('GET', '/sessions/([0-9a-f-]{36})/diff', 'files', async (req, res, ctx, m) => {
    const d = await diff(files, await folder(ctx, m[1]), q(ctx, 'path'));
    ev(ctx, 'diff_view', { sessionId: m[1], path: d.path });
    json(res, 200, d);
  });

  // ---------- the computer's folders (scope "files", keys with every project) ----------
  const allProjects = ctx => { if (ctx.key.projects) throw apiErr(403, 'forbidden_scope', 'Only keys with every project can browse the computer\'s folders.'); };
  route('GET', '/folders', 'files', (req, res, ctx) => {
    allProjects(ctx);
    const p = q(ctx, 'path');
    json(res, 200, p ? folderPicker.list(p) : { path: null, roots: folderPicker.roots() });
  });
  route('POST', '/folders', 'files', async (req, res, ctx) => {
    allProjects(ctx);
    const b = await api.readBody(req);
    const r = await folderPicker.make(b.parent, b.name, { git: !!b.git });
    ev(ctx, 'folder_create', { path: r.path, git: r.git });
    json(res, 200, r);
  });

  // ---------- git (scope "git"; HANDOFF_GIT_ACTIONS) ----------
  const gitFolder = async (ctx, id) => {
    if (!cfg.gitActions) throw apiErr(404, 'git_off', 'Git actions are turned off in this Handoff (HANDOFF_GIT_ACTIONS).');
    return folder(ctx, id);
  };
  const pathList = v => (Array.isArray(v) ? v.slice(0, 5000).map(String) : undefined);
  route('POST', '/sessions/([0-9a-f-]{36})/commit-message', 'git', async (req, res, ctx, m) => {
    const b = await api.readBody(req);
    const prompt = await commitContext(files, await gitFolder(ctx, m[1]), pathList(b.paths));
    json(res, 200, { message: tidyMessage(await runner.oneShot(prompt)) });
  });
  route('POST', '/sessions/([0-9a-f-]{36})/commit', 'git', async (req, res, ctx, m) => {
    const b = await api.readBody(req);
    const r = await gitCommit(files, await gitFolder(ctx, m[1]), { message: b.message, paths: pathList(b.paths) });
    ev(ctx, 'git_commit', { sessionId: m[1], branch: r.branch, hash: r.hash, files: r.files, subject: r.subject.slice(0, 200) });
    json(res, 200, r);
  });
  route('POST', '/sessions/([0-9a-f-]{36})/push', 'git', async (req, res, ctx, m) => {
    const r = await gitPush(files, await gitFolder(ctx, m[1]));
    ev(ctx, 'git_push', { sessionId: m[1], branch: r.branch, remote: r.remote });
    json(res, 200, r);
  });
  route('POST', '/sessions/([0-9a-f-]{36})/discard', 'git', async (req, res, ctx, m) => {
    const b = await api.readBody(req);
    const r = await gitDiscard(files, await gitFolder(ctx, m[1]), b.path, path.join(DATA_DIR, 'discarded'));
    ev(ctx, 'git_discard', { sessionId: m[1], path: r.path, status: r.status });
    json(res, 200, r);
  });
  route('POST', '/sessions/([0-9a-f-]{36})/worktree/remove', 'git', async (req, res, ctx, m) => {
    const cwd = await gitFolder(ctx, m[1]);
    const s = await sessionFor(ctx.key, m[1]);
    if ((s.run && s.run.status !== 'exited') || s.info?.live) throw apiErr(409, 'session_running', 'This session is still running: stop it first.');
    const r = await removeWorktree(files, cwd);
    ev(ctx, 'worktree_remove', { sessionId: m[1], name: r.name, branch: r.branch });
    json(res, 200, r);
  });
}
