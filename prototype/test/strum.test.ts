import { describe, expect, it } from 'vitest';
import { chordConfig, onsetConfig } from '../src/detection/config';
import { VOICINGS, type ChordName } from '../src/detection/chords';
import { detectStrumsInAnalysis, highPass } from '../src/detection/pipeline';
import { StrumTracker } from '../src/detection/strum';
import { scoreChords } from '../src/detection/evaluate';
import { noise, SR, strummedChord } from './signals';

/** Am, C, G, D x5 each, 1 s apart (the rec1 task), over room noise. */
function progression(sr = SR) {
  const order: ChordName[] = ['Am', 'C', 'G', 'D'];
  const labels: { t: number; chord: ChordName }[] = [];
  order.forEach((c, ci) => {
    for (let k = 0; k < 5; k++) labels.push({ t: 2.5 + ci * 5.5 + k * 1.0, chord: c });
  });
  const n = Math.round((labels[labels.length - 1].t + 1.5) * sr);
  const x = noise(0.002, n, 31);
  labels.forEach((l, i) => {
    const at = Math.round(l.t * sr);
    const s = strummedChord({ notes: VOICINGS[l.chord], n: Math.min(Math.round(2.5 * sr), n - at), sampleRate: sr, amplitude: 0.1, spreadMs: 4 + (i % 4) * 4, seed: 100 + i, detuneCents: (i % 3) * 6 - 6 });
    // Fade the last 100 ms out: an abrupt end is a click the detector rightly reports as an onset.
    const fade = Math.round(0.1 * sr);
    for (let j = 0; j < s.length; j++) x[at + j] += s[j] * Math.min(1, (s.length - j) / fade);
  });
  return { x: highPass(x, sr), labels };
}

describe('StrumTracker', () => {
  it('hands over each strum with the audio from its onset, independent of push size', () => {
    const { x } = progression();
    const run = (chunk: number) => {
      const tr = new StrumTracker(SR, onsetConfig, chordConfig.chordWindowEndMs);
      tr.detector.setNoiseFloorDb(-54);
      const out = [];
      for (let i = 0; i < x.length; i += chunk) out.push(...tr.push(x.subarray(i, i + chunk)));
      out.push(...tr.flush());
      return out;
    };
    const a = run(128);
    expect(a).toHaveLength(20);
    const want = Math.round((chordConfig.chordWindowEndMs / 1000) * SR);
    for (const s of a) {
      expect(s.audio.length).toBe(want);
      expect(s.audio[0]).toBe(x[s.event.sampleIndex]);
      expect(s.audio[want - 1]).toBe(x[s.event.sampleIndex + want - 1]);
    }
    const b = run(1000);
    expect(b.map((s) => s.event.sampleIndex)).toEqual(a.map((s) => s.event.sampleIndex));
  });
});

describe('full 0.3 chain (onsets + chords) on a synthetic Am/C/G/D x5 progression', () => {
  for (const sr of [48000, 44100]) {
    it(`20/20 strums, 20/20 chords at ${sr} Hz`, () => {
      const { x, labels } = progression(sr);
      const out = detectStrumsInAnalysis(x, sr, { noiseFloorDb: -54 });
      expect(out).toHaveLength(20);
      out.forEach((s, i) => {
        // Strums spread over up to 80 ms (16 ms per string): timed within 30 ms of the first string.
        expect(Math.abs(s.event.timeSec - labels[i].t)).toBeLessThan(0.03);
        expect(s.chord.chord, `strum ${i} at ${labels[i].t}: ${JSON.stringify(s.chord.scores)}`).toBe(labels[i].chord);
      });
    });
  }
});

describe('scoreChords', () => {
  it('matches by time and counts correct / unsure / wrong with confusions', () => {
    const s = scoreChords(
      [{ timeSec: 1.01, chord: 'C' }, { timeSec: 2, chord: null }, { timeSec: 3.02, chord: 'G' }, { timeSec: 9, chord: 'D' }],
      [{ timeSec: 1, chord: 'C' }, { timeSec: 2, chord: 'Am' }, { timeSec: 3, chord: 'D' }, { timeSec: 5, chord: 'D' }],
    );
    expect(s).toMatchObject({ matched: 3, correct: 1, unsure: 1, wrong: 1, confusions: { 'Am>?': 1, 'D>G': 1 } });
    expect(s.accuracy).toBeCloseTo(1 / 3);
  });
});
