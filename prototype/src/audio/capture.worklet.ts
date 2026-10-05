/**
 * Capture AudioWorklet. Runs on the audio thread.
 * Counts frames and posts level statistics (sum of squares, peak, clip count)
 * every `blockSizeFrames` frames. Later milestones will also forward raw blocks.
 *
 * Bundled by Vite via `?worker&url` (see mic.ts) so it works in production builds.
 */
import { accumulateStats, emptyStats, type BlockStats } from '../detection/level';
import { CAPTURE_PROCESSOR_NAME, type CaptureOptions, type LevelMessage } from './messages';

// Minimal typings for the AudioWorkletGlobalScope (not in lib.dom).
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
}

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly blockSize: number;
  private readonly clipThreshold: number;
  private stats: BlockStats = emptyStats();
  private framesProcessed = 0;
  private emptyQuanta = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const opts = (options?.processorOptions ?? {}) as Partial<CaptureOptions>;
    this.blockSize = opts.blockSizeFrames ?? 1024;
    this.clipThreshold = opts.clipThreshold ?? 0.99;
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) {
      this.emptyQuanta++;
      return true;
    }
    // Mono: we requested channelCount 1; if more arrive, use the first channel.
    const channel = input[0];
    accumulateStats(this.stats, channel, this.clipThreshold);
    this.framesProcessed += channel.length;

    if (this.stats.count >= this.blockSize) {
      const msg: LevelMessage = {
        type: 'level',
        endFrame: currentFrame + channel.length,
        framesProcessed: this.framesProcessed,
        count: this.stats.count,
        sumSquares: this.stats.sumSquares,
        peak: this.stats.peak,
        clipCount: this.stats.clipCount,
        emptyQuanta: this.emptyQuanta,
      };
      this.port.postMessage(msg);
      this.stats = emptyStats();
    }
    return true;
  }
}

registerProcessor(CAPTURE_PROCESSOR_NAME, CaptureProcessor);
