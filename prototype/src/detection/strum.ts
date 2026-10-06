/**
 * Streaming strum tracker (0.3): the onset detector plus a short history of the analysis signal, so each
 * strum can be handed over together with the audio its chord is read from. Pure, deterministic.
 * Runs in the capture AudioWorklet; the chord itself is classified on the main thread (TECH.md 2.7).
 *
 * A strum is returned once both are true: the onset detector has confirmed it (merge window closed)
 * and the audio up to onset + `audioAfterOnsetMs` has arrived. `audio[0]` is the onset sample.
 */
import type { OnsetConfig } from './config';
import { OnsetDetector, type OnsetEvent } from './onset';

export interface StrumWithAudio {
  event: OnsetEvent;
  /** Analysis signal from the onset to onset + audioAfterOnsetMs (a fresh copy, safe to transfer). */
  audio: Float32Array;
}

/** History kept for the chord audio (the onset is confirmed at most ~0.3 s after it happened). */
const HISTORY_SEC = 1.2;
const NONE: StrumWithAudio[] = [];

export class StrumTracker {
  readonly detector: OnsetDetector;
  private readonly ring: Float32Array;
  private readonly mask: number;
  private total = 0;
  private audioSamples: number;
  private readonly pending: OnsetEvent[] = [];

  constructor(
    readonly sampleRate: number,
    onsetCfg: OnsetConfig,
    audioAfterOnsetMs: number,
  ) {
    this.detector = new OnsetDetector(sampleRate, onsetCfg);
    this.audioSamples = Math.max(1, Math.round((audioAfterOnsetMs / 1000) * sampleRate));
    let size = 1024;
    while (size < HISTORY_SEC * sampleRate + this.audioSamples) size <<= 1;
    this.ring = new Float32Array(size);
    this.mask = size - 1;
  }

  /** Feeds analysis samples; returns strums whose audio is complete. */
  push(samples: Float32Array): StrumWithAudio[] {
    for (let i = 0; i < samples.length; i++) this.ring[(this.total + i) & this.mask] = samples[i];
    this.total += samples.length;
    const events = this.detector.push(samples);
    for (const e of events) this.pending.push(e);
    return this.takeReady(false);
  }

  /** End of a file: confirms the last strum and returns everything pending with the audio available. */
  flush(): StrumWithAudio[] {
    for (const e of this.detector.flush()) this.pending.push(e);
    return this.takeReady(true);
  }

  /** Allocates only when a strum is handed over (nothing per audio quantum otherwise). */
  private takeReady(all: boolean): StrumWithAudio[] {
    if (this.pending.length === 0 || (!all && this.total < this.pending[0].sampleIndex + this.audioSamples)) return NONE;
    const out: StrumWithAudio[] = [];
    while (this.pending.length > 0) {
      const e = this.pending[0];
      const end = e.sampleIndex + this.audioSamples;
      if (!all && this.total < end) break;
      this.pending.shift();
      const from = Math.max(e.sampleIndex, this.total - this.ring.length);
      const to = Math.min(end, this.total);
      const audio = new Float32Array(Math.max(0, to - from));
      for (let i = 0; i < audio.length; i++) audio[i] = this.ring[(from + i) & this.mask];
      out.push({ event: e, audio });
    }
    return out;
  }
}
