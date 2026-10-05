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

/** Analysis-path filtering. The raw mic signal (for future recording) is never filtered. */
export interface AnalysisConfig {
  /** 2nd-order (biquad, Butterworth) high-pass cutoff. Low E on guitar is 82 Hz. */
  highPassHz: number;
  /** Number of cascaded 2nd-order sections: 1 = 12 dB/octave (default), 2 = 24 dB/octave. */
  highPassStages: number;
}

export const analysisConfig: AnalysisConfig = {
  /** Removes rumble, handling noise and AC hum (50/60 Hz) below the low E string. */
  highPassHz: 70,
  /**
   * 1 section cuts 30 Hz rumble by ~15 dB and 50 Hz hum by ~7 dB while keeping the low E
   * (82 Hz) within ~2 dB. Use 2 if rumble/hum still moves the meter (costs ~2 dB more at 82 Hz).
   */
  highPassStages: 1,
};

/** Room noise floor: initial "stay quiet" measurement + slow tracker afterwards. */
export interface NoiseFloorConfig {
  /** Length of the "Stay quiet..." measurement right after Start. */
  quietMeasureMs: number;
  /** Percentile (0-100) of block RMS (dBFS) during the quiet period used as the initial floor. */
  initialPercentile: number;
  /** Lowest value the floor can take (dBFS). Lower than the meter scale on purpose. */
  minDb: number;
  /** The tracker looks at windows of this length and uses their percentile below. */
  trackWindowMs: number;
  /** Percentile (0-100) of block RMS inside a tracking window (same idea as initialPercentile). */
  trackPercentile: number;
  /** How fast the floor may fall towards a quieter window (fast: room got quieter). */
  fallDbPerSec: number;
  /** How fast the floor may rise towards a louder window (very slow: never learn the guitar). */
  riseDbPerSec: number;
  /** Windows louder than floor + this are treated as playing/talking and ignored completely. */
  ignoreAboveDb: number;
  /** Sound counts as "above the room" (coloured meter, "Sound!" chip) above floor + this. */
  roomMarginDb: number;
  /** If the initial floor is above this, show the "noisy room" hint. */
  noisyRoomDb: number;
}

export const noiseFloorConfig: NoiseFloorConfig = {
  quietMeasureMs: 2000,
  initialPercentile: 90,
  minDb: -100,
  trackWindowMs: 1000,
  trackPercentile: 90,
  fallDbPerSec: 10,
  riseDbPerSec: 0.5,
  ignoreAboveDb: 10,
  roomMarginDb: 6,
  noisyRoomDb: -35,
};
