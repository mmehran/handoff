// Laptop status and keep-awake. Battery, how soon the computer would go to sleep by itself, what
// closing the lid does, and a switch that keeps it awake: off, while Claude works, or always.
//
// Keeping awake uses the system's own "busy, don't sleep" request (what video players use): on Windows
// SetThreadExecutionState from a small helper process, `caffeinate` on macOS, `systemd-inhibit` on
// Linux. It stops sleeping when idle; closing the lid or choosing Sleep still sleeps. The helper exits
// with Handoff, so nothing is left behind, and no system setting is changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { httpErr } from './runner.js';

export const MODES = ['off', 'working', 'always'];
const GRACE_MS = 10 * 60e3; // "while Claude works" stays awake this long after it stops, for your reply
const LID = { 0: 'nothing', 1: 'sleep', 2: 'hibernate', 3: 'shutdown' };

// One PowerShell run that reports everything at once, as JSON.
const PS_STATUS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
$p = [System.Windows.Forms.SystemInformation]::PowerStatus
Add-Type -Name Idle -Namespace Handoff -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; } [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII p); public static uint Ms() { LII l = new LII(); l.cbSize = 8; GetLastInputInfo(ref l); return (uint)Environment.TickCount - l.dwTime; }'
$idx = { param($sub, $set) ((powercfg /query SCHEME_CURRENT $sub $set) -join ' ' | Select-String -AllMatches 'Index:\s*0x([0-9a-fA-F]+)').Matches | ForEach-Object { [Convert]::ToInt64($_.Groups[1].Value, 16) } }
$sleep = @(& $idx SUB_SLEEP STANDBYIDLE)
$hib = @(& $idx SUB_SLEEP HIBERNATEIDLE)
$lid = @(& $idx SUB_BUTTONS LIDACTION)
[pscustomobject]@{
  hasBattery = ($p.BatteryChargeStatus -ne 'NoSystemBattery' -and $p.BatteryChargeStatus -notmatch 'Unknown')
  percent = [math]::Round($p.BatteryLifePercent * 100)
  plugged = ($p.PowerLineStatus -eq 'Online')
  charging = ($p.BatteryChargeStatus -match 'Charging')
  secondsLeft = $p.BatteryLifeRemaining
  idleMs = [Handoff.Idle]::Ms()
  sleepAc = $sleep[0]; sleepDc = $sleep[1]; hibAc = $hib[0]; hibDc = $hib[1]; lidAc = $lid[0]; lidDc = $lid[1]
} | ConvertTo-Json -Compress
`;

const PS_AWAKE = parent => String.raw`
$parent = ${parent}
Add-Type -Name Power -Namespace Handoff -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[Handoff.Power]::SetThreadExecutionState(0x80000001) | Out-Null
while (Get-Process -Id $parent -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }
`;

// PowerShell takes a script most reliably as base64 of its UTF-16 text
const encoded = script => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (e, out) => e ? reject(e) : resolve(String(out))));
}

export class Laptop extends EventEmitter {
  // isWorking(): is any Claude session busy or waiting for you right now?
  constructor({ dataDir, isWorking = async () => false, log = () => {}, platform = process.platform, interval = 15e3 }) {
    super();
    this.file = path.join(dataDir, 'laptop.json');
    this.isWorking = isWorking;
    this.log = log;
    this.platform = platform;
    this.helper = null;      // the keep-awake process while it runs
    this.lastWork = 0;
    this.cache = null;       // { at, value } for status()
    this.mode = 'off';
    try { const m = JSON.parse(fs.readFileSync(this.file, 'utf8')).mode; if (MODES.includes(m)) this.mode = m; } catch { /* never set */ }
    this.timer = setInterval(() => this.check().catch(e => this.log(`[laptop] ${e.message}`)), interval);
    this.timer.unref?.();
    setImmediate(() => this.check().catch(() => {}));
  }

  async setMode(mode) {
    if (!MODES.includes(mode)) throw httpErr(400, `keep awake: one of ${MODES.join(', ')}`);
    this.mode = mode;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ mode })); } catch { /* kept in memory */ }
    return this.check();
  }

  // should the computer be kept awake now? Starts or stops the helper to match.
  async check() {
    let want = this.mode === 'always';
    if (this.mode === 'working') {
      if (await this.isWorking().catch(() => false)) this.lastWork = Date.now();
      want = Date.now() - this.lastWork < GRACE_MS;
    }
    if (want && !this.helper) this.hold();
    else if (!want && this.helper) this.release();
    return this.keepAwake();
  }

  keepAwake() {
    return {
      mode: this.mode, active: !!this.helper,
      since: this.helper?.since || null,
      // "while Claude works": still awake for this long after it stopped
      graceUntil: this.mode === 'working' && this.helper && this.lastWork ? this.lastWork + GRACE_MS : null,
      supported: ['win32', 'darwin', 'linux'].includes(this.platform)
    };
  }

  hold() {
    let p;
    try {
      if (this.platform === 'win32') p = spawn('powershell.exe', encoded(PS_AWAKE(process.pid)), { windowsHide: true, stdio: 'ignore' });
      else if (this.platform === 'darwin') p = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      else if (this.platform === 'linux') p = spawn('systemd-inhibit', ['--what=idle:sleep', '--who=Handoff', '--why=Keeping the computer awake for Claude', 'sleep', 'infinity'], { stdio: 'ignore' });
      else return;
    } catch (e) { this.log(`[laptop] couldn't keep awake: ${e.message}`); return; }
    p.since = Date.now();
    p.on('error', e => { this.log(`[laptop] keep-awake helper: ${e.message}`); if (this.helper === p) this.helper = null; });
    p.on('exit', () => { if (this.helper === p) this.helper = null; });
    this.helper = p;
    this.log('[laptop] keeping the computer awake');
    this.emit('change');
  }

  release() {
    const p = this.helper;
    this.helper = null;
    try { p?.kill(); } catch { /* gone */ }
    this.log('[laptop] the computer may sleep again');
    this.emit('change');
  }

  stop() { clearInterval(this.timer); if (this.helper) this.release(); }

  // battery, sleep timers, lid, and the machine itself; cached for 20 s (PowerShell is slow to start)
  async status() {
    if (this.cache && Date.now() - this.cache.at < 20e3) return { ...this.cache.value, keepAwake: this.keepAwake() };
    const host = { name: os.hostname(), platform: this.platform, uptime: Math.round(os.uptime()), memory: { total: os.totalmem(), free: os.freemem() }, load: os.loadavg()[0] || null, cpus: os.cpus().length };
    let power = null;
    try { power = await this.power(); } catch (e) { this.log(`[laptop] status: ${e.message}`); }
    const value = { host, ...(power || { battery: null, sleep: null }), at: Date.now() };
    this.cache = { at: Date.now(), value };
    return { ...value, keepAwake: this.keepAwake() };
  }

  async power() {
    if (this.platform === 'win32') {
      const j = JSON.parse(await run('powershell.exe', encoded(PS_STATUS)));
      const onBattery = j.hasBattery && !j.plugged;
      const min = s => (Number.isFinite(s) ? Math.round(s / 60) : null); // 0 = never
      const sleepAfter = min(onBattery ? j.sleepDc : j.sleepAc), hibAfter = min(onBattery ? j.hibDc : j.hibAc);
      const idleMin = Math.floor((Number(j.idleMs) || 0) / 60e3);
      return {
        battery: j.hasBattery ? { percent: j.percent, plugged: !!j.plugged, charging: !!j.charging, minutesLeft: j.secondsLeft > 0 ? Math.round(j.secondsLeft / 60) : null } : null,
        sleep: {
          afterMinutes: sleepAfter, hibernateAfterMinutes: hibAfter, idleMinutes: idleMin,
          // when it would sleep by itself if nothing changes (Handoff keeping it awake aside)
          inMinutes: sleepAfter ? Math.max(0, sleepAfter - idleMin) : null,
          lid: LID[onBattery ? j.lidDc : j.lidAc] || null, onBattery
        }
      };
    }
    if (this.platform === 'darwin') {
      const b = await run('pmset', ['-g', 'batt']).catch(() => '');
      const m = b.match(/(\d+)%;\s*([a-z ]+);/i);
      return { battery: m ? { percent: Number(m[1]), plugged: /AC Power/.test(b), charging: /charging/i.test(m[2]) && !/discharging/i.test(m[2]), minutesLeft: null } : null, sleep: null };
    }
    if (this.platform === 'linux') {
      try {
        const dir = '/sys/class/power_supply/BAT0';
        const percent = Number(fs.readFileSync(path.join(dir, 'capacity'), 'utf8'));
        const st = fs.readFileSync(path.join(dir, 'status'), 'utf8').trim();
        return { battery: { percent, plugged: st !== 'Discharging', charging: st === 'Charging', minutesLeft: null }, sleep: null };
      } catch { return { battery: null, sleep: null }; }
    }
    return null;
  }
}
