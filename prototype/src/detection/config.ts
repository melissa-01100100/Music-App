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

/**
 * Strum (onset) detection. Spectral flux on log-compressed STFT magnitudes, optional
 * high-frequency weighting, adaptive median threshold, peak picking, minimum gap, and a
 * level gate tied to the room noise floor. See detection/onset.ts and TECH.md 2.2.
 * "ODF units" = average rectified increase of log(1 + gamma*|X|) per analysed bin.
 */
export interface OnsetConfig {
  /** STFT frame length (power of two). 1024 = ~21 ms at 48 kHz. */
  frameSizeSamples: number;
  /** STFT hop. 256 = ~5.3 ms at 48 kHz. */
  hopSizeSamples: number;
  /** Log compression log(1 + gamma*|X|), |X| normalised so a full-scale sine = 1. */
  logCompressionGamma: number;
  /** Lowest / highest frequency used in the flux sum. */
  fluxMinHz: number;
  fluxMaxHz: number;
  /**
   * Flux compares each frame with the frame this many hops earlier. 2 (~11 ms) collects the rise of a
   * strum that hits the strings one after another over 20-40 ms into one clear peak.
   */
  fluxLagFrames: number;
  /** High-frequency (HFC-style) weighting: bin weight = 1 + hfcWeight * f / fluxMaxHz (then normalised). 0 = plain flux. */
  hfcWeight: number;
  /** Adaptive threshold: delta + lambda * median(odf over the window). Higher = less sensitive. */
  thresholdDelta: number;
  thresholdLambda: number;
  /** Past part of the median window (the lookahead is added on top). */
  medianWindowMs: number;
  /** Peak must be the maximum over this much time before it ... */
  peakPreMaxMs: number;
  /** ... and this much time after it. This is the added detection delay. */
  peakLookaheadMs: number;
  /** Two strums closer than this count as one (the first wins). 120 BPM sixteenths = 125 ms. */
  minInterOnsetMs: number;
  /** Absolute floor: the strum's frame level must be at least this far above the room noise floor. */
  minAboveRoomDb: number;
  /** Floor used until the room has been measured (effectively "no level gate"). */
  fallbackNoiseFloorDb: number;
  /**
   * Timestamp refinement: search this far back from the newest sample of the peak frame for the
   * start of the attack (clamped to 80 ms, and never before the previous strum + minimum gap).
   */
  refineSearchMs: number;
  /** The search uses an attack envelope (energy of x[n]-x[n-1]) in blocks of this length. */
  attackBlockMs: number;
  /** Onset = first block in the search window above min + fraction * (max - min) of the envelope. */
  attackFraction: number;
}

export const onsetConfig: OnsetConfig = {
  frameSizeSamples: 1024,
  hopSizeSamples: 256,
  logCompressionGamma: 1000,
  fluxMinHz: 60,
  fluxMaxHz: 10000,
  fluxLagFrames: 2,
  hfcWeight: 1,
  thresholdDelta: 0.1,
  thresholdLambda: 1.5,
  medianWindowMs: 100,
  peakPreMaxMs: 16,
  peakLookaheadMs: 16,
  minInterOnsetMs: 70,
  minAboveRoomDb: 10,
  fallbackNoiseFloorDb: -100,
  refineSearchMs: 50,
  attackBlockMs: 1,
  attackFraction: 0.2,
};

/** Onset settings the Developer drawer may change live (no detector restart needed). */
export type LiveOnsetSettings = Pick<OnsetConfig, 'thresholdDelta' | 'thresholdLambda' | 'minInterOnsetMs' | 'minAboveRoomDb'>;

/** Raw-audio recording for the golden test set. */
export interface RecordingConfig {
  /** Recording stops by itself after this long (memory: ~23 MB of floats at 48 kHz). */
  maxRecordSec: number;
  /** The worklet posts raw audio to the main thread in chunks of this many frames while recording. */
  chunkFrames: number;
}

export const recordingConfig: RecordingConfig = {
  maxRecordSec: 120,
  chunkFrames: 4096,
};

/** Strum display. */
export interface StrumUiConfig {
  /** How long the big flash stays lit after a strum. */
  flashMs: number;
  /** Event log keeps this many lines (newest first). */
  logMaxLines: number;
}

export const strumUiConfig: StrumUiConfig = {
  flashMs: 180,
  logMaxLines: 200,
};
