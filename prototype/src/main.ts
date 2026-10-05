import './style.css';
import { analysisConfig, levelConfig, noiseFloorConfig } from './detection/config';
import { initialMeterState, rms, toDbfs, updateMeter, type MeterState } from './detection/level';
import { isNoisyRoom, NoiseFloorEstimator } from './detection/noiseFloor';
import { MicSession } from './audio/mic';
import { classifyMicError, type MicError } from './audio/errors';
import type { LevelMessage } from './audio/messages';
import { createMeterView } from './ui/meter';
import { buildDeviceReport, reportToText, type ReportInput, type ReportRow } from './ui/deviceReport';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const ui = {
  start: $<HTMLButtonElement>('start'),
  resume: $<HTMLButtonElement>('resume'),
  status: $('status'),
  error: $('error'),
  errorTitle: $('error-title'),
  errorHelp: $('error-help'),
  errorDetail: $('error-detail'),
  info: $<HTMLTableElement>('info'),
  copy: $<HTMLButtonElement>('copy'),
  build: $('build'),
  roomHint: $('room-hint'),
  remeasure: $<HTMLButtonElement>('remeasure'),
};

const meterView = createMeterView({
  fill: $('meter-fill'),
  roomFill: $('meter-room-fill'),
  roomZone: $('meter-room-zone'),
  floorMark: $('meter-floor'),
  chip: $('chip'),
  roomDb: $('room-db'),
  aboveDb: $('above-db'),
  peak: $('meter-peak'),
  db: $('db'),
  peakDb: $('peak-db'),
  clip: $('clip'),
  scale: $('scale'),
});

const BUILD = `v0.1.1 · ${__BUILD_ID__} · ${__BUILD_TIME__}`;
ui.build.textContent = BUILD;

// ---- state ----
let session: MicSession | null = null;
let meter: MeterState = initialMeterState(levelConfig.meterFloorDb);
let pending: LevelMessage[] = [];
let lastFrameMs = performance.now();
let lastBlockAtMs = 0;
let framesProcessed = 0;
let blocksReceived = 0;
let emptyQuanta = 0;
let lastInfoRenderMs = 0;
const noiseFloor = new NoiseFloorEstimator(noiseFloorConfig);

// ---- worklet messages: queue, consumed by the animation loop ----
function onWorkletMessage(msg: LevelMessage): void {
  pending.push(msg);
  // Noise floor works per block (not per animation frame), on the high-passed signal.
  if (session && msg.count > 0) {
    const blockDb = toDbfs(Math.sqrt(msg.sumSquares / msg.count), noiseFloorConfig.minDb);
    const wasMeasuring = noiseFloor.state === 'measuring';
    noiseFloor.addBlock(blockDb, (msg.count / session.ctx.sampleRate) * 1000);
    if (wasMeasuring && noiseFloor.initialFloorDb !== null) onQuietMeasured();
  }
  framesProcessed = msg.framesProcessed;
  emptyQuanta = msg.emptyQuanta;
  blocksReceived++;
  lastBlockAtMs = performance.now();
}

function isStalled(now: number): boolean {
  return !!session && session.ctx.state === 'running' && now - lastBlockAtMs > levelConfig.stallWarningMs;
}

function frame(now: number): void {
  let input: { rmsDb: number; peakDb: number; clipped: boolean } | null = null;
  if (pending.length > 0) {
    // Merge all blocks that arrived since the last animation frame.
    let sumSquares = 0, count = 0, peak = 0, clips = 0;
    for (const m of pending) {
      sumSquares += m.sumSquares;
      count += m.count;
      peak = Math.max(peak, m.peak);
      clips += m.clipCount;
    }
    pending = [];
    const floor = levelConfig.meterFloorDb;
    input = {
      // Analysis (high-passed) level and peak; clips are counted on the raw signal.
      rmsDb: toDbfs(rms({ sumSquares, count, peak, clipCount: clips }), floor),
      peakDb: toDbfs(peak, floor),
      clipped: clips > 0,
    };
  }
  meter = updateMeter(meter, input, now, lastFrameMs, levelConfig);
  lastFrameMs = now;
  meterView.render(meter, now, !!session, {
    floorDb: noiseFloor.floorDb,
    measuring: !!session && noiseFloor.state === 'measuring',
    remainingMs: noiseFloor.remainingMs,
  });

  if (now - lastInfoRenderMs > 500) {
    lastInfoRenderMs = now;
    renderInfo(now);
  }
  requestAnimationFrame(frame);
}

// ---- device info ----
function reportInput(now: number): ReportInput {
  const uaData = (navigator as Navigator & {
    userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string; mobile?: boolean };
  }).userAgentData;
  const input: ReportInput = {
    userAgent: navigator.userAgent,
    uaBrands: uaData?.brands
      ?.filter((b) => !/not.?a.?brand/i.test(b.brand))
      .map((b) => `${b.brand} ${b.version}`)
      .join(', '),
    uaPlatform: uaData?.platform,
    uaMobile: uaData?.mobile,
    isSecureContext: window.isSecureContext,
    buildId: BUILD,
    highPassHz: analysisConfig.highPassHz,
    highPassStages: analysisConfig.highPassStages,
  };
  if (session) {
    const info = session.info();
    input.mic = {
      ...info,
      settings: info.settings as Record<string, unknown>,
      supportedConstraints: info.supportedConstraints as Record<string, unknown>,
    };
    input.framesProcessed = framesProcessed;
    input.blocksReceived = blocksReceived;
    input.emptyQuanta = emptyQuanta;
    input.stalled = isStalled(now);
    input.noiseFloor = {
      phase: noiseFloor.state,
      currentDb: noiseFloor.floorDb,
      initialDb: noiseFloor.initialFloorDb,
      noisy: isNoisyRoom(noiseFloor.initialFloorDb, noiseFloorConfig.noisyRoomDb),
    };
  }
  return input;
}

function renderInfo(now: number): void {
  const rows = buildDeviceReport(reportInput(now));
  ui.info.replaceChildren(...rows.map(rowEl));
  updateResumeButton();
}

function rowEl(r: ReportRow): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = r.status;
  const a = document.createElement('td');
  a.textContent = r.label;
  const b = document.createElement('td');
  b.textContent = r.value;
  if (r.note) {
    const n = document.createElement('span');
    n.className = 'note';
    n.textContent = r.note;
    b.appendChild(n);
  }
  tr.append(a, b);
  return tr;
}

// ---- errors / status ----
function showError(e: MicError | null): void {
  ui.error.hidden = !e;
  if (!e) return;
  ui.errorTitle.textContent = e.title;
  ui.errorHelp.textContent = e.help;
  ui.errorDetail.textContent = e.detail;
}

function toMicError(err: unknown): MicError {
  return typeof err === 'object' && err !== null && 'kind' in err && 'help' in err ? (err as MicError) : classifyMicError(err);
}

function updateResumeButton(): void {
  const needs = !!session && session.needsResume();
  ui.resume.hidden = !needs;
  if (session) {
    ui.status.textContent = needs
      ? 'Audio paused (screen locked or app switched). Tap to resume.'
      : noiseFloor.state === 'measuring'
        ? 'Measuring your room. Stay quiet and keep the guitar still.'
        : 'Listening. Strum your guitar.';
  }
}

// ---- noise floor ----
function onQuietMeasured(): void {
  const initial = noiseFloor.initialFloorDb;
  ui.roomHint.hidden = !isNoisyRoom(initial, noiseFloorConfig.noisyRoomDb);
  ui.remeasure.hidden = false;
  console.info('[room] noise floor measured', initial?.toFixed(1), 'dBFS');
  updateResumeButton();
  renderInfo(performance.now());
}

function startQuietMeasurement(): void {
  noiseFloor.restart();
  ui.roomHint.hidden = true;
  ui.remeasure.hidden = true;
  updateResumeButton();
}

// ---- buttons ----
ui.start.addEventListener('click', async () => {
  if (session) return;
  ui.start.disabled = true;
  ui.status.textContent = 'Starting microphone...';
  showError(null);
  try {
    session = await MicSession.start(
      {
        blockSizeFrames: levelConfig.blockSizeFrames,
        clipThreshold: levelConfig.clipThreshold,
        highPassHz: analysisConfig.highPassHz,
        highPassStages: analysisConfig.highPassStages,
      },
      { onMessage: onWorkletMessage, onChange: () => renderInfo(performance.now()) },
    );
    lastBlockAtMs = performance.now();
    ui.start.hidden = true;
    startQuietMeasurement();
    updateResumeButton();
    renderInfo(performance.now());
    console.info('[mic] started', session.info());
  } catch (err) {
    const e = toMicError(err);
    console.warn('[mic] start failed', e);
    showError(e);
    ui.status.textContent = 'Could not start. See the message below.';
    ui.start.disabled = false;
  }
});

ui.resume.addEventListener('click', async () => {
  if (!session) return;
  try {
    await session.resume();
    showError(null);
  } catch (err) {
    showError(toMicError(err));
  }
  updateResumeButton();
});

ui.remeasure.addEventListener('click', () => {
  if (session) startQuietMeasurement();
});

ui.copy.addEventListener('click', async () => {
  const text = reportToText(buildDeviceReport(reportInput(performance.now())));
  try {
    await navigator.clipboard.writeText(text);
    ui.copy.textContent = 'Copied';
  } catch {
    ui.copy.textContent = 'Copy failed';
  }
  setTimeout(() => (ui.copy.textContent = 'Copy info'), 1500);
});

renderInfo(performance.now());
requestAnimationFrame(frame);

// Debug handle for the developer (browser console / automated smoke tests).
(window as unknown as { __micDebug: unknown }).__micDebug = {
  get session() {
    return session;
  },
  get noiseFloor() {
    return noiseFloor;
  },
};
