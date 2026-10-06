/**
 * Scoring of detected onsets against labelled onsets (golden set, unit tests).
 * Pure; used by tools/evaluate.ts and the tests.
 */
import { percentile } from './noiseFloor';

export interface OnsetScore {
  expected: number;
  detected: number;
  truePositives: number;
  falsePositives: number;
  missed: number;
  recall: number;
  precision: number;
  /** Signed errors (detected - expected) in ms, one per matched onset. */
  errorsMs: number[];
  /** Mean signed error (bias), ms. NaN if nothing matched. */
  meanErrorMs: number;
  /** Median / 95th percentile of |error|, ms. NaN if nothing matched. */
  medianAbsErrorMs: number;
  p95AbsErrorMs: number;
  maxAbsErrorMs: number;
}

/**
 * Greedy one-to-one matching in time order: each expected onset takes the nearest
 * unused detection within `toleranceSec`. Unmatched detections are false positives
 * (this includes double triggers on a single strum).
 */
export function scoreOnsets(detectedSec: readonly number[], expectedSec: readonly number[], toleranceSec = 0.05): OnsetScore {
  const det = [...detectedSec].sort((a, b) => a - b);
  const exp = [...expectedSec].sort((a, b) => a - b);
  const used = new Array<boolean>(det.length).fill(false);
  const errorsMs: number[] = [];
  let start = 0;
  for (const e of exp) {
    while (start < det.length && det[start] < e - toleranceSec) start++;
    let best = -1;
    let bestDist = Infinity;
    for (let j = start; j < det.length && det[j] <= e + toleranceSec; j++) {
      const d = Math.abs(det[j] - e);
      if (!used[j] && d < bestDist) {
        best = j;
        bestDist = d;
      }
    }
    if (best >= 0) {
      used[best] = true;
      errorsMs.push((det[best] - e) * 1000);
    }
  }
  const tp = errorsMs.length;
  const abs = errorsMs.map(Math.abs);
  return {
    expected: exp.length,
    detected: det.length,
    truePositives: tp,
    falsePositives: det.length - tp,
    missed: exp.length - tp,
    recall: exp.length ? tp / exp.length : 1,
    precision: det.length ? tp / det.length : 1,
    errorsMs,
    meanErrorMs: tp ? errorsMs.reduce((a, b) => a + b, 0) / tp : NaN,
    medianAbsErrorMs: tp ? percentile(abs, 50) : NaN,
    p95AbsErrorMs: tp ? percentile(abs, 95) : NaN,
    maxAbsErrorMs: tp ? Math.max(...abs) : NaN,
  };
}

/** Smallest gap between consecutive detections (seconds); Infinity for < 2 events. */
export function minGapSec(timesSec: readonly number[]): number {
  const t = [...timesSec].sort((a, b) => a - b);
  let g = Infinity;
  for (let i = 1; i < t.length; i++) g = Math.min(g, t[i] - t[i - 1]);
  return g;
}

export interface ChordScore {
  /** Labelled strums matched to a detection (within the tolerance). */
  matched: number;
  correct: number;
  /** Matched, but the detector said "?" (null). */
  unsure: number;
  /** Matched and named a different chord. */
  wrong: number;
  /** correct / matched. */
  accuracy: number;
  /** "expected>detected" -> count, for the wrong and unsure ones (detected "?" when unsure). */
  confusions: Record<string, number>;
}

/** Chord accuracy on the strums both labelled and detected (same greedy time matching as scoreOnsets). */
export function scoreChords(
  detected: readonly { timeSec: number; chord: string | null }[],
  expected: readonly { timeSec: number; chord: string }[],
  toleranceSec = 0.05,
): ChordScore {
  const det = [...detected].sort((a, b) => a.timeSec - b.timeSec);
  const used = new Array<boolean>(det.length).fill(false);
  const out: ChordScore = { matched: 0, correct: 0, unsure: 0, wrong: 0, accuracy: NaN, confusions: {} };
  for (const e of [...expected].sort((a, b) => a.timeSec - b.timeSec)) {
    let best = -1;
    let bestDist = Infinity;
    det.forEach((d, j) => {
      const dist = Math.abs(d.timeSec - e.timeSec);
      if (!used[j] && dist <= toleranceSec && dist < bestDist) {
        best = j;
        bestDist = dist;
      }
    });
    if (best < 0) continue;
    used[best] = true;
    out.matched++;
    const got = det[best].chord;
    if (got === e.chord) out.correct++;
    else {
      if (got === null || got === '?') out.unsure++;
      else out.wrong++;
      const key = `${e.chord}>${got ?? '?'}`;
      out.confusions[key] = (out.confusions[key] ?? 0) + 1;
    }
  }
  out.accuracy = out.matched ? out.correct / out.matched : NaN;
  return out;
}
