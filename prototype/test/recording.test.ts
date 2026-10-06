import { describe, expect, it } from 'vitest';
import { buildRecordingJson, fileStamp, formatClock, RecordingBuffer } from '../src/audio/recording';
import { decodeWav, encodeWav16 } from '../src/audio/wav';
import type { OnsetEvent } from '../src/detection/onset';
import { onsetConfig } from '../src/detection/config';
import { clampToSpec, formatSetting, SLIDERS } from '../src/ui/devSettings';
import { pickShareSet } from '../src/ui/share';
import { formatConfidence, formatScores, formatStrumRow } from '../src/ui/strumView';
import { shortDeviceName } from '../src/ui/deviceReport';

const ev = (sampleIndex: number, strength = 1, levelDb = -20): OnsetEvent => ({ sampleIndex, timeSec: sampleIndex / 48000, strength, levelDb });

describe('RecordingBuffer', () => {
  it('collects chunks, stops at the maximum length and keeps the stream start frame', () => {
    const r = new RecordingBuffer(48000, 10000);
    expect(r.add(new Float32Array(4096).fill(0.1), 96000)).toBe(false);
    expect(r.add(new Float32Array(4096).fill(0.2), 96000 + 4096)).toBe(false);
    expect(r.add(new Float32Array(4096).fill(0.3), 96000 + 8192)).toBe(true);
    expect(r.add(new Float32Array(4096), 96000 + 12288)).toBe(true);
    expect(r.frames).toBe(10000);
    expect(r.startFrame).toBe(96000);
    expect(r.endFrame).toBe(106000);
    const wav = decodeWav(encodeWav16(r.chunks, r.sampleRate));
    expect(wav.samples.length).toBe(10000);
    expect(wav.samples[9999]).toBeCloseTo(0.3, 3);
  });

  it('puts only strums inside the recording into the JSON, timed from the WAV start', () => {
    const r = new RecordingBuffer(48000, 48000 * 10);
    r.add(new Float32Array(48000), 48000); // recording covers stream frames 48000..96000
    const events = [ev(1000), ev(48000), ev(60000, 0.876543, -18.26), ev(96000)];
    const json = buildRecordingJson(r, events, {
      build: 'v0.2 · test',
      device: 'Pixel 10, Android 16, Chrome 141',
      deviceInfo: { 'Sample rate': '48000 Hz' },
      recordedAt: new Date('2026-10-05T12:00:00Z'),
      noiseFloorDbAtStart: -52.34,
      noiseFloorDbAtEnd: null,
      config: { onset: onsetConfig },
    });
    expect(json.sampleRate).toBe(48000);
    expect(json.durationSec).toBe(1);
    expect(json.noiseFloorDb).toBe(-52.3);
    expect(json.events).toEqual([
      { timeSec: 0, strength: 1, levelDb: -20, sampleIndex: 0 },
      { timeSec: 0.25, strength: 0.8765, levelDb: -18.3, sampleIndex: 12000 },
    ]);
    // Survives a JSON round trip (what tools/evaluate.ts reads).
    expect(JSON.parse(JSON.stringify(json)).events[1].timeSec).toBe(0.25);
  });

  it('exports the chord, confidence and scores of each strum (0.3, formatVersion 2)', () => {
    const r = new RecordingBuffer(48000, 48000 * 10);
    r.add(new Float32Array(48000), 0);
    const chord = { chord: 'C', best: 'C', confidence: 0.81234, scores: { Am: 0.71111, C: 0.93333, G: 0.3, D: 0.2 } };
    const json = buildRecordingJson(r, [{ ...ev(24000), chord }, { ...ev(36000), chord: { ...chord, chord: '?' } }], {
      build: 'v0.3 · test', device: 'SM-S9210', deviceInfo: {}, recordedAt: new Date(0),
      noiseFloorDbAtStart: null, noiseFloorDbAtEnd: null, config: {},
    });
    expect(json.formatVersion).toBe(2);
    expect(json.events[0]).toMatchObject({ chord: 'C', chordBest: 'C', confidence: 0.812, scores: { Am: 0.711, C: 0.933 } });
    expect(json.events[1].chord).toBe('?');
  });
});

describe('export helpers', () => {
  it('file stamps and clock', () => {
    expect(fileStamp(new Date(2026, 9, 5, 9, 3, 7))).toBe('2026-10-05_09-03-07');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65.9)).toBe('1:05');
    expect(formatClock(120)).toBe('2:00');
  });

  it('share picks the first file set the browser accepts (JSON is not shareable on Android)', () => {
    const can = (files: string[]) => files.every((f) => f.endsWith('.wav') || f.endsWith('.txt'));
    expect(pickShareSet([['a.wav', 'a.json'], ['a.wav', 'a.json.txt'], ['a.wav']], can)).toEqual(['a.wav', 'a.json.txt']);
    expect(pickShareSet([['a.json']], can)).toBeNull();
    expect(
      pickShareSet([['x'], ['a.wav']], (f) => {
        if (f[0] === 'x') throw new TypeError('nope');
        return true;
      }),
    ).toEqual(['a.wav']);
  });

  it('short device name', () => {
    expect(
      shortDeviceName({ uaModel: 'Pixel 10', uaPlatform: 'Android', uaPlatformVersion: '16.0.0', uaBrands: 'Chromium 141, Google Chrome 141', userAgent: 'x' }),
    ).toBe('Pixel 10, Android 16, Google Chrome 141');
    expect(shortDeviceName({ userAgent: 'Mozilla/5.0' })).toBe('Mozilla/5.0');
  });
});

describe('strum log and developer sliders', () => {
  it('formats a log row', () => {
    expect(formatStrumRow({ timeSec: 12.3456, strength: 0.8765, aboveRoomDb: 23.6 })).toEqual(['12.346 s', '', 'strength 0.88', '+24 dB']);
    expect(formatStrumRow({ timeSec: 1, strength: 1, aboveRoomDb: null })[3]).toBe('room ?');
    expect(formatStrumRow({ timeSec: 1, strength: 1, aboveRoomDb: 5, chord: 'G', confidence: 0.876 })[1]).toBe('G 88%');
    expect(formatStrumRow({ timeSec: 1, strength: 1, aboveRoomDb: 5, chord: '?', confidence: 0.2 })[1]).toBe('?');
    expect(formatScores({ Am: 0.1234, C: 0.9 })).toBe('Am 0.12 · C 0.90');
    expect(formatConfidence(1.4)).toBe('100%');
  });

  it('defaults sit inside the slider ranges, and values are clamped to the grid', () => {
    for (const spec of SLIDERS) {
      const d = onsetConfig[spec.key];
      expect(d).toBeGreaterThanOrEqual(spec.min);
      expect(d).toBeLessThanOrEqual(spec.max);
      expect(clampToSpec(spec, d)).toBeCloseTo(d, 9);
    }
    const gap = SLIDERS.find((s) => s.key === 'minInterOnsetMs')!;
    expect(clampToSpec(gap, 1000)).toBe(gap.max);
    expect(clampToSpec(gap, 72)).toBe(70);
    expect(formatSetting(gap, 70)).toBe('70 ms');
    // Down-up strumming at 120 BPM sixteenths (125 ms) must be possible with the default.
    expect(onsetConfig.minInterOnsetMs).toBeLessThan(120);
  });
});
