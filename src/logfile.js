import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { DATA_DIR } from './config.js';

// When running hidden (autostart) there is no console: append output to data/<name> instead.
export function logToFile(name) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, name);
  try { if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1'); } catch { /* new */ }
  const out = fs.createWriteStream(file, { flags: 'a' });
  for (const level of ['log', 'warn', 'error']) {
    console[level] = (...a) => out.write(`${new Date().toISOString()} ${util.format(...a)}\n`);
  }
}
