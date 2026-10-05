import { describe, expect, it } from 'vitest';
import { onsetConfig } from '../src/detection/config';
import { minGapSec, scoreOnsets } from '../src/detection/evaluate';
import { FFT, hannWindow } from '../src/detection/fft';
import { OnsetDetector } from '../src/detection/onset';
import { detectOnsets, detectOnsetsInAnalysis, highPass, measureQuietFloorDb } from '../src/detection/pipeline';
import { add, mixAt, noise, pluck, sine, SR, strumTrack } from './signals';

/** Live-like run: high-pass, measure the room in the first 2 s, then detect. */
function detect(x: Float32Array, chunkSamples = 128) {
  const a = highPass(x, SR);
  const floor = measureQuietFloorDb(a, SR);
  return detectOnsetsInAnalysis(a, SR, { noiseFloorDb: floor, chunkSamples });
}

/** Irregular strum times starting after the 2 s room measurement. */
function irregularTimes(count: number, start = 2.5): number[] {
  const t: number[] = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    t.push(Number(at.toFixed(4)));
    at += 0.4 + ((i * 37) % 7) * 0.05;
  }
  return t;
}

describe('FFT', () => {
  it('matches a direct DFT', () => {
    const n = 64;
    const x = Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + (i % 5) * 0.1);
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    new FFT(n).forward(re, im);
    for (const k of [0, 1, 7, 20, 32, 50]) {
      let dr = 0, di = 0;
      for (let i = 0; i < n; i++) {
        dr += x[i] * Math.cos((2 * Math.PI * k * i) / n);
        di -= x[i] * Math.sin((2 * Math.PI * k * i) / n);
      }
      expect(re[k]).toBeCloseTo(dr, 9);
      expect(im[k]).toBeCloseTo(di, 9);
    }
  });

  it('rejects sizes that are not powers of two', () => {
    expect(() => new FFT(1000)).toThrow(RangeError);
  });

  it('Hann-windowed full-scale sine peaks at N/4 (the detector normalisation)', () => {
    const n = 1024;
    const k = 64;
    const w = hannWindow(n);
    const re = Float64Array.from({ length: n }, (_, i) => w[i] * Math.cos((2 * Math.PI * k * i) / n));
    const im = new Float64Array(n);
    new FFT(n).forward(re, im);
    expect(Math.hypot(re[k], im[k])).toBeCloseTo(n / 4, 6);
  });
});

describe('onset detector: synthetic strums', () => {
  it('(a) finds >= 95% of plucked bursts over room noise, < 10 ms error, no doubles', () => {
    const times = irregularTimes(40);
    const x = strumTrack({ timesSec: times, durationSec: times[times.length - 1] + 2, amplitudes: [0.2, 0.08, 0.3, 0.12] });
    const ev = detect(x);
    const s = scoreOnsets(
      ev.map((e) => e.timeSec),
      times,
    );
    expect(s.recall).toBeGreaterThanOrEqual(0.95);
    expect(s.falsePositives).toBe(0); // includes double triggers
    expect(s.maxAbsErrorMs).toBeLessThan(10);
    expect(Math.abs(s.meanErrorMs)).toBeLessThan(5);
  });

  it('(b) keeps fast down-up strums (125 ms apart, alternating loud/soft) separate', () => {
    const times = Array.from({ length: 48 }, (_, i) => 2.5 + i * 0.125);
    for (const roots of [undefined, [110]]) {
      const x = strumTrack({ timesSec: times, durationSec: 10, amplitudes: [0.2, 0.1], roots });
      const ev = detect(x);
      const s = scoreOnsets(
        ev.map((e) => e.timeSec),
        times,
      );
      expect(s.recall).toBeGreaterThanOrEqual(0.95);
      expect(s.falsePositives).toBe(0);
      expect(s.maxAbsErrorMs).toBeLessThan(10);
      expect(minGapSec(ev.map((e) => e.timeSec))).toBeGreaterThan(0.1);
    }
  });

  it('gives one event for a strum spread over six strings (30 ms), timed at the first string', () => {
    const times = irregularTimes(12);
    const x = noise(0.003, Math.round((times[times.length - 1] + 2) * SR), 11);
    const strings = [82.4, 110, 146.8, 196, 246.9, 329.6];
    times.forEach((t, i) => {
      strings.forEach((f, s) => mixAt(x, pluck(f, 0.06, SR, 1000 + i * 10 + s), Math.round((t + s * 0.006) * SR)));
    });
    const ev = detect(x);
    const s = scoreOnsets(
      ev.map((e) => e.timeSec),
      times,
    );
    expect(s.recall).toBe(1);
    expect(s.falsePositives).toBe(0);
    expect(s.maxAbsErrorMs).toBeLessThan(10);
  });

  it('timestamps are sample indices on the audio clock, independent of push size', () => {
    const times = irregularTimes(10);
    const x = strumTrack({ timesSec: times, durationSec: times[times.length - 1] + 2 });
    const a = detect(x, 128).map((e) => e.sampleIndex);
    const b = detect(x, 1000).map((e) => e.sampleIndex);
    const c = detect(x, 7).map((e) => e.sampleIndex);
    expect(a.length).toBe(times.length);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    const ev = detect(x);
    for (const e of ev) expect(e.timeSec).toBeCloseTo(e.sampleIndex / SR, 12);
  });

  it('is deterministic', () => {
    const times = irregularTimes(8);
    const x = strumTrack({ timesSec: times, durationSec: 8 });
    expect(detect(x)).toEqual(detect(x));
  });

  it('works at 44.1 kHz too (all parameters derive from the sample rate)', () => {
    const sr = 44100;
    const times = [0.5, 0.9, 1.3, 1.425, 1.8];
    const n = Math.round(3 * sr);
    const x = noise(0.003, n, 5);
    times.forEach((t, i) => mixAt(x, pluck(110 + 20 * i, 0.2, sr, i + 1, sr), Math.round(t * sr)));
    const ev = detectOnsets(x, sr, { noiseFloorDb: -50 });
    const s = scoreOnsets(
      ev.map((e) => e.timeSec),
      times,
    );
    expect(s.recall).toBe(1);
    expect(s.falsePositives).toBe(0);
    expect(s.maxAbsErrorMs).toBeLessThan(10);
  });
});

describe('onset detector: no false triggers', () => {
  const dur = 30;

  it('(c) room noise only: none', () => {
    expect(detect(noise(0.003, dur * SR, 3))).toEqual([]);
    expect(detect(noise(0.02, dur * SR, 4))).toEqual([]);
  });

  it('(c) room noise only, before the room is measured (no level gate): under 1 per minute', () => {
    const ev = detectOnsetsInAnalysis(highPass(noise(0.003, 60 * SR, 9), SR), SR, { noiseFloorDb: null });
    expect(ev.length).toBeLessThanOrEqual(1);
  });

  it('(c) slow swells (noise and a tone fading in and out) and rumble: none', () => {
    const swell = noise(0.003, 20 * SR, 4);
    for (let i = 0; i < swell.length; i++) {
      const t = i / SR;
      swell[i] *= t < 4 ? 1 : 1 + 30 * Math.max(0, Math.sin((Math.PI * (t - 4)) / 6)) ** 2;
    }
    expect(detect(swell)).toEqual([]);

    const tone = noise(0.003, 20 * SR, 5);
    for (let i = 0; i < tone.length; i++) {
      const t = i / SR;
      const g = t < 3 ? 0 : 0.2 * Math.min(1, (t - 3) / 1.5) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.3 * t));
      tone[i] += g * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t));
    }
    expect(detect(tone)).toEqual([]);

    const rumble = add(noise(0.003, 20 * SR, 6), sine(0.3, 20 * SR, 30), sine(0.1, 20 * SR, 50));
    for (let i = 0; i < rumble.length; i++) {
      const t = i / SR;
      rumble[i] += (t > 3 ? 0.3 * Math.sin(2 * Math.PI * 0.7 * t) : 0) * Math.sin(2 * Math.PI * 25 * t);
    }
    expect(detect(rumble)).toEqual([]);
  });

  it('a ringing chord after one strum gives exactly one event', () => {
    const x = noise(0.003, 8 * SR, 8);
    mixAt(x, pluck(110, 0.3, 5 * SR, 3), Math.round(2.5 * SR));
    expect(detect(x)).toHaveLength(1);
  });

  it('ignores strums that are not clearly above the room (absolute floor)', () => {
    const x = noise(0.01, 8 * SR, 12);
    mixAt(x, pluck(110, 0.012, SR, 3), Math.round(3 * SR)); // barely above the room
    mixAt(x, pluck(131, 0.3, SR, 4), Math.round(5 * SR));
    const ev = detect(x);
    expect(ev).toHaveLength(1);
    expect(ev[0].timeSec).toBeCloseTo(5, 1);
  });
});

describe('onset detector: live settings', () => {
  const times = [2.5, 2.56, 3.0];
  const x = strumTrack({ timesSec: times, durationSec: 4.5 });
  const a = highPass(x, SR);

  function run(settings: Parameters<OnsetDetector['updateSettings']>[0]) {
    const d = new OnsetDetector(SR, onsetConfig);
    d.setNoiseFloorDb(-50);
    d.updateSettings(settings);
    const out = [];
    for (let i = 0; i < a.length; i += 128) out.push(...d.push(a.subarray(i, i + 128)));
    return out.map((e) => Math.round(e.timeSec * 100) / 100);
  }

  it('minimum gap merges strums closer than minInterOnsetMs (first wins)', () => {
    expect(run({ minInterOnsetMs: 70 })).toEqual([2.5, 3.0]);
    expect(run({ minInterOnsetMs: 40 })).toEqual([2.5, 2.56, 3.0]);
  });

  it('a very high threshold suppresses everything; the gate margin too', () => {
    expect(run({ thresholdDelta: 50 })).toEqual([]);
    expect(run({ minAboveRoomDb: 60 })).toEqual([]);
  });

  it('ignores invalid values', () => {
    const d = new OnsetDetector(SR, onsetConfig);
    d.updateSettings({ thresholdDelta: Number.NaN, minInterOnsetMs: -5 });
    expect(d.settings.thresholdDelta).toBe(onsetConfig.thresholdDelta);
    expect(d.settings.minInterOnsetMs).toBe(0);
  });
});
