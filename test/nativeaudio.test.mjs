// The fast player's / 3DS player's AudioWorklet (web/lib/native-audio-worklet.mjs), run outside a browser: its buffer
// (web/lib/jitterring.mjs – see test/jitterring.test.mjs) with the 3DS page's options, the in-band commands (the 3DS
// host's fast-forward ratio), the tap and the buffer's numbers for the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SR = 32728;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.posted = [];
    this.port = { postMessage: (m) => this.posted.push(m), onmessage: null };
  }
};
let NativeAudio = null;
globalThis.registerProcessor = (_name, cls) => {
  NativeAudio = cls;
};
await import('../web/lib/native-audio-worklet.mjs');

/** A worklet as a page makes it; `got` collects the commands its mixer receives (in order, with the frame played). */
function worklet(opts = {}) {
  const w = new NativeAudio({ processorOptions: { init: [{ type: 'mode', mode: 'plain' }], ...opts } });
  const got = [];
  const cmd = w.mixer.command.bind(w.mixer);
  w.mixer.command = (m) => {
    got.push({ ...m, at: w.ring.played });
    cmd(m);
  };
  const send = (d) => w.port.onmessage({ data: d });
  /** n frames of a ramp (left = right = start, start+1, … scaled), as the page posts them. */
  const push = (n, start) => {
    const f = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) f[i * 2] = f[i * 2 + 1] = (start + i) / 1e6;
    send(f);
  };
  /** One 128-frame block out. */
  const out = () => {
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    w.process([], [[L, R]]);
    return L;
  };
  return { w, got, send, push, out };
}
const DS = { prime: Math.round(SR * 0.06), primeMax: Math.round(SR * 0.24), trim: Math.round(SR * 0.2), maxLag: Math.round(SR * 0.45) };

test('worklet without options (fast player): plays what is there at once', () => {
  const { push, out } = worklet();
  push(100, 1);
  const a = out();
  assert.ok(a[0] > 0 && a[99] > 0, 'the frames that came play at once');
  assert.ok(a[127] < a[99], 'then the last sample dies away');
});

test('3DS options: waits until `prime` frames are there, then plays them in order', () => {
  const { w, push, out } = worklet({ prime: 1000, maxLag: 8000, trim: 3000 });
  push(500, 1);
  assert.ok(out().every((x) => x === 0), 'not enough yet: silent (priming)');
  push(600, 501);
  out(); // (the fade-in)
  const a = out();
  for (let i = 0; i < 128; i++) assert.equal(Math.round(a[i] * 1e6), 129 + i, 'in order, nothing skipped');
  assert.equal(w.ring.stats.underruns, 0);
});

test('3DS options: a source a little faster than real time stays below the high mark, without jumps', () => {
  const { w, push, out } = worklet(DS);
  // 0.3 % more than real time (the 3DS core paced at 60 fps, before 2.7.3): 128.4 frames per block, for 60 s
  let next = 1;
  let owed = 0;
  let prev = null;
  let maxStep = 0;
  for (let b = 0; b < (60 * SR) / 128; b++) {
    owed += 128 * 1.003;
    const n = Math.floor(owed);
    owed -= n;
    push(n, next);
    next += n;
    const a = out();
    for (const x of a) {
      if (prev !== null && x > 0) maxStep = Math.max(maxStep, Math.abs(x - prev) * 1e6);
      if (x > 0) prev = x;
    }
  }
  assert.ok(w.ring.lag <= w.ring.high + 600, `the delay stays near the high mark (${w.ring.lag})`);
  assert.ok(maxStep < 2, `never a jump, the ramp only runs a little faster (largest step ${maxStep.toFixed(2)}, float32 rounding included)`);
  assert.equal(w.ring.stats.skips, 0);
});

test('tap: records what comes out and sends it with the buffer\'s numbers; the numbers also go out once a second', () => {
  const { w, send, push, out } = worklet();
  send({ type: 'tap', frames: 256 });
  push(300, 1);
  out();
  out();
  const tap = w.posted.find((m) => m.type === 'tap');
  assert.equal(tap.l.length, 256);
  assert.equal(Math.round(tap.l[5] * 1e6), 6);
  assert.equal(tap.ring.underruns, 0);
  for (let k = 0; k < SR / 128; k++) out();
  const ring = w.posted.find((m) => m.type === 'ring');
  assert.ok(ring && ring.ring.underruns === 1 && ring.ring.silent > 0, 'ran dry once since');
});

test('in-band commands take effect when the sound that came after them plays, not when they arrive', () => {
  const { got, send, push, out } = worklet({ prime: 256, maxLag: 8000, trim: 4000 });
  push(1000, 1);
  send({ type: 'rate', ratio: 2.5, exact: true, inband: true });
  push(1000, 1001);
  send({ type: 'probe' }); // (not in-band: right away)
  assert.ok(got.some((m) => m.type === 'probe'), 'ordinary commands go straight to the mixer');
  assert.ok(!got.some((m) => m.type === 'rate'), 'the ratio waits for its sound');
  for (let k = 0; k < 7; k++) out(); // 896 frames
  assert.ok(!got.some((m) => m.type === 'rate'));
  out();
  out(); // past frame 1000
  const r = got.find((m) => m.type === 'rate');
  assert.ok(r && r.at >= 1000 && r.at <= 1000 + 128, `applied with the first block that reaches its sound (at ${r?.at})`);
});

test('in-band commands still arrive after a clear (a loaded state) – nothing is left to wait for', () => {
  const { got, send, push } = worklet({ prime: 256 });
  push(1000, 1);
  send({ type: 'rate', ratio: 3, exact: true, inband: true });
  send('clear');
  assert.ok(got.some((m) => m.type === 'rate' && m.ratio === 3));
});

test('the 3DS host’s own fast-forward sound goes straight to the mixer’s recording, split into channels – not into the buffer', () => {
  const { w, send } = worklet({ prime: 256 });
  send({ type: 'mode', mode: 'music' }); // (the helper starts in "plain")
  const seen = [];
  w.mixer.ffSound = (l, r, n) => seen.push({ l: Array.from(l.subarray(0, n)), r: Array.from(r.subarray(0, n)) });
  const pushed = w.ring.pushed;
  send({ type: 'ffsound', f: Float32Array.from([0.1, -0.1, 0.2, -0.2, 0.3, -0.3]) });
  assert.equal(w.ring.pushed, pushed, 'nothing in the buffer: it is not played as it is');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].l.map((x) => +x.toFixed(3)), [0.1, 0.2, 0.3]);
  assert.deepEqual(seen[0].r.map((x) => +x.toFixed(3)), [-0.1, -0.2, -0.3]);
  // "plain" leaves the mixer out: nothing for it to record; a mixer that fails is reported and left alone
  send({ type: 'mode', mode: 'plain' });
  send({ type: 'ffsound', f: new Float32Array(4) });
  assert.equal(seen.length, 1);
  send({ type: 'mode', mode: 'music' });
  w.mixer.ffSound = () => {
    throw new Error('boom');
  };
  send({ type: 'ffsound', f: new Float32Array(4) });
  assert.ok(w.broken && w.posted.some((m) => m.type === 'mixer' && m.e.type === 'error'));
});
