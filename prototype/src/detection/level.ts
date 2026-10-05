/**
 * Pure level-metering helpers. No DOM, no Web Audio: safe to run in Node tests,
 * in an AudioWorklet, or to port to another engine.
 */
import type { LevelConfig } from './config';

export interface BlockStats {
  /** Number of samples summarised. */
  count: number;
  /** Sum of squared samples (lets several blocks be merged exactly). */
  sumSquares: number;
  /** Largest absolute sample value. */
  peak: number;
  /** Samples with |x| >= clipThreshold. */
  clipCount: number;
}

export function emptyStats(): BlockStats {
  return { count: 0, sumSquares: 0, peak: 0, clipCount: 0 };
}

/** Adds `samples` into `stats` (mutates and returns it, so the worklet allocates nothing). */
export function accumulateStats(
  stats: BlockStats,
  samples: ArrayLike<number>,
  clipThreshold: number,
): BlockStats {
  let sumSquares = stats.sumSquares;
  let peak = stats.peak;
  let clipCount = stats.clipCount;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const a = x < 0 ? -x : x;
    sumSquares += x * x;
    if (a > peak) peak = a;
    if (a >= clipThreshold) clipCount++;
  }
  stats.count += samples.length;
  stats.sumSquares = sumSquares;
  stats.peak = peak;
  stats.clipCount = clipCount;
  return stats;
}

export function computeStats(samples: ArrayLike<number>, clipThreshold: number): BlockStats {
  return accumulateStats(emptyStats(), samples, clipThreshold);
}

export function rms(stats: BlockStats): number {
  return stats.count > 0 ? Math.sqrt(stats.sumSquares / stats.count) : 0;
}

/** Linear amplitude (1.0 = full scale) to dBFS, clamped at `floorDb` (silence => floorDb). */
export function toDbfs(amplitude: number, floorDb: number): number {
  if (!(amplitude > 0)) return floorDb;
  return Math.max(floorDb, 20 * Math.log10(amplitude));
}

/** Position of a dB value on the meter, 0 (floor) .. 1 (0 dBFS). */
export function meterFraction(db: number, floorDb: number): number {
  if (db <= floorDb) return 0;
  if (db >= 0) return 1;
  return (db - floorDb) / -floorDb;
}

export type MeterZone = 'green' | 'amber' | 'red';

export function meterZone(db: number, clipping: boolean, cfg: Pick<LevelConfig, 'amberFromDb' | 'redFromDb'>): MeterZone {
  if (clipping || db >= cfg.redFromDb) return 'red';
  if (db >= cfg.amberFromDb) return 'amber';
  return 'green';
}

/** State of the meter display, advanced once per animation frame or per block. */
export interface MeterState {
  /** Displayed (smoothed) RMS level in dBFS. */
  levelDb: number;
  /** Peak-hold marker in dBFS. */
  peakHoldDb: number;
  /** Time (ms) the peak-hold marker was last raised. */
  peakHoldSetAtMs: number;
  /** Time (ms) of the most recent clipped sample, or -Infinity. */
  lastClipAtMs: number;
}

export function initialMeterState(floorDb: number): MeterState {
  return { levelDb: floorDb, peakHoldDb: floorDb, peakHoldSetAtMs: 0, lastClipAtMs: -Infinity };
}

export type MeterTimingConfig = Pick<
  LevelConfig,
  'meterFloorDb' | 'peakHoldMs' | 'peakFallDbPerSec' | 'clipHoldMs' | 'meterReleaseDbPerSec'
>;

/**
 * Advances the meter to time `nowMs` given the newest measurement.
 * Pass `input = null` when no new block arrived (the meter just decays).
 * Level: instant attack, linear release. Peak hold: holds, then falls.
 */
export function updateMeter(
  prev: MeterState,
  input: { rmsDb: number; peakDb: number; clipped: boolean } | null,
  nowMs: number,
  prevMs: number,
  cfg: MeterTimingConfig,
): MeterState {
  const dtSec = Math.max(0, nowMs - prevMs) / 1000;
  const floor = cfg.meterFloorDb;

  const released = Math.max(floor, prev.levelDb - cfg.meterReleaseDbPerSec * dtSec);
  const levelDb = input ? Math.max(input.rmsDb, released) : released;

  let peakHoldDb = prev.peakHoldDb;
  let peakHoldSetAtMs = prev.peakHoldSetAtMs;
  if (input && input.peakDb >= peakHoldDb) {
    peakHoldDb = input.peakDb;
    peakHoldSetAtMs = nowMs;
  } else if (nowMs - peakHoldSetAtMs > cfg.peakHoldMs) {
    peakHoldDb = Math.max(floor, peakHoldDb - cfg.peakFallDbPerSec * dtSec);
  }

  const lastClipAtMs = input && input.clipped ? nowMs : prev.lastClipAtMs;

  return { levelDb, peakHoldDb, peakHoldSetAtMs, lastClipAtMs };
}

export function isClipLit(state: MeterState, nowMs: number, clipHoldMs: number): boolean {
  return nowMs - state.lastClipAtMs <= clipHoldMs;
}
