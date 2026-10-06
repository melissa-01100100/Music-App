import { describe, expect, it } from 'vitest';
import { pitchConfig, tunerConfig } from '../src/detection/config';
import { lagRange, parabolicPeak, PitchDetector, PitchTracker, type PitchFrame } from '../src/detection/pitch';
import { highPass } from '../src/detection/pipeline';
import { centsOff, midiToHz, readString, STANDARD_TUNING, TunerSmoother } from '../src/detection/tuner';
import { noise, rng, sine } from './signals';

/**
 * Plucked-string model for the tuner: harmonics with a STRONG 2nd harmonic (louder than the
 * fundamental, as phone mics hear a guitar's low strings), higher harmonics decaying faster,
 * a noisy pick attack, plus background noise.
 */
function pluckedString(f0: number, sampleRate: number, opts: { durationSec?: number; seed?: number; amps?: number[]; noiseRms?: number } = {}): Float32Array {
  const n = Math.round((opts.durationSec ?? 2) * sampleRate);
  const r = rng(opts.seed ?? 1);
  const amps = opts.amps ?? [1, 2, 0.9, 0.7, 0.45, 0.3, 0.2, 0.15, 0.1, 0.08];
  const out = noise(opts.noiseRms ?? 0.002, n, (opts.seed ?? 1) + 1000);
  const peak = 0.25;
  const total = amps.reduce((a, b) => a + b, 0);
  amps.forEach((a, i) => {
    const h = i + 1;
    const f = f0 * h;
    if (f >= sampleRate / 2) return;
    const amp = (peak * a) / total;
    const tau = 1.2 / (1 + 0.4 * i);
    const w = (2 * Math.PI * f) / sampleRate;
    const ph = r() * 2 * Math.PI;
    for (let j = 0; j < n; j++) out[j] += amp * Math.exp(-j / sampleRate / tau) * Math.sin(w * j + ph);
  });
  const atkLen = Math.round(0.02 * sampleRate);
  for (let j = 0; j < atkLen; j++) out[j] += 0.1 * (r() * 2 - 1) * Math.exp(-j / sampleRate / 0.003);
  return out;
}

const NOISE_FLOOR_DB = -55; // background noise of 0.002 RMS is ~-54 dBFS before the high-pass

function track(x: Float32Array, sampleRate: number, expectedHz?: number): PitchFrame[] {
  const t = new PitchTracker(sampleRate, pitchConfig);
  const a = highPass(x, sampleRate);
  const frames: PitchFrame[] = [];
  for (let i = 0; i < a.length; i += 128) frames.push(...t.push(a.subarray(i, i + 128), { noiseFloorDb: NOISE_FLOOR_DB, expectedHz }));
  return frames;
}

describe('parabolicPeak', () => {
  it('finds the vertex of a parabola', () => {
    const f = (x: number) => 2 - (x - 0.3) ** 2;
    const p = parabolicPeak(f(-1), f(0), f(1));
    expect(p.offset).toBeCloseTo(0.3, 9);
    expect(p.value).toBeCloseTo(2, 9);
  });
  it('returns the middle point when it is not a maximum', () => {
    expect(parabolicPeak(1, 0, 1)).toEqual({ offset: 0, value: 0 });
  });
});

describe('lagRange', () => {
  it('covers low E (minus 50 cents) at 48 kHz and 44.1 kHz with a 4096 window', () => {
    for (const sr of [48000, 44100]) {
      const r = lagRange(sr, pitchConfig);
      expect(r.max).toBeGreaterThanOrEqual(sr / 80);
      expect(r.max).toBeLessThanOrEqual(pitchConfig.windowSamples / 2);
      expect(r.min).toBeLessThanOrEqual(sr / 340);
    }
  });
});

describe('PitchDetector on pure tones', () => {
  it('measures sines to well under 1 cent', () => {
    const det = new PitchDetector(48000, pitchConfig);
    for (const f of [82.41, 110, 146.83, 196, 246.94, 329.63, 100.7]) {
      const res = det.detect(sine(0.3, pitchConfig.windowSamples, f));
      expect(res.hz).not.toBeNull();
      expect(Math.abs(centsOff(res.hz as number, f))).toBeLessThan(0.5);
      expect(res.clarity).toBeGreaterThan(0.95);
    }
  });
});

const DETUNE = [-30, -10, 0, 10, 30];

describe.each([48000, 44100])('plucked open strings at %i Hz', (sampleRate) => {
  for (const s of STANDARD_TUNING) {
    it(`string ${s.number} (${s.label}) detuned ${DETUNE.join('/')} cents: within ±2 cents, right string, no octave errors`, () => {
      const target = midiToHz(s.midi, tunerConfig.a4Hz);
      for (const detune of DETUNE) {
        const f0 = target * Math.pow(2, detune / 1200);
        const frames = track(pluckedString(f0, sampleRate, { seed: s.number * 10 + detune }), sampleRate);
        // Skip the first window (pick attack); everything after must be right.
        const settled = frames.filter((f) => f.endSample / sampleRate > 0.15 && f.hz !== null);
        expect(settled.length, `${s.label} ${detune}`).toBeGreaterThan(40);
        for (const f of settled) {
          const r = readString(f.hz as number, tunerConfig.a4Hz);
          expect(r.string.label, `${s.label} ${detune}c at ${(f.endSample / sampleRate).toFixed(2)} s`).toBe(s.label);
          expect(Math.abs(r.cents - detune), `${s.label} ${detune}c got ${r.cents.toFixed(2)}`).toBeLessThanOrEqual(2);
        }
        // Even the attack frames never jump an octave.
        for (const f of frames) if (f.hz !== null) expect(Math.abs(centsOff(f.hz, f0))).toBeLessThan(100);

        // Through the smoother: the displayed value is also within ±2 cents.
        const sm = new TunerSmoother(tunerConfig);
        let last = null;
        for (const f of frames) last = sm.push(f.hz, (f.endSample / sampleRate) * 1000) ?? last;
        expect(last?.string.label).toBe(s.label);
        expect(Math.abs((last?.cents ?? 99) - detune)).toBeLessThanOrEqual(2);
      }
    });
  }
});

describe('octave-error resistance', () => {
  it('weak fundamental (2nd harmonic 3x louder) on low E still reads E2', () => {
    const f0 = midiToHz(40, 440);
    const frames = track(pluckedString(f0, 48000, { amps: [0.6, 1.8, 0.8, 0.6, 0.4, 0.3, 0.2] }), 48000);
    const good = frames.filter((f) => f.hz !== null && f.endSample > 0.15 * 48000);
    expect(good.length).toBeGreaterThan(40);
    for (const f of good) expect(Math.abs(centsOff(f.hz as number, f0))).toBeLessThan(5);
  });

  it('a locked string hint picks the right octave even when the fundamental is nearly gone', () => {
    const f0 = midiToHz(45, 440); // A2
    const x = pluckedString(f0, 48000, { amps: [0.15, 1.5, 0.3, 1.0, 0.2, 0.5] });
    const hinted = track(x, 48000, f0).filter((f) => f.hz !== null && f.endSample > 0.15 * 48000);
    expect(hinted.length).toBeGreaterThan(20);
    for (const f of hinted) expect(Math.abs(centsOff(f.hz as number, f0))).toBeLessThan(5);
  });
});

describe('no reading without a note', () => {
  it('silence gives no reading', () => {
    const frames = track(new Float32Array(48000), 48000);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.hz === null)).toBe(true);
  });

  it('room noise at the floor gives no reading', () => {
    const frames = track(noise(0.002, 96000, 5), 48000);
    expect(frames.every((f) => f.hz === null && f.reason === 'quiet')).toBe(true);
  });

  it('loud white noise (above the gate) is rejected as unclear', () => {
    const frames = track(noise(0.1, 96000, 6), 48000);
    expect(frames.every((f) => f.hz === null)).toBe(true);
    expect(frames.some((f) => f.reason === 'unclear')).toBe(true);
  });

  it('a fading note stops reading once it sinks into the room noise', () => {
    const f0 = 110;
    const x = pluckedString(f0, 48000, { durationSec: 12 });
    const frames = track(x, 48000);
    const tail = frames.filter((f) => f.endSample > 11 * 48000);
    expect(tail.every((f) => f.hz === null)).toBe(true);
  });
});
