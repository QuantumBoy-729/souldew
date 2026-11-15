// Live tracking through the RetroArch app (server/lib/retroarch.mjs): the command and reply format, the launch intent
// and the polling bridge, against a fake RetroArch that answers on a UDP port like its network command interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseReadReply, readCommand, chunks, configLines, launchArgs, headerOf, RetroArchClient, RetroArchBridge, CHUNK, RA_PORT,
  systemOfRom, isAndroid, detectRetroArch, launchRetroArch,
} from '../server/lib/retroarch.mjs';
import { EMULATORS, assetPatterns, detectEmulator } from '../server/lib/emulator.mjs';
import { discoverCandidates } from '../server/lib/library.mjs';
import { retroarchState } from '../web/lib/livebridge.mjs';

const TABLE = JSON.parse(readFileSync(new URL('../shared/data/addresses.json', import.meta.url)));

/** A fake RetroArch: `mem(addr, len)` returns the bytes (or null for "no such memory"). */
async function fakeRetroArch(mem) {
  const sock = createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    const [cmd, a, n] = msg.toString().trim().split(' ');
    if (cmd !== 'READ_CORE_MEMORY') return;
    const addr = Number.parseInt(a, 16);
    const bytes = mem(addr, Number(n));
    const body = bytes ? [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ') : '-1 no memory map defined';
    sock.send(`READ_CORE_MEMORY ${a} ${body}\n`, rinfo.port, rinfo.address);
  });
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  return { port: sock.address().port, close: () => sock.close() };
}

test('command and reply format', () => {
  assert.equal(readCommand(0x02024284, 16), 'READ_CORE_MEMORY 2024284 16');
  assert.deepEqual(parseReadReply('READ_CORE_MEMORY 2024284 0a ff 00\n', 3), { addr: 0x2024284, bytes: Buffer.from([0x0a, 0xff, 0]) });
  assert.deepEqual(parseReadReply('READ_CORE_MEMORY 2024284 -1 no memory map defined'), { addr: 0x2024284, error: 'no memory map defined' });
  assert.match(parseReadReply('READ_CORE_MEMORY 10 00', 4).error, /short read/);
  assert.equal(parseReadReply('GET_STATUS PLAYING'), null);
  assert.equal(parseReadReply('READ_CORE_MEMORY zz 00'), null);
  assert.equal(parseReadReply('READ_CORE_MEMORY 10 0g'), null);
});

test('long reads are cut into pieces that cover the region exactly', () => {
  assert.deepEqual(chunks(0x100, 10), [{ addr: 0x100, len: 10 }]);
  const c = chunks(0x1000, CHUNK * 2 + 5);
  assert.deepEqual(c.map((x) => x.len), [CHUNK, CHUNK, 5]);
  assert.equal(c[2].addr, 0x1000 + CHUNK * 2);
});

test('launch intent and config', () => {
  const args = launchArgs({ rom: '/sdcard/Games/emerald.gba', system: 'gba', config: '/sdcard/souldew/ra.cfg' });
  assert.deepEqual(args.slice(0, 3), ['start', '-n', 'com.retroarch.aarch64/com.retroarch.browser.retroactivity.RetroActivityFuture']);
  assert.ok(args.includes('/data/data/com.retroarch.aarch64/cores/mgba_libretro_android.so'));
  assert.equal(launchArgs({ pkg: 'com.retroarch', rom: 'a', system: 'gbc', config: 'c' }).at(-3 + 1), 'CONFIGFILE');
  assert.throws(() => launchArgs({ rom: 'a', system: 'nds', config: 'c' }), /no RetroArch core/);
  assert.throws(() => launchArgs({ system: 'gba' }), /required/);
  assert.match(configLines(), new RegExp(`network_cmd_enable = "true"\\nnetwork_cmd_port = "${RA_PORT}"`));
});

test('ROM headers match the address tables', () => {
  const gba = Buffer.alloc(0x150);
  gba.write('POKEMON EMER', 0xa0, 'latin1');
  gba.write('BPEE', 0xac, 'latin1');
  assert.equal(findId(headerOf(gba, 'gba')), 'emerald_us');

  const red = Buffer.alloc(0x150);
  red.write('POKEMON RED', 0x134, 'latin1');
  assert.equal(findId(headerOf(red, 'gb')), 'red_us');

  const crystal = Buffer.alloc(0x150);
  crystal.write('PM_CRYSTAL', 0x134, 'latin1');
  crystal.write('BYTE', 0x13f, 'latin1');
  crystal[0x143] = 0x80;
  assert.deepEqual(headerOf(crystal, 'gbc'), { platform: 'gb', code: 'BYTE', title: 'PM_CRYSTAL' });
  assert.equal(findId(headerOf(crystal, 'gbc')), 'crystal_us');
});

function findId(h) {
  return JSON.parse(JSON.stringify(TABLE)).games.find((g) => {
    const m = g.match || {};
    return [].concat(m.gameCode || []).includes(h.code) || (m.title && h.title.toUpperCase().startsWith(String(m.title).toUpperCase()));
  })?.id;
}

test('the client reads across chunks and reports errors and silence', async () => {
  const ra = await fakeRetroArch((addr, len) => (addr >= 0x02000000 ? Buffer.alloc(len, addr & 0xff) : null));
  const client = new RetroArchClient({ port: ra.port, timeout: 150 });
  try {
    const big = await client.read(0x02000000, CHUNK + 20);
    assert.equal(big.length, CHUNK + 20);
    assert.equal(big[0], 0);
    assert.equal(big[CHUNK], CHUNK & 0xff);
    await assert.rejects(client.read(0x100, 4), /no memory map/);
  } finally {
    client.close();
    ra.close();
  }
  const silent = new RetroArchClient({ port: 1, timeout: 80 });
  await assert.rejects(silent.read(0x02000000, 4), /no answer|ECONN/);
  silent.close();
});

test('the bridge turns RetroArch memory into the same live frames as the mGBA bridge', async () => {
  const emerald = findEntryRegions('BPEE');
  const mem = Buffer.alloc(0x400000);
  const ra = await fakeRetroArch((addr, len) => {
    const o = addr - 0x02000000;
    return o >= 0 && o + len <= mem.length ? mem.subarray(o, o + len) : null;
  });
  const events = [];
  const header = { platform: 'gba', code: 'BPEE', title: 'POKEMON EMER' };
  const bridge = new RetroArchBridge((ev, d) => events.push([ev, d]), {
    client: new RetroArchClient({ port: ra.port, timeout: 200 }), table: TABLE, interval: 10, readHeader: async () => ({ ...header }),
  });
  try {
    await bridge.watch('/x/emerald.gba', 'gba');
    assert.equal(bridge.status().supported, true);
    const end = Date.now() + 2000;
    while (!events.some(([e]) => e === 'live') && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    const live = events.find(([e]) => e === 'live')[1];
    assert.equal(live.source, 'retroarch');
    assert.equal(live.game.entryId, 'emerald_us');
    assert.equal(live.regions.length, emerald.length);
    for (const r of live.regions) assert.equal(r.hex.length, r.len * 2);
  } finally {
    bridge.stop();
    bridge.client.close();
    ra.close();
  }
});

function findEntryRegions(code) {
  const g = TABLE.games.find((x) => [].concat(x.match?.gameCode || []).includes(code));
  // gen 3: party count (1 byte) and the party
  return [{ len: 1 }, { len: g.structSize * 6 }];
}

test('a game without live data says so and polls nothing', async () => {
  const events = [];
  const bridge = new RetroArchBridge((ev, d) => events.push([ev, d]), {
    client: new RetroArchClient({ port: 1, timeout: 50 }), table: TABLE, readHeader: async () => ({ platform: 'gba', code: 'ZZZZ', title: 'HOMEBREW' }),
  });
  await bridge.watch('/x/h.gba', 'gba');
  assert.equal(bridge.timer, null);
  assert.equal(bridge.status().error, 'noLiveData');
  bridge.client.close();
});

test('systems by file extension, Android detection', () => {
  assert.equal(systemOfRom('/a/Emerald.GBA'), 'gba');
  assert.equal(systemOfRom('crystal.gbc'), 'gbc');
  assert.equal(systemOfRom('red.gb'), 'gb');
  assert.equal(systemOfRom('hg.nds'), null);
  assert.equal(isAndroid('android', {}), true);
  assert.equal(isAndroid('linux', { ANDROID_ROOT: '/system' }), true);
  assert.equal(isAndroid('linux', {}), false);
});

test('the RetroArch app is found with pm path, and only on Android', () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    return args[1] === 'com.retroarch' ? { status: 0, stdout: 'package:/data/app/x/base.apk\n' } : { status: 1, stdout: '' };
  };
  assert.deepEqual(detectRetroArch({ run, android: false, now: 1e9 }), { installed: false });
  assert.equal(calls.length, 0);
  assert.deepEqual(detectRetroArch({ run, android: true, now: 2e9, env: {} }), { installed: true, path: 'com.retroarch', pkg: 'com.retroarch', source: 'system' });
  assert.deepEqual(calls.map((c) => c[2]), ['com.retroarch.aarch64', 'com.retroarch']);
  // kept for a while: no second round of pm calls
  detectRetroArch({ run, android: true, now: 2e9 + 1000, env: {} });
  assert.equal(calls.length, 2);
  // a package name from the environment is used as given, but only if it is a plain package name
  assert.equal(detectRetroArch({ run, android: true, now: 3e9, env: { SOULDEW_RETROARCH_PKG: 'x; rm -rf /' } }).installed, false);
  assert.equal(calls.length, 2);
});

test('Termux cannot call pm: RetroArch counts as installed and the launch finds out', () => {
  const refused = () => ({ status: 255, stdout: '', stderr: 'cmd: Failure calling service package: Failed transaction (2147483646)' });
  assert.deepEqual(detectRetroArch({ run: refused, android: true, now: 4e9, env: {} }), { installed: true, path: 'RetroArch', pkg: null, source: 'assumed' });
  // a package that is simply not installed prints nothing: not installed
  const missing = () => ({ status: 1, stdout: '', stderr: '' });
  assert.deepEqual(detectRetroArch({ run: missing, android: true, now: 5e9, env: {} }), { installed: false });
  // pm itself missing
  const noPm = () => ({ error: Object.assign(new Error('spawn pm ENOENT'), { code: 'ENOENT' }), status: null });
  assert.equal(detectRetroArch({ run: noPm, android: true, now: 6e9, env: {} }).installed, true);
});

test('launching stages the ROM and the config in the shared folder and starts RetroArch with am', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ra-'));
  try {
    const rom = join(dir, 'private', 'Emerald.gba');
    mkdirSync(join(dir, 'private'));
    writeFileSync(rom, Buffer.alloc(64, 7));
    const shared = join(dir, 'shared');
    let started = null;
    const fakeAm = (out, code = 0) => (cmd, args) => {
      started = [cmd, args];
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stdout.emit('data', out);
        child.emit('close', code);
      });
      return child;
    };
    const run = fakeAm('Starting: Intent { cmp=com.retroarch/.x }\n');
    const r = await launchRetroArch(rom, { pkg: 'com.retroarch', run, shared, env: {} });
    assert.equal(started[0], 'am');
    assert.ok(started[1].includes('com.retroarch/com.retroarch.browser.retroactivity.RetroActivityFuture'));
    assert.ok(started[1].includes(r.rom));
    // RetroArch's own settings are used: no config file named
    assert.equal(r.config, null);
    assert.ok(!started[1].includes('CONFIGFILE'));
    assert.match(r.rom, /shared[/]roms[/]Emerald\.gba$/);
    assert.deepEqual(readFileSync(r.rom), Buffer.alloc(64, 7));
    // opt-in generated config: network commands on
    const g = await launchRetroArch(rom, { pkg: 'com.retroarch', run, shared, env: { SOULDEW_RETROARCH_CONFIG: 'generated' } });
    assert.match(readFileSync(g.config, 'utf8'), /network_cmd_enable = "true"/);
    assert.ok(started[1].includes('CONFIGFILE'));
    // a ROM that is not a GBA / Game Boy game is refused before anything starts
    started = null;
    // without a known package, the builds are tried in turn: the first one is not installed, the second starts
    const tried = [];
    const second = (cmd, args) => {
      tried.push(args[2]);
      return fakeAm(args[2].startsWith('com.retroarch.aarch64') ? 'Error: Activity class {com.retroarch.aarch64/x} does not exist.\n' : 'Starting: Intent\n', 0)(cmd, args);
    };
    assert.equal((await launchRetroArch(rom, { run: second, shared, env: {} })).pkg, 'com.retroarch');
    assert.equal(tried.length, 2);
    // neither is installed: a clear error
    await assert.rejects(launchRetroArch(rom, { run: fakeAm('Error: Activity class does not exist.\n'), shared, env: {} }), { code: 'retroarchStart' });
    started = null;
    await assert.rejects(launchRetroArch(join(dir, 'x.nds'), { run, shared, env: {} }), { code: 'retroarchSystem' });
    assert.equal(started, null);
    // am missing (not on Android): a clear error instead of a crash
    const failing = () => {
      const child = new EventEmitter();
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn am ENOENT'), { code: 'ENOENT' })));
      return child;
    };
    await assert.rejects(launchRetroArch(rom, { pkg: 'com.retroarch', run: failing, shared, env: {} }), { code: 'emuLaunch' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the panel state follows the reader status', () => {
  assert.equal(retroarchState(null), 'waiting');
  assert.equal(retroarchState({ game: { code: 'BPEE' } }), 'waiting');
  assert.equal(retroarchState({ error: 'noAnswer' }), 'noAnswer');
  assert.equal(retroarchState({ error: 'readFailed' }), 'readFailed');
  assert.equal(retroarchState({ error: 'noLiveData' }), 'unsupported');
  assert.equal(retroarchState({ error: 'noAnswer' }, { fresh: true }), 'live');
});

test('Android ROM search looks through shared storage', () => {
  const dirs = discoverCandidates('/data/data/com.termux/files/home', { platform: 'android', env: {} });
  for (const d of ['/storage/emulated/0/Download', '/storage/emulated/0/ROMs', '/storage/emulated/0/RetroArch/downloads']) assert.ok(dirs.includes(d), d);
});

test('RetroArch is listed as an emulator for the Game Boy family, with nothing to download', () => {
  assert.deepEqual(EMULATORS.retroarch.systems, ['gb', 'gbc', 'gba']);
  assert.equal(EMULATORS.retroarch.live, 'udp');
  assert.deepEqual(assetPatterns('retroarch'), []);
  assert.deepEqual(detectEmulator('retroarch'), process.platform === 'android' ? detectEmulator('retroarch') : { installed: false });
});
