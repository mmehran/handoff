import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { DATA_DIR } from './config.js';

// Past `max` bytes the file becomes <file>.1 (replacing an older one), so logs stay bounded.
export function rotate(file, max = 5 * 1024 * 1024) {
  try { if (fs.statSync(file).size > max) fs.renameSync(file, file + '.1'); } catch { /* new */ }
}

// When running hidden (autostart) there is no console: append output to data/<name> instead.
export function logToFile(name) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, name);
  rotate(file);
  const out = fs.createWriteStream(file, { flags: 'a' });
  for (const level of ['log', 'warn', 'error']) {
    console[level] = (...a) => out.write(`${new Date().toISOString()} ${util.format(...a)}\n`);
  }
}
