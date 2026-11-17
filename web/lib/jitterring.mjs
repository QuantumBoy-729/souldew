// The sound worklet's buffer (native-audio-worklet.mjs): the host's stereo frames as the page hands them over, read
// out in 128-frame blocks on the sound card's clock. The sound comes in bursts – one host frame (160–640 frames) after
// each picture, and the 3DS page's pictures are up to 7 MB, so on a busy PC it can stall for a few hundred ms and then
// arrive all at once. Whatever the buffer does to bridge that must not be heard:
//
// - Running dry: the last sample dies away over ~3 ms instead of dropping to zero (a step is a click), and the sound
//   that comes back fades in over 4 ms. With `prime` (the 3DS page) it then waits until that many frames are there
//   again, one short gap rather than a crackle of tiny ones – and every gap raises `prime` by half (up to `primeMax`),
//   so a PC whose sound arrives late now and then gets a buffer that covers it; after 30 s without a gap it shrinks.
// - Too much buffered (each gap leaves the late sound queued behind it): with `trim` (the 3DS page) the buffer is read
//   a little faster – at most 0.5 % (8.6 cents, as RetroArch's dynamic rate control), through a windowed-sinc
//   interpolator – until it is back in the middle of its range, and a little slower when it runs low. 2.7.3 folded one
//   frame more into every 128-frame block by linear interpolation instead: its error, modulated at 256 Hz, was only
//   25 dB below a 6 kHz tone (14 dB at 10 kHz) – a grainy, harsh sound for as long as the buffer stayed above 200 ms
//   (in a Windows test machine: up to half the time).
// - Far too much (above `maxLag`): it skips ahead to the middle of its range, crossfading over 8 ms.
// At the normal fill nothing of this runs: the frames come out exactly as they went in.
//
// `paused` (the game is paused): running dry then is no gap – `prime` stays as it is.
// `played` counts the frames read (skipped ones too) – the positions the worklet's in-band commands wait for.

const TAPS = 32; // interpolator length (frames)
const HALF = TAPS / 2; // it reads HALF - 1 frames before the position and HALF after
const PHASES = 256; // table resolution between two frames (linear in between)
const MAX_DEV = 0.005; // the most the reading speed changes
const MIN_DEV = 0.001; // the least, while it changes at all (so the fill gets back in range, not just near it)
const SWING = 0.5; // seconds for the reading speed to go from 1 to the most
const LAND = 0.00025; // back at speed 1: the reading position drifts this much per frame onto a whole frame
const FADE_IN = 128; // frames
const DECAY = 0.96; // per frame, of the last sample when running dry (−40 dB in ~110 frames, ~3 ms)
const XFADE = 256; // frames of crossfade when skipping ahead
const CLEAN = 30; // seconds without a gap before `prime` shrinks again

function bessel0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 32; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/** Kaiser-windowed sinc (β 8.5, cut-off at 96 % of Nyquist), PHASES + 1 phases of TAPS taps, each summing to 1. */
function kernel() {
  const k = new Float32Array((PHASES + 1) * TAPS);
  const beta = 8.5;
  const fc = 0.96;
  const norm = bessel0(beta);
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let j = 0; j < TAPS; j++) {
      const x = j - (HALF - 1) - frac; // the tap's distance from the reading position
      const t = x / HALF;
      const w = Math.abs(t) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - t * t)) / norm;
      const s = x === 0 ? 1 : Math.sin(Math.PI * fc * x) / (Math.PI * fc * x);
      k[p * TAPS + j] = s * w;
      sum += s * w;
    }
    for (let j = 0; j < TAPS; j++) k[p * TAPS + j] /= sum;
  }
  return k;
}
const KERNEL = kernel();

export class JitterRing {
  /**
   * `rate`: the context's sample rate. Options in frames: `prime` – wait for this much after running dry (0: play
   * whatever is there), `primeMax` – how far gaps may raise it, `trim` – above this the reading speeds up (0: never
   * changes speed), `maxLag` – above this it skips ahead (default ~125 ms at 32 kHz).
   */
  constructor(rate, { prime = 0, primeMax = 0, trim = 0, maxLag = 0 } = {}) {
    this.rate = rate;
    this.size = 65536; // frames (~2 s at 32 kHz), a power of two
    this.mask = this.size - 1;
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    this.frac = 0; // reading position between `read` and the next frame
    this.ratio = 1; // frames read per frame played
    this.maxLag = maxLag > 0 ? Math.min(maxLag, this.size >> 1) : 4096;
    this.base = prime > 0 ? Math.min(prime, this.maxLag >> 1) : 0;
    this.prime = this.base;
    this.primeMax = Math.max(this.base, Math.min(primeMax || 0, this.size >> 2));
    this.trim = trim > 0 ? trim : 0;
    this.priming = this.prime > 0;
    this.started = false; // has any sound played yet (a gap before that is no gap)
    this.paused = false; // the game is paused: running dry is no gap
    this.fill = 0; // the buffered frames, averaged over ~0.4 s (the speed control's measure)
    this.draining = false;
    this.filling = false;
    this.clean = 0; // frames played since the last gap
    this.gain = 1; // fade-in
    this.tailL = 0; // the decaying last sample while dry
    this.tailR = 0;
    this.lastL = 0;
    this.lastR = 0;
    this.xf = 0; // frames of crossfade left, from the old reading position
    this.xRead = 0;
    this.xFrac = 0;
    this.pushed = 0;
    this.played = 0;
    this.stats = { underruns: 0, silent: 0, dropped: 0, skips: 0, resampled: 0 };
    this.s = new Float64Array(2); // (one frame read, and one from the old position while skipping ahead)
    this.x = new Float64Array(2);
  }

  /** Frames buffered from the reading position on. */
  get lag() {
    return (this.write - this.read) & this.mask;
  }

  /** Above this the reading speeds up (only with `trim`). */
  get high() {
    return Math.max(this.trim, this.prime + Math.round(this.trim * 0.7));
  }

  /** Interleaved stereo frames in. */
  push(d) {
    let n = d.length >> 1;
    // more than the ring holds apart from what is being read (seconds at once – a stalled page): the oldest goes now
    const over = this.lag + n - (this.size - 8192);
    if (over > 0) {
      const k = Math.min(over, this.lag);
      if (k) this.jump(k, false);
      const cut = over - k; // (only if this one message alone is too much)
      if (cut) {
        d = d.subarray(cut * 2);
        n -= cut;
        this.pushed += cut;
        this.played += cut;
        this.stats.dropped += cut;
      }
    }
    const { l, r, mask } = this;
    let w = this.write;
    for (let i = 0; i < n; i++) {
      l[w] = d[i * 2];
      r[w] = d[i * 2 + 1];
      w = (w + 1) & mask;
    }
    this.write = w;
    this.pushed += n;
  }

  /** Everything buffered is gone (a loaded state, a reset): wait for new sound. */
  clear() {
    this.read = this.write = 0;
    this.frac = 0;
    this.ratio = 1;
    this.fill = 0;
    this.draining = this.filling = false;
    this.xf = 0;
    this.played = this.pushed;
    this.priming = this.prime > 0;
    this.started = false;
    this.gain = 0;
    this.tailL = this.lastL;
    this.tailR = this.lastR;
  }

  /** Leave `n` buffered frames out – crossfaded from where the reading was (`fade`), or at once. */
  jump(n, fade = true) {
    if (fade && this.started && !this.priming) {
      this.xf = XFADE;
      this.xRead = this.read;
      this.xFrac = this.frac;
    }
    this.read = (this.read + n) & this.mask;
    this.played += n;
    this.stats.dropped += n;
    this.stats.skips++;
  }

  /** The reading speed for the next block (with `trim`): 1 between `prime` / 2 and `high`, else up to ±0.5 %. */
  steer(n) {
    const hi = this.high;
    const mid = (this.prime + hi) >> 1;
    const lo = this.prime >> 1;
    if (this.fill > hi) this.draining = true;
    else if (this.fill <= mid) this.draining = false;
    if (this.fill < lo) this.filling = true;
    else if (this.fill >= (this.prime * 3) >> 2) this.filling = false;
    const full = this.rate * 0.1; // the whole 0.5 % at 100 ms off
    let want = 1;
    const dev = (off) => Math.max(MIN_DEV, Math.min(MAX_DEV, (off / full) * MAX_DEV));
    if (this.draining) want = 1 + dev(this.fill - mid);
    else if (this.filling) want = 1 - dev(((this.prime * 3) >> 2) - this.fill);
    const step = (MAX_DEV * n) / (this.rate * SWING);
    if (Math.abs(want - this.ratio) <= step) this.ratio = want;
    else this.ratio += want > this.ratio ? step : -step;
  }

  /** The frame at reading position (`at`, `frac`) – interpolated unless that is a whole frame. */
  sample(at, frac, out, o) {
    if (frac === 0) {
      out[o] = this.l[at];
      out[o + 1] = this.r[at];
      return;
    }
    const ph = frac * PHASES;
    const p = Math.floor(ph);
    const t = ph - p;
    const k0 = p * TAPS;
    const k1 = k0 + TAPS;
    const { l, r, mask } = this;
    let a = 0;
    let b = 0;
    let idx = (at - (HALF - 1)) & mask;
    for (let j = 0; j < TAPS; j++) {
      const c = KERNEL[k0 + j] + (KERNEL[k1 + j] - KERNEL[k0 + j]) * t;
      a += l[idx] * c;
      b += r[idx] * c;
      idx = (idx + 1) & mask;
    }
    out[o] = a;
    out[o + 1] = b;
  }

  /** The next n frames into outL / outR. */
  take(outL, outR, n) {
    let lag = this.lag;
    this.fill += (lag - this.fill) * Math.min(1, n / (this.rate * 0.4));
    if (this.priming && lag >= this.prime) {
      this.priming = false;
      this.fill = lag;
    }
    if (!this.priming) {
      const max = this.trim ? Math.max(this.maxLag, this.high + this.trim) : this.maxLag;
      if (lag > max) {
        this.jump(lag - (this.trim ? (this.prime + this.high) >> 1 : this.maxLag >> 1));
        lag = this.lag;
        this.fill = lag;
      }
      if (this.trim) this.steer(n);
    }
    if (this.ratio !== 1 || this.frac !== 0) this.stats.resampled++;
    const { s, x } = this;
    for (let i = 0; i < n; i++) {
      let L = 0;
      let R = 0;
      let sound = false;
      if (!this.priming) {
        const exact = this.frac === 0 && this.ratio === 1;
        if (lag >= (exact ? 1 : HALF + 1)) {
          this.sample(this.read, this.frac, s, 0);
          L = s[0];
          R = s[1];
          if (this.xf > 0) {
            // skipping ahead: the old position fades out as the new one comes in (equal power)
            this.sample(this.xRead, this.xFrac, x, 0);
            const g = Math.sin(((XFADE - this.xf) / XFADE) * Math.PI * 0.5);
            const h = Math.cos(((XFADE - this.xf) / XFADE) * Math.PI * 0.5);
            L = L * g + x[0] * h;
            R = R * g + x[1] * h;
            this.xf--;
            const xn = this.xFrac + this.ratio;
            const xk = Math.floor(xn);
            this.xFrac = xn - xk;
            this.xRead = (this.xRead + xk) & this.mask;
          }
          // on to the next position (back at speed 1 a fractional position drifts onto a whole frame, then is exact)
          let next = this.frac + this.ratio;
          if (this.ratio === 1 && this.frac !== 0) next = Math.min(2, next + LAND); // (2: landed on a whole frame)
          const k = Math.floor(next);
          this.frac = next - k;
          this.read = (this.read + k) & this.mask;
          this.played += k;
          lag -= k;
          if (this.gain < 1) {
            this.gain = Math.min(1, this.gain + 1 / FADE_IN);
            L *= this.gain;
            R *= this.gain;
          }
          sound = true;
          this.started = true;
          this.clean++;
        } else if (this.started) {
          // ran dry – a gap, unless the game is paused (then nothing was due)
          if (!this.paused) {
            this.stats.underruns++;
            this.clean = 0;
            if (this.base) this.prime = Math.min(this.primeMax, Math.round(this.prime * 1.5));
          }
          this.tailL = this.lastL;
          this.tailR = this.lastR;
          this.gain = 0;
          this.frac = 0;
          this.ratio = 1;
          this.xf = 0;
          this.draining = this.filling = false;
          this.priming = this.base > 0;
          this.started = false;
        }
      }
      if (!sound) this.stats.silent++;
      // the last sample before a gap dies away instead of stopping (added under the sound that comes back)
      if (this.tailL || this.tailR) {
        this.tailL *= DECAY;
        this.tailR *= DECAY;
        if (Math.abs(this.tailL) < 1e-6 && Math.abs(this.tailR) < 1e-6) this.tailL = this.tailR = 0;
        L += this.tailL;
        R += this.tailR;
      }
      outL[i] = L;
      outR[i] = R;
      if (sound) {
        this.lastL = L;
        this.lastR = R;
      }
    }
    if (this.base && this.prime > this.base && this.clean > this.rate * CLEAN) {
      this.prime = Math.max(this.base, Math.round(this.prime * 0.8));
      this.clean = 0;
    }
  }
}
