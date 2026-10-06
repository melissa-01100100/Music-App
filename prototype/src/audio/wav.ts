/**
 * WAV encode/decode. Pure (no DOM, no Web Audio): used by the recorder in the browser,
 * by tests, and by tools/evaluate.ts in Node.
 */

/** Float samples in [-1, 1] to 16-bit PCM (clipped, rounded). */
export function floatTo16(x: number): number {
  const c = x > 1 ? 1 : x < -1 ? -1 : x;
  return c < 0 ? Math.round(c * 0x8000) : Math.round(c * 0x7fff);
}

/**
 * Encodes mono float samples (one array or a list of chunks) as a 16-bit PCM WAV file.
 * Returns the complete file bytes.
 */
export function encodeWav16(chunks: Float32Array | readonly Float32Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  const list = chunks instanceof Float32Array ? [chunks] : chunks;
  const frames = list.reduce((n, c) => n + c.length, 0);
  const dataBytes = frames * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  let off = 44;
  for (const c of list) {
    for (let i = 0; i < c.length; i++, off += 2) v.setInt16(off, floatTo16(c[i]), true);
  }
  return new Uint8Array(buf);
}

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** First channel as floats in [-1, 1]. */
  samples: Float32Array;
}

/** Decodes PCM 16/24/32-bit integer and 32-bit float WAV files (incl. WAVE_FORMAT_EXTENSIBLE). */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) => String.fromCharCode(...bytes.subarray(off, off + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = v.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true); // extensible: sub-format GUID
      fmt = { format, channels: v.getUint16(body + 2, true), sampleRate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before fmt chunk');
      const len = Math.min(size, bytes.length - body);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, samples: readSamples(v, body, len, fmt) };
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

function readSamples(v: DataView, start: number, len: number, f: { format: number; channels: number; bits: number }): Float32Array {
  const bytesPer = f.bits / 8;
  const frameBytes = bytesPer * f.channels;
  const frames = Math.floor(len / frameBytes);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const p = start + i * frameBytes;
    if (f.format === 3 && f.bits === 32) out[i] = v.getFloat32(p, true);
    else if (f.format === 1 && f.bits === 16) out[i] = v.getInt16(p, true) / 0x8000;
    else if (f.format === 1 && f.bits === 24) {
      const x = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16);
      out[i] = x / 0x800000;
    } else if (f.format === 1 && f.bits === 32) out[i] = v.getInt32(p, true) / 0x80000000;
    else throw new Error(`Unsupported WAV format ${f.format} / ${f.bits}-bit`);
  }
  return out;
}
