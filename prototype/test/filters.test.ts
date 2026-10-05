import { describe, expect, it } from 'vitest';
import { analysisConfig } from '../src/detection/config';
import { Biquad, biquadGainAt, highPassCoeffs } from '../src/detection/filters';
import { add, db, noise, rmsOf, sine, SR } from './signals';

const HZ = analysisConfig.highPassHz;

function filter(x: Float32Array, cutoff = HZ, sampleRate = SR): Float32Array {
  const out = new Float32Array(x.length);
  new Biquad(highPassCoeffs(cutoff, sampleRate)).process(x, out);
  return out;
}

/** RMS after the filter has settled (skip the first 0.2 s). */
const settledRms = (y: Float32Array) => rmsOf(y, Math.floor(0.2 * SR));

describe('high-pass coefficients', () => {
  it('is -3 dB at the cutoff and flat well above it', () => {
    const c = highPassCoeffs(HZ, SR);
    expect(db(biquadGainAt(c, HZ, SR))).toBeCloseTo(-3.01, 1);
    expect(Math.abs(db(biquadGainAt(c, 1000, SR)))).toBeLessThan(0.05);
    expect(Math.abs(db(biquadGainAt(c, 110, SR)))).toBeLessThan(1.5); // A2, open A string
  });

  it('keeps the low E string (82 Hz) mostly intact and cuts 50/60 Hz hum and 30 Hz rumble', () => {
    const c = highPassCoeffs(HZ, SR);
    expect(db(biquadGainAt(c, 82.4, SR))).toBeGreaterThan(-2);
    expect(db(biquadGainAt(c, 50, SR))).toBeLessThan(-6);
    expect(db(biquadGainAt(c, 30, SR))).toBeLessThan(-14);
    expect(db(biquadGainAt(c, 10, SR))).toBeLessThan(-30);
  });

  it('works at 44.1 kHz too and rejects invalid cutoffs', () => {
    expect(db(biquadGainAt(highPassCoeffs(HZ, 44100), HZ, 44100))).toBeCloseTo(-3.01, 1);
    expect(() => highPassCoeffs(0, SR)).toThrow(RangeError);
    expect(() => highPassCoeffs(30000, SR)).toThrow(RangeError);
  });
});

describe('Biquad high-pass on synthetic signals', () => {
  it('removes 30 Hz rumble', () => {
    const rumble = sine(0.3, SR, 30);
    const y = filter(rumble);
    expect(db(settledRms(y)) - db(rmsOf(rumble))).toBeLessThan(-14);
  });

  it('passes a 110 Hz note and removes the rumble mixed with it', () => {
    const note = sine(0.2, SR, 110);
    const mix = add(note, sine(0.3, SR, 30), noise(0.001, SR, 7));
    const y = filter(mix);
    // Output is close to the note alone: rumble is gone, the note is kept.
    expect(Math.abs(db(settledRms(y)) - db(rmsOf(note)))).toBeLessThan(1.5);
    // Without filtering, the rumble dominated the level.
    expect(db(rmsOf(mix)) - db(rmsOf(note))).toBeGreaterThan(3);
  });

  it('two cascaded sections (highPassStages = 2) cut 30 Hz by more than 28 dB', () => {
    const c = highPassCoeffs(HZ, SR);
    expect(2 * db(biquadGainAt(c, 30, SR))).toBeLessThan(-28);
  });

  it('removes DC offset', () => {
    const dc = new Float32Array(SR).fill(0.1);
    expect(settledRms(filter(dc))).toBeLessThan(1e-4);
  });

  it('gives identical output when fed in 128-frame quanta (state carries across calls)', () => {
    const x = add(sine(0.2, 4096, 110), noise(0.01, 4096, 3));
    const whole = filter(x);
    const bq = new Biquad(highPassCoeffs(HZ, SR));
    const chunked = new Float32Array(x.length);
    for (let i = 0; i < x.length; i += 128) {
      const out = new Float32Array(128);
      bq.process(x.subarray(i, i + 128), out);
      chunked.set(out, i);
    }
    for (let i = 0; i < x.length; i++) expect(chunked[i]).toBeCloseTo(whole[i], 6);
  });

  it('does not modify the input buffer (raw path stays untouched)', () => {
    const x = sine(0.5, 1024, 30);
    const copy = x.slice();
    new Biquad(highPassCoeffs(HZ, SR)).process(x, new Float32Array(1024));
    expect(x).toEqual(copy);
  });
});
