import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav16, floatTo16 } from '../src/audio/wav';
import { scoreOnsets } from '../src/detection/evaluate';
import { noise, sine, SR } from './signals';

describe('WAV encoder', () => {
  it('writes a valid 16-bit mono PCM header', () => {
    const bytes = encodeWav16(new Float32Array(100), 48000);
    const v = new DataView(bytes.buffer);
    const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
    expect(bytes.length).toBe(44 + 200);
    expect(tag(0)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(bytes.length - 8);
    expect(tag(8)).toBe('WAVE');
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(96000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(tag(36)).toBe('data');
    expect(v.getUint32(40, true)).toBe(200);
  });

  it('round-trips samples within 16-bit precision, from chunks', () => {
    const x = Float32Array.from([...sine(0.5, 3000, 440), ...noise(0.2, 2000, 3)]);
    const chunks = [x.subarray(0, 1234), x.subarray(1234, 4096), x.subarray(4096)];
    const d = decodeWav(encodeWav16(chunks, SR));
    expect(d.sampleRate).toBe(SR);
    expect(d.channels).toBe(1);
    expect(d.bitsPerSample).toBe(16);
    expect(d.samples.length).toBe(x.length);
    let maxErr = 0;
    for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(d.samples[i] - x[i]));
    expect(maxErr).toBeLessThan(1 / 32768 + 1e-6);
  });

  it('clips out-of-range samples instead of wrapping', () => {
    expect(floatTo16(1.5)).toBe(32767);
    expect(floatTo16(-1.5)).toBe(-32768);
    expect(floatTo16(0)).toBe(0);
    const d = decodeWav(encodeWav16(Float32Array.from([2, -2]), 44100));
    expect(d.samples[0]).toBeCloseTo(1, 3);
    expect(d.samples[1]).toBe(-1);
  });

  it('rejects files that are not WAV', () => {
    expect(() => decodeWav(new Uint8Array(50))).toThrow();
  });
});

describe('onset scoring', () => {
  it('counts hits, misses, doubles and timing error', () => {
    const s = scoreOnsets([1.002, 1.03, 2.0, 5.0], [1.0, 2.004, 3.0], 0.05);
    expect(s.truePositives).toBe(2);
    expect(s.missed).toBe(1);
    expect(s.falsePositives).toBe(2); // the double at 1.03 and the extra at 5.0
    expect(s.recall).toBeCloseTo(2 / 3);
    expect(s.precision).toBeCloseTo(0.5);
    expect(s.errorsMs[0]).toBeCloseTo(2);
    expect(s.errorsMs[1]).toBeCloseTo(-4);
    expect(s.maxAbsErrorMs).toBeCloseTo(4);
  });

  it('handles empty inputs', () => {
    const s = scoreOnsets([], []);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.meanErrorMs).toBeNaN();
  });
});
