/**
 * Guitar tuner logic: standard tuning, nearest string, cents offset, display smoothing,
 * hold, and "recently in tune" per string. Pure (time is passed in), unit tested.
 */
import type { TunerConfig } from './config';

export interface GuitarString {
  /** Guitar string number: 6 = low E (thickest) ... 1 = high E. */
  number: number;
  /** Note letter shown on screen and on the chip. */
  name: string;
  /** Scientific pitch name, e.g. "E2". */
  label: string;
  /** MIDI note number (A4 = 69). */
  midi: number;
}

/** Standard tuning, low to high: E2 A2 D3 G3 B3 E4. */
export const STANDARD_TUNING: readonly GuitarString[] = [
  { number: 6, name: 'E', label: 'E2', midi: 40 },
  { number: 5, name: 'A', label: 'A2', midi: 45 },
  { number: 4, name: 'D', label: 'D3', midi: 50 },
  { number: 3, name: 'G', label: 'G3', midi: 55 },
  { number: 2, name: 'B', label: 'B3', midi: 59 },
  { number: 1, name: 'E', label: 'E4', midi: 64 },
];

export function midiToHz(midi: number, a4Hz: number): number {
  return a4Hz * Math.pow(2, (midi - 69) / 12);
}

/** Cents from `refHz` to `hz` (positive = sharp). */
export function centsOff(hz: number, refHz: number): number {
  return 1200 * Math.log2(hz / refHz);
}

export function stringByNumber(n: number, tuning: readonly GuitarString[] = STANDARD_TUNING): GuitarString | undefined {
  return tuning.find((s) => s.number === n);
}

export type TuneDirection = 'up' | 'down' | 'ok';

export interface StringReading {
  string: GuitarString;
  targetHz: number;
  hz: number;
  /** Raw cents from the target (not clamped; can be beyond ±50 when far out of tune). */
  cents: number;
}

/** Nearest string to `hz` (or the locked string), with the cents offset. */
export function readString(hz: number, a4Hz: number, lockedString: number | null = null, tuning: readonly GuitarString[] = STANDARD_TUNING): StringReading {
  let best = tuning[0];
  let bestCents = Infinity;
  for (const s of tuning) {
    if (lockedString !== null && s.number !== lockedString) continue;
    const c = centsOff(hz, midiToHz(s.midi, a4Hz));
    if (Math.abs(c) < Math.abs(bestCents)) {
      best = s;
      bestCents = c;
    }
  }
  return { string: best, targetHz: midiToHz(best.midi, a4Hz), hz, cents: bestCents };
}

export function tuneDirection(cents: number, inTuneCents: number): TuneDirection {
  if (Math.abs(cents) <= inTuneCents) return 'ok';
  return cents < 0 ? 'up' : 'down';
}

export function clampCents(cents: number, range: number): number {
  return Math.max(-range, Math.min(range, cents));
}

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface TunerDisplay {
  string: GuitarString;
  targetHz: number;
  /** Smoothed frequency (from the smoothed cents). */
  hz: number;
  /** Smoothed cents (not clamped). */
  cents: number;
  /** Smoothed cents clamped to ±displayRangeCents (needle position). */
  needleCents: number;
  inTune: boolean;
  direction: TuneDirection;
  /** True while showing the last value after the note faded. */
  held: boolean;
}

export interface StringMemory {
  /** Last smoothed cents shown for this string. */
  cents: number;
  hz: number;
  atMs: number;
  /** Last time it was (stably) in tune, or null. */
  inTuneAtMs: number | null;
}

/**
 * Turns per-frame pitch readings into a steady display:
 *  - a new string must win `switchFrames` readings in a row (ignores pluck glitches),
 *  - median of the last `medianFrames` cents, then an EMA,
 *  - when readings stop, the last value is held for `holdMs`, then cleared,
 *  - a string counts as "recently in tune" after `inTuneFrames` in-tune readings in a row,
 *    for `inTuneMemoryMs`.
 */
export class TunerSmoother {
  private current: GuitarString | null = null;
  private recent: number[] = [];
  private ema: number | null = null;
  private candidate: GuitarString | null = null;
  private candidateCount = 0;
  private lastReadingMs = -Infinity;
  private inTuneRun = 0;
  private locked: number | null = null;
  private readonly memory = new Map<number, StringMemory>();
  private view: TunerDisplay | null = null;

  constructor(
    private readonly cfg: TunerConfig,
    private readonly tuning: readonly GuitarString[] = STANDARD_TUNING,
  ) {}

  /** Lock to one string (number 1..6), or null for automatic. Clears the current display. */
  lock(stringNumber: number | null): void {
    this.locked = stringNumber;
    this.resetDisplay();
  }

  get lockedString(): number | null {
    return this.locked;
  }

  /** Target frequency of the locked string (a hint for the pitch detector), or undefined. */
  get expectedHz(): number | undefined {
    const s = this.locked === null ? undefined : stringByNumber(this.locked, this.tuning);
    return s ? midiToHz(s.midi, this.cfg.a4Hz) : undefined;
  }

  /** Feeds one detector frame: a frequency in Hz, or null (no clear pitch). */
  push(hz: number | null, nowMs: number): TunerDisplay | null {
    if (hz === null || !(hz > 0)) return this.onNoReading(nowMs);
    const r = readString(hz, this.cfg.a4Hz, this.locked, this.tuning);
    this.lastReadingMs = nowMs;

    if (this.current?.number !== r.string.number) {
      if (this.candidate?.number === r.string.number) this.candidateCount++;
      else {
        this.candidate = r.string;
        this.candidateCount = 1;
      }
      if (this.current !== null && this.candidateCount < this.cfg.switchFrames) return this.holdView(nowMs);
      if (this.current === null && this.candidateCount < this.cfg.switchFrames) return null;
      this.current = r.string;
      this.recent = [];
      this.ema = null;
      this.inTuneRun = 0;
    }
    this.candidate = null;
    this.candidateCount = 0;

    this.recent.push(r.cents);
    if (this.recent.length > this.cfg.medianFrames) this.recent.shift();
    const med = median(this.recent);
    this.ema = this.ema === null ? med : this.ema + this.cfg.emaAlpha * (med - this.ema);

    const cents = this.ema;
    const direction = tuneDirection(cents, this.cfg.inTuneCents);
    const inTune = direction === 'ok';
    this.inTuneRun = inTune ? this.inTuneRun + 1 : 0;

    const mem = this.memory.get(r.string.number);
    const stableInTune = this.inTuneRun >= this.cfg.inTuneFrames;
    this.memory.set(r.string.number, {
      cents,
      hz: r.targetHz * Math.pow(2, cents / 1200),
      atMs: nowMs,
      inTuneAtMs: stableInTune ? nowMs : (mem?.inTuneAtMs ?? null),
    });

    this.view = {
      string: r.string,
      targetHz: r.targetHz,
      hz: r.targetHz * Math.pow(2, cents / 1200),
      cents,
      needleCents: clampCents(cents, this.cfg.displayRangeCents),
      inTune,
      direction,
      held: false,
    };
    return this.view;
  }

  /** What to show right now (also used by the render loop between readings). */
  displayAt(nowMs: number): TunerDisplay | null {
    if (this.view && nowMs - this.lastReadingMs > this.cfg.holdMs) this.resetDisplay();
    return this.view;
  }

  /** True if this string was stably in tune within the last `inTuneMemoryMs`. */
  recentlyInTune(stringNumber: number, nowMs: number): boolean {
    const at = this.memory.get(stringNumber)?.inTuneAtMs;
    return at !== null && at !== undefined && nowMs - at <= this.cfg.inTuneMemoryMs;
  }

  /** Last reading per string (for Copy info). */
  memoryFor(stringNumber: number): StringMemory | undefined {
    return this.memory.get(stringNumber);
  }

  /** Forget everything (display and per-string memory). */
  clear(): void {
    this.memory.clear();
    this.resetDisplay();
  }

  private onNoReading(nowMs: number): TunerDisplay | null {
    this.candidate = null;
    this.candidateCount = 0;
    return this.holdView(nowMs);
  }

  private holdView(nowMs: number): TunerDisplay | null {
    if (!this.view) return null;
    if (nowMs - this.lastReadingMs > this.cfg.holdMs) {
      this.resetDisplay();
      return null;
    }
    if (nowMs > this.lastReadingMs) this.view = { ...this.view, held: true };
    return this.view;
  }

  private resetDisplay(): void {
    this.current = null;
    this.recent = [];
    this.ema = null;
    this.candidate = null;
    this.candidateCount = 0;
    this.inTuneRun = 0;
    this.view = null;
  }
}
