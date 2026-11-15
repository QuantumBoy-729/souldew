// Live tracking through the RetroArch app (Android, started from Termux). RetroArch has no scripting API like mGBA, but
// it can answer memory reads over its "network commands" (UDP, localhost): souldew sends READ_CORE_MEMORY and gets the
// bytes back. The reads are the same regions the other readers stream (shared/live/parse.mjs regionsFor), and the
// result is the same `live` event the mGBA bridge emits, so the UI needs nothing new.
//
// RetroArch's protocol (command.c, "network_cmd_enable"):
//   souldew → RA   READ_CORE_MEMORY <addr hex> <bytes decimal>
//   RA → souldew   READ_CORE_MEMORY <addr hex> <byte hex> <byte hex> …   or   READ_CORE_MEMORY <addr hex> -1 <reason>
// Addresses are the core's own memory map – mGBA and Gambatte publish the bus addresses the address tables use.
import { createSocket } from 'node:dgram';
import { open } from 'node:fs/promises';
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { basename, extname, posix } from 'node:path';
import { findEntry, regionsFor } from '../../shared/live/parse.mjs';
import { readJson } from './livebridge.mjs';
import { writeFileAtomic, httpError, safeFileName } from './fsutil.mjs';

export const RA_PORT = 55355;
/** RetroArch answers in one datagram of limited size (about 4 KB of text) – a read is cut into pieces of this many bytes. */
export const CHUNK = 1000;

/** Android's RetroArch builds: the package decides where its cores and config live. */
export const PACKAGES = ['com.retroarch.aarch64', 'com.retroarch'];
export const ACTIVITY = 'com.retroarch.browser.retroactivity.RetroActivityFuture';

/** The libretro core RetroArch loads per system (file names as the Android build ships them). */
export const CORES = {
  gba: 'mgba_libretro_android.so',
  gb: 'gambatte_libretro_android.so',
  gbc: 'gambatte_libretro_android.so',
};

export const readCommand = (addr, len) => `READ_CORE_MEMORY ${addr.toString(16)} ${len}`;

/**
 * RetroArch's answer to a READ_CORE_MEMORY: { addr, bytes } or { addr, error }; null for anything else (a stray
 * datagram, another command's reply). The byte count is checked against what was asked.
 */
export function parseReadReply(text, expect = null) {
  const parts = String(text).trim().split(/\s+/);
  if (parts[0] !== 'READ_CORE_MEMORY' || !/^[0-9a-f]+$/i.test(parts[1] || '')) return null;
  const addr = Number.parseInt(parts[1], 16);
  if (parts[2] === '-1') return { addr, error: parts.slice(3).join(' ') || 'unknown' };
  const hex = parts.slice(2);
  if (!hex.every((b) => /^[0-9a-f]{2}$/i.test(b))) return null;
  if (expect != null && hex.length !== expect) return { addr, error: `short read (${hex.length} of ${expect})` };
  return { addr, bytes: Buffer.from(hex.join(''), 'hex') };
}

/** [{ addr, len }] pieces of at most `max` bytes that together cover addr … addr+len. */
export function chunks(addr, len, max = CHUNK) {
  const out = [];
  for (let o = 0; o < len; o += max) out.push({ addr: addr + o, len: Math.min(max, len - o) });
  return out;
}

/**
 * What RetroArch needs in its config for this to work: appended to the config file the intent names, so the user's own
 * settings stay. `network_cmd_enable` is off by default.
 */
export function configLines({ port = RA_PORT } = {}) {
  return ['network_cmd_enable = "true"', `network_cmd_port = "${port}"`, 'pause_nonactive = "false"'].join('\n') + '\n';
}

/**
 * The `am start` arguments that open RetroArch with a game (Termux: `am start …`). `rom` and `config` are paths the
 * RetroArch app itself can read – shared storage, not Termux's private folder.
 */
export function launchArgs({ pkg = PACKAGES[0], rom, system, config, coresDir = `/data/data/${pkg}/cores` }) {
  const core = CORES[system];
  if (!core) throw new Error(`no RetroArch core for ${system}`);
  if (!rom || !config) throw new Error('rom and config are required');
  return [
    'start', '-n', `${pkg}/${ACTIVITY}`,
    '--es', 'ROM', rom,
    '--es', 'LIBRETRO', `${coresDir}/${core}`,
    '--es', 'CONFIGFILE', config,
  ];
}

/** { platform, code, title } from a GBA or Game Boy ROM header, the way the address tables look a game up. */
export function headerOf(buf, system) {
  const text = (a, b) => buf.subarray(a, b).toString('latin1').replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (system === 'gba') return { platform: 'gba', code: text(0xac, 0xb0), title: text(0xa0, 0xac) };
  // Game Boy Color carts with the CGB flag keep a 4-letter product code inside the title field
  const cgb = (buf[0x143] & 0x80) !== 0;
  const code = cgb && /^[A-Z0-9]{4}$/.test(text(0x13f, 0x143)) ? text(0x13f, 0x143) : '';
  return { platform: 'gb', code, title: text(0x134, cgb ? 0x13f : 0x144) };
}

/** Android (Termux's Node reports 'android'; ANDROID_ROOT covers other Node builds for the platform). */
export const isAndroid = (platform = process.platform, env = process.env) => platform === 'android' || !!env.ANDROID_ROOT;

/** The system of a ROM file by its extension, or null. */
export const systemOfRom = (path) => ({ '.gba': 'gba', '.gbc': 'gbc', '.gb': 'gb' })[extname(String(path)).toLowerCase()] || null;

/**
 * Folder both souldew and the RetroArch app can read and write: the config file and ROMs the app can't reach in
 * souldew's own (private) folder go here. Termux needs `termux-setup-storage` once for it.
 */
export const sharedDir = (env = process.env) => env.SOULDEW_SHARED_DIR || '/storage/emulated/0/souldew';

let detected = { at: 0, value: null };
/**
 * Is the RetroArch app installed? `pm path <package>` (Termux has it); the answer is kept for half a minute because
 * the status route asks on every page load. Not installed anywhere but on Android.
 */
export function detectRetroArch({ run = spawnSync, now = Date.now(), env = process.env, android = isAndroid() } = {}) {
  if (!android) return { installed: false };
  if (detected.value && now - detected.at < 30000) return detected.value;
  const pkgs = env.SOULDEW_RETROARCH_PKG ? [env.SOULDEW_RETROARCH_PKG] : PACKAGES;
  let value = { installed: false };
  for (const pkg of pkgs) {
    if (!/^[\w.]+$/.test(pkg)) continue;
    let r;
    try {
      r = run('pm', ['path', pkg], { encoding: 'utf8', timeout: 5000 });
    } catch {
      continue;
    }
    if (r?.status === 0 && /^package:/m.test(r.stdout || '')) {
      value = { installed: true, path: pkg, source: 'system' };
      break;
    }
  }
  detected = { at: now, value };
  return value;
}

/**
 * Starts RetroArch with `rom` through Android's `am`. The app can only read shared storage, so a ROM outside it is
 * copied into souldew's shared folder first, and the config file (network commands on) goes there too. Returns
 * { rom, config } – the paths RetroArch got.
 */
export async function launchRetroArch(rom, { pkg, env = process.env, run = spawn, shared = sharedDir(env) } = {}) {
  const system = systemOfRom(rom);
  if (!system) throw httpError(400, 'RetroArch spielt hier nur GBA- und Game-Boy-Spiele', 'retroarchSystem');
  if (/[\0\r\n]/.test(String(rom))) throw httpError(400, 'Ungültiger Pfad', 'badEmulatorPath');
  pkg ||= detectRetroArch({ env }).path || PACKAGES[0];
  let staged = rom;
  const readable = /^\/(?:storage|sdcard)\//.test(String(rom));
  try {
    mkdirSync(shared, { recursive: true });
    if (!readable) {
      staged = posix.join(shared, 'roms', safeFileName(basename(rom)));
      mkdirSync(posix.dirname(staged), { recursive: true });
      if (!existsSync(staged) || statSync(staged).size !== statSync(rom).size) copyFileSync(rom, staged);
    }
  } catch (e) {
    throw httpError(500, `Gemeinsamer Ordner nicht beschreibbar: ${e.message}`, 'retroarchShared', { detail: e.code || e.message, dir: shared });
  }
  const config = posix.join(shared, 'retroarch.cfg');
  writeFileAtomic(config, configLines());
  const child = run('am', launchArgs({ pkg, rom: staged, system, config }), { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (e) => reject(httpError(500, `RetroArch konnte nicht gestartet werden: ${e.message}`, 'emuLaunch', { emu: 'RetroArch', detail: e.code || e.message })));
  });
  child.unref?.();
  return { rom: staged, config };
}

/** UDP client for RetroArch's command port. One request at a time; a lost datagram is a timeout, not a hang. */
export class RetroArchClient {
  constructor({ host = '127.0.0.1', port = RA_PORT, timeout = 400 } = {}) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.socket = createSocket('udp4');
    this.socket.on('error', () => {});
    this.socket.unref?.();
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }

  /** Reads len bytes at addr (several datagrams when long). Rejects with an Error whose message says why. */
  async read(addr, len) {
    const parts = [];
    for (const c of chunks(addr, len)) parts.push(await this.readOnce(c.addr, c.len));
    return Buffer.concat(parts);
  }

  readOnce(addr, len) {
    return new Promise((resolve, reject) => {
      const done = (fn, v) => {
        clearTimeout(timer);
        this.socket.off('message', onMessage);
        fn(v);
      };
      const onMessage = (msg) => {
        const r = parseReadReply(msg.toString('latin1'), len);
        if (!r || r.addr !== addr) return; // not ours – keep waiting
        if (r.error) done(reject, new Error(r.error));
        else done(resolve, r.bytes);
      };
      const timer = setTimeout(() => done(reject, new Error('no answer')), this.timeout);
      this.socket.on('message', onMessage);
      this.socket.send(readCommand(addr, len), this.port, this.host, (err) => err && done(reject, err));
    });
  }
}

/**
 * Polls the running game and emits what LiveBridge emits: `live` frames (source 'retroarch') and `live-status`.
 * `watch(rom, system)` is called when souldew has started the game; `stop()` when it ends.
 */
export class RetroArchBridge {
  constructor(emit, { client = new RetroArchClient(), table = null, interval = 250, readHeader = readRomHeader } = {}) {
    this.emit = emit;
    this.client = client;
    this.table = table;
    this.interval = interval;
    this.readHeader = readHeader;
    this.game = null;
    this.regions = [];
    this.error = null;
    this.lastFrame = null;
    this.timer = null;
    this.busy = false;
    this.fails = 0;
  }

  status() {
    return { source: 'retroarch', port: this.client.port, error: this.error, game: this.game, supported: this.regions.length > 0, lastAt: this.lastFrame?.at || null };
  }

  async watch(rom, system) {
    this.stop();
    this.table ||= readJsonSafe();
    this.game = await this.readHeader(rom, system);
    const entry = findEntry(this.table, this.game);
    this.game.entryId = entry?.id || null;
    this.regions = regionsFor(entry);
    this.error = this.regions.length ? null : 'noLiveData';
    this.emit('live-status', this.status());
    if (!this.regions.length) return;
    this.timer = setInterval(() => this.poll(), this.interval);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.fails = 0;
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const data = [];
      for (const r of this.regions) data.push((await this.client.read(r.addr, r.len)).toString('hex'));
      this.fails = 0;
      this.error = null;
      this.lastFrame = { source: 'retroarch', at: Date.now(), game: this.game, regions: this.regions.map((r, i) => ({ ...r, hex: data[i] })) };
      this.emit('live', this.lastFrame);
    } catch (e) {
      // RetroArch not started yet, no network commands, or a core that has no such memory: say it once, keep trying
      const err = e.message === 'no answer' ? 'noAnswer' : 'readFailed';
      if (++this.fails === 3 || this.error !== err) {
        this.error = err;
        this.emit('live-status', { ...this.status(), detail: e.message });
      }
    } finally {
      this.busy = false;
    }
  }
}

function readJsonSafe() {
  try {
    return readJson('addresses.json');
  } catch {
    return { games: [] };
  }
}

/** Reads just the header of the ROM file (a few hundred bytes). */
export async function readRomHeader(path, system) {
  const f = await open(path, 'r');
  try {
    const buf = Buffer.alloc(0x150);
    await f.read(buf, 0, buf.length, 0);
    return headerOf(buf, system);
  } finally {
    await f.close();
  }
}
