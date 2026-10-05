import { describe, expect, it } from 'vitest';
import { checkEnvironment, classifyMicError } from '../src/audio/errors';

const domErr = (name: string, message = 'x') => Object.assign(new Error(message), { name });

describe('classifyMicError', () => {
  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'no-microphone'],
    ['OverconstrainedError', 'no-microphone'],
    ['NotReadableError', 'mic-busy'],
    ['TypeError', 'unknown'],
  ])('%s -> %s', (name, kind) => {
    const e = classifyMicError(domErr(name, 'boom'));
    expect(e.kind).toBe(kind);
    expect(e.title.length).toBeGreaterThan(0);
    expect(e.help.length).toBeGreaterThan(0);
    expect(e.detail).toBe(`${name}: boom`);
  });

  it('handles non-Error values', () => {
    expect(classifyMicError('weird').kind).toBe('unknown');
    expect(classifyMicError(null).kind).toBe('unknown');
  });
});

describe('checkEnvironment', () => {
  const ok = { isSecureContext: true, hasGetUserMedia: true, hasAudioWorklet: true };
  it('passes a capable secure browser', () => {
    expect(checkEnvironment(ok)).toBeNull();
  });
  it('flags insecure pages first', () => {
    expect(checkEnvironment({ ...ok, isSecureContext: false, hasGetUserMedia: false })?.kind).toBe('insecure-context');
  });
  it('flags missing APIs', () => {
    expect(checkEnvironment({ ...ok, hasGetUserMedia: false })?.kind).toBe('unsupported');
    expect(checkEnvironment({ ...ok, hasAudioWorklet: false })?.kind).toBe('unsupported');
  });
});
