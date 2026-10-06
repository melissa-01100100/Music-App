/** Messages between the capture AudioWorklet and the main thread. */
import type { LiveOnsetSettings, OnsetConfig } from '../detection/config';

export const CAPTURE_PROCESSOR_NAME = 'capture-processor';

export interface CaptureOptions {
  blockSizeFrames: number;
  clipThreshold: number;
  /** Analysis-path high-pass cutoff (Hz). The raw signal is not filtered. */
  highPassHz: number;
  /** Cascaded 2nd-order sections (1 = 12 dB/octave). */
  highPassStages: number;
  /** Strum detector settings (runs in the worklet on the analysis signal). */
  onset: OnsetConfig;
  /** Raw-audio chunk size posted while recording. */
  recordChunkFrames: number;
  /** Analysis-audio chunk size posted while the tuner tap is on (0.2.1). */
  tapChunkFrames?: number;
}

export interface LevelMessage {
  type: 'level';
  /** Audio-clock frame index (AudioWorkletGlobalScope.currentFrame) at the end of this block. */
  endFrame: number;
  /** Total frames processed by this node since it started. */
  framesProcessed: number;
  /** Frames in this block (normally blockSizeFrames). */
  count: number;
  /** Sum of squares of the ANALYSIS signal (high-passed). Drives the meter and noise floor. */
  sumSquares: number;
  /** Largest |x| of the analysis signal. */
  peak: number;
  /** Sum of squares of the RAW mic signal (unfiltered), for reference. */
  rawSumSquares: number;
  /** Largest |x| of the raw mic signal. */
  rawPeak: number;
  /** Clipped samples, counted on the RAW signal (clipping happens before any filtering). */
  clipCount: number;
  /** process() calls where the input had no channels (mic disconnected / not delivering). */
  emptyQuanta: number;
}

/** A detected strum. sampleIndex is on the framesProcessed timeline (0 = first frame after Start). */
export interface OnsetMessage {
  type: 'onset';
  sampleIndex: number;
  strength: number;
  levelDb: number;
}

/** Raw (unfiltered) mic audio while recording. `samples` is transferred, not copied. */
export interface RawChunkMessage {
  type: 'raw';
  /** framesProcessed index of samples[0]. */
  startFrame: number;
  samples: Float32Array;
}

/** Sent after the last raw chunk once recording has been switched off. */
export interface RecordStoppedMessage {
  type: 'record-stopped';
  endFrame: number;
}

/**
 * High-passed ANALYSIS audio for the tuner's pitch detector (main thread), only while the tap is on.
 * `samples` is transferred, not copied.
 */
export interface AnalysisChunkMessage {
  type: 'analysis';
  /** framesProcessed index of samples[0]. */
  startFrame: number;
  samples: Float32Array;
}

export type WorkletMessage = LevelMessage | OnsetMessage | RawChunkMessage | RecordStoppedMessage | AnalysisChunkMessage;

/** Main thread -> worklet. */
export type ControlMessage =
  | { type: 'onset-settings'; settings: Partial<LiveOnsetSettings> }
  | { type: 'noise-floor'; db: number | null }
  | { type: 'record'; on: boolean }
  /** Tuner on/off: stream the analysis signal to the main thread. */
  | { type: 'tap'; on: boolean };
