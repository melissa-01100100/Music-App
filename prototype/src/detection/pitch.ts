/**
 * Monophonic pitch detection for the tuner: McLeod Pitch Method (MPM, McLeod & Wyvill 2005).
 * Pure (no DOM, no Web Audio), deterministic, unit tested.
 *
 *   NSDF n(τ) = 2·r(τ) / m(τ),  r(τ) = Σ x[j]·x[j+τ],  m(τ) = Σ (x[j]² + x[j+τ]²)
 *
 * n(τ) is 1 for a perfectly periodic signal at its period and stays in -1..1 whatever the level.
 * r(τ) comes from one zero-padded FFT (|X|² -> inverse), m(τ) from a running sum, so a 4096-sample
 * window costs two 8192-point FFTs.
 *
 * Octave errors: a strong 2nd harmonic gives a second NSDF peak at half the period. MPM takes the
 * FIRST "key maximum" (highest point of each positive lobe) that reaches `peakThreshold` x the
 * highest one. At half the period the fundamental and other odd harmonics are out of phase, which
 * pulls that peak well below the true period's peak, so the true period wins unless the fundamental
 * is almost missing. Optional `expectedHz` (tuner locked to a string) picks the clear peak nearest
 * that pitch instead, which removes octave errors entirely for a locked string.
 */
import type { PitchConfig } from './config';
import { FFT } from './fft';
import { Biquad, lowPassCoeffs } from './filters';

export type PitchRejectReason = 'quiet' | 'unclear';

export interface PitchResult {
  /** Detected fundamental in Hz, or null when there is no reliable pitch. */
  hz: number | null;
  /** NSDF height at the chosen period (0..1). 1 = perfectly periodic. */
  clarity: number;
  /** RMS level of the window in dBFS. */
  levelDb: number;
  /** Why there is no reading (only when hz is null). */
  reason?: PitchRejectReason;
}

export interface DetectOptions {
  /** Current room noise floor in dBFS (null = not measured yet: only the absolute gate applies). */
  noiseFloorDb?: number | null;
  /** If set, choose the clear NSDF peak closest to this pitch (manual string lock). */
  expectedHz?: number;
}

/** Peak position and height by fitting a parabola through three equally spaced points. */
export function parabolicPeak(y0: number, y1: number, y2: number): { offset: number; value: number } {
  const denom = y0 - 2 * y1 + y2;
  if (denom >= 0 || !Number.isFinite(denom)) return { offset: 0, value: y1 };
  const offset = Math.max(-1, Math.min(1, (0.5 * (y0 - y2)) / denom));
  return { offset, value: y1 - 0.25 * (y0 - y2) * offset };
}

/** Lag ranges searched, from the frequency limits. */
export function lagRange(sampleRate: number, cfg: Pick<PitchConfig, 'minHz' | 'maxHz' | 'windowSamples'>): { min: number; max: number } {
  const min = Math.max(2, Math.floor(sampleRate / cfg.maxHz));
  const max = Math.min(Math.floor(cfg.windowSamples / 2), Math.ceil(sampleRate / cfg.minHz));
  return { min, max };
}

export class PitchDetector {
  private readonly n: number;
  private readonly fft: FFT;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly x: Float64Array;
  /** NSDF for lags 0..lagMax+1. */
  readonly nsdf: Float64Array;
  private readonly lagMin: number;
  private readonly lagMax: number;

  constructor(
    readonly sampleRate: number,
    private readonly cfg: PitchConfig,
  ) {
    this.n = cfg.windowSamples;
    if ((this.n & (this.n - 1)) !== 0) throw new RangeError(`windowSamples must be a power of two, got ${this.n}`);
    this.fft = new FFT(this.n * 2);
    this.re = new Float64Array(this.n * 2);
    this.im = new Float64Array(this.n * 2);
    this.x = new Float64Array(this.n);
    const lags = lagRange(sampleRate, cfg);
    this.lagMin = lags.min;
    this.lagMax = lags.max;
    this.nsdf = new Float64Array(this.lagMax + 2);
  }

  /** Analyses one window of exactly `windowSamples` (already high-passed) samples. */
  detect(window: ArrayLike<number>, opts: DetectOptions = {}): PitchResult {
    const n = this.n;
    if (window.length < n) throw new RangeError(`window needs ${n} samples, got ${window.length}`);
    const x = this.x;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += window[i];
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const v = window[i] - mean;
      x[i] = v;
      energy += v * v;
    }
    const levelDb = 10 * Math.log10(energy / n + 1e-20);
    const floor = opts.noiseFloorDb;
    const gateDb = Math.max(this.cfg.minLevelDb, floor === null || floor === undefined ? -Infinity : floor + this.cfg.minAboveRoomDb);
    if (levelDb < gateDb) return { hz: null, clarity: 0, levelDb, reason: 'quiet' };

    this.computeNsdf();
    const peaks = this.keyMaxima();
    if (peaks.length === 0) return { hz: null, clarity: 0, levelDb, reason: 'unclear' };

    const best = this.choosePeak(peaks, opts.expectedHz);
    const p = parabolicPeak(this.nsdf[best - 1], this.nsdf[best], this.nsdf[best + 1]);
    const clarity = Math.min(1, p.value);
    if (clarity < this.cfg.minClarity) return { hz: null, clarity, levelDb, reason: 'unclear' };
    return { hz: this.sampleRate / (best + p.offset), clarity, levelDb };
  }

  /** n(τ) for τ = 0..lagMax+1 (r via FFT autocorrelation, m via running sum). */
  private computeNsdf(): void {
    const { n, re, im, x, nsdf } = this;
    re.fill(0);
    im.fill(0);
    re.set(x);
    this.fft.forward(re, im);
    for (let k = 0; k < re.length; k++) {
      re[k] = re[k] * re[k] + im[k] * im[k];
      im[k] = 0;
    }
    // |X|² is real and even, so a forward FFT equals size x the inverse.
    this.fft.forward(re, im);
    const scale = 1 / re.length;
    let m = 0;
    for (let i = 0; i < n; i++) m += 2 * x[i] * x[i];
    for (let tau = 0; tau < nsdf.length; tau++) {
      if (tau > 0) m -= x[tau - 1] * x[tau - 1] + x[n - tau] * x[n - tau];
      nsdf[tau] = m > 1e-12 ? (2 * re[tau] * scale) / m : 0;
    }
  }

  /** Lag of the highest point of each positive lobe (after the first zero crossing), inside the lag range. */
  private keyMaxima(): number[] {
    const { nsdf, lagMin, lagMax } = this;
    const out: number[] = [];
    let tau = 1;
    while (tau <= lagMax && nsdf[tau] > 0) tau++; // skip the lobe around τ = 0
    let best = -1;
    for (; tau <= lagMax; tau++) {
      const v = nsdf[tau];
      if (v > 0) {
        if (best < 0 || v > nsdf[best]) best = tau;
      } else if (best >= 0) {
        out.push(best);
        best = -1;
      }
    }
    // A lobe still open at lagMax only counts if its maximum is a real local maximum.
    if (best >= 0 && best < lagMax && nsdf[best] >= nsdf[best + 1]) out.push(best);
    return out.filter((t) => t >= lagMin && t <= lagMax && t > 0 && nsdf[t] >= nsdf[t - 1] && nsdf[t] >= nsdf[t + 1]);
  }

  private choosePeak(peaks: number[], expectedHz?: number): number {
    const { nsdf } = this;
    let highest = 0;
    for (const t of peaks) highest = Math.max(highest, nsdf[t]);
    if (expectedHz && expectedHz > 0) {
      // Locked string: the clear peak nearest the expected pitch (in octaves).
      let pick = -1;
      let pickDist = Infinity;
      for (const t of peaks) {
        if (nsdf[t] < this.cfg.minClarity) continue;
        const dist = Math.abs(Math.log2(this.sampleRate / t / expectedHz));
        if (dist < pickDist) {
          pick = t;
          pickDist = dist;
        }
      }
      if (pick >= 0) return pick;
    }
    const cut = this.cfg.peakThreshold * highest;
    for (const t of peaks) if (nsdf[t] >= cut) return t;
    return peaks[0];
  }
}

export interface PitchFrame extends PitchResult {
  /** Index (on the pushed-sample timeline) one past the last sample of the analysed window. */
  endSample: number;
}

/**
 * Streaming wrapper: low-passes the (already high-passed) input, keeps the last `windowSamples`
 * samples and analyses them every `hopSamples`. Push any chunk size; no reading until the first
 * full window. The level gate therefore sees the low-passed level.
 */
export class PitchTracker {
  private readonly ring: Float32Array;
  private readonly frame: Float32Array;
  private write = 0;
  private filled = 0;
  private sinceHop = 0;
  private total = 0;
  readonly detector: PitchDetector;
  private readonly lowPass: Biquad[];

  constructor(
    sampleRate: number,
    private readonly cfg: PitchConfig,
  ) {
    this.detector = new PitchDetector(sampleRate, cfg);
    const lp = cfg.lowPassHz > 0 && cfg.lowPassHz < sampleRate / 2 ? lowPassCoeffs(cfg.lowPassHz, sampleRate) : null;
    this.lowPass = lp ? Array.from({ length: Math.max(1, cfg.lowPassStages) }, () => new Biquad(lp)) : [];
    this.ring = new Float32Array(cfg.windowSamples);
    this.frame = new Float32Array(cfg.windowSamples);
  }

  push(samples: ArrayLike<number>, opts: DetectOptions = {}): PitchFrame[] {
    const out: PitchFrame[] = [];
    const n = this.ring.length;
    let input: ArrayLike<number> = samples;
    if (this.lowPass.length) {
      const f = Float32Array.from(samples);
      for (const b of this.lowPass) b.process(f, f);
      input = f;
    }
    for (let i = 0; i < input.length; i++) {
      this.ring[this.write] = input[i];
      this.write = (this.write + 1) % n;
      this.total++;
      if (this.filled < n) this.filled++;
      if (++this.sinceHop >= this.cfg.hopSamples && this.filled === n) {
        this.sinceHop = 0;
        // Unroll the ring, oldest sample first.
        this.frame.set(this.ring.subarray(this.write), 0);
        this.frame.set(this.ring.subarray(0, this.write), n - this.write);
        out.push({ ...this.detector.detect(this.frame, opts), endSample: this.total });
      }
    }
    return out;
  }

  reset(): void {
    this.ring.fill(0);
    this.write = 0;
    this.filled = 0;
    this.sinceHop = 0;
    for (const b of this.lowPass) b.reset();
  }
}
