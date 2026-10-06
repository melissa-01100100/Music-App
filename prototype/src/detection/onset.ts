/**
 * Streaming strum (onset) detector. Pure: no DOM, no Web Audio, deterministic.
 * Runs inside the capture AudioWorklet, in Node tests and in tools/evaluate.ts.
 *
 * Feed it the ANALYSIS signal (after the 70 Hz high-pass) with `push(samples)`; it returns
 * the strums confirmed so far. Per STFT frame (N = 1024, hop 256, Hann):
 *   1. log-compressed magnitude  L[k] = log(1 + gamma * |X[k]| / (N/4))
 *   2. onset function  odf = sum_k w[k] * max(0, L_t[k] - L_{t-lag}[k])
 *      (half-wave-rectified spectral flux; weights favour high bins and sum to 1)
 *   3. peak picking: odf[p] is the max over [p - pre, p + lookahead] and
 *      odf[p] > delta + lambda * median(odf[p - medianWindow ... p + lookahead])
 *   4. level gate (absolute floor): frame RMS around the peak > room noise floor + minAboveRoomDb
 *   5. timestamp refinement: in the `refineSearchMs` before the end of the peak frame, the first
 *      1 ms block where the attack envelope (energy of x[n] - x[n-1]) rises above
 *      min + attackFraction * (max - min). That is the first string / pick noise of the strum.
 *   6. strum merging (0.3): candidate peaks within `minInterOnsetMs` of the first candidate are one
 *      strum (a slow strum gives one peak per string or two). The strum is emitted once no later
 *      candidate can join; its time is the first candidate within `strumLevelSpanDb` of the loudest
 *      one, its strength/level the maximum. A candidate `splitStrengthRatio` x stronger than the
 *      first starts a new strum.
 * Timestamps are sample indices of the analysed stream (audio clock), never wall clock.
 * Because of step 6 a strum is reported ~minInterOnsetMs + refineSearchMs after its onset
 * (~160 ms by default); the timestamp is not affected. Call `flush()` at the end of a file.
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
/** Most candidates kept for one strum (more are folded into the last slot's maximum). */
const MAX_CANDIDATES = 16;
/** Upper limits for time-based settings, so ring buffers can be sized once. */
const MAX_LOOK_MS = 60;
const MAX_SEARCH_MS = 80;

export class OnsetDetector {
  readonly sampleRate: number;
  /** Optional per-frame hook for tools/debugging: (frameIndex, odf, frameLevelDb). */
  onFrame: ((frame: number, odf: number, levelDb: number) => void) | null = null;

  private cfg: OnsetConfig;
  private readonly n: number;
  private readonly hop: number;
  private readonly lag: number;
  private readonly fft: FFT;
  private readonly win: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  /** Log magnitudes of the last `lag + 1` frames (ring by frame index). */
  private readonly logHist: Float64Array[];
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

  private noiseFloorDb: number | null = null;
  /** Onset of the newest candidate (open strum or emitted). */
  private lastOnsetSample = -Infinity;
  /** Onset of the last emitted strum. */
  private lastEmittedSample = -Infinity;
  // Candidates of the strum being merged (count 0 = none open).
  private candCount = 0;
  private readonly candOnset = new Float64Array(MAX_CANDIDATES);
  private readonly candLevel = new Float64Array(MAX_CANDIDATES);
  private readonly candStrength = new Float64Array(MAX_CANDIDATES);

  // Derived from settings (frames / samples).
  private preFrames = 0;
  private lookFrames = 0;
  private medianFrames = 0;
  private searchSamples = 0;
  private minGapSamples = 0;
  private attackBlock = 1;

  constructor(sampleRate: number, cfg: OnsetConfig) {
    if (!(sampleRate > 0)) throw new RangeError(`Invalid sample rate ${sampleRate}`);
    this.sampleRate = sampleRate;
    this.cfg = { ...cfg };
    this.n = cfg.frameSizeSamples;
    this.hop = cfg.hopSizeSamples;
    if (!(this.hop > 0 && this.hop <= this.n)) throw new RangeError('hopSizeSamples must be in 1..frameSizeSamples');
    this.lag = Math.max(1, Math.round(cfg.fluxLagFrames));
    this.fft = new FFT(this.n);
    this.win = hannWindow(this.n);
    this.re = new Float64Array(this.n);
    this.im = new Float64Array(this.n);
    const bins = this.n / 2 + 1;
    this.logHist = Array.from({ length: this.lag + 1 }, () => new Float64Array(bins));
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
    // A Hann-windowed full-scale sine peaks at N/4: normalise so it reads 1.
    this.magNorm = this.n / 4;

    this.applyDerived();
    const need = this.n + Math.ceil(((MAX_LOOK_MS + MAX_SEARCH_MS) / 1000) * sampleRate) + 4 * this.hop;
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

  /** Live-tunable settings (Developer drawer). Take effect from the next frame. */
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

  /** Feeds samples; returns strums confirmed during this call (usually none). */
  push(samples: ArrayLike<number>): OnsetEvent[] {
    let events: OnsetEvent[] = NO_EVENTS;
    let due = this.nextFrame * this.hop + this.n;
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.total & this.mask] = samples[i];
      this.total++;
      if (this.total === due) {
        this.computeFrame(this.nextFrame);
        const p = this.nextFrame - this.lookFrames;
        const ev = this.checkPeak(p);
        // Once a candidate from a later frame could no longer fall inside the window, the strum is complete.
        const done = this.candCount > 0 && (p + 1) * this.hop + this.n - this.searchSamples >= this.candOnset[0] + this.minGapSamples;
        const closed = ev ?? (done ? this.closeStrum() : null);
        this.nextFrame++;
        due += this.hop;
        if (closed) {
          if (events === NO_EVENTS) events = [];
          events.push(closed);
        }
      }
    }
    return events;
  }

  /** Emits the strum still being merged (end of a file). Live use never needs this. */
  flush(): OnsetEvent[] {
    const ev = this.closeStrum();
    return ev ? [ev] : [];
  }

  /** Adds a candidate peak; returns a completed strum if this candidate closed the previous one. */
  private addCandidate(onset: number, strength: number, levelDb: number): OnsetEvent | null {
    let closed: OnsetEvent | null = null;
    if (this.candCount > 0) {
      const inWindow = onset - this.candOnset[0] < this.minGapSamples;
      const ratio = this.cfg.splitStrengthRatio;
      const split = ratio > 0 && strength >= ratio * this.candStrength[0];
      if (inWindow && !split) {
        const i = Math.min(this.candCount, MAX_CANDIDATES - 1);
        if (i === this.candCount) {
          this.candOnset[i] = onset;
          this.candLevel[i] = levelDb;
          this.candStrength[i] = strength;
          this.candCount++;
        } else {
          this.candLevel[i] = Math.max(this.candLevel[i], levelDb);
          this.candStrength[i] = Math.max(this.candStrength[i], strength);
        }
        this.lastOnsetSample = onset;
        return null;
      }
      closed = this.closeStrum();
    }
    this.candOnset[0] = onset;
    this.candLevel[0] = levelDb;
    this.candStrength[0] = strength;
    this.candCount = 1;
    this.lastOnsetSample = onset;
    return closed;
  }

  private closeStrum(): OnsetEvent | null {
    const n = this.candCount;
    if (n === 0) return null;
    this.candCount = 0;
    let maxLevel = -Infinity, maxStrength = 0;
    for (let i = 0; i < n; i++) {
      maxLevel = Math.max(maxLevel, this.candLevel[i]);
      maxStrength = Math.max(maxStrength, this.candStrength[i]);
    }
    let onset = this.candOnset[0];
    for (let i = 0; i < n; i++) {
      if (this.candLevel[i] >= maxLevel - this.cfg.strumLevelSpanDb) {
        onset = this.candOnset[i];
        break;
      }
    }
    this.lastEmittedSample = onset;
    return { sampleIndex: onset, timeSec: onset / this.sampleRate, strength: maxStrength, levelDb: maxLevel };
  }

  private applyDerived(): void {
    const c = this.cfg;
    const hopMs = (this.hop / this.sampleRate) * 1000;
    const frames = (ms: number, maxMs: number) => Math.max(0, Math.round(Math.min(ms, maxMs) / hopMs));
    this.preFrames = frames(c.peakPreMaxMs, MAX_LOOK_MS);
    this.lookFrames = frames(c.peakLookaheadMs, MAX_LOOK_MS);
    this.medianFrames = Math.min(ODF_RING - 100, frames(c.medianWindowMs, 1e9));
    this.searchSamples = Math.round((Math.min(MAX_SEARCH_MS, Math.max(1, c.refineSearchMs)) / 1000) * this.sampleRate);
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
    const cur = this.logHist[f % (this.lag + 1)];
    const old = this.logHist[(f + 1) % (this.lag + 1)]; // = frame f - lag
    let flux = 0;
    for (let k = this.kMin; k <= this.kMax; k++) {
      const l = Math.log(1 + gamma * Math.sqrt(re[k] * re[k] + im[k] * im[k]) * norm);
      const d = l - old[k];
      if (d > 0) flux += this.weights[k] * d;
      cur[k] = l;
    }
    const slot = f % ODF_RING;
    // The first `lag` frames have nothing to compare with.
    this.odf[slot] = f < this.lag ? 0 : flux;
    this.level[slot] = 10 * Math.log10(sumSq / n + 1e-20);
    if (this.onFrame) this.onFrame(f, this.odf[slot], this.level[slot]);
  }

  private odfAt(f: number): number {
    return this.odf[f % ODF_RING];
  }

  private checkPeak(p: number): OnsetEvent | null {
    if (p < this.lag) return null;
    const v = this.odfAt(p);
    if (!(v > 0)) return null;
    for (let j = Math.max(0, p - this.preFrames); j < p; j++) if (this.odfAt(j) >= v) return null;
    for (let j = p + 1; j <= p + this.lookFrames; j++) if (this.odfAt(j) > v) return null;

    const c = this.cfg;
    const median = this.medianOdf(Math.max(this.lag, p - this.medianFrames), p + this.lookFrames);
    if (v <= c.thresholdDelta + c.thresholdLambda * median) return null;

    let levelDb = -Infinity;
    for (let j = p; j <= p + this.lookFrames; j++) levelDb = Math.max(levelDb, this.level[j % ODF_RING]);
    const floor = this.noiseFloorDb ?? c.fallbackNoiseFloorDb;
    if (levelDb < floor + c.minAboveRoomDb) return null;

    const onset = this.refineOnset(p);
    // A candidate too close after an already emitted strum belongs to it (its tail).
    if (this.candCount === 0 && onset - this.lastEmittedSample < this.minGapSamples) return null;
    return this.addCandidate(onset, v, levelDb);
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

  /** Sample index where the strum's attack starts (see file header, step 5). */
  private refineOnset(p: number): number {
    const end = Math.min(this.total, p * this.hop + this.n);
    const oldest = this.total - this.ring.length + 2;
    // Never before the previous candidate of this strum, nor inside the window of the last emitted strum.
    const afterPrev =
      this.candCount > 0 ? this.lastOnsetSample + this.attackBlock : this.lastEmittedSample + this.minGapSamples;
    const s0 = Math.max(1, oldest, end - this.searchSamples, Number.isFinite(afterPrev) ? afterPrev : 0);
    const blk = this.attackBlock;
    const nBlocks = Math.floor((end - s0) / blk);
    // Fallback: the Hann-weighted centre of the newest quarter of the peak frame.
    if (nBlocks < 2) return Math.max(0, end - this.n / 4);

    const env = this.envScratch;
    const { ring, mask } = this;
    let max = -1;
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
      if (e > max) max = e;
    }
    const base = this.baseline(nBlocks);
    const thr = base + this.cfg.attackFraction * (max - base);
    let b = 0;
    while (b < nBlocks - 1 && env[b] <= thr) b++;
    return s0 + b * blk;
  }

  /** Median of the attack envelope over the first part of the search window (sorts a scratch copy). */
  private baseline(nBlocks: number): number {
    const m = Math.max(1, Math.round(nBlocks * this.cfg.refineBaselineFraction));
    const s = this.medianScratch.length >= m ? this.medianScratch : new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const x = this.envScratch[i];
      let j = i;
      while (j > 0 && s[j - 1] > x) {
        s[j] = s[j - 1];
        j--;
      }
      s[j] = x;
    }
    return m % 2 ? s[m >> 1] : 0.5 * (s[(m >> 1) - 1] + s[m >> 1]);
  }
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}
