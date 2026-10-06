/**
 * Scores the strum detector on the golden clips:
 *   npm run evaluate                 (all pairs in test/fixtures/)
 *   npm run evaluate -- path/to/dir  (another folder)
 * For each `x.wav` with an `x.labels.json`, runs the same chain as the app
 * (70 Hz high-pass + onset detector + chord classifier) and prints recall, precision and timing
 * error, plus chord accuracy for labels that have a "chord" (0.3).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav } from '../src/audio/wav';
import { chordConfig, onsetConfig } from '../src/detection/config';
import { scoreChords, scoreOnsets } from '../src/detection/evaluate';
import { detectStrumsInAnalysis, estimateFloorDb, highPass } from '../src/detection/pipeline';

const TOLERANCE_SEC = 0.05;

interface Labels {
  sampleRate?: number;
  noiseFloorDb?: number | null;
  events: { timeSec: number; chord?: string }[];
}

const here = fileURLToPath(new URL('.', import.meta.url));
const dir = resolve(process.argv[2] ?? join(here, '..', 'test', 'fixtures'));

if (!existsSync(dir)) {
  console.log(`No fixtures folder at ${dir}. Nothing to evaluate.`);
  process.exit(0);
}
const wavs = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav')).sort();
const pairs = wavs
  .map((w) => ({ wav: join(dir, w), labels: join(dir, w.replace(/\.wav$/i, '.labels.json')) }))
  .filter((p) => existsSync(p.labels));

if (pairs.length === 0) {
  console.log(`No labelled clips in ${dir} (need name.wav + name.labels.json). Nothing to evaluate.`);
  process.exit(0);
}

const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log(`Detector settings: ${JSON.stringify(onsetConfig)}`);
console.log(`Chord settings: ${JSON.stringify(chordConfig)}`);
console.log(`Match tolerance ±${TOLERANCE_SEC * 1000} ms\n`);
console.log(['clip', 'labels', 'found', 'hits', 'missed', 'extra', 'recall', 'precision', 'bias ms', 'median |err|', 'p95 |err|', 'floor dB', 'chords ok'].join('\t'));

let allDetected: number[] = [];
let allExpected: number[] = [];
const allChordsDet: { timeSec: number; chord: string | null }[] = [];
const allChordsExp: { timeSec: number; chord: string }[] = [];
let offset = 0;
for (const p of pairs) {
  const wav = decodeWav(readFileSync(p.wav));
  const labels = JSON.parse(readFileSync(p.labels, 'utf8')) as Labels;
  if (labels.sampleRate && labels.sampleRate !== wav.sampleRate) {
    console.warn(`  ${basename(p.wav)}: labels say ${labels.sampleRate} Hz, WAV is ${wav.sampleRate} Hz (using the WAV rate)`);
  }
  const analysis = highPass(wav.samples, wav.sampleRate);
  const floor = typeof labels.noiseFloorDb === 'number' ? labels.noiseFloorDb : estimateFloorDb(analysis);
  const strums = detectStrumsInAnalysis(analysis, wav.sampleRate, { noiseFloorDb: floor });
  const found = strums.map((e) => e.event.timeSec);
  const expected = labels.events.map((e) => e.timeSec);
  const s = scoreOnsets(found, expected, TOLERANCE_SEC);
  const det = strums.map((e) => ({ timeSec: e.event.timeSec, chord: e.chord.chord }));
  const exp = labels.events.filter((e) => typeof e.chord === 'string').map((e) => ({ timeSec: e.timeSec, chord: e.chord as string }));
  const c = exp.length ? scoreChords(det, exp, TOLERANCE_SEC) : null;
  console.log(
    [basename(p.wav), s.expected, s.detected, s.truePositives, s.missed, s.falsePositives, pct(s.recall), pct(s.precision),
      fmt(s.meanErrorMs), fmt(s.medianAbsErrorMs), fmt(s.p95AbsErrorMs), fmt(floor ?? NaN),
      c ? `${c.correct}/${c.matched} (${c.unsure} ?, ${c.wrong} wrong)` : '-'].join('\t'),
  );
  // Concatenate on one timeline (clips separated by a gap wider than the tolerance) for totals.
  const dur = wav.samples.length / wav.sampleRate + 1;
  allDetected = allDetected.concat(found.map((t) => t + offset));
  allExpected = allExpected.concat(expected.map((t) => t + offset));
  for (const d of det) allChordsDet.push({ timeSec: d.timeSec + offset, chord: d.chord });
  for (const e of exp) allChordsExp.push({ timeSec: e.timeSec + offset, chord: e.chord });
  offset += dur;
}
const t = scoreOnsets(allDetected, allExpected, TOLERANCE_SEC);
console.log(
  `\nTOTAL ${pairs.length} clips: recall ${pct(t.recall)}, precision ${pct(t.precision)}, missed ${t.missed}, extra ${t.falsePositives}, ` +
    `bias ${fmt(t.meanErrorMs)} ms, median |err| ${fmt(t.medianAbsErrorMs)} ms, p95 |err| ${fmt(t.p95AbsErrorMs)} ms`,
);
if (allChordsExp.length) {
  const c = scoreChords(allChordsDet, allChordsExp, TOLERANCE_SEC);
  console.log(`CHORDS: ${c.correct}/${c.matched} correct (${pct(c.accuracy)}), ${c.unsure} unsure, ${c.wrong} wrong; confusions ${JSON.stringify(c.confusions)}`);
}
