/**
 * Chord classification of one strum: chroma + bass chroma vs. the voicing templates.
 * Pure, deterministic. See TECH.md 2.3.
 *
 *   score(chord) = (1 - bassWeight) * cos(chroma, T_chord) + bassWeight * cos(bass, B_chord)
 *   confidence   = clamp((s1 - minScore) / (1 - minScore)) * clamp((s1 - s2) / marginFull)
 *   unsure ("?") if s1 < minScore, s1 - s2 < minMargin, or the window is not above the room.
 * The 0.4 milestone will calibrate this (and add per-player templates).
 */
import { CHORDS, buildTemplates, type ChordName, type TemplateSet } from './chords';
import { computeChroma, type Chroma } from './chroma';
import type { ChordConfig } from './config';

export interface ChordResult {
  /** Best chord, or null when unsure ("?"). */
  chord: ChordName | null;
  /** Best-scoring chord even when unsure (for logs and tuning). */
  best: ChordName;
  /** Score per chord (about 0..1, higher = better match). */
  scores: Record<ChordName, number>;
  /** 0..1. */
  confidence: number;
  /** Best score minus second best. */
  margin: number;
  /** Why it is unsure, if it is. */
  reason: 'ok' | 'low-score' | 'low-margin' | 'too-quiet';
  /** Chroma of the analysed window (for tools/debugging). */
  chroma: Chroma;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export class ChordClassifier {
  readonly templates: TemplateSet;

  constructor(readonly cfg: ChordConfig) {
    this.templates = buildTemplates(cfg);
  }

  /** Window [start, end) in samples relative to the onset. */
  windowSamples(sampleRate: number): { start: number; end: number } {
    return {
      start: Math.round((this.cfg.chordWindowStartMs / 1000) * sampleRate),
      end: Math.round((this.cfg.chordWindowEndMs / 1000) * sampleRate),
    };
  }

  /** Classifies a chroma (already computed). `aboveRoomDb` null = room not measured (no gate). */
  classifyChroma(ch: Chroma, aboveRoomDb: number | null = null): Omit<ChordResult, 'chroma'> {
    const { cfg, templates } = this;
    const hasBass = ch.bass.some((x) => x > 0);
    const bw = hasBass ? cfg.bassWeight : 0;
    const scores = {} as Record<ChordName, number>;
    let best: ChordName = CHORDS[0];
    for (const c of CHORDS) {
      scores[c] = (1 - bw) * cosine(ch.chroma, templates.chroma[c]) + bw * cosine(ch.bass, templates.bass[c]);
      if (scores[c] > scores[best]) best = c;
    }
    let second = -Infinity;
    for (const c of CHORDS) if (c !== best) second = Math.max(second, scores[c]);
    const s1 = scores[best];
    const margin = s1 - second;
    const confidence = clamp01((s1 - cfg.minScore) / (1 - cfg.minScore)) * clamp01(margin / cfg.marginFull);
    const reason: ChordResult['reason'] =
      aboveRoomDb !== null && aboveRoomDb < cfg.minAboveRoomDb
        ? 'too-quiet'
        : s1 < cfg.minScore
          ? 'low-score'
          : margin < cfg.minMargin
            ? 'low-margin'
            : 'ok';
    return { chord: reason === 'ok' ? best : null, best, scores, confidence: reason === 'ok' ? confidence : Math.min(confidence, 0.5), margin, reason };
  }

  /**
   * Classifies the strum whose onset is at `onsetIndex` in `samples` (high-passed analysis signal).
   * Needs samples up to onsetIndex + chordWindowEndMs; a shorter buffer uses what is there.
   */
  classify(samples: Float32Array, onsetIndex: number, sampleRate: number, noiseFloorDb: number | null = null): ChordResult {
    const w = this.windowSamples(sampleRate);
    const from = Math.max(0, onsetIndex + w.start);
    const to = Math.min(samples.length, onsetIndex + w.end);
    const ch = computeChroma(samples.subarray(from, Math.max(from, to)), sampleRate, this.cfg);
    const above = noiseFloorDb === null ? null : ch.levelDb - noiseFloorDb;
    return { ...this.classifyChroma(ch, above), chroma: ch };
  }
}
