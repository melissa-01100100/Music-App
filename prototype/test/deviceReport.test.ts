import { describe, expect, it } from 'vitest';
import { buildDeviceReport, formatMs, processingRow, reportToText, type ReportInput } from '../src/ui/deviceReport';

const base: ReportInput = { userAgent: 'UA', isSecureContext: true, buildId: 'v0.1' };

const mic = (settings: Record<string, unknown>): ReportInput['mic'] => ({
  contextState: 'running',
  sampleRate: 48000,
  baseLatencySec: 0.01,
  outputLatencySec: undefined,
  trackLabel: 'Default',
  trackReadyState: 'live',
  trackMuted: false,
  settings,
  supportedConstraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  wakeLock: 'active',
});

const find = (rows: ReturnType<typeof buildDeviceReport>, label: string) => rows.find((r) => r.label === label);

describe('processingRow', () => {
  it('off is ok, on is bad, missing is warn', () => {
    expect(processingRow('echoCancellation', { echoCancellation: false }, {}).status).toBe('ok');
    expect(processingRow('echoCancellation', { echoCancellation: true }, {}).status).toBe('bad');
    const missing = processingRow('autoGainControl', {}, { autoGainControl: true });
    expect(missing.status).toBe('warn');
    expect(missing.value).toContain('supported');
  });
});

describe('buildDeviceReport', () => {
  it('before start: secure page ok, mic not started', () => {
    const rows = buildDeviceReport(base);
    expect(find(rows, 'Secure page (HTTPS)')?.status).toBe('ok');
    expect(find(rows, 'Microphone')?.value).toContain('not started');
  });

  it('flags insecure context in red', () => {
    expect(find(buildDeviceReport({ ...base, isSecureContext: false }), 'Secure page (HTTPS)')?.status).toBe('bad');
  });

  it('flags processing that is still on in red', () => {
    const rows = buildDeviceReport({
      ...base,
      mic: mic({ echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 }),
    });
    expect(find(rows, 'echoCancellation')?.status).toBe('bad');
    expect(find(rows, 'noiseSuppression')?.status).toBe('ok');
    expect(find(rows, 'Sample rate')?.value).toBe('48000 Hz');
    expect(find(rows, 'Base latency')?.value).toBe('10.0 ms');
    expect(find(rows, 'Output latency')?.value).toBe('not reported');
  });

  it('flags a suspended context and a stall', () => {
    const m = mic({});
    m!.contextState = 'suspended';
    const rows = buildDeviceReport({ ...base, mic: m, framesProcessed: 1000, blocksReceived: 1, stalled: true });
    expect(find(rows, 'Audio state')?.status).toBe('bad');
    expect(find(rows, 'Frames processed')?.status).toBe('bad');
  });

  it('text export marks problems', () => {
    const text = reportToText(buildDeviceReport({ ...base, mic: mic({ echoCancellation: true }) }));
    expect(text).toContain('echoCancellation: ON [bad]');
  });
});

describe('formatMs', () => {
  it('formats seconds as ms', () => {
    expect(formatMs(0.0213)).toBe('21.3 ms');
    expect(formatMs(undefined)).toBe('not reported');
  });
});
