/**
 * The four Phase 0 chords as open-position voicings (standard tuning) and their chroma templates.
 * Pure, deterministic. See TECH.md 2.3.
 *
 * Templates are built from the notes that actually sound (not just the triad) plus their first
 * partials with decaying weights, because a guitar string puts a lot of energy in its harmonics
 * (an E3 string also sounds B4, E5, G#5...). Pitch class index: 0 = C, 1 = C#, ... 9 = A, 11 = B.
 */
import type { ChordConfig } from './config';

export const CHORDS = ['Am', 'C', 'G', 'D'] as const;
export type ChordName = (typeof CHORDS)[number];

/** Sounding notes, low to high, as MIDI numbers (A4 = 69). */
export const VOICINGS: Record<ChordName, readonly number[]> = {
  Am: [45, 52, 57, 60, 64], // x02210: A2 E3 A3 C4 E4
  C: [48, 52, 55, 60, 64], // x32010: C3 E3 G3 C4 E4
  G: [43, 47, 50, 55, 59, 67], // 320003: G2 B2 D3 G3 B3 G4
  D: [50, 57, 62, 66], // xx0232: D3 A3 D4 F#4
};

export const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export function midiToHz(midi: number, a4Hz = 440): number {
  return a4Hz * 2 ** ((midi - 69) / 12);
}

/** Pitch class (0 = C) of a fractional MIDI pitch, rounded to the nearest semitone. */
export function pitchClassOf(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

export type TemplateConfig = Pick<ChordConfig, 'harmonicWeights' | 'chromaMinHz' | 'chromaMaxHz' | 'bassMinHz' | 'bassMaxHz' | 'bassRootWeight' | 'a4Hz'>;

/** Adds the partials of `notes` that fall inside [minHz, maxHz] into a 12-bin profile. */
function partialProfile(notes: readonly number[], weights: readonly number[], minHz: number, maxHz: number, a4Hz: number, noteWeight: (i: number) => number): Float64Array {
  const t = new Float64Array(12);
  notes.forEach((midi, i) => {
    weights.forEach((w, h) => {
      const f = midiToHz(midi, a4Hz) * (h + 1);
      if (f < minHz || f > maxHz) return;
      t[pitchClassOf(midi + 12 * Math.log2(h + 1))] += w * noteWeight(i);
    });
  });
  return normalise(t);
}

/** Full-range template: every sounding note with its harmonics, L2-normalised. */
export function chordTemplate(chord: ChordName, cfg: TemplateConfig): Float64Array {
  return partialProfile(VOICINGS[chord], cfg.harmonicWeights, cfg.chromaMinHz, cfg.chromaMaxHz, cfg.a4Hz, () => 1);
}

/** Bass template: only partials inside the bass range; the lowest note weighs `bassRootWeight`. */
export function bassTemplate(chord: ChordName, cfg: TemplateConfig): Float64Array {
  return partialProfile(VOICINGS[chord], cfg.harmonicWeights, cfg.bassMinHz, cfg.bassMaxHz, cfg.a4Hz, (i) => (i === 0 ? cfg.bassRootWeight : 1));
}

export interface TemplateSet {
  chroma: Record<ChordName, Float64Array>;
  bass: Record<ChordName, Float64Array>;
}

export function buildTemplates(cfg: TemplateConfig): TemplateSet {
  const chroma = {} as Record<ChordName, Float64Array>;
  const bass = {} as Record<ChordName, Float64Array>;
  for (const c of CHORDS) {
    chroma[c] = chordTemplate(c, cfg);
    bass[c] = bassTemplate(c, cfg);
  }
  return { chroma, bass };
}

/** L2 normalisation in place (an all-zero vector stays zero). Returns the same array. */
export function normalise(v: Float64Array): Float64Array {
  let s = 0;
  for (const x of v) s += x * x;
  if (s > 0) {
    const k = 1 / Math.sqrt(s);
    for (let i = 0; i < v.length; i++) v[i] *= k;
  }
  return v;
}
