/**
 * Pure DSP filters. No DOM, no Web Audio: runs in Node tests, in the AudioWorklet,
 * and can be ported to another engine.
 *
 * Used on the ANALYSIS path only (meter, noise floor, later onset/chroma).
 * The raw mic signal is never modified, so future recording stays untouched.
 */

/** Normalised biquad coefficients (a0 = 1). */
export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * 2nd-order high-pass (RBJ Audio EQ Cookbook). Q = 1/sqrt(2) gives a Butterworth
 * response: flat pass band, -3 dB at `cutoffHz`, -12 dB/octave below it.
 */
export function highPassCoeffs(cutoffHz: number, sampleRate: number, q = Math.SQRT1_2): BiquadCoeffs {
  if (!(cutoffHz > 0) || !(sampleRate > 0) || cutoffHz >= sampleRate / 2) {
    throw new RangeError(`Invalid high-pass cutoff ${cutoffHz} Hz at ${sampleRate} Hz`);
  }
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** 2nd-order low-pass (RBJ Audio EQ Cookbook), Butterworth with the default Q. */
export function lowPassCoeffs(cutoffHz: number, sampleRate: number, q = Math.SQRT1_2): BiquadCoeffs {
  if (!(cutoffHz > 0) || !(sampleRate > 0) || cutoffHz >= sampleRate / 2) {
    throw new RangeError(`Invalid low-pass cutoff ${cutoffHz} Hz at ${sampleRate} Hz`);
  }
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Magnitude response |H(f)| of a biquad (linear gain). Used by tests and for docs. */
export function biquadGainAt(c: BiquadCoeffs, freqHz: number, sampleRate: number): number {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  // H(e^jw) = (b0 + b1 e^-jw + b2 e^-2jw) / (1 + a1 e^-jw + a2 e^-2jw)
  const nr = c.b0 + c.b1 * Math.cos(w) + c.b2 * Math.cos(2 * w);
  const ni = -(c.b1 * Math.sin(w) + c.b2 * Math.sin(2 * w));
  const dr = 1 + c.a1 * Math.cos(w) + c.a2 * Math.cos(2 * w);
  const di = -(c.a1 * Math.sin(w) + c.a2 * Math.sin(2 * w));
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

/**
 * Stateful biquad (transposed direct form II). State carries across calls, so
 * feeding 128-frame quanta gives exactly the same output as one long buffer.
 */
export class Biquad {
  private z1 = 0;
  private z2 = 0;

  constructor(private readonly c: BiquadCoeffs) {}

  /** Filters `input` into `output` (may be the same array). Allocates nothing. */
  process(input: ArrayLike<number>, output: { [i: number]: number; length: number }): void {
    const { b0, b1, b2, a1, a2 } = this.c;
    let z1 = this.z1;
    let z2 = this.z2;
    const n = input.length;
    for (let i = 0; i < n; i++) {
      const x = input[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      output[i] = y;
    }
    // Flush denormals / tiny values so silence stays cheap on the audio thread.
    this.z1 = Math.abs(z1) < 1e-20 ? 0 : z1;
    this.z2 = Math.abs(z2) < 1e-20 ? 0 : z2;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}
