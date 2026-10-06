/**
 * Chroma (pitch class profile) of a short audio segment. Pure, deterministic, allocation per call
 * (runs once per strum on the main thread, not on the audio thread).
 *
 *   1. one Hann window over the whole segment, zero-padded to `fftSize`, magnitude spectrum
 *   2. fold every bin between minHz and maxHz into its nearest pitch class (A4 = a4Hz), weighted by
 *      cos^2 of its distance from the semitone centre, so bins between two notes (window leakage)
 *      count little
 *   3. log compression log(1 + gamma * c / max(c)), then L2 normalisation
 * The bass chroma is the same fold over the bass range only (lowest strings).
 */
import type { ChordConfig } from './config';
import { FFT } from './fft';
import { normalise } from './chords';

export type ChromaConfig = Pick<ChordConfig, 'fftSize' | 'chromaMinHz' | 'chromaMaxHz' | 'bassMinHz' | 'bassMaxHz' | 'chromaLogGamma' | 'a4Hz' | 'peaksOnly'>;

export interface Chroma {
  /** 12 values, index 0 = C, L2-normalised (all zero for silence). */
  chroma: Float64Array;
  /** Bass-range chroma, same layout. */
  bass: Float64Array;
  /** RMS level of the segment in dBFS. */
  levelDb: number;
}

const ffts = new Map<number, FFT>();
function fftOf(size: number): FFT {
  let f = ffts.get(size);
  if (!f) ffts.set(size, (f = new FFT(size)));
  return f;
}

/** Magnitude spectrum (bins 0..fftSize/2) of the Hann-windowed segment, zero-padded. */
export function magnitudeSpectrum(segment: ArrayLike<number>, fftSize: number): Float64Array {
  const n = Math.min(segment.length, fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let i = 0; i < n; i++) re[i] = segment[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n));
  fftOf(fftSize).forward(re, im);
  const mag = new Float64Array(fftSize / 2 + 1);
  for (let k = 0; k < mag.length; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}

/** Raw (uncompressed, unnormalised) fold of spectrum bins in [minHz, maxHz] into 12 pitch classes. */
export function foldPitchClasses(mag: Float64Array, sampleRate: number, fftSize: number, minHz: number, maxHz: number, a4Hz: number, peaksOnly = false): Float64Array {
  const out = new Float64Array(12);
  const binHz = sampleRate / fftSize;
  const k0 = Math.max(1, Math.ceil(minHz / binHz));
  const k1 = Math.min(mag.length - 1, Math.floor(maxHz / binHz));
  for (let k = k0; k <= k1; k++) {
    if (peaksOnly && !(mag[k] > mag[k - 1] && mag[k] >= mag[k + 1])) continue;
    const midi = 69 + 12 * Math.log2((k * binHz) / a4Hz);
    const nearest = Math.round(midi);
    const w = Math.cos(Math.PI * (midi - nearest)) ** 2;
    out[((nearest % 12) + 12) % 12] += w * mag[k];
  }
  return out;
}

/** log(1 + gamma * c / max(c)), then L2-normalised. All-zero input stays zero. */
export function compressChroma(c: Float64Array, gamma: number): Float64Array {
  let max = 0;
  for (const x of c) max = Math.max(max, x);
  const out = new Float64Array(12);
  if (!(max > 0)) return out;
  for (let i = 0; i < 12; i++) out[i] = Math.log1p((gamma * c[i]) / max);
  return normalise(out);
}

export function computeChroma(segment: ArrayLike<number>, sampleRate: number, cfg: ChromaConfig): Chroma {
  let sumSq = 0;
  for (let i = 0; i < segment.length; i++) sumSq += segment[i] * segment[i];
  const levelDb = segment.length && sumSq > 0 ? 10 * Math.log10(sumSq / segment.length) : -Infinity;
  const mag = magnitudeSpectrum(segment, cfg.fftSize);
  const full = foldPitchClasses(mag, sampleRate, cfg.fftSize, cfg.chromaMinHz, cfg.chromaMaxHz, cfg.a4Hz, cfg.peaksOnly);
  const bass = foldPitchClasses(mag, sampleRate, cfg.fftSize, cfg.bassMinHz, cfg.bassMaxHz, cfg.a4Hz, cfg.peaksOnly);
  return { chroma: compressChroma(full, cfg.chromaLogGamma), bass: compressChroma(bass, cfg.chromaLogGamma), levelDb };
}
