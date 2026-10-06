import { describe, expect, it } from 'vitest';
import { levelConfig } from '../src/detection/config';
import {
  accumulateStats,
  computeStats,
  emptyStats,
  initialMeterState,
  isClipLit,
  meterFraction,
  meterZone,
  rms,
  toDbfs,
  updateMeter,
} from '../src/detection/level';

const FLOOR = -60;

function sine(amplitude: number, n: number, freqHz = 440, sampleRate = 48000): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

describe('block stats', () => {
  it('silence has zero rms and peak', () => {
    const s = computeStats(new Float32Array(1024), 0.99);
    expect(s).toEqual({ count: 1024, sumSquares: 0, peak: 0, clipCount: 0 });
    expect(rms(s)).toBe(0);
  });

  it('full-scale sine has rms of 1/sqrt(2)', () => {
    const s = computeStats(sine(1, 48000), 1.01);
    expect(rms(s)).toBeCloseTo(Math.SQRT1_2, 3);
    expect(s.peak).toBeCloseTo(1, 3);
  });

  it('peak uses absolute value', () => {
    const s = computeStats([0.1, -0.7, 0.3], 0.99);
    expect(s.peak).toBeCloseTo(0.7);
  });

  it('counts clipped samples at or above the threshold, both polarities', () => {
    const s = computeStats([0.5, 0.99, -1, 1, 0.98], 0.99);
    expect(s.clipCount).toBe(3);
  });

  it('accumulating two halves equals computing the whole', () => {
    const x = sine(0.3, 2048);
    const whole = computeStats(x, 0.99);
    const parts = accumulateStats(accumulateStats(emptyStats(), x.subarray(0, 700), 0.99), x.subarray(700), 0.99);
    expect(parts.count).toBe(whole.count);
    expect(parts.sumSquares).toBeCloseTo(whole.sumSquares, 6);
    expect(parts.peak).toBe(whole.peak);
  });

  it('rms of empty stats is 0 (no divide by zero)', () => {
    expect(rms(emptyStats())).toBe(0);
  });
});

describe('dBFS', () => {
  it('converts amplitudes', () => {
    expect(toDbfs(1, FLOOR)).toBeCloseTo(0);
    expect(toDbfs(0.5, FLOOR)).toBeCloseTo(-6.0206, 3);
    expect(toDbfs(0.1, FLOOR)).toBeCloseTo(-20);
  });

  it('clamps silence and tiny values to the floor', () => {
    expect(toDbfs(0, FLOOR)).toBe(FLOOR);
    expect(toDbfs(1e-9, FLOOR)).toBe(FLOOR);
    expect(toDbfs(Number.NaN, FLOOR)).toBe(FLOOR);
  });

  it('maps dB to meter fraction', () => {
    expect(meterFraction(-60, FLOOR)).toBe(0);
    expect(meterFraction(-80, FLOOR)).toBe(0);
    expect(meterFraction(-30, FLOOR)).toBeCloseTo(0.5);
    expect(meterFraction(0, FLOOR)).toBe(1);
    expect(meterFraction(3, FLOOR)).toBe(1);
  });
});

describe('meter zone', () => {
  const cfg = { amberFromDb: -12, redFromDb: -3 };
  it('is green / amber / red by level', () => {
    expect(meterZone(-30, false, cfg)).toBe('green');
    expect(meterZone(-12, false, cfg)).toBe('amber');
    expect(meterZone(-6, false, cfg)).toBe('amber');
    expect(meterZone(-3, false, cfg)).toBe('red');
  });
  it('is red whenever clipping, even at low RMS', () => {
    expect(meterZone(-40, true, cfg)).toBe('red');
  });
});

describe('meter state (smoothing, peak hold, clip hold)', () => {
  const cfg = levelConfig;
  const start = initialMeterState(cfg.meterFloorDb);

  it('attacks instantly and releases at the configured rate', () => {
    const a = updateMeter(start, { rmsDb: -20, peakDb: -10, clipped: false }, 1000, 1000, cfg);
    expect(a.levelDb).toBe(-20);
    const b = updateMeter(a, null, 1500, 1000, cfg); // 0.5 s later, no input
    expect(b.levelDb).toBeCloseTo(-20 - cfg.meterReleaseDbPerSec * 0.5);
  });

  it('never releases below the floor', () => {
    const a = updateMeter(start, { rmsDb: -50, peakDb: -50, clipped: false }, 0, 0, cfg);
    const b = updateMeter(a, null, 60_000, 0, cfg);
    expect(b.levelDb).toBe(cfg.meterFloorDb);
    expect(b.peakHoldDb).toBe(cfg.meterFloorDb);
  });

  it('holds the peak for peakHoldMs, then lets it fall', () => {
    const a = updateMeter(start, { rmsDb: -20, peakDb: -6, clipped: false }, 1000, 1000, cfg);
    const held = updateMeter(a, { rmsDb: -30, peakDb: -25, clipped: false }, 1000 + cfg.peakHoldMs - 10, 1000, cfg);
    expect(held.peakHoldDb).toBe(-6);
    const t2 = 1000 + cfg.peakHoldMs + 500;
    const fell = updateMeter(held, null, t2, t2 - 100, cfg);
    expect(fell.peakHoldDb).toBeCloseTo(-6 - cfg.peakFallDbPerSec * 0.1);
  });

  it('a higher peak replaces the held one immediately', () => {
    const a = updateMeter(start, { rmsDb: -20, peakDb: -12, clipped: false }, 0, 0, cfg);
    const b = updateMeter(a, { rmsDb: -20, peakDb: -2, clipped: false }, 100, 0, cfg);
    expect(b.peakHoldDb).toBe(-2);
    expect(b.peakHoldSetAtMs).toBe(100);
  });

  it('lights CLIP for clipHoldMs after the last clipped block', () => {
    const a = updateMeter(start, { rmsDb: -3, peakDb: 0, clipped: true }, 5000, 5000, cfg);
    expect(isClipLit(a, 5000, cfg.clipHoldMs)).toBe(true);
    expect(isClipLit(a, 5000 + cfg.clipHoldMs, cfg.clipHoldMs)).toBe(true);
    expect(isClipLit(a, 5001 + cfg.clipHoldMs, cfg.clipHoldMs)).toBe(false);
    expect(isClipLit(start, 0, cfg.clipHoldMs)).toBe(false);
  });
});
