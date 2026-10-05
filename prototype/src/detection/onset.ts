/**
 * Streaming strum (onset) detector. Pure: no DOM, no Web Audio, deterministic.
 * Runs inside the capture AudioWorklet, in Node tests and in tools/evaluate.ts.
 *
 * Feed it the ANALYSIS signal (after the 70 Hz high-pass) with `push(samples)`; it returns
 * the strums found so far. Pipeline per STFT frame (N = 1024, hop 256, Hann):
 *   1. log-compressed magnitude  L[k] = log(1 + gamma * |X[k]| / (N/4))
 *   2. onset function odf = sum_k w[k] * max(0, L[k] - Lprev[k])   (weights favour high bins, sum w = 1)
 *   3. peak picking: odf[p] is the max over [p - pre, p + lookahead] and
 *      odf[p] > delta + lambda * median(odf[p - medianWindow ... p + lookahead])
 *   4. level gate: frame RMS around the peak > room noise floor + minAboveRoomDb
 *   5. timestamp refinement: back over frames with odf > riseFraction * peak, then to the
 *      sample block where the attack envelope (energy of x[n] - x[n-1]) starts to rise
 *   6. minimum inter-onset interval (the first strum wins)
 * Timestamps are sample indices of the stream (audio clock), never wall clock.
 *
 * `push` allocates nothing in steady state except the returned event objects.
 */
import type { LiveOnsetSettings, OnsetConfig } from './config';
import { FFT, hannWindow } from './fft';

export interface OnsetEvent {
  /** Sample index in the analysed stream (0 = first sample pushed). */
  sampleIndex: number;
  /** sampleIndex / sampleRate. */
  timeSec: number;
  /** Onset-function peak value (ODF units, see config). Bigger = sharper, louder attack. */
  strength: number;
  /** Highest frame RMS level (dBFS, analysis path) around the strum. */
  levelDb: number;
}

const NO_EVENTS: OnsetEvent[] = [];
const ODF_RING = 512;

export class OnsetDetector {
  readonly sampleRate: number;
  private cfg: OnsetConfig;
  private readonly n: number;
  private readonly hop: number;
  private readonly fft: FFT;
  private readonly win: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly prevLog: Float64Array;
  private readonly weights: Float64Array;
  private readonly kMin: number;
  private readonly kMax: number;
  private readonly magNorm: number;

  private readonly ring: Float32Array;
  private readonly mask: number;
  private total = 0;
  private nextFrame = 0;

  private readonly odf = new Float64Array(ODF_RING);
  private readonly level = new Float64Array(ODF_RING);
  private readonly medianScratch = new Float64Array(ODF_RING);
  private readonly envScratch: Float64Array;

  /** Optional per-frame hook for tools/debugging: (frameIndex, odf, frameLevelDb). */
  onFrame: ((frame: number, odf: number, levelDb: number) => void) | null = null;

  private noiseFloorDb: number | null = null;
  private lastOnsetSample = -Infinity;

  // Derived (in frames / samples), recomputed when settings change.
  private preFrames = 0;
  private lookFrames = 0;
  private medianFrames = 0;
  private backFrames = 0;
  private minGapSamples = 0;
  private attackBlock = 1;

  constructor(sampleRate: number, cfg: OnsetConfig) {
    if (!(sampleRate > 0)) throw new RangeError(`Invalid sample rate ${sampleRate}`);
    this.sampleRate = sampleRate;
    this.cfg = { ...cfg };
    this.n = cfg.frameSizeSamples;
    this.hop = cfg.hopSizeSamples;
    if (!(this.hop > 0 && this.hop <= this.n)) throw new RangeError('hopSizeSamples must be in 1..frameSizeSamples');
    this.fft = new FFT(this.n);
    this.win = hannWindow(this.n);
    this.re = new Float64Array(this.n);
    this.im = new Float64Array(this.n);
    const bins = this.n / 2 + 1;
    this.prevLog = new Float64Array(bins);
    const binHz = sampleRate / this.n;
    this.kMin = Math.max(1, Math.ceil(cfg.fluxMinHz / binHz));
    this.kMax = Math.min(bins - 1, Math.floor(Math.min(cfg.fluxMaxHz, sampleRate / 2) / binHz));
    this.weights = new Float64Array(bins);
    let sumW = 0;
    for (let k = this.kMin; k <= this.kMax; k++) {
      const w = 1 + cfg.hfcWeight * ((k * binHz) / cfg.fluxMaxHz);
      this.weights[k] = w;
      sumW += w;
    }
    for (let k = this.kMin; k <= this.kMax; k++) this.weights[k] /= sumW;
    // Hann-windowed full-scale sine peaks at N/4: normalise so it reads 1.
    this.magNorm = this.n / 4;

    this.applyDerived();
    const maxBack = Math.ceil((60 / 1000) * sampleRate / this.hop); // refineMaxBackMs is clamped to 60 ms
    const maxLook = Math.ceil((60 / 1000) * sampleRate / this.hop);
    const need = this.n + (maxBack + maxLook + 4) * this.hop;
    let size = 8192;
    while (size < need) size <<= 1;
    this.ring = new Float32Array(size);
    this.mask = size - 1;
    this.envScratch = new Float64Array(size);
  }

  /** Room noise floor (dBFS of the analysis signal, same scale as the meter). null = not measured yet. */
  setNoiseFloorDb(db: number | null): void {
    this.noiseFloorDb = db !== null && Number.isFinite(db) ? db : null;
  }

  /** Live-tunable settings (Developer drawer). Takes effect from the next frame. */
  updateSettings(s: Partial<LiveOnsetSettings>): void {
    const next = { ...this.cfg };
    if (isNum(s.thresholdDelta)) next.thresholdDelta = Math.max(0, s.thresholdDelta);
    if (isNum(s.thresholdLambda)) next.thresholdLambda = Math.max(0, s.thresholdLambda);
    if (isNum(s.minInterOnsetMs)) next.minInterOnsetMs = Math.max(0, s.minInterOnsetMs);
    if (isNum(s.minAboveRoomDb)) next.minAboveRoomDb = s.minAboveRoomDb;
    this.cfg = next;
    this.applyDerived();
  }

  get settings(): Readonly<OnsetConfig> {
    return this.cfg;
  }

  /** Total samples pushed so far. */
  get samplesConsumed(): number {
    return this.total;
  }

  /** Clears all history (sample counter restarts at 0). Settings and noise floor are kept. */
  reset(): void {
    this.total = 0;
    this.nextFrame = 0;
    this.ring.fill(0);
    this.prevLog.fill(0);
    this.odf.fill(0);
    this.level.fill(0);
    this.lastOnsetSample = -Infinity;
  }

  /** Feeds samples; returns strums confirmed during this call (usually none). */
  push(samples: ArrayLike<number>): OnsetEvent[] {
    let events: OnsetEvent[] = NO_EVENTS;
    const n = this.n;
    const hop = this.hop;
    let due = this.nextFrame * hop + n;
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.total & this.mask] = samples[i];
      this.total++;
      if (this.total === due) {
        this.computeFrame(this.nextFrame);
        const ev = this.checkPeak(this.nextFrame - this.lookFrames);
        this.nextFrame++;
        due += hop;
        if (ev) {
          if (events === NO_EVENTS) events = [];
          events.push(ev);
        }
      }
    }
    return events;
  }

  private applyDerived(): void {
    const c = this.cfg;
    const hopMs = (this.hop / this.sampleRate) * 1000;
    const frames = (ms: number, max: number) => Math.min(max, Math.max(0, Math.round(ms / hopMs)));
    this.preFrames = frames(c.peakPreMaxMs, 60);
    this.lookFrames = frames(Math.min(c.peakLookaheadMs, 60), 60);
    this.medianFrames = frames(c.medianWindowMs, ODF_RING - 70);
    this.backFrames = frames(Math.min(c.refineMaxBackMs, 60), 60);
    this.minGapSamples = Math.round((c.minInterOnsetMs / 1000) * this.sampleRate);
    this.attackBlock = Math.max(1, Math.round((c.attackBlockMs / 1000) * this.sampleRate));
  }

  private computeFrame(f: number): void {
    const n = this.n;
    const start = f * this.hop;
    const { re, im, win, ring, mask } = this;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const x = ring[(start + i) & mask];
      sumSq += x * x;
      re[i] = x * win[i];
      im[i] = 0;
    }
    this.fft.forward(re, im);
    const gamma = this.cfg.logCompressionGamma;
    const norm = 1 / this.magNorm;
    let flux = 0;
    for (let k = this.kMin; k <= this.kMax; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * norm;
      const l = Math.log(1 + gamma * mag);
      const d = l - this.prevLog[k];
      if (d > 0) flux += this.weights[k] * d;
      this.prevLog[k] = l;
    }
    const slot = f % ODF_RING;
    // Frame 0 has no previous frame: its "flux" is just the level, not a change.
    this.odf[slot] = f === 0 ? 0 : flux;
    this.level[slot] = 10 * Math.log10(sumSq / n + 1e-20);
    if (this.onFrame) this.onFrame(f, this.odf[slot], this.level[slot]);
  }

  private odfAt(f: number): number {
    return this.odf[f % ODF_RING];
  }

  private checkPeak(p: number): OnsetEvent | null {
    if (p < 1) return null;
    const v = this.odfAt(p);
    if (!(v > 0)) return null;
    for (let j = Math.max(1, p - this.preFrames); j < p; j++) if (this.odfAt(j) >= v) return null;
    for (let j = p + 1; j <= p + this.lookFrames; j++) if (this.odfAt(j) > v) return null;

    const c = this.cfg;
    const threshold = c.thresholdDelta + c.thresholdLambda * this.medianOdf(Math.max(1, p - this.medianFrames), p + this.lookFrames);
    if (v <= threshold) return null;

    let levelDb = -Infinity;
    for (let j = p; j <= p + this.lookFrames; j++) levelDb = Math.max(levelDb, this.level[j % ODF_RING]);
    const floor = this.noiseFloorDb ?? c.fallbackNoiseFloorDb;
    if (levelDb < floor + c.minAboveRoomDb) return null;

    const onset = this.refineOnset(p, v);
    if (onset - this.lastOnsetSample < this.minGapSamples) return null;
    this.lastOnsetSample = onset;
    return { sampleIndex: onset, timeSec: onset / this.sampleRate, strength: v, levelDb };
  }

  private medianOdf(from: number, to: number): number {
    const s = this.medianScratch;
    let len = 0;
    for (let j = from; j <= to; j++) {
      // Insertion sort into the scratch buffer (windows are ~25 values).
      const x = this.odfAt(j);
      let i = len++;
      while (i > 0 && s[i - 1] > x) {
        s[i] = s[i - 1];
        i--;
      }
      s[i] = x;
    }
    if (len === 0) return 0;
    const mid = len >> 1;
    return len % 2 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
  }

  /** Sample index where the strum's energy starts to rise (see file header, step 5). */
  private refineOnset(p: number, peak: number): number {
    const c = this.cfg;
    let r = p;
    const minR = Math.max(1, p - this.backFrames);
    while (r - 1 >= minR && this.odfAt(r - 1) > c.refineRiseFraction * peak) r--;

    const oldest = this.total - this.ring.length + 1;
    const s0 = Math.max(1, (r - 1) * this.hop, oldest + 1);
    const s1 = Math.min(this.total, p * this.hop + this.n);
    const blk = this.attackBlock;
    const nBlocks = Math.floor((s1 - s0) / blk);
    if (nBlocks < 2) return r * this.hop + this.n / 2;

    const env = this.envScratch;
    const { ring, mask } = this;
    let max = -1, argMax = 0, min = Infinity;
    for (let b = 0; b < nBlocks; b++) {
      let e = 0;
      const from = s0 + b * blk;
      let prev = ring[(from - 1) & mask];
      for (let s = from; s < from + blk; s++) {
        const x = ring[s & mask];
        const d = x - prev;
        e += d * d;
        prev = x;
      }
      env[b] = e;
      if (e > max) { max = e; argMax = b; }
      if (e < min) min = e;
    }
    const thr = min + c.attackFraction * (max - min);
    let b = argMax;
    while (b > 0 && env[b - 1] > thr) b--;
    return s0 + b * blk;
  }
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}
