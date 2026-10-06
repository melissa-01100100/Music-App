import './style.css';
import {
  analysisConfig,
  chordConfig,
  levelConfig,
  noiseFloorConfig,
  onsetConfig,
  pitchConfig,
  recordingConfig,
  tunerConfig,
  type LiveOnsetSettings,
  type OnsetConfig,
} from './detection/config';
import { initialMeterState, rms, toDbfs, updateMeter, type MeterState } from './detection/level';
import { isNoisyRoom, NoiseFloorEstimator } from './detection/noiseFloor';
import { ChordClassifier } from './detection/classifier';
import { PitchTracker, type PitchFrame } from './detection/pitch';
import { TunerSmoother } from './detection/tuner';
import { MicSession } from './audio/mic';
import { classifyMicError, type MicError } from './audio/errors';
import type { LevelMessage, OnsetMessage, WorkletMessage } from './audio/messages';
import { buildRecordingJson, fileStamp, formatClock, RecordingBuffer, type StrumRecord } from './audio/recording';
import { encodeWav16 } from './audio/wav';
import { createMeterView } from './ui/meter';
import {
  buildDeviceReport,
  reportToObject,
  reportToText,
  shortDeviceName,
  type ReportInput,
  type ReportRow,
} from './ui/deviceReport';
import { createStrumView } from './ui/strumView';
import { createDevDrawer } from './ui/devDrawer';
import { saveFiles, shareOrDownload } from './ui/share';
import { createTunerView, tunerSummary, type TunerPhase } from './ui/tunerView';

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
  record: $<HTMLButtonElement>('record'),
  recTime: $('rec-time'),
  recStatus: $('rec-status'),
  export: $<HTMLButtonElement>('export'),
  save: $<HTMLButtonElement>('save'),
  exportRow: $('export-row'),
  saveHint: $('save-hint'),
  clearStrums: $<HTMLButtonElement>('clear-strums'),
  devReset: $<HTMLButtonElement>('dev-reset'),
  devCopy: $<HTMLButtonElement>('dev-copy'),
  modeStrum: $<HTMLButtonElement>('mode-strum'),
  modeTuner: $<HTMLButtonElement>('mode-tuner'),
  tunerCard: $('tuner-card'),
  strumCard: $('strum-card'),
  logCard: $('log-card'),
  dev: $('dev'),
};

const strumView = createStrumView({
  flash: $('flash'),
  chord: $('chord-name'),
  confidence: $('chord-conf'),
  scores: $('chord-scores'),
  count: $('strum-count'),
  last: $('last-strum'),
  log: $('log') as HTMLOListElement,
});

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

const BUILD = `v0.3 · ${__BUILD_ID__} · ${__BUILD_TIME__}`;
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
let floorSentDb: number | null = null;

// Strum detection (runs in the worklet; settings changed live from the Developer drawer).
const DEFAULT_LIVE: LiveOnsetSettings = {
  thresholdDelta: onsetConfig.thresholdDelta,
  thresholdLambda: onsetConfig.thresholdLambda,
  minInterOnsetMs: onsetConfig.minInterOnsetMs,
  minAboveRoomDb: onsetConfig.minAboveRoomDb,
};
let liveSettings: LiveOnsetSettings = { ...DEFAULT_LIVE };
const currentOnsetConfig = (): OnsetConfig => ({ ...onsetConfig, ...liveSettings });
/** Every strum since Start, with its chord (also used to fill the recording's JSON). */
const strums: StrumRecord[] = [];
// Chord classification (0.3) runs here on the main thread, on the ~160 ms of audio each strum message carries.
const chordClassifier = new ChordClassifier(chordConfig);
let chordMsTotal = 0;

// Mode + tuner (0.2.1). Pitch detection runs on the main thread on analysis audio the worklet
// streams only while the tuner is open (TECH.md 2.6). The strum detector keeps running in the worklet.
type Mode = 'strum' | 'tuner';
let mode: Mode = 'strum';
let pitchTracker: PitchTracker | null = null;
const tuner = new TunerSmoother(tunerConfig);
let lastPitch: PitchFrame | null = null;
let lastReading: PitchFrame | null = null;
let pitchFrames = 0;
let pitchReadings = 0;
let pitchMsTotal = 0;
const tunerView = createTunerView(
  {
    note: $('tuner-note'),
    string: $('tuner-string'),
    needle: $('tuner-needle'),
    zone: $('needle-zone'),
    cents: $('tuner-cents'),
    hint: $('tuner-hint'),
    sub: $('tuner-sub'),
    hz: $('tuner-hz'),
    chips: $('string-chips'),
  },
  (n) => tuner.lock(tuner.lockedString === n ? null : n),
);

// Recording.
type RecState = 'idle' | 'recording' | 'stopping' | 'ready';
let recState: RecState = 'idle';
let rec: RecordingBuffer | null = null;
let recStartedAt = new Date();
let recFloorAtStart: number | null = null;
let recFloorAtEnd: number | null = null;

// High-entropy UA hints (device model), Chrome only. Fetched once.
let uaHigh: { model?: string; platformVersion?: string } = {};
void (navigator as Navigator & { userAgentData?: { getHighEntropyValues?(h: string[]): Promise<Record<string, unknown>> } })
  .userAgentData?.getHighEntropyValues?.(['model', 'platformVersion'])
  .then((v) => {
    uaHigh = { model: typeof v.model === 'string' && v.model ? v.model : undefined, platformVersion: v.platformVersion as string | undefined };
  })
  .catch(() => undefined);

// ---- worklet messages ----
function onWorkletMessage(msg: WorkletMessage): void {
  switch (msg.type) {
    case 'level':
      return onLevel(msg);
    case 'onset':
      return onOnset(msg);
    case 'raw':
      if (rec && rec.add(msg.samples, msg.startFrame) && recState === 'recording') stopRecording();
      return;
    case 'record-stopped':
      return onRecordingStopped();
    case 'analysis':
      return onAnalysis(msg.samples);
  }
}

/** Tuner: pitch detection on the high-passed audio chunk from the worklet. */
function onAnalysis(samples: Float32Array): void {
  if (mode !== 'tuner' || !pitchTracker) return;
  const t0 = performance.now();
  const frames = pitchTracker.push(samples, { noiseFloorDb: noiseFloor.floorDb, expectedHz: tuner.expectedHz });
  const now = performance.now();
  pitchMsTotal += now - t0;
  for (const f of frames) {
    pitchFrames++;
    if (f.hz !== null) {
      pitchReadings++;
      lastReading = f;
    }
    lastPitch = f;
    tuner.push(f.hz, now);
  }
}

function setMode(next: Mode): void {
  mode = next;
  const isTuner = next === 'tuner';
  ui.modeStrum.setAttribute('aria-pressed', String(!isTuner));
  ui.modeTuner.setAttribute('aria-pressed', String(isTuner));
  ui.tunerCard.hidden = !isTuner;
  ui.strumCard.hidden = isTuner;
  ui.logCard.hidden = isTuner;
  ui.dev.hidden = isTuner;
  // Same mic session: only the worklet's analysis tap is switched.
  pitchTracker?.reset();
  session?.post({ type: 'tap', on: isTuner });
  updateResumeButton();
}

function tunerPhase(): TunerPhase {
  if (!session) return 'off';
  return noiseFloor.state === 'measuring' ? 'measuring' : 'listening';
}

function onOnset(msg: OnsetMessage): void {
  if (!session) return;
  const { sampleIndex, strength, levelDb } = msg;
  const sr = session.ctx.sampleRate;
  const floor = noiseFloor.floorDb;
  const t0 = performance.now();
  const r = chordClassifier.classify(msg.audio, 0, sr, floor);
  chordMsTotal += performance.now() - t0;
  const chord = { chord: r.chord ?? '?', best: r.best, confidence: r.confidence, scores: r.scores };
  const ev: StrumRecord = { sampleIndex, timeSec: sampleIndex / sr, strength, levelDb, chord };
  strums.push(ev);
  // Plucks while tuning stay in the recording's event list but don't count on the strum screen.
  if (mode !== 'strum') return;
  strumView.add(
    { timeSec: ev.timeSec, strength, aboveRoomDb: floor === null ? null : levelDb - floor, chord: chord.chord, confidence: chord.confidence, scores: chord.scores },
    performance.now(),
  );
}

/** Keeps the worklet's level gate in step with the room floor (sent only when it changes). */
function syncFloor(): void {
  const db = noiseFloor.floorDb;
  const changed = db === null || floorSentDb === null ? db !== floorSentDb : Math.abs(db - floorSentDb) >= 0.1;
  if (session && changed) {
    session.post({ type: 'noise-floor', db });
    floorSentDb = db;
  }
}

// Meter blocks: queued, consumed by the animation loop.
function onLevel(msg: LevelMessage): void {
  pending.push(msg);
  // Noise floor works per block (not per animation frame), on the high-passed signal.
  if (session && msg.count > 0) {
    // Unclamped: exact zeros (-Infinity) are digital silence, which the estimator ignores.
    const blockDb = msg.sumSquares > 0 ? 10 * Math.log10(msg.sumSquares / msg.count) : -Infinity;
    if (noiseFloor.addBlock(blockDb, (msg.count / session.ctx.sampleRate) * 1000)) onQuietMeasured();
    syncFloor();
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
    retrying: noiseFloor.retrying,
  });

  strumView.tick(now);
  if (mode === 'tuner') tunerView.render(tuner.displayAt(now), tunerPhase(), (n) => tuner.recentlyInTune(n, now), tuner.lockedString);
  if (rec && (recState === 'recording' || recState === 'stopping')) {
    ui.recTime.textContent = `${formatClock(rec.durationSec)} / ${formatClock(recordingConfig.maxRecordSec)}`;
  }

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
    uaModel: uaHigh.model,
    uaPlatformVersion: uaHigh.platformVersion,
    onsetSummary: onsetSummary(),
    tunerSummary: tunerSummary(tunerConfig.a4Hz, (n) => tuner.memoryFor(n), (n) => tuner.recentlyInTune(n, now)),
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
      unsteady: noiseFloor.unsteadyStart,
      digitalSilenceSec: noiseFloor.digitalSilenceMs / 1000,
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

function onsetSummary(): string {
  const c = liveSettings;
  const named = strums.filter((s) => s.chord && s.chord.chord !== '?').length;
  const avg = strums.length ? (chordMsTotal / strums.length).toFixed(1) : '-';
  return `in audio worklet · δ ${c.thresholdDelta.toFixed(2)}, λ ${c.thresholdLambda.toFixed(1)}, merge ${c.minInterOnsetMs} ms, room +${c.minAboveRoomDb} dB · ${strums.length} strums (${named} named, chord ${chordConfig.chordWindowStartMs}-${chordConfig.chordWindowEndMs} ms, ${avg} ms each)`;
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
        ? noiseFloor.retrying
          ? 'Please stay quiet — measuring again. We heard sound during the room measurement; keep the guitar still for 2 seconds.'
          : 'Measuring your room. Stay quiet and keep the guitar still.'
        : mode === 'tuner'
          ? 'Listening. Pluck one string at a time.'
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
  syncFloor();
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
        onset: currentOnsetConfig(),
        recordChunkFrames: recordingConfig.chunkFrames,
        tapChunkFrames: pitchConfig.hopSamples,
        strumAudioMs: chordConfig.chordWindowEndMs,
      },
      { onMessage: onWorkletMessage, onChange: () => renderInfo(performance.now()) },
    );
    lastBlockAtMs = performance.now();
    pitchTracker = new PitchTracker(session.ctx.sampleRate, pitchConfig);
    if (mode === 'tuner') session.post({ type: 'tap', on: true });
    ui.start.hidden = true;
    ui.record.disabled = false;
    floorSentDb = null;
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

// ---- recording ----
function startRecording(): void {
  if (!session) return;
  const sr = session.ctx.sampleRate;
  rec = new RecordingBuffer(sr, Math.round(recordingConfig.maxRecordSec * sr));
  recStartedAt = new Date();
  recFloorAtStart = noiseFloor.floorDb;
  recState = 'recording';
  session.post({ type: 'record', on: true });
  ui.record.textContent = 'Stop';
  ui.record.classList.add('on');
  ui.exportRow.hidden = true;
  ui.saveHint.hidden = true;
  ui.recStatus.textContent = 'Recording… play as you normally would. Tap Stop when done (it stops by itself after 2 minutes).';
}

function stopRecording(): void {
  if (!session || recState !== 'recording') return;
  recState = 'stopping';
  recFloorAtEnd = noiseFloor.floorDb;
  session.post({ type: 'record', on: false });
  ui.record.disabled = true;
  ui.recStatus.textContent = 'Finishing…';
}

function onRecordingStopped(): void {
  recState = 'ready';
  ui.record.disabled = false;
  ui.record.textContent = 'Record again';
  ui.record.classList.remove('on');
  if (!rec || rec.frames === 0) {
    ui.recStatus.textContent = 'Nothing was recorded.';
    return;
  }
  ui.recTime.textContent = `${formatClock(rec.durationSec)} / ${formatClock(recordingConfig.maxRecordSec)}`;
  ui.exportRow.hidden = false;
  ui.saveHint.hidden = false;
  ui.recStatus.textContent = `Recorded ${rec.durationSec.toFixed(1)} s. Tap "Save to device" to keep the original files.`;
}

function buildExportFiles(): { wav: File; json: File; strumsInside: number } | null {
  if (!rec || rec.frames === 0) return null;
  const stamp = fileStamp(recStartedAt);
  const input = reportInput(performance.now());
  const meta = {
    build: BUILD,
    device: shortDeviceName(input),
    deviceInfo: reportToObject(buildDeviceReport(input)),
    recordedAt: recStartedAt,
    noiseFloorDbAtStart: recFloorAtStart,
    noiseFloorDbAtEnd: recFloorAtEnd,
    config: { onset: currentOnsetConfig(), analysis: analysisConfig, noiseFloor: noiseFloorConfig, chord: chordConfig },
  };
  const data = buildRecordingJson(rec, strums, meta);
  const wavBytes = encodeWav16(rec.chunks, rec.sampleRate);
  return {
    wav: new File([wavBytes], `strums-${stamp}.wav`, { type: 'audio/wav' }),
    json: new File([JSON.stringify(data, null, 2)], `strums-${stamp}.json`, { type: 'application/json' }),
    strumsInside: data.events.length,
  };
}

ui.record.addEventListener('click', () => {
  if (recState === 'recording') stopRecording();
  else if (recState === 'idle' || recState === 'ready') startRecording();
});

ui.save.addEventListener('click', async () => {
  const files = buildExportFiles();
  if (!files) return;
  ui.save.disabled = true;
  try {
    await saveFiles(files.wav, files.json);
    const sizeMb = (files.wav.size / 1e6).toFixed(1);
    ui.recStatus.textContent = `Saved ${files.wav.name} (${sizeMb} MB) and the .json with ${files.strumsInside} strums to Downloads. Attach both files from Files → Downloads.`;
    console.info('[export] saved', files.wav.name, files.wav.size, 'bytes');
  } catch (err) {
    ui.recStatus.textContent = `Save failed: ${String(err)}`;
    console.warn('[export] save failed', err);
  } finally {
    ui.save.disabled = false;
  }
});

ui.export.addEventListener('click', async () => {
  const files = buildExportFiles();
  if (!files) return;
  ui.export.disabled = true;
  try {
    const result = await shareOrDownload(files.wav, files.json, `Strum recording ${fileStamp(recStartedAt)}`);
    const sizeMb = (files.wav.size / 1e6).toFixed(1);
    ui.recStatus.textContent =
      result === 'cancelled'
        ? 'Sharing cancelled. Tap the button again to retry.'
        : result === 'downloaded'
          ? `Downloaded ${files.wav.name} (${sizeMb} MB) and the .json with ${files.strumsInside} strums.`
          : `Shared ${files.wav.name} (${sizeMb} MB) and the .json with ${files.strumsInside} strums. Chat apps may re-compress the audio: "Save to device" keeps the original.`;
    console.info('[export]', result, files.wav.name, files.wav.size, 'bytes');
  } catch (err) {
    ui.recStatus.textContent = `Export failed: ${String(err)}`;
    console.warn('[export] failed', err);
  } finally {
    ui.export.disabled = false;
  }
});

// ---- strums + developer drawer ----
ui.modeStrum.addEventListener('click', () => setMode('strum'));
ui.modeTuner.addEventListener('click', () => setMode('tuner'));

ui.clearStrums.addEventListener('click', () => strumView.clear());

const devDrawer = createDevDrawer($('sliders'), liveSettings, (patch) => {
  liveSettings = { ...liveSettings, ...patch };
  session?.post({ type: 'onset-settings', settings: patch });
});

ui.devReset.addEventListener('click', () => {
  liveSettings = { ...DEFAULT_LIVE };
  devDrawer.set(liveSettings);
  session?.post({ type: 'onset-settings', settings: liveSettings });
});

ui.devCopy.addEventListener('click', async () => {
  const text = JSON.stringify({ build: BUILD, onset: liveSettings }, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    ui.devCopy.textContent = 'Copied';
  } catch {
    ui.devCopy.textContent = 'Copy failed';
  }
  setTimeout(() => (ui.devCopy.textContent = 'Copy settings'), 1500);
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
  get strums() {
    return strums;
  },
  get recording() {
    return { state: recState, frames: rec?.frames ?? 0, startFrame: rec?.startFrame ?? null };
  },
  get settings() {
    return liveSettings;
  },
  get chords() {
    return { classified: strums.filter((s) => s.chord).length, avgMs: strums.length ? chordMsTotal / strums.length : 0, last: strums[strums.length - 1]?.chord ?? null };
  },
  get tuner() {
    return {
      mode,
      display: tuner.displayAt(performance.now()),
      locked: tuner.lockedString,
      lastPitch,
      lastReading,
      pitchFrames,
      pitchReadings,
      avgPitchMs: pitchFrames ? pitchMsTotal / pitchFrames : 0,
    };
  },
  setMode,
};
