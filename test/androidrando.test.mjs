// The randomizer on Android: no Java, the bridge runs through the Android Runtime (dalvikvm) from a DEX jar.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { bridgeCommand, ANDROID_DALVIKVM, ANDROID_HEAP } = await import('../server/lib/toolchain.mjs');

test('Android: dalvikvm with the dex jar as class path, then the bridge', () => {
  const [bin, argv, cwd] = bridgeCommand({ platform: 'android', java: { bin: ANDROID_DALVIKVM[0] }, jar: '/data/app/tools/upr/PokeRandoZX.jar', bridgeDir: '/x', args: ['info', '/r.gba'] });
  assert.equal(bin, ANDROID_DALVIKVM[0]);
  assert.equal(argv[0], '-Xmx1g');
  assert.equal(argv[argv.indexOf('-cp') + 1], '/data/app/tools/upr/PokeRandoZX.jar');
  assert.deepEqual(argv.slice(-3), ['SoulLinkBridge', 'info', '/r.gba']);
  assert.ok(argv.includes('-Dfile.encoding=UTF-8'));
  assert.ok(!argv.some((a) => a.includes('awt')), 'only options ART understands');
  assert.equal(cwd, '/data/app/tools/upr');
});

test('Android, a 3DS game: the biggest heap ART can start (not the desktop 4.5 GB, which it refuses)', () => {
  const [, argv] = bridgeCommand({ platform: 'android', java: { bin: ANDROID_DALVIKVM[0] }, jar: '/j.jar', ctr: true, workDir: '/w', args: ['randomize'] });
  assert.equal(argv[0], ANDROID_HEAP);
  assert.ok(Number(ANDROID_HEAP.match(/\d+/)[0]) <= 1800, 'above ~1.8 GB ART does not start');
  assert.ok(argv.includes('-Dsouldew.upr.root=/w'));
});

test('desktop: java -cp bridge folder first, then the jar', () => {
  const [bin, argv] = bridgeCommand({ platform: 'linux', java: { bin: 'java' }, jar: '/t/upr.jar', bridgeDir: '/t/bridge', args: ['info', '/r.gba'] });
  assert.equal(bin, 'java');
  const cp = argv[argv.indexOf('-cp') + 1];
  assert.ok(cp.startsWith('/t/bridge'), 'the bridge folder (fixed Effectiveness) wins');
  assert.ok(cp.endsWith('/t/upr.jar'));
  assert.deepEqual(argv.slice(-3), ['SoulLinkBridge', 'info', '/r.gba']);
});
