import { describe, expect, it } from 'vitest';
import { chordConfig } from '../src/detection/config';
import { CHORDS, VOICINGS, bassTemplate, chordTemplate, midiToHz, pitchClassOf, type ChordName } from '../src/detection/chords';
import { compressChroma, computeChroma, foldPitchClasses, magnitudeSpectrum } from '../src/detection/chroma';
import { ChordClassifier, cosine } from '../src/detection/classifier';
import { highPass } from '../src/detection/pipeline';
import { add, noise, sine, SR, strummedChord } from './signals';

const clf = new ChordClassifier(chordConfig);
const ONSET = 4800; // 100 ms of lead-in before the strum

/** A strum at ONSET over room noise, high-passed like the live analysis path. */
function strum(chord: ChordName, o: Partial<Parameters<typeof strummedChord>[0]> = {}, sr = SR, noiseRms = 0.001) {
  const n = Math.round(0.6 * sr);
  const x = noise(noiseRms, n, (o.seed ?? 1) + 50);
  const s = strummedChord({ notes: VOICINGS[chord], n: n - ONSET, sampleRate: sr, ...o });
  for (let i = 0; i < s.length; i++) x[ONSET + i] += s[i];
  return highPass(x, sr);
}

describe('chord templates', () => {
  it('voicings match the TECH.md table', () => {
    const names = (c: ChordName) => [...new Set(VOICINGS[c].map(pitchClassOf))].sort((a, b) => a - b);
    expect(names('Am')).toEqual([0, 4, 9]); // C E A
    expect(names('C')).toEqual([0, 4, 7]); // C E G
    expect(names('G')).toEqual([2, 7, 11]); // D G B
    expect(names('D')).toEqual([2, 6, 9]); // D F# A
    expect(midiToHz(45)).toBeCloseTo(110, 6);
    expect(midiToHz(VOICINGS.G[0])).toBeCloseTo(98, 0);
  });

  it('templates are unit vectors and peak on the chord tones; harmonics add the fifth/third partials', () => {
    for (const c of CHORDS) {
      const t = chordTemplate(c, chordConfig);
      expect(cosine(t, t)).toBeCloseTo(1, 9);
      const tones = new Set(VOICINGS[c].map(pitchClassOf));
      const top3 = [...t].map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, i]) => i);
      for (const i of top3) expect(tones.has(i)).toBe(true);
    }
    // The 3rd partial of E3 is B4: Am's template has some B even though B is not a chord tone.
    expect(chordTemplate('Am', chordConfig)[11]).toBeGreaterThan(0);
  });

  it('bass templates weight the lowest note most', () => {
    const roots: Record<ChordName, number> = { Am: 9, C: 0, G: 7, D: 2 };
    for (const c of CHORDS) {
      const b = bassTemplate(c, chordConfig);
      expect(b.indexOf(Math.max(...b))).toBe(roots[c]);
    }
  });

  it('the confusable pairs are the most similar templates (Am/C, G/D), so margins matter', () => {
    const t = (c: ChordName) => chordTemplate(c, chordConfig);
    expect(cosine(t('Am'), t('C'))).toBeGreaterThan(cosine(t('Am'), t('G')));
    expect(cosine(t('G'), t('D'))).toBeGreaterThan(cosine(t('G'), t('Am')));
    expect(cosine(t('Am'), t('C'))).toBeLessThan(0.95);
  });
});

describe('chroma', () => {
  it('a pure tone lands in its pitch class (A4 -> A, C4 -> C), at 48 and 44.1 kHz', () => {
    for (const sr of [48000, 44100]) {
      for (const [hz, pc] of [[440, 9], [261.63, 0], [110, 9], [98, 7]] as const) {
        const ch = computeChroma(sine(0.3, Math.round(0.11 * sr), hz, sr), sr, chordConfig);
        expect(ch.chroma.indexOf(Math.max(...ch.chroma))).toBe(pc);
      }
    }
  });

  it('fold ignores bins outside the range, compression keeps the order and normalises', () => {
    const mag = magnitudeSpectrum(sine(0.3, 4800, 3000), 8192);
    const raw = foldPitchClasses(mag, SR, 8192, 75, 2000, 440, true);
    expect(Math.max(...raw)).toBeLessThan(1e-3 * mag.reduce((a, b) => Math.max(a, b), 0));
    const c = compressChroma(Float64Array.from([4, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0]), 3);
    expect(c[0]).toBeGreaterThan(c[9]);
    expect(c[9]).toBeGreaterThan(c[1]);
    expect(cosine(c, c)).toBeCloseTo(1, 9);
    expect([...compressChroma(new Float64Array(12), 3)]).toEqual(new Array(12).fill(0));
  });

  it('is deterministic', () => {
    const a = strum('G');
    expect(clf.classify(a, ONSET, SR)).toEqual(clf.classify(a, ONSET, SR));
  });
});

describe('chord classifier on synthetic strums (exact voicings)', () => {
  it('names each chord with confidence, in tune', () => {
    for (const c of CHORDS) {
      const r = clf.classify(strum(c), ONSET, SR, -60);
      expect(r.chord, `${c}: ${JSON.stringify(r.scores)}`).toBe(c);
      expect(r.confidence).toBeGreaterThan(0.5);
    }
  });

  it('robust to detuning (±15 cents), slow strums, weak bass strings, other seeds and 44.1 kHz', () => {
    let total = 0, correct = 0, wrongNamed = 0;
    for (const sr of [48000, 44100]) {
      for (const c of CHORDS) {
        for (const detuneCents of [-15, 0, 15]) {
          for (const spreadMs of [3, 15]) {
            for (const seed of [1, 2]) {
              // Phone mics are weak on bass: the two lowest strings 10 dB down.
              const stringGains = seed === 2 ? [0.3, 0.3, 1, 1, 1, 1] : undefined;
              const r = clf.classify(strum(c, { detuneCents, spreadMs, seed, stringGains }, sr), Math.round((ONSET * sr) / SR), sr, -60);
              total++;
              if (r.chord === c) correct++;
              else if (r.chord !== null) wrongNamed++;
            }
          }
        }
      }
    }
    expect(correct / total).toBeGreaterThanOrEqual(0.95);
    expect(wrongNamed).toBe(0);
  });

  it('Am vs C and G vs D: the distinguishing notes decide', () => {
    for (const [a, b] of [['Am', 'C'], ['C', 'Am'], ['G', 'D'], ['D', 'G']] as const) {
      const r = clf.classify(strum(a, { seed: 7 }), ONSET, SR, -60);
      expect(r.scores[a]).toBeGreaterThan(r.scores[b] + chordConfig.minMargin);
    }
  });

  it('room noise only, or a strum barely above the room, gives "?"', () => {
    const n = noise(0.003, SR, 9);
    const a = highPass(n, SR);
    const r = clf.classify(a, ONSET, SR, -50);
    expect(r.chord).toBeNull();
    expect(r.reason).toBe('too-quiet');
    const quiet = clf.classify(strum('C', { amplitude: 0.0005 }, SR, 0.003), ONSET, SR, -50);
    expect(quiet.chord).toBeNull();
  });

  it('a chord outside the four (E minor, as in rec1) is "?" or low confidence, not a confident wrong name', () => {
    const em = [40, 47, 52, 55, 59, 64]; // 022000: E2 B2 E3 G3 B3 E4
    const n = Math.round(0.6 * SR);
    const x = add(noise(0.001, n, 3), new Float32Array(n));
    const s = strummedChord({ notes: em, n: n - ONSET });
    for (let i = 0; i < s.length; i++) x[ONSET + i] += s[i];
    const r = clf.classify(highPass(x, SR), ONSET, SR, -60);
    expect(r.chord === null || r.confidence < 0.8).toBe(true);
  });

  it('uses whatever audio is there when the buffer ends early', () => {
    const a = strum('D');
    const r = clf.classify(a.subarray(0, ONSET + 2000), ONSET, SR, -60);
    expect(CHORDS).toContain(r.best);
  });
});
