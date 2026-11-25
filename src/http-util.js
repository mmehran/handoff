// Small HTTP helpers shared by the parts of Handoff that answer requests (the web app, and anything
// added next to it).
import { httpErr } from './runner.js';

export function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

export function sse(res) {
  // no-transform stops Cloudflare from compressing (and therefore buffering) the stream;
  // the 2 KB comment pushes the first bytes through any proxy buffer immediately
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store, no-transform', 'Content-Encoding': 'identity', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`:${' '.repeat(2048)}\nretry: 3000\n\n`);
}

export const BODY_WITH_PHOTOS = 4 * 7 * 1024 * 1024; // up to 4 photos of 5 MB, base64-encoded

export async function readJson(req, limit = 256 * 1024) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.startsWith('application/json')) throw httpErr(415, 'expected application/json');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw httpErr(413, 'body too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw httpErr(400, 'invalid json'); }
}

export function clientIp(req) {
  // We only listen on loopback, so forwarded headers can only come from the local tunnel agent.
  const xf = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || '?';
}

export const delay = ms => new Promise(r => setTimeout(r, ms));
