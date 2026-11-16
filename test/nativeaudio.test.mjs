// The fast player's / 3DS player's AudioWorklet (web/lib/native-audio-worklet.mjs), run outside a browser: its ring
// buffer, the 3DS page's options (prime, trim, maxLag) and the in-band commands (the 3DS host's fast-forward ratio).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SR = 32728;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { postMessage() {}, onmessage: null };
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
    got.push({ ...m, at: w.played });
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
const lag = (w) => (w.write - w.read + w.size) % w.size;

test('worklet without options (fast player): plays what is there, silence when dry, drops to half of 4096 when overfull', () => {
  const { w, push, out } = worklet();
  push(100, 1);
  const a = out();
  assert.ok(a[0] > 0 && a[99] > 0, 'the frames that came play at once');
  assert.equal(a[100], 0, 'then silence (nothing to wait for)');
  push(5000, 1);
  assert.equal(lag(w), 2048, 'overfull: back to half the limit');
});

test('3DS options: after running dry the worklet waits until `prime` frames are there again, then plays them in order', () => {
  const { w, push, out } = worklet({ prime: 1000, maxLag: 8000, trim: 3000 });
  push(500, 1);
  assert.ok(out().every((x) => x === 0), 'not enough yet: silent (priming)');
  push(600, 501);
  const a = out();
  assert.equal(Math.round(a[0] * 1e6), 1, 'primed: plays from the first frame');
  for (let i = 1; i < 128; i++) assert.equal(Math.round(a[i] * 1e6), i + 1, 'in order, nothing skipped');
  for (let k = 0; k < 7; k++) out(); // 1024 of the 1100 frames
  const dry = out(); // runs dry inside this block
  assert.ok(dry[0] > 0 && dry[127] === 0, 'what is left plays, then silence');
  push(200, 2000);
  assert.ok(out().every((x) => x === 0), 'ran dry: waits for `prime` frames again instead of playing crumbs');
  assert.ok(w.priming);
});

test('3DS options: a source a little faster than real time is trimmed smoothly – no jumps, the delay stays near `trim`', () => {
  const { w, push, out } = worklet({ prime: 500, maxLag: 8000, trim: 2000 });
  // 0.3 % more than real time (the 3DS core at 60 fps): 128.4 frames per block, for 40 s
  let next = 1;
  let owed = 0;
  let prev = null;
  let maxStep = 0;
  for (let b = 0; b < (40 * SR) / 128; b++) {
    owed += 128 * 1.003;
    const n = Math.floor(owed);
    owed -= n;
    push(n, next);
    next += n;
    const a = out();
    for (const x of a) {
      if (prev !== null && x > 0) maxStep = Math.max(maxStep, Math.round((x - prev) * 1e6));
      if (x > 0) prev = x;
    }
  }
  assert.ok(lag(w) <= 2000 + 260, `the delay stays at the trim level (${lag(w)})`);
  assert.ok(maxStep <= 2, `never a jump, only a frame folded in now and then (largest step ${maxStep})`);
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
