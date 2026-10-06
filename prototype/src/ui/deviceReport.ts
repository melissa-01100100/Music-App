/**
 * Builds the rows of the "Device info" panel. Pure (data in, rows out) so it is unit tested;
 * the DOM rendering lives in main.ts.
 */

export type RowStatus = 'ok' | 'warn' | 'bad' | 'info';

export interface ReportRow {
  label: string;
  value: string;
  status: RowStatus;
  /** Short explanation shown when status is warn/bad. */
  note?: string;
}

export interface ReportInput {
  userAgent: string;
  /** From navigator.userAgentData (Chrome only), if available. */
  uaBrands?: string;
  uaPlatform?: string;
  uaMobile?: boolean;
  /** From userAgentData.getHighEntropyValues (Chrome only), e.g. "Pixel 10". */
  uaModel?: string;
  uaPlatformVersion?: string;
  isSecureContext: boolean;
  buildId: string;
  /** Present once the mic has started. */
  mic?: {
    contextState: string;
    sampleRate: number;
    baseLatencySec?: number;
    outputLatencySec?: number;
    trackLabel: string;
    trackReadyState: string;
    trackMuted: boolean;
    settings: Record<string, unknown>;
    supportedConstraints: Record<string, unknown>;
    wakeLock: string;
  };
  framesProcessed?: number;
  blocksReceived?: number;
  emptyQuanta?: number;
  stalled?: boolean;
  /** Analysis-path high-pass cutoff in Hz (the raw signal is not filtered). */
  highPassHz?: number;
  /** Cascaded 2nd-order sections (order = 2 x stages). */
  highPassStages?: number;
  /** One-line summary of the strum detector settings. */
  onsetSummary?: string;
  /** Tuner: reference pitch and last reading per string (0.2.1). */
  tunerSummary?: string;
  /** Room noise floor (present once the mic has started). */
  noiseFloor?: {
    phase: 'measuring' | 'tracking';
    /** Current (tracked) floor in dBFS, null while measuring. */
    currentDb: number | null;
    /** Floor from the "stay quiet" measurement, null while measuring. */
    initialDb: number | null;
    /** Initial floor is above the "noisy room" threshold. */
    noisy: boolean;
  };
}

const PROCESSING_KEYS = ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const;

export function formatMs(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) return 'not reported';
  return `${(sec * 1000).toFixed(1)} ms`;
}

/** Row for a voice-processing setting that must be OFF for guitar. */
export function processingRow(key: string, settings: Record<string, unknown>, supported: Record<string, unknown>): ReportRow {
  const v = settings[key];
  if (v === false) return { label: key, value: 'off', status: 'ok' };
  if (v === true) {
    return { label: key, value: 'ON', status: 'bad', note: 'Still on: the browser is altering the guitar sound.' };
  }
  const sup = supported[key] === true ? 'supported but not reported' : 'not reported';
  return { label: key, value: sup, status: 'warn', note: 'Cannot confirm it is off on this device.' };
}

/** "2nd-order", "4th-order", ... for N cascaded 2nd-order sections. */
export function filterOrder(stages: number): string {
  const order = 2 * stages;
  return `${order}${order === 2 ? 'nd' : 'th'}-order`;
}

export function formatDbfs(db: number | null): string {
  return db === null || !Number.isFinite(db) ? 'n/a' : `${db.toFixed(1)} dBFS`;
}

/** Row describing the room noise floor. */
export function noiseFloorRow(nf: NonNullable<ReportInput['noiseFloor']>): ReportRow {
  if (nf.phase === 'measuring') return { label: 'Room noise floor', value: 'measuring...', status: 'info' };
  return {
    label: 'Room noise floor',
    value: `${formatDbfs(nf.currentDb)} now, ${formatDbfs(nf.initialDb)} at start`,
    status: nf.noisy ? 'warn' : 'ok',
    note: nf.noisy ? 'Noisy room: try a quieter spot, away from fans/TV.' : undefined,
  };
}

export function buildDeviceReport(input: ReportInput): ReportRow[] {
  const rows: ReportRow[] = [];
  rows.push({ label: 'Build', value: input.buildId, status: 'info' });
  if (input.uaBrands) rows.push({ label: 'Browser', value: input.uaBrands, status: 'info' });
  if (input.uaPlatform !== undefined) {
    rows.push({ label: 'Platform', value: `${input.uaPlatform}${input.uaMobile ? ' (mobile)' : ''}`, status: 'info' });
  }
  if (input.uaModel) rows.push({ label: 'Device model', value: input.uaModel, status: 'info' });
  rows.push({ label: 'User agent', value: input.userAgent, status: 'info' });
  rows.push({
    label: 'Secure page (HTTPS)',
    value: input.isSecureContext ? 'yes' : 'NO',
    status: input.isSecureContext ? 'ok' : 'bad',
    note: input.isSecureContext ? undefined : 'The microphone needs an https:// link.',
  });

  if (input.highPassHz !== undefined) {
    rows.push({ label: 'Analysis high-pass', value: `${input.highPassHz} Hz (${filterOrder(input.highPassStages ?? 1)}, meter/detection only)`, status: 'info' });
  }

  if (input.onsetSummary) rows.push({ label: 'Strum detector', value: input.onsetSummary, status: 'info' });
  if (input.tunerSummary) rows.push({ label: 'Tuner', value: input.tunerSummary, status: 'info' });

  const mic = input.mic;
  if (!mic) {
    rows.push({ label: 'Microphone', value: 'not started (tap Start)', status: 'info' });
    return rows;
  }

  rows.push({
    label: 'Audio state',
    value: mic.contextState,
    status: mic.contextState === 'running' ? 'ok' : 'bad',
    note: mic.contextState === 'running' ? undefined : 'Audio is paused. Tap "Tap to resume".',
  });
  rows.push({ label: 'Sample rate', value: `${mic.sampleRate} Hz`, status: 'info' });
  rows.push({ label: 'Base latency', value: formatMs(mic.baseLatencySec), status: 'info' });
  rows.push({ label: 'Output latency', value: formatMs(mic.outputLatencySec), status: 'info' });
  rows.push({ label: 'Mic', value: mic.trackLabel || '(no label)', status: 'info' });
  rows.push({
    label: 'Mic track',
    value: `${mic.trackReadyState}${mic.trackMuted ? ', muted' : ''}`,
    status: mic.trackReadyState === 'live' && !mic.trackMuted ? 'ok' : 'bad',
    note: mic.trackReadyState === 'live' && !mic.trackMuted ? undefined : 'The phone is not delivering mic audio right now.',
  });

  for (const key of PROCESSING_KEYS) rows.push(processingRow(key, mic.settings, mic.supportedConstraints));

  const cc = mic.settings.channelCount;
  rows.push({ label: 'channelCount', value: cc === undefined ? 'not reported' : String(cc), status: 'info' });
  const trackRate = mic.settings.sampleRate;
  if (trackRate !== undefined) rows.push({ label: 'Mic sample rate', value: `${String(trackRate)} Hz`, status: 'info' });
  const lat = mic.settings.latency;
  if (typeof lat === 'number') rows.push({ label: 'Mic latency (reported)', value: formatMs(lat), status: 'info' });

  if (input.noiseFloor) rows.push(noiseFloorRow(input.noiseFloor));

  rows.push({
    label: 'Screen wake lock',
    value: mic.wakeLock,
    status: mic.wakeLock === 'active' ? 'ok' : 'warn',
    note: mic.wakeLock === 'active' ? undefined : 'The screen may turn off during a test.',
  });

  if (input.framesProcessed !== undefined) {
    rows.push({
      label: 'Frames processed',
      value: input.framesProcessed.toLocaleString('en-US'),
      status: input.stalled ? 'bad' : 'ok',
      note: input.stalled ? 'Audio has stopped arriving.' : undefined,
    });
  }
  if (input.blocksReceived !== undefined) rows.push({ label: 'Blocks received', value: String(input.blocksReceived), status: 'info' });
  if (input.emptyQuanta) rows.push({ label: 'Empty input quanta', value: String(input.emptyQuanta), status: 'warn' });

  return rows;
}

/** Plain-text version for the "Copy info" button. */
export function reportToText(rows: ReportRow[]): string {
  return rows.map((r) => `${r.label}: ${r.value}${r.status === 'bad' || r.status === 'warn' ? ` [${r.status}]` : ''}`).join('\n');
}

/** Short device description for exports, e.g. "Pixel 10, Android 16, Google Chrome 141". */
export function shortDeviceName(input: Pick<ReportInput, 'uaModel' | 'uaPlatform' | 'uaPlatformVersion' | 'uaBrands' | 'userAgent'>): string {
  const parts: string[] = [];
  if (input.uaModel) parts.push(input.uaModel);
  if (input.uaPlatform) parts.push(input.uaPlatformVersion ? `${input.uaPlatform} ${input.uaPlatformVersion.split('.')[0]}` : input.uaPlatform);
  if (input.uaBrands) {
    const brand = input.uaBrands.split(', ').find((b) => !/^Chromium /.test(b)) ?? input.uaBrands.split(', ')[0];
    if (brand) parts.push(brand.replace(/(\d+)\..*$/, '$1'));
  }
  return parts.length ? parts.join(', ') : input.userAgent;
}

/** Rows as a plain object (label -> value) for JSON exports. */
export function reportToObject(rows: ReportRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) out[r.label] = r.value;
  return out;
}
