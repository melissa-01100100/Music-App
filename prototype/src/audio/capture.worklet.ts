/**
 * Capture AudioWorklet. Runs on the audio thread.
 *  - analysis path: the mic signal through a 2nd-order high-pass (`highPassHz`). Feeds the level
 *    statistics (meter, noise floor) and the strum (onset) detector.
 *  - raw path: the untouched mic signal. Clip detection, and recording (posted in chunks).
 * The raw input buffer is never modified; filtering writes into a scratch buffer.
 *
 * Why the onset detector runs here (TECH.md 2.5): it is cheap (one 1024-point FFT every
 * 256 frames, ~1% of the audio thread on a desktop), it sees every sample in order with the
 * exact frame count, and it cannot be delayed by UI work on the main thread. Only small event
 * messages cross threads.
 *
 * Bundled by Vite via `?worker&url` (see mic.ts) so it works in production builds.
 */
import { accumulateStats, emptyStats, type BlockStats } from '../detection/level';
import { Biquad, highPassCoeffs } from '../detection/filters';
import { onsetConfig } from '../detection/config';
import { OnsetDetector } from '../detection/onset';
import {
  CAPTURE_PROCESSOR_NAME,
  type CaptureOptions,
  type ControlMessage,
  type LevelMessage,
  type OnsetMessage,
  type RawChunkMessage,
} from './messages';

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
  private readonly detector: OnsetDetector;
  private readonly recordChunkFrames: number;
  private scratch = new Float32Array(128);
  private raw: BlockStats = emptyStats();
  private analysis: BlockStats = emptyStats();
  private framesProcessed = 0;
  private emptyQuanta = 0;

  private recording = false;
  private recChunk: Float32Array | null = null;
  private recFill = 0;
  private recChunkStart = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const opts = (options?.processorOptions ?? {}) as Partial<CaptureOptions>;
    this.blockSize = opts.blockSizeFrames ?? 1024;
    this.clipThreshold = opts.clipThreshold ?? 0.99;
    const coeffs = highPassCoeffs(opts.highPassHz ?? 70, sampleRate);
    this.hpf = Array.from({ length: Math.max(1, opts.highPassStages ?? 1) }, () => new Biquad(coeffs));
    this.detector = new OnsetDetector(sampleRate, opts.onset ?? onsetConfig);
    this.recordChunkFrames = opts.recordChunkFrames ?? 4096;
    this.port.onmessage = (e: MessageEvent<ControlMessage>) => this.onControl(e.data);
  }

  private onControl(msg: ControlMessage): void {
    if (msg.type === 'onset-settings') this.detector.updateSettings(msg.settings);
    else if (msg.type === 'noise-floor') this.detector.setNoiseFloorDb(msg.db);
    else if (msg.type === 'record') {
      if (msg.on && !this.recording) {
        this.recording = true;
        this.recChunk = null;
        this.recFill = 0;
      } else if (!msg.on && this.recording) {
        this.recording = false;
        this.flushRecording();
        this.port.postMessage({ type: 'record-stopped', endFrame: this.framesProcessed });
      }
    }
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

    if (this.recording) this.record(channel);

    // The detector's sample counter equals framesProcessed (both start at 0 and see every frame).
    const events = this.detector.push(this.scratch);
    for (const ev of events) {
      const msg: OnsetMessage = { type: 'onset', sampleIndex: ev.sampleIndex, strength: ev.strength, levelDb: ev.levelDb };
      this.port.postMessage(msg);
    }

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

  /** Copies the RAW quantum into the current chunk; posts full chunks (transferred). */
  private record(channel: Float32Array): void {
    let i = 0;
    while (i < channel.length) {
      if (!this.recChunk) {
        this.recChunk = new Float32Array(this.recordChunkFrames);
        this.recFill = 0;
        this.recChunkStart = this.framesProcessed + i;
      }
      const n = Math.min(channel.length - i, this.recChunk.length - this.recFill);
      this.recChunk.set(channel.subarray(i, i + n), this.recFill);
      this.recFill += n;
      i += n;
      if (this.recFill === this.recChunk.length) this.flushRecording();
    }
  }

  private flushRecording(): void {
    if (!this.recChunk || this.recFill === 0) {
      this.recChunk = null;
      return;
    }
    const samples = this.recFill === this.recChunk.length ? this.recChunk : this.recChunk.slice(0, this.recFill);
    const msg: RawChunkMessage = { type: 'raw', startFrame: this.recChunkStart, samples };
    this.port.postMessage(msg, [samples.buffer]);
    this.recChunk = null;
    this.recFill = 0;
  }
}

registerProcessor(CAPTURE_PROCESSOR_NAME, CaptureProcessor);
