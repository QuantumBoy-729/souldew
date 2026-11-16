// Java + Universal Pokemon Randomizer ZX detection, download and invocation.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync, readdirSync, chmodSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, delimiter, dirname } from 'node:path';
import { listZip, readZipEntry } from './zip.mjs';
import { TOOLS_DIR, BUNDLED_TOOLS, CACHE_DIR } from './paths.mjs';

export const UPR_VERSION = '4.6.1';
export const UPR_URL = 'https://github.com/Ajarmar/universal-pokemon-randomizer-zx/releases/download/v4.6.1/PokeRandoZX-v4_6_1.zip';
export const UPR_ZIP_SHA256 = '26051fe8a6665ea0582dfcd4d1c3e4889da42a2f731f5fc530fff0cb691a43fd';
const BUNDLED_JAR = join(BUNDLED_TOOLS, 'upr', 'PokeRandoZX.jar');
export const UPR_JAR = existsSync(BUNDLED_JAR) ? BUNDLED_JAR : join(TOOLS_DIR, 'upr', 'PokeRandoZX.jar');
export const BRIDGE_DIR = join(BUNDLED_TOOLS, 'upr-bridge');
const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java';
const bundledJava = (arch) => join(BUNDLED_TOOLS, 'jre', `${process.platform}-${arch}`, 'bin', JAVA_EXE);
const BUNDLED_JAVA = bundledJava(process.arch);
// An arm64 Windows PC runs the bundled x64 runtime through Windows' x64 emulation.
const BUNDLED_FALLBACK = process.platform === 'win32' && process.arch === 'arm64' ? bundledJava('x64') : null;

/**
 * JVM options for the randomizer. UTF-8 as the default charset: Java 17 on Windows would otherwise read and write
 * text in the ANSI code page (cp1252), unlike macOS – the same seed must give the same game on every computer.
 */
export const JAVA_OPTS = ['-Xmx1g', '-Djava.awt.headless=true', '-Dfile.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8'];

/**
 * A 3DS game (Gen 6/7) needs far more Java heap: UPR ZX's own launcher starts it with -Xmx4608M (Sun runs out of memory
 * below ~2 GB). Only a ceiling – Java takes what it uses.
 */
export const CTR_HEAP = '-Xmx4608m';
/** Rebuilding a 3DS game writes ~3 GB and hashes it: minutes on a slow disk. */
export const CTR_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * JVM options of one bridge call. `ctr`: a 3DS game – the larger heap and UPR's working folder `workDir` (the patched
 * SysConstants in tools/upr-bridge reads -Dsouldew.upr.root; without it UPR writes next to its jar, inside the app).
 */
export function javaOptsFor({ ctr = false, workDir = null } = {}) {
  if (!ctr) return JAVA_OPTS;
  return [CTR_HEAP, ...JAVA_OPTS.filter((o) => !o.startsWith('-Xmx')), ...(workDir ? [`-Dsouldew.upr.root=${workDir}`] : [])];
}

/**
 * The @@ lines of the bridge's output → { json, warnings, error, settingsString, done, code, step, files }.
 * Other lines (UPR's own "NCCH: …" chatter) are ignored.
 */
export function parseBridgeOutput(out) {
  const result = { json: null, warnings: [], error: null, settingsString: null, done: null, code: null, step: null, files: null };
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.match(/^@@(\w+) (.*)$/);
    if (!m) continue;
    let value;
    try {
      value = JSON.parse(m[2]);
    } catch {
      continue; // a garbled line must not throw inside an event handler (= server crash)
    }
    if (m[1] === 'JSON') result.json = value;
    else if (m[1] === 'WARN') result.warnings.push(value);
    else if (m[1] === 'ERROR') result.error = value;
    else if (m[1] === 'SETTINGS') result.settingsString = value;
    else if (m[1] === 'DONE') result.done = value;
    else if (m[1] === 'CODE') result.code = value;
    else if (m[1] === 'STEP') result.step = value;
    else if (m[1] === 'FILES') result.files = value;
  }
  return result;
}

let javaCache = null;

/**
 * Android (nodejs-mobile reports platform "android"): there is no Java, but the randomizer is plain Java code and the
 * Android app packs it as DEX (scripts/android-assets.mjs: PokeRandoZX.jar = classes.dex with the bridge + classes2.dex
 * with UPR + UPR's resource files). Android's own runtime runs it: `dalvikvm64 -Xmx… -cp <jar> SoulLinkBridge …`. The
 * bridge's classes come first in the dex order, like the bridge folder on a desktop class path.
 * Why dalvikvm and not app_process: app_process appends the device's `dalvik.vm.heapsize` (512 MB) after any -Xmx, so a
 * 3DS game (Omega Ruby: ~1.9 GB output) ran out of memory halfway; dalvikvm takes -Xmx as given. The heap must fit into
 * the low 4 GB of address space, so ~1.8 GB is the most (−Xmx1900m and above fail to start) – checked on a Snapdragon 8
 * Gen 3 tablet: Omega Ruby randomizes in about a minute with it.
 */
export const ANDROID_DALVIKVM = ['/apex/com.android.art/bin/dalvikvm64', '/apex/com.android.art/bin/dalvikvm'];
export const ANDROID_HEAP = '-Xmx1800m';
const androidRuntime = (exists = existsSync) => ANDROID_DALVIKVM.find((p) => exists(p)) || null;

/** The command that runs the bridge: [binary, argv, cwd]. `platform`/`java` injectable for tests. */
export function bridgeCommand({ platform = process.platform, java, jar = UPR_JAR, bridgeDir = BRIDGE_DIR, ctr = false, workDir = null, args = [] }) {
  if (platform === 'android') {
    // ART takes the options of a JVM that mean something to it: system properties (no -Xss, awt) and the heap – 1 GB
    // for a Game Boy / DS game, the most ART allows for a 3DS game
    const opts = javaOptsFor({ ctr, workDir }).filter((o) => /^-D(file\.encoding|souldew\.)/.test(o));
    return [java.bin, [ctr ? ANDROID_HEAP : '-Xmx1g', ...opts, '-cp', jar, 'SoulLinkBridge', ...args], workDir || dirname(jar)];
  }
  // the bridge folder first: it carries a fixed copy of UPR's Effectiveness (EnumMap instead of HashMap – the order
  // of a HashMap of enums depends on the JVM, so "sensible items" on Gen 4/5 gave different ROMs per Java version)
  // and of SysConstants (the working folder above)
  return [java.bin, [...javaOptsFor({ ctr, workDir }), '-cp', [bridgeDir, jar].join(delimiter), 'SoulLinkBridge', ...args], workDir || dirname(jar)];
}

/** Installed JDKs / JREs in the usual Windows folders (…\Java\jdk-17\bin\java.exe, Adoptium, Microsoft, Zulu …). */
export function windowsJavaCandidates(env = process.env, list = readdirSync) {
  const found = [];
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean);
  // 'jdk-21.0.4.7-hotspot' → 21, 'jdk1.8.0_202' / 'jre1.8.0' → 8
  const major = (name) => {
    const m = /(\d+)(?:\.(\d+))?/.exec(name);
    return !m ? 0 : m[1] === '1' && m[2] ? Number(m[2]) : Number(m[1]);
  };
  for (const root of [...new Set(roots)]) {
    for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru']) {
      let names = [];
      try {
        names = list(join(root, vendor));
      } catch {
        continue;
      }
      for (const name of names) found.push({ path: join(root, vendor, name, 'bin', 'java.exe'), major: major(name) });
    }
  }
  // newest first, so a current Java wins over an old Java 8 left behind
  return found.sort((a, b) => b.major - a.major).map((f) => f.path);
}

function javaCandidates() {
  // The bundled runtime comes first: both players then use the identical Java version,
  // which keeps seeded randomization byte-identical across machines.
  const list = [BUNDLED_JAVA];
  if (BUNDLED_FALLBACK) list.push(BUNDLED_FALLBACK);
  if (process.env.JAVA_HOME) list.push(join(process.env.JAVA_HOME, 'bin', JAVA_EXE));
  list.push('java');
  if (process.platform === 'darwin') {
    const r = spawnSync('/usr/libexec/java_home', [], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) list.push(join(r.stdout.trim(), 'bin', 'java'));
    list.push('/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home/bin/java');
    list.push('/opt/homebrew/opt/openjdk/bin/java');
  }
  if (process.platform === 'win32') list.push(...windowsJavaCandidates());
  return list;
}

export function detectJava(force = false) {
  if (javaCache && !force) return javaCache;
  if (process.platform === 'android') {
    const bin = androidRuntime();
    javaCache = bin ? { ok: true, bin, version: 'Android Runtime', major: 8, bundled: true, vendor: 'ART' } : { ok: false, bin: null, version: null, major: 0 };
    return javaCache;
  }
  for (const bin of javaCandidates()) {
    try {
      // windowsHide: java.exe is a console program – without it every check would flash a console window
      const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      const text = `${r.stderr || ''}${r.stdout || ''}`;
      const m = text.match(/version "([^"]+)"/);
      if (r.status === 0 && m) {
        const raw = m[1];
        const major = raw.startsWith('1.') ? Number(raw.split('.')[1]) : Number(raw.split(/[.+-]/)[0]);
        javaCache = { ok: major >= 8, bin, version: raw, major, bundled: bin === BUNDLED_JAVA || bin === BUNDLED_FALLBACK, vendor: text.split(/\r?\n/)[1]?.trim() || '' };
        return javaCache;
      }
    } catch {
      // try next candidate
    }
  }
  javaCache = { ok: false, bin: null, version: null, major: 0 };
  return javaCache;
}

export function uprStatus() {
  return {
    version: UPR_VERSION,
    installed: existsSync(UPR_JAR),
    bridge: existsSync(join(BRIDGE_DIR, 'SoulLinkBridge.class')),
    jar: UPR_JAR,
  };
}

export async function installUpr() {
  const res = await fetch(UPR_URL);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== UPR_ZIP_SHA256) throw new Error('The randomizer download’s checksum doesn’t match – cancelled');
  mkdirSync(join(TOOLS_DIR, 'upr'), { recursive: true });
  const tmp = join(TOOLS_DIR, 'upr', 'download.zip');
  writeFileSync(tmp, buf);
  try {
    const entry = listZip(tmp).find((e) => e.name.endsWith('PokeRandoZX.jar'));
    if (!entry) throw new Error('PokeRandoZX.jar not found in the download');
    writeFileSync(UPR_JAR + '.part', readZipEntry(tmp, entry));
    renameSync(UPR_JAR + '.part', UPR_JAR);
  } finally {
    rmSync(tmp, { force: true });
  }
  return uprStatus();
}

/**
 * Run the SoulLinkBridge (see tools/upr-bridge/SoulLinkBridge.java). Resolves with parsed @@ lines.
 * `ctr`: a 3DS game – bigger heap, its own working folder under the cache (removed afterwards), a longer timeout.
 * `onLine`: called with every line the bridge prints while it runs (progress of a 3DS build).
 * A failure carries `code` when the bridge named one ('encrypted', 'memory', 'timeout').
 */
export function runBridge(args, { timeoutMs, ctr = false, onLine = null } = {}) {
  const java = detectJava();
  if (!java.ok) return Promise.reject(new Error('Java 8+ wasn’t found. Please install Java (e.g. Temurin 21 from adoptium.net).'));
  if (!existsSync(UPR_JAR)) return Promise.reject(new Error('Universal Pokemon Randomizer ZX is missing – please install it in the setup.'));
  if (process.platform === 'android') {
    try {
      chmodSync(UPR_JAR, 0o444); // Android refuses to load code from a file the app can still write to
    } catch {
      // read-only already
    }
  }
  const limit = timeoutMs ?? (ctr ? CTR_TIMEOUT_MS : 180000);
  // a 3DS build's own folder for the game files UPR unpacks (hundreds of MB) – never inside the app, never shared
  const workDir = ctr ? join(CACHE_DIR, 'upr-3ds', randomBytes(6).toString('hex')) : null;
  if (workDir) mkdirSync(workDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const [bin, argv, cwd] = bridgeCommand({ java, ctr, workDir, args });
    const child = spawn(bin, argv, {
      cwd,
      windowsHide: true, // no console window next to the app while the randomizer runs
    });
    let out = '';
    let err = '';
    let partial = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, limit);
    child.stdout.on('data', (d) => {
      out += d;
      if (!onLine) return;
      const lines = (partial + d).split(/\r?\n/);
      partial = lines.pop();
      for (const l of lines) {
        try {
          onLine(l);
        } catch {
          // progress only – never the build's failure
        }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    const cleanup = () => {
      clearTimeout(timer);
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    };
    child.on('error', (e) => {
      cleanup();
      reject(e);
    });
    child.on('close', (code) => {
      cleanup();
      // `code`: the code the bridge named (@@CODE), `exitCode`: the process' exit code
      const result = { ...parseBridgeOutput(out), exitCode: code, stdout: out, stderr: err };
      if (code !== 0 || result.error) {
        const detail = timedOut ? `Timed out after ${Math.round(limit / 1000)} s` : result.error || err.split(/\r?\n/).find((l) => l.trim())?.trim() || `Exit code ${code}`;
        const e = new Error(`Randomizer error: ${detail}`);
        e.details = result;
        e.code = timedOut ? 'timeout' : result.code || (/OutOfMemoryError/.test(err) ? 'memory' : null);
        reject(e);
        return;
      }
      resolve(result);
    });
  });
}
