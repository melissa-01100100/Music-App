/**
 * Raw-audio recording for the golden test set. Pure (no DOM / Web Audio), unit tested.
 * The worklet sends raw (unfiltered) mono chunks while recording; `RecordingBuffer`
 * collects them, and `buildRecordingJson` describes the take (settings + detected strums).
 */
import type { OnsetEvent } from '../detection/onset';

export class RecordingBuffer {
  readonly chunks: Float32Array[] = [];
  /** Stream frame index (worklet framesProcessed timeline) of the first recorded sample. */
  startFrame: number | null = null;
  frames = 0;

  constructor(
    readonly sampleRate: number,
    readonly maxFrames: number,
  ) {}

  /**
   * Adds a chunk that starts at stream frame `startFrame`. Truncates at `maxFrames`.
   * Returns true once the buffer is full (the caller should stop recording).
   */
  add(chunk: Float32Array, startFrame: number): boolean {
    if (this.startFrame === null) this.startFrame = startFrame;
    const room = this.maxFrames - this.frames;
    if (room <= 0) return true;
    const part = chunk.length > room ? chunk.slice(0, room) : chunk;
    this.chunks.push(part);
    this.frames += part.length;
    return this.frames >= this.maxFrames;
  }

  get durationSec(): number {
    return this.frames / this.sampleRate;
  }

  /** Stream frame index just after the last recorded sample. */
  get endFrame(): number {
    return (this.startFrame ?? 0) + this.frames;
  }

  /** Detected strums inside the recording, with times relative to the recording start. */
  eventsInside(events: readonly OnsetEvent[]): { timeSec: number; strength: number; levelDb: number; sampleIndex: number }[] {
    if (this.startFrame === null) return [];
    const start = this.startFrame;
    return events
      .filter((e) => e.sampleIndex >= start && e.sampleIndex < this.endFrame)
      .map((e) => ({
        timeSec: round((e.sampleIndex - start) / this.sampleRate, 6),
        strength: round(e.strength, 4),
        levelDb: round(e.levelDb, 1),
        sampleIndex: e.sampleIndex - start,
      }));
  }
}

export interface RecordingMeta {
  build: string;
  /** Short device description, e.g. "Pixel 10, Android 16, Chrome 141". */
  device: string;
  /** Full device info panel as label -> value. */
  deviceInfo: Record<string, string>;
  recordedAt: Date;
  /** Room floor (analysis path, dBFS) when the recording started / stopped. */
  noiseFloorDbAtStart: number | null;
  noiseFloorDbAtEnd: number | null;
  /** All detection settings in force (onset, analysis filter, noise floor). */
  config: Record<string, unknown>;
}

/** JSON that goes next to the WAV. Close to the draft label format in TECH.md section 5. */
export function buildRecordingJson(rec: RecordingBuffer, events: readonly OnsetEvent[], meta: RecordingMeta) {
  return {
    format: 'chord-detect-recording',
    formatVersion: 1,
    sampleRate: rec.sampleRate,
    device: meta.device,
    build: meta.build,
    recordedAt: meta.recordedAt.toISOString(),
    durationSec: round(rec.durationSec, 3),
    frames: rec.frames,
    audio: 'raw mic input (before the 70 Hz analysis high-pass), mono, 16-bit PCM WAV',
    noiseFloorDb: meta.noiseFloorDbAtStart === null ? null : round(meta.noiseFloorDbAtStart, 1),
    noiseFloorDbAtEnd: meta.noiseFloorDbAtEnd === null ? null : round(meta.noiseFloorDbAtEnd, 1),
    eventsAre: 'detected by the app (not hand-checked); times in seconds from the start of the WAV',
    config: meta.config,
    deviceInfo: meta.deviceInfo,
    events: rec.eventsInside(events),
  };
}

/** "2026-10-05_21-30-07" in local time, safe for file names. */
export function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** "1:05" */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function round(x: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
}
