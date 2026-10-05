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
