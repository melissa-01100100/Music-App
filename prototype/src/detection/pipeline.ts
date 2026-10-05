/**
 * Offline version of the live analysis chain, for tests and tools/evaluate.ts:
 *   raw mic samples -> analysis high-pass -> OnsetDetector   (exactly what the worklet does)
 * plus a room noise floor estimate. Pure: no DOM, no Web Audio.
 */
import { analysisConfig, noiseFloorConfig, onsetConfig, type AnalysisConfig, type OnsetConfig } from './config';
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

/** Per-block (1024-sample) RMS levels in dBFS, like the worklet's level messages. */
export function blockLevelsDb(analysis: Float32Array, minDb = noiseFloorConfig.minDb): number[] {
  const out: number[] = [];
  for (let i = 0; i + BLOCK <= analysis.length; i += BLOCK) {
    let s = 0;
    for (let j = i; j < i + BLOCK; j++) s += analysis[j] * analysis[j];
    out.push(Math.max(minDb, 10 * Math.log10(s / BLOCK + 1e-20)));
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
  const levels = blockLevelsDb(analysis);
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
  return events;
}

/** Full chain from RAW samples (high-pass + detector). */
export function detectOnsets(raw: Float32Array, sampleRate: number, opts: DetectOptions = {}): OnsetEvent[] {
  return detectOnsetsInAnalysis(highPass(raw, sampleRate), sampleRate, opts);
}
