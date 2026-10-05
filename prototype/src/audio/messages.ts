/** Messages between the capture AudioWorklet and the main thread. */

export const CAPTURE_PROCESSOR_NAME = 'capture-processor';

export interface CaptureOptions {
  blockSizeFrames: number;
  clipThreshold: number;
  /** Analysis-path high-pass cutoff (Hz). The raw signal is not filtered. */
  highPassHz: number;
  /** Cascaded 2nd-order sections (1 = 12 dB/octave). */
  highPassStages: number;
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

export type WorkletMessage = LevelMessage;
