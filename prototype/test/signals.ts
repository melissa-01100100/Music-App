/** Deterministic synthetic signals for DSP tests. */
export const SR = 48000;

/** Small seeded PRNG (mulberry32) so tests are repeatable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sine(amplitude: number, n: number, freqHz: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

/** Uniform white noise with the given RMS. */
export function noise(rmsLevel: number, n: number, seed = 1): Float32Array {
  const r = rng(seed);
  const k = rmsLevel * Math.sqrt(3); // uniform [-k, k] has RMS k/sqrt(3)
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (r() * 2 - 1) * k;
  return out;
}

export function add(...signals: Float32Array[]): Float32Array {
  const out = new Float32Array(signals[0].length);
  for (const s of signals) for (let i = 0; i < out.length; i++) out[i] += s[i];
  return out;
}

export function rmsOf(x: ArrayLike<number>, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

export const db = (amp: number) => 20 * Math.log10(amp);

/**
 * Plucked-string-like burst: decaying harmonics of `f0` (higher harmonics decay faster)
 * plus a short noisy pick attack. Peak amplitude roughly `amplitude`.
 */
export function pluck(f0: number, amplitude: number, n: number, seed = 1, sampleRate = SR): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  const harmonics = 10;
  let norm = 0;
  for (let h = 1; h <= harmonics; h++) norm += 1 / h;
  for (let h = 1; h <= harmonics; h++) {
    const f = f0 * h;
    if (f >= sampleRate / 2) break;
    const a = amplitude / h / norm * 1.6;
    const tau = 0.6 / (1 + 0.35 * (h - 1));
    const phase = r() * 2 * Math.PI;
    const w = (2 * Math.PI * f) / sampleRate;
    for (let i = 0; i < n; i++) out[i] += a * Math.exp(-i / sampleRate / tau) * Math.sin(w * i + phase);
  }
  // Pick attack: ~3 ms decaying white noise burst.
  const atk = 0.5 * amplitude;
  const atkLen = Math.min(n, Math.round(0.02 * sampleRate));
  for (let i = 0; i < atkLen; i++) out[i] += atk * (r() * 2 - 1) * Math.exp(-i / sampleRate / 0.003);
  return out;
}

/** Mixes `burst` into `into` starting at sample `at` (truncated at the end). */
export function mixAt(into: Float32Array, burst: Float32Array, at: number): void {
  for (let i = 0; i < burst.length && at + i < into.length; i++) into[at + i] += burst[i];
}

export const CHORD_ROOTS_HZ = [110, 131, 98, 147];

/**
 * A "strum track": `quietSec` of background noise only (for the room measurement), then
 * bursts at the given times (seconds), cycling through CHORD_ROOTS_HZ, over background noise.
 */
export function strumTrack(opts: {
  timesSec: number[];
  durationSec: number;
  noiseRms?: number;
  amplitudes?: number[];
  roots?: number[];
  seed?: number;
}): Float32Array {
  const n = Math.round(opts.durationSec * SR);
  const out = noise(opts.noiseRms ?? 0.003, n, opts.seed ?? 7);
  const roots = opts.roots ?? CHORD_ROOTS_HZ;
  opts.timesSec.forEach((t, i) => {
    const amp = opts.amplitudes ? opts.amplitudes[i % opts.amplitudes.length] : 0.2;
    mixAt(out, pluck(roots[i % roots.length], amp, Math.round(1.5 * SR), 100 + i), Math.round(t * SR));
  });
  return out;
}
