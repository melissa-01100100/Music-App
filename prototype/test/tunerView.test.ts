import { describe, expect, it } from 'vitest';
import { buildDeviceReport } from '../src/ui/deviceReport';
import { formatCents, needlePercent, tunerHint, tunerSummary } from '../src/ui/tunerView';
import { STANDARD_TUNING, type TunerDisplay } from '../src/detection/tuner';

const disp = (cents: number, direction: TunerDisplay['direction']): TunerDisplay => ({
  string: STANDARD_TUNING[0],
  targetHz: 82.41,
  hz: 82.41,
  cents,
  needleCents: Math.max(-50, Math.min(50, cents)),
  inTune: direction === 'ok',
  direction,
  held: false,
});

describe('tuner view helpers', () => {
  it('formats cents with a sign', () => {
    expect(formatCents(12.4)).toBe('+12 cents');
    expect(formatCents(-3.2)).toBe('−3 cents');
    expect(formatCents(0.3)).toBe('0 cents');
    expect(formatCents(-0.4)).toBe('0 cents');
  });
  it('needle position', () => {
    expect(needlePercent(0, 50)).toBe(50);
    expect(needlePercent(-50, 50)).toBe(0);
    expect(needlePercent(25, 50)).toBe(75);
    expect(needlePercent(400, 50)).toBe(100);
  });
  it('hints', () => {
    expect(tunerHint(null, 'off').text).toBe('Tap Start');
    expect(tunerHint(disp(3, 'ok'), 'measuring').text).toBe('Stay quiet…');
    expect(tunerHint(null, 'listening').text).toBe('Pluck one string');
    expect(tunerHint(disp(-20, 'up'), 'listening')).toMatchObject({ text: 'Tune up ↑', kind: 'up' });
    expect(tunerHint(disp(20, 'down'), 'listening')).toMatchObject({ text: 'Tune down ↓', kind: 'down' });
    expect(tunerHint(disp(1, 'ok'), 'listening')).toMatchObject({ text: 'In tune ✓', kind: 'ok' });
  });
  it('summary for Copy info', () => {
    const s = tunerSummary(
      440,
      (n) => (n === 6 ? { cents: -3.4, hz: 82.2, atMs: 0, inTuneAtMs: 0 } : n === 5 ? { cents: 12.2, hz: 110.8, atMs: 0, inTuneAtMs: null } : undefined),
      (n) => n === 6,
    );
    expect(s).toBe('A4 = 440 Hz · last reading per string: E2 −3c ✓ · A2 +12c · D3 – · G3 – · B3 – · E4 –');
    const rows = buildDeviceReport({ userAgent: 'x', isSecureContext: true, buildId: 'b', tunerSummary: s });
    expect(rows.find((r) => r.label === 'Tuner')?.value).toBe(s);
  });
});
