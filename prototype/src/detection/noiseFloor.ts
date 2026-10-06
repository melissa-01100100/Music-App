/**
 * Room noise floor estimation. Pure (no DOM, no Web Audio), unit tested.
 *
 * 1. Quiet measurement: for `quietMeasureMs` right after Start the player stays quiet.
 *    The initial floor is a high percentile (default p90) of the per-block RMS in dBFS,
 *    so it sits at the top of normal room-noise wobble rather than its average.
 * 2. Tracking: afterwards the floor follows the room slowly. Blocks are grouped into
 *    windows (`trackWindowMs`); each window's percentile level moves the floor:
 *      - quieter window  -> floor falls quickly (`fallDbPerSec`),
 *      - slightly louder -> floor rises very slowly (`riseDbPerSec`),
 *      - much louder (> floor + `ignoreAboveDb`, i.e. guitar/talking) -> ignored.
 *    So the floor never "learns" the guitar, and a short loud burst cannot move it up.
 *
 * Input levels are block RMS in dBFS of the ANALYSIS (high-passed) signal.
 */
import type { NoiseFloorConfig } from './config';

/** Linear-interpolated percentile, p in 0..100. Returns NaN for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** One tracking step: moves `floorDb` towards a window level `levelDb` observed over `dtSec`. */
export function stepFloor(
  floorDb: number,
  levelDb: number,
  dtSec: number,
  cfg: Pick<NoiseFloorConfig, 'fallDbPerSec' | 'riseDbPerSec' | 'ignoreAboveDb' | 'minDb'>,
): number {
  if (!Number.isFinite(levelDb)) return floorDb;
  if (levelDb < floorDb) return Math.max(cfg.minDb, levelDb, floorDb - cfg.fallDbPerSec * dtSec);
  if (levelDb > floorDb + cfg.ignoreAboveDb) return floorDb; // playing / talking: ignore
  return Math.min(levelDb, floorDb + cfg.riseDbPerSec * dtSec);
}

export type NoiseFloorPhase = 'measuring' | 'tracking';

/** Quiet measurement followed by slow tracking. Feed it every analysis block. */
export class NoiseFloorEstimator {
  private phase: NoiseFloorPhase = 'measuring';
  private elapsedMs = 0;
  private quietBlocks: number[] = [];
  private windowBlocks: number[] = [];
  private windowMs = 0;
  private floor: number | null = null;
  private initial: number | null = null;

  constructor(private readonly cfg: NoiseFloorConfig) {}

  /** Adds one block's RMS level (dBFS) lasting `blockMs`. */
  addBlock(levelDb: number, blockMs: number): void {
    const db = Math.max(this.cfg.minDb, Number.isFinite(levelDb) ? levelDb : this.cfg.minDb);
    if (this.phase === 'measuring') {
      this.quietBlocks.push(db);
      this.elapsedMs += blockMs;
      if (this.elapsedMs >= this.cfg.quietMeasureMs) {
        this.initial = percentile(this.quietBlocks, this.cfg.initialPercentile);
        this.floor = this.initial;
        this.quietBlocks = [];
        this.phase = 'tracking';
      }
      return;
    }
    this.windowBlocks.push(db);
    this.windowMs += blockMs;
    if (this.windowMs >= this.cfg.trackWindowMs) {
      const level = percentile(this.windowBlocks, this.cfg.trackPercentile);
      this.floor = stepFloor(this.floor as number, level, this.windowMs / 1000, this.cfg);
      this.windowBlocks = [];
      this.windowMs = 0;
    }
  }

  /** Starts a fresh quiet measurement (e.g. "Measure room again"). */
  restart(): void {
    this.phase = 'measuring';
    this.elapsedMs = 0;
    this.quietBlocks = [];
    this.windowBlocks = [];
    this.windowMs = 0;
    this.floor = null;
    this.initial = null;
  }

  get state(): NoiseFloorPhase {
    return this.phase;
  }

  /** Milliseconds of the quiet measurement still to go (0 once tracking). */
  get remainingMs(): number {
    return this.phase === 'measuring' ? Math.max(0, this.cfg.quietMeasureMs - this.elapsedMs) : 0;
  }

  /** Current floor in dBFS, or null while the quiet measurement is running. */
  get floorDb(): number | null {
    return this.floor;
  }

  /** Floor measured during the quiet period, or null if not finished yet. */
  get initialFloorDb(): number | null {
    return this.initial;
  }
}

/** Top of the "room noise" zone on the meter: everything up to here is drawn grey. */
export function roomZoneTopDb(floorDb: number, marginDb: number): number {
  return floorDb + marginDb;
}

/** True when the level is clearly above the room (coloured meter, "Sound!" chip). */
export function isAboveRoom(levelDb: number, floorDb: number | null, marginDb: number): boolean {
  return floorDb !== null && levelDb > floorDb + marginDb;
}

/** How far the level is above the room noise floor, in dB (never negative). */
export function aboveRoomDb(levelDb: number, floorDb: number): number {
  return Math.max(0, levelDb - floorDb);
}

export function isNoisyRoom(initialFloorDb: number | null, noisyRoomDb: number): boolean {
  return initialFloorDb !== null && initialFloorDb > noisyRoomDb;
}
