import { describe, expect, it } from 'vitest';
import { tunerConfig, type TunerConfig } from '../src/detection/config';
import { lowPassCoeffs, biquadGainAt } from '../src/detection/filters';
import {
  centsOff,
  clampCents,
  median,
  midiToHz,
  readString,
  STANDARD_TUNING,
  TunerSmoother,
  tuneDirection,
} from '../src/detection/tuner';

const cfg: TunerConfig = { ...tunerConfig };
const hzAt = (midi: number, cents: number, a4 = 440) => midiToHz(midi, a4) * Math.pow(2, cents / 1200);
const FRAME_MS = 21;

describe('notes and cents', () => {
  it('standard tuning frequencies', () => {
    const hz = STANDARD_TUNING.map((s) => midiToHz(s.midi, 440));
    const expected = [82.41, 110, 146.83, 196, 246.94, 329.63];
    hz.forEach((h, i) => expect(h).toBeCloseTo(expected[i], 2));
    expect(STANDARD_TUNING.map((s) => s.number)).toEqual([6, 5, 4, 3, 2, 1]);
  });
  it('A4 reference is configurable', () => {
    expect(midiToHz(45, 442)).toBeCloseTo(110.5, 6);
    expect(readString(110.5, 442).cents).toBeCloseTo(0, 6);
    expect(readString(110.5, 440).cents).toBeCloseTo(7.85, 1);
  });
  it('cents', () => {
    expect(centsOff(220, 110)).toBeCloseTo(1200, 9);
    expect(centsOff(hzAt(45, -17), 110)).toBeCloseTo(-17, 9);
  });
  it('nearest string, including far out of tune', () => {
    expect(readString(hzAt(40, 30), 440).string.label).toBe('E2');
    expect(readString(hzAt(64, -40), 440).string.label).toBe('E4');
    const between = readString(hzAt(45, 240), 440); // A2 +240 is nearer than D3 -260
    expect(between.string.label).toBe('A2');
    expect(between.cents).toBeCloseTo(240, 6);
    expect(readString(hzAt(55, -30), 440).string.number).toBe(3);
  });
  it('locked string ignores the nearest one', () => {
    const r = readString(hzAt(45, 0), 440, 6);
    expect(r.string.label).toBe('E2');
    expect(r.cents).toBeCloseTo(500, 6);
  });
  it('direction and clamping', () => {
    expect(tuneDirection(-12, 5)).toBe('up');
    expect(tuneDirection(9, 5)).toBe('down');
    expect(tuneDirection(5, 5)).toBe('ok');
    expect(tuneDirection(-4.9, 5)).toBe('ok');
    expect(clampCents(-130, 50)).toBe(-50);
    expect(clampCents(12, 50)).toBe(12);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('low-pass filter', () => {
  it('Butterworth: -3 dB at the cutoff, flat below', () => {
    const c = lowPassCoeffs(1000, 48000);
    expect(20 * Math.log10(biquadGainAt(c, 1000, 48000))).toBeCloseTo(-3.01, 1);
    expect(20 * Math.log10(biquadGainAt(c, 330, 48000))).toBeGreaterThan(-0.1);
    expect(20 * Math.log10(biquadGainAt(c, 8000, 48000))).toBeLessThan(-30);
  });
});

/** Feeds readings (Hz or null) at FRAME_MS intervals; returns the displays. */
function feed(sm: TunerSmoother, readings: (number | null)[], startMs = 0) {
  return readings.map((hz, i) => sm.push(hz, startMs + i * FRAME_MS));
}

describe('TunerSmoother', () => {
  it('needs a few frames before showing a string, then reads the cents', () => {
    const sm = new TunerSmoother(cfg);
    const out = feed(sm, Array(10).fill(hzAt(50, -20)));
    expect(out.slice(0, cfg.switchFrames - 1).every((d) => d === null)).toBe(true);
    const last = out[9]!;
    expect(last.string.label).toBe('D3');
    expect(last.cents).toBeCloseTo(-20, 6);
    expect(last.direction).toBe('up');
    expect(last.inTune).toBe(false);
  });

  it('a single glitch reading does not move the needle or switch strings', () => {
    const sm = new TunerSmoother(cfg);
    feed(sm, Array(10).fill(hzAt(45, 3)));
    const before = sm.displayAt(10 * FRAME_MS)!;
    const glitch = sm.push(hzAt(45, 40), 11 * FRAME_MS)!; // one wild reading on the same string
    expect(Math.abs(glitch.cents - before.cents)).toBeLessThan(0.5); // median rejects it
    const other = sm.push(hzAt(57, 0), 12 * FRAME_MS)!; // one reading of another string
    expect(other.string.label).toBe('A2');
  });

  it('switches string after switchFrames readings in a row', () => {
    const sm = new TunerSmoother(cfg);
    feed(sm, Array(10).fill(hzAt(45, 0)));
    const out = feed(sm, Array(cfg.switchFrames).fill(hzAt(59, 10)), 300);
    expect(out[cfg.switchFrames - 2]!.string.label).toBe('A2');
    expect(out[cfg.switchFrames - 1]!.string.label).toBe('B3');
    expect(out[cfg.switchFrames - 1]!.cents).toBeCloseTo(10, 6);
  });

  it('smooths jitter: alternating ±4 cents reads close to 0', () => {
    const sm = new TunerSmoother(cfg);
    const out = feed(sm, Array.from({ length: 30 }, (_, i) => hzAt(55, i % 2 ? 4 : -4)));
    expect(Math.abs(out[29]!.cents)).toBeLessThan(1.5);
  });

  it('holds the last value while the note fades, then clears', () => {
    const sm = new TunerSmoother(cfg);
    feed(sm, Array(10).fill(hzAt(40, 12)));
    const t0 = 9 * FRAME_MS;
    const held = sm.push(null, t0 + 500)!;
    expect(held.held).toBe(true);
    expect(held.cents).toBeCloseTo(12, 6);
    expect(sm.displayAt(t0 + cfg.holdMs - 1)).not.toBeNull();
    expect(sm.displayAt(t0 + cfg.holdMs + 1)).toBeNull();
    expect(sm.push(null, t0 + cfg.holdMs + 50)).toBeNull();
  });

  it('marks a string as recently in tune only after a stable in-tune run, and forgets it later', () => {
    const sm = new TunerSmoother(cfg);
    feed(sm, Array(cfg.switchFrames + cfg.inTuneFrames - 2).fill(hzAt(59, 1)));
    expect(sm.recentlyInTune(2, 200)).toBe(false);
    feed(sm, Array(3).fill(hzAt(59, 1)), 200);
    expect(sm.recentlyInTune(2, 300)).toBe(true);
    expect(sm.recentlyInTune(1, 300)).toBe(false);
    expect(sm.recentlyInTune(2, 300 + cfg.inTuneMemoryMs + 100)).toBe(false);
    expect(sm.memoryFor(2)?.cents).toBeCloseTo(1, 6);
  });

  it('in tune within ±inTuneCents, configurable', () => {
    const sm = new TunerSmoother({ ...cfg, inTuneCents: 2 });
    const d = feed(sm, Array(10).fill(hzAt(64, 4)))[9]!;
    expect(d.inTune).toBe(false);
    expect(d.direction).toBe('down');
  });

  it('locking a string reads every note against it and clamps the needle', () => {
    const sm = new TunerSmoother(cfg);
    sm.lock(6);
    expect(sm.expectedHz).toBeCloseTo(82.41, 2);
    const d = feed(sm, Array(10).fill(hzAt(45, 0)))[9]!; // an A played while locked to low E
    expect(d.string.number).toBe(6);
    expect(d.cents).toBeCloseTo(500, 6);
    expect(d.needleCents).toBe(cfg.displayRangeCents);
    expect(d.direction).toBe('down');
    sm.lock(null);
    expect(sm.expectedHz).toBeUndefined();
    expect(sm.displayAt(1000)).toBeNull();
  });
});
