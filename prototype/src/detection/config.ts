/**
 * ALL tunable values for the Phase 0 prototype live here.
 * Units are part of the names (Db = dBFS, Ms = milliseconds, Frames = samples per channel).
 * Later milestones (onset, chroma, classifier) add their tunables to this file too.
 */
export interface LevelConfig {
  blockSizeFrames: number;
  meterFloorDb: number;
  amberFromDb: number;
  redFromDb: number;
  clipThreshold: number;
  peakHoldMs: number;
  peakFallDbPerSec: number;
  clipHoldMs: number;
  meterReleaseDbPerSec: number;
  stallWarningMs: number;
}

export const levelConfig: LevelConfig = {
  /** Frames the capture worklet accumulates before posting stats (~21 ms at 48 kHz). */
  blockSizeFrames: 1024,
  /** Bottom of the meter scale. Anything quieter is shown as empty. */
  meterFloorDb: -60,
  /** Meter turns amber at or above this level (healthy guitar level is below it). */
  amberFromDb: -12,
  /** Meter turns red at or above this level, even without hard clipping. */
  redFromDb: -3,
  /** A sample with |x| at or above this is counted as clipped (1.0 = full scale). */
  clipThreshold: 0.99,
  /** How long the peak-hold marker stays before it starts falling. */
  peakHoldMs: 1500,
  /** Fall speed of the peak-hold marker after the hold time. */
  peakFallDbPerSec: 20,
  /** How long the red "CLIP" warning stays lit after the last clipped sample. */
  clipHoldMs: 2000,
  /** Smoothing of the displayed RMS level: release speed (attack is instant). */
  meterReleaseDbPerSec: 30,
  /** If no audio block arrives for this long while running, show a "stalled" warning. */
  stallWarningMs: 1000,
};
