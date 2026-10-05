/**
 * Capture AudioWorklet. Runs on the audio thread.
 * Counts frames and posts level statistics every `blockSizeFrames` frames:
 *  - analysis path: the mic signal through a 2nd-order high-pass (`highPassHz`),
 *    used for the meter and noise floor (and later onset/chroma);
 *  - raw path: the untouched mic signal (clip detection now, recording later).
 * The raw input buffer is never modified; filtering writes into a scratch buffer.
 *
 * Bundled by Vite via `?worker&url` (see mic.ts) so it works in production builds.
 */
import { accumulateStats, emptyStats, type BlockStats } from '../detection/level';
import { Biquad, highPassCoeffs } from '../detection/filters';
import { CAPTURE_PROCESSOR_NAME, type CaptureOptions, type LevelMessage } from './messages';

// Minimal typings for the AudioWorkletGlobalScope (not in lib.dom).
declare const currentFrame: number;
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
}

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly blockSize: number;
  private readonly clipThreshold: number;
  private readonly hpf: Biquad[];
  private scratch = new Float32Array(128);
  private raw: BlockStats = emptyStats();
  private analysis: BlockStats = emptyStats();
  private framesProcessed = 0;
  private emptyQuanta = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const opts = (options?.processorOptions ?? {}) as Partial<CaptureOptions>;
    this.blockSize = opts.blockSizeFrames ?? 1024;
    this.clipThreshold = opts.clipThreshold ?? 0.99;
    const coeffs = highPassCoeffs(opts.highPassHz ?? 70, sampleRate);
    this.hpf = Array.from({ length: Math.max(1, opts.highPassStages ?? 1) }, () => new Biquad(coeffs));
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) {
      this.emptyQuanta++;
      return true;
    }
    // Mono: we requested channelCount 1; if more arrive, use the first channel.
    const channel = input[0];
    if (this.scratch.length !== channel.length) this.scratch = new Float32Array(channel.length);
    this.hpf[0].process(channel, this.scratch);
    for (let s = 1; s < this.hpf.length; s++) this.hpf[s].process(this.scratch, this.scratch);

    accumulateStats(this.raw, channel, this.clipThreshold);
    // Clip count only matters on the raw path; Infinity keeps the analysis count at 0.
    accumulateStats(this.analysis, this.scratch, Infinity);
    this.framesProcessed += channel.length;

    if (this.raw.count >= this.blockSize) {
      const msg: LevelMessage = {
        type: 'level',
        endFrame: currentFrame + channel.length,
        framesProcessed: this.framesProcessed,
        count: this.analysis.count,
        sumSquares: this.analysis.sumSquares,
        peak: this.analysis.peak,
        rawSumSquares: this.raw.sumSquares,
        rawPeak: this.raw.peak,
        clipCount: this.raw.clipCount,
        emptyQuanta: this.emptyQuanta,
      };
      this.port.postMessage(msg);
      this.raw = emptyStats();
      this.analysis = emptyStats();
    }
    return true;
  }
}

registerProcessor(CAPTURE_PROCESSOR_NAME, CaptureProcessor);
