/**
 * Offline version of the live analysis chain, for tests and tools/evaluate.ts:
 *   raw mic samples -> analysis high-pass -> OnsetDetector   (exactly what the worklet does)
 * plus a room noise floor estimate. Pure: no DOM, no Web Audio.
 */
import { analysisConfig, chordConfig, noiseFloorConfig, onsetConfig, type AnalysisConfig, type ChordConfig, type OnsetConfig } from './config';
import { ChordClassifier, type ChordResult } from './classifier';
import { StrumTracker } from './strum';
import { Biquad, highPassCoeffs } from './filters';
import { NoiseFloorEstimator, percentile } from './noiseFloor';
import { OnsetDetector, type OnsetEvent } from './onset';

/** Same filter chain as the capture worklet (state carried across calls). */
export function makeAnalysisFilter(sampleRate: number, cfg: AnalysisConfig = analysisConfig) {
  const coeffs = highPassCoeffs(cfg.highPassHz, sampleRate);
  const stages = Array.from({ length: Math.max(1, cfg.highPassStages) }, () => new Biquad(coeffs));
  return (input: ArrayLike<number>, output: Float32Array): void => {
    stages[0].process(input, output);
    for (let s = 1; s < stages.length; s++) stages[s].process(output, output);
  };
}

export function highPass(samples: ArrayLike<number>, sampleRate: number, cfg: AnalysisConfig = analysisConfig): Float32Array {
  const out = new Float32Array(samples.length);
  makeAnalysisFilter(sampleRate, cfg)(samples, out);
  return out;
}

const BLOCK = 1024;

/**
 * Per-block (1024-sample) RMS levels in dBFS, like the worklet's level messages.
 * Unclamped by default: an all-zero block is -Infinity (digital silence, ignored by the floor).
 */
export function blockLevelsDb(analysis: Float32Array, minDb = -Infinity): number[] {
  const out: number[] = [];
  for (let i = 0; i + BLOCK <= analysis.length; i += BLOCK) {
    let s = 0;
    for (let j = i; j < i + BLOCK; j++) s += analysis[j] * analysis[j];
    out.push(Math.max(minDb, s > 0 ? 10 * Math.log10(s / BLOCK) : -Infinity));
  }
  return out;
}

/**
 * Room floor as the live app measures it: the "stay quiet" estimate over the first
 * `quietMeasureMs` of the analysis signal. Returns null if the clip is too short.
 */
export function measureQuietFloorDb(analysis: Float32Array, sampleRate: number): number | null {
  const est = new NoiseFloorEstimator(noiseFloorConfig);
  const blockMs = (BLOCK / sampleRate) * 1000;
  for (const db of blockLevelsDb(analysis)) {
    est.addBlock(db, blockMs);
    if (est.initialFloorDb !== null) return est.initialFloorDb;
  }
  return null;
}

/**
 * Floor estimate for a clip that may not start quietly (e.g. a recording made mid-session):
 * a low percentile of all block levels.
 */
export function estimateFloorDb(analysis: Float32Array, pct = 10): number | null {
  const levels = blockLevelsDb(analysis)
    .filter((db) => db >= noiseFloorConfig.digitalSilenceDb)
    .map((db) => Math.max(noiseFloorConfig.minDb, db));
  return levels.length ? percentile(levels, pct) : null;
}

export interface DetectOptions {
  config?: OnsetConfig;
  /** Room floor in dBFS. Omit to skip the level gate. */
  noiseFloorDb?: number | null;
  /** Push size, to mimic the worklet's 128-frame quanta. */
  chunkSamples?: number;
}

/** Runs the detector over an already high-passed signal. */
export function detectOnsetsInAnalysis(analysis: Float32Array, sampleRate: number, opts: DetectOptions = {}): OnsetEvent[] {
  const det = new OnsetDetector(sampleRate, opts.config ?? onsetConfig);
  det.setNoiseFloorDb(opts.noiseFloorDb ?? null);
  const chunk = opts.chunkSamples ?? 128;
  const events: OnsetEvent[] = [];
  for (let i = 0; i < analysis.length; i += chunk) events.push(...det.push(analysis.subarray(i, i + chunk)));
  events.push(...det.flush());
  return events;
}

/** Full chain from RAW samples (high-pass + detector). */
export function detectOnsets(raw: Float32Array, sampleRate: number, opts: DetectOptions = {}): OnsetEvent[] {
  return detectOnsetsInAnalysis(highPass(raw, sampleRate), sampleRate, opts);
}

export interface ClassifiedStrum {
  event: OnsetEvent;
  chord: ChordResult;
}

/**
 * Full 0.3 chain on an already high-passed signal, exactly as the app runs it: StrumTracker (onsets +
 * chord audio, worklet) then ChordClassifier (main thread).
 */
export function detectStrumsInAnalysis(
  analysis: Float32Array,
  sampleRate: number,
  opts: DetectOptions & { chord?: ChordConfig } = {},
): ClassifiedStrum[] {
  const chord = opts.chord ?? chordConfig;
  const clf = new ChordClassifier(chord);
  const tracker = new StrumTracker(sampleRate, opts.config ?? onsetConfig, chord.chordWindowEndMs);
  tracker.detector.setNoiseFloorDb(opts.noiseFloorDb ?? null);
  const chunk = opts.chunkSamples ?? 128;
  const out: ClassifiedStrum[] = [];
  const take = (list: ReturnType<StrumTracker['push']>) => {
    for (const s of list) out.push({ event: s.event, chord: clf.classify(s.audio, 0, sampleRate, opts.noiseFloorDb ?? null) });
  };
  for (let i = 0; i < analysis.length; i += chunk) take(tracker.push(analysis.subarray(i, i + chunk)));
  take(tracker.flush());
  return out;
}
