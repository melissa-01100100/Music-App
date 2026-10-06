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
  /** Lowest value the floor can take (dBFS). Lower than the meter scale on purpose; real mics never get here. */
  minDb: number;
  /**
   * Blocks quieter than this (dBFS) are digital silence (exact zeros: mic muted while the page was in
   * the background, mic start-up, a stalled stream). They are ignored completely: they are not room noise.
   * Before 0.3 they dragged the floor to the clamp (-100 dBFS on the Galaxy S24), which disabled the level gate.
   */
  digitalSilenceDb: number;
  /**
   * The quiet measurement is "unsteady" (someone played or talked) when p90 - p10 of its blocks
   * exceeds this. A steady room is within ~3-6 dB; strumming gives 30+ dB.
   */
  maxQuietSpreadDb: number;
  /**
   * ... or when its median is louder than this (dBFS). With processing off, real rooms measured so far
   * sit around -50 to -60 dBFS; continuous strumming (ringing strings, small spread) is -10 to -25.
   */
  maxQuietDb: number;
  /** Unsteady measurements are repeated this many times ("Please stay quiet — measuring again"). */
  maxQuietRetries: number;
  /**
   * If it is still unsteady after the retries, the floor is this low percentile instead of p90,
   * capped at `unsteadyMaxFloorDb` (a typical quiet room; the tracker then adjusts it slowly).
   */
  unsteadyPercentile: number;
  unsteadyMaxFloorDb: number;
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
  minDb: -90,
  digitalSilenceDb: -120,
  maxQuietSpreadDb: 12,
  maxQuietDb: -30,
  maxQuietRetries: 2,
  unsteadyPercentile: 20,
  unsteadyMaxFloorDb: -50,
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
  /**
   * Strum merge window. A real strum hits the strings one after another, and a slow strum can take
   * ~100 ms, giving one onset-function peak per string or two (rec1, Galaxy S24: pairs 70-100 ms apart).
   * All candidate peaks within this window of the first one are ONE strum (see `strumLevelSpanDb`).
   * 120 BPM sixteenths (fastest down-up target) = 125 ms, so keep it below ~120 ms.
   */
  minInterOnsetMs: number;
  /**
   * Exception to the merge window: a candidate this many times stronger (ODF peak) than the first
   * one in the window starts a new strum (a fresh, much sharper attack). 0 = never split.
   */
  splitStrengthRatio: number;
  /**
   * Timestamp of a merged strum: the first candidate whose level is within this many dB of the loudest
   * candidate in the window. A quiet precursor (finger noise, a faint first string) followed by the
   * real strum is then timed at the real strum.
   */
  strumLevelSpanDb: number;
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
  /**
   * Onset = first block in the search window above base + fraction * (max - base) of the envelope,
   * where base = the median of the first `refineBaselineFraction` of the window (the sound before
   * the attack; with a chord still ringing the minimum block is far too low a baseline).
   */
  attackFraction: number;
  refineBaselineFraction: number;
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
  minInterOnsetMs: 110,
  splitStrengthRatio: 2.5,
  strumLevelSpanDb: 12,
  minAboveRoomDb: 10,
  fallbackNoiseFloorDb: -100,
  refineSearchMs: 50,
  attackBlockMs: 1,
  attackFraction: 0.2,
  refineBaselineFraction: 0.5,
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

/**
 * Pitch detection for the tuner (0.2.1). McLeod Pitch Method (normalised square difference,
 * computed with an FFT) on the high-passed analysis signal. See detection/pitch.ts and TECH.md 2.6.
 */
export interface PitchConfig {
  /** Analysis window. 4096 = 85 ms at 48 kHz: ~7 periods of low E (82.4 Hz). Power of two. */
  windowSamples: number;
  /** A new pitch estimate every this many samples (~21 ms at 48 kHz). */
  hopSamples: number;
  /**
   * Low-pass (2nd-order Butterworth, cascaded `lowPassStages` times) before pitch analysis. Keeps the
   * fundamental and first harmonics of every open string and removes most hiss, which otherwise
   * biases the reading by a few cents as the note fades. 0 = off.
   */
  lowPassHz: number;
  lowPassStages: number;
  /** Lowest / highest pitch searched. E2 -50 cents = 80 Hz, E4 +50 cents = 339 Hz. */
  minHz: number;
  maxHz: number;
  /**
   * MPM "key maximum" rule: the first NSDF peak at least this fraction of the highest peak wins.
   * Higher = fewer octave-up errors from a strong 2nd harmonic, but more octave-down risk.
   */
  peakThreshold: number;
  /** Minimum clarity (NSDF peak height, 0..1) for a reading. Noise is ~0.3, a ringing string 0.9+. */
  minClarity: number;
  /** The window's level must be at least this far above the room noise floor (silence gate). */
  minAboveRoomDb: number;
  /** Absolute level gate (dBFS), also used while the room is still being measured. */
  minLevelDb: number;
}

export const pitchConfig: PitchConfig = {
  windowSamples: 4096,
  hopSamples: 1024,
  lowPassHz: 1000,
  lowPassStages: 2,
  minHz: 60,
  maxHz: 420,
  peakThreshold: 0.9,
  minClarity: 0.8,
  minAboveRoomDb: 10,
  minLevelDb: -70,
};

/** Tuner logic and display (0.2.1). Standard tuning; see detection/tuner.ts. */
export interface TunerConfig {
  /** Reference pitch for A4. */
  a4Hz: number;
  /** A string counts as in tune when |cents| is at most this. */
  inTuneCents: number;
  /** The needle shows -range..+range cents (further away is pinned at the end). */
  displayRangeCents: number;
  /** Median over this many recent readings (in cents) ... */
  medianFrames: number;
  /** ... followed by an exponential moving average with this weight for the newest value (0..1). */
  emaAlpha: number;
  /** A different string must win this many readings in a row before the display switches to it. */
  switchFrames: number;
  /** When the note fades (no readings), keep showing the last value this long. */
  holdMs: number;
  /** A string must stay in tune for this many readings in a row before its chip turns green. */
  inTuneFrames: number;
  /** A chip stays green this long after the string was last in tune ("recently"). */
  inTuneMemoryMs: number;
}

export const tunerConfig: TunerConfig = {
  a4Hz: 440,
  inTuneCents: 5,
  displayRangeCents: 50,
  medianFrames: 5,
  emaAlpha: 0.35,
  switchFrames: 3,
  holdMs: 1500,
  inTuneFrames: 6,
  inTuneMemoryMs: 90_000,
};

/**
 * Chord classification (0.3). For each strum: one Hann window over [onset + chordWindowStartMs,
 * onset + chordWindowEndMs] of the analysis signal, zero-padded FFT, folded into a 12-bin chroma and
 * a bass chroma, compared with voicing templates (detection/chords.ts). See TECH.md 2.3.
 */
export interface ChordConfig {
  /** Analysis window start after the strum's onset (skips the pick/strum transient). */
  chordWindowStartMs: number;
  /** Analysis window end after the onset. The chord can be shown this long after the strum, at the earliest. */
  chordWindowEndMs: number;
  /** FFT size (power of two, >= window length; zero-padded). 8192 = 5.9 Hz bins at 48 kHz. */
  fftSize: number;
  /** Chroma fold range. */
  chromaMinHz: number;
  chromaMaxHz: number;
  /** Bass chroma range (lowest notes: G2 98, A2 110, C3 131, D3 147 Hz). */
  bassMinHz: number;
  bassMaxHz: number;
  /**
   * Fold only spectral peaks (local maxima) instead of every bin: the window's leakage skirts and the
   * noise between partials then add nothing.
   */
  peaksOnly: boolean;
  /** Log compression of the folded chroma: log(1 + gamma * c / max(c)). */
  chromaLogGamma: number;
  /** Tuning reference for the pitch-class fold. */
  a4Hz: number;
  /** Template partial weights: index 0 = fundamental, 1 = 2nd harmonic, ... */
  harmonicWeights: number[];
  /** Weight of the bass-chroma similarity in the final score (0..1; the rest is the full chroma). */
  bassWeight: number;
  /** In the bass template, the chord's lowest note gets this weight (other notes 1). */
  bassRootWeight: number;
  /** "Unsure" if the best score is below this ... */
  minScore: number;
  /** ... or beats the second best by less than this. */
  minMargin: number;
  /** Confidence: margin at which the margin part reaches 100%. */
  marginFull: number;
  /** The level of the window must be at least this far above the room floor (otherwise "?"). */
  minAboveRoomDb: number;
}

/**
 * Defaults tuned lightly on rec1 (Galaxy S24, C/G/D strums; TECH.md 2.3): peaks-only fold, a later and
 * longer window (50-160 ms: a slow strum is still building up at 30 ms) and gentle log compression gave
 * the biggest margins. Bass weight kept small but non-zero: it is the main Am/C cue in theory, and rec1
 * has no Am to check it on.
 */
export const chordConfig: ChordConfig = {
  chordWindowStartMs: 50,
  chordWindowEndMs: 160,
  fftSize: 8192,
  chromaMinHz: 75,
  chromaMaxHz: 2000,
  bassMinHz: 75,
  bassMaxHz: 170,
  peaksOnly: true,
  chromaLogGamma: 3,
  a4Hz: 440,
  harmonicWeights: [1, 0.6, 0.4, 0.3, 0.2, 0.15],
  bassWeight: 0.1,
  bassRootWeight: 2,
  minScore: 0.7,
  minMargin: 0.05,
  marginFull: 0.2,
  minAboveRoomDb: 6,
};
