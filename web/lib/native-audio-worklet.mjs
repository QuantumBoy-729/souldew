// AudioWorklet of the fast player (lib/nativeplayer.mjs): a ring buffer the page fills with the host's stereo samples
// (at the context's rate), drained through souldew's turbo mixer (turboaudio.mjs) – at 1× the game's sound as it is,
// while fast-forwarding the music at normal speed ("music"), silence ("mute") or the sped-up original ("original"; "plain"
// leaves the mixer out). The host sends fast-forward sound sped up by the real speed, as RetroArch does for player.html,
// so the mixer works here exactly as there. Underruns play silence; an overfull buffer (the page fell behind) drops the
// oldest samples so the delay stays short. If the mixer ever fails, the sound passes through as it is.
// The 3DS page (lib/ctrplayer.mjs) asks for more (processorOptions): `prime` – after running dry, wait until that many
// frames are buffered again (its sound arrives between pictures of up to 7 MB: one short gap, not a crackle of tiny
// ones), `maxLag` – a bigger buffer, and `trim` – above that many buffered frames one frame per block is left out, so a
// game that makes a little more than real time of sound (the 3DS core: 0.3 %) never piles up to the hard limit, where
// a whole stretch would be dropped at once. Commands marked `inband` (the host's fast-forward ratio) take effect when
// the sound that arrived after them is played, not when they arrive.
import { TurboMixer } from './turboaudio.mjs';

class NativeAudio extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = 65536; // frames (~2 s at 32 kHz)
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    const o = options?.processorOptions || {};
    this.maxLag = o.maxLag > 0 ? Math.min(o.maxLag, this.size >> 1) : 4096; // ~125 ms – more is dropped
    this.prime = o.prime > 0 ? Math.min(o.prime, this.maxLag >> 1) : 0;
    this.trim = o.trim > 0 ? o.trim : 0;
    this.priming = this.prime > 0;
    this.pushed = 0; // frames ever pushed / played (positions for the in-band commands)
    this.played = 0;
    this.inband = []; // [{ at, m }]
    this.inL = new Float32Array(128);
    this.inR = new Float32Array(128);
    this.plain = false;
    this.broken = false;
    // what came out over the last ~0.1 s (RMS and peak of both channels) – the probe reports it (tests, diagnostics)
    this.level = { rms: 0, peak: 0 };
    this.lvl = { sum: 0, peak: 0, n: 0 };
    this.mixer = new TurboMixer(sampleRate, { onEvent: (e) => this.port.postMessage({ type: 'mixer', e: e.type === 'probe' ? { ...e, level: this.level } : e }) });
    for (const m of options?.processorOptions?.init || []) this.command(m);
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof Float32Array) return this.push(d);
      if (d === 'clear') {
        this.read = this.write = 0;
        this.played = this.pushed;
        this.priming = this.prime > 0;
        for (const x of this.inband.splice(0)) this.command(x.m); // (nothing left to wait for)
        return;
      }
      if (d?.inband) this.inband.push({ at: this.pushed, m: d });
      else this.command(d);
    };
  }

  command(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'mode') this.plain = m.mode === 'plain';
    try {
      this.mixer.command(m.type === 'mode' && m.mode === 'plain' ? { type: 'mode', mode: 'original' } : m);
    } catch (err) {
      this.fail(err);
    }
  }

  fail(err) {
    if (!this.broken) this.port.postMessage({ type: 'mixer', e: { type: 'error', message: String(err?.message || err) } });
    this.broken = true;
  }

  push(d) {
    const n = d.length >> 1;
    for (let i = 0; i < n; i++) {
      this.l[this.write] = d[i * 2];
      this.r[this.write] = d[i * 2 + 1];
      this.write = (this.write + 1) % this.size;
    }
    this.pushed += n;
    const lag = (this.write - this.read + this.size) % this.size;
    if (lag > this.maxLag) {
      const to = this.prime || this.maxLag >> 1;
      this.read = (this.write - to + this.size) % this.size;
      this.played += lag - to;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const n = L.length;
    if (this.inL.length < n) {
      this.inL = new Float32Array(n);
      this.inR = new Float32Array(n);
    }
    while (this.inband.length && this.inband[0].at <= this.played) this.command(this.inband.shift().m);
    this.take(n);
    let mixed = false;
    if (!this.plain && !this.broken) {
      try {
        this.mixer.process(this.inL, this.inR, L, R, n);
        mixed = true;
      } catch (err) {
        this.fail(err);
      }
    }
    if (!mixed) {
      L.set(this.inL.subarray(0, n));
      if (R !== L) R.set(this.inR.subarray(0, n));
    }
    this.measure(L, R, n);
    return true;
  }

  /** The next n frames of the ring into inL / inR (silence where it ran dry, or while priming). */
  take(n) {
    const lag = (this.write - this.read + this.size) % this.size;
    if (this.priming && lag >= this.prime) this.priming = false;
    if (!this.priming && this.trim && lag > this.trim + n + 2) {
      // one frame more than the block, resampled into it (0.8 % faster for a moment – inaudible, and no click)
      const step = (n + 1) / n;
      for (let i = 0; i < n; i++) {
        const p = i * step;
        const k = Math.floor(p);
        const f = p - k;
        const a = (this.read + k) % this.size;
        const b = (a + 1) % this.size;
        this.inL[i] = this.l[a] + (this.l[b] - this.l[a]) * f;
        this.inR[i] = this.r[a] + (this.r[b] - this.r[a]) * f;
      }
      this.read = (this.read + n + 1) % this.size;
      this.played += n + 1;
      return;
    }
    for (let i = 0; i < n; i++) {
      if (this.priming || this.read === this.write) {
        if (!this.priming && this.prime) this.priming = true; // ran dry: wait until `prime` frames are there again
        this.inL[i] = 0;
        this.inR[i] = 0;
        continue;
      }
      this.inL[i] = this.l[this.read];
      this.inR[i] = this.r[this.read];
      this.read = (this.read + 1) % this.size;
      this.played++;
    }
  }

  measure(L, R, n) {
    const m = this.lvl;
    for (let i = 0; i < n; i++) {
      const a = L[i];
      const b = R[i];
      m.sum += a * a + b * b;
      const p = Math.max(Math.abs(a), Math.abs(b));
      if (p > m.peak) m.peak = p;
    }
    m.n += n;
    if (m.n >= sampleRate / 10) {
      this.level = { rms: Math.sqrt(m.sum / (2 * m.n)), peak: m.peak };
      m.sum = m.peak = m.n = 0;
    }
  }
}
registerProcessor('native-audio', NativeAudio);
