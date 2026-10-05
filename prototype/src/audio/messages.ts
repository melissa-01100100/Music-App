/** Messages between the capture AudioWorklet and the main thread. */

export const CAPTURE_PROCESSOR_NAME = 'capture-processor';

export interface CaptureOptions {
  blockSizeFrames: number;
  clipThreshold: number;
}

export interface LevelMessage {
  type: 'level';
  /** Audio-clock frame index (AudioWorkletGlobalScope.currentFrame) at the end of this block. */
  endFrame: number;
  /** Total frames processed by this node since it started. */
  framesProcessed: number;
  /** Frames in this block (normally blockSizeFrames). */
  count: number;
  sumSquares: number;
  peak: number;
  clipCount: number;
  /** process() calls where the input had no channels (mic disconnected / not delivering). */
  emptyQuanta: number;
}

export type WorkletMessage = LevelMessage;
