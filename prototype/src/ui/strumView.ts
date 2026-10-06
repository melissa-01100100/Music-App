/** DOM rendering of the strum flash, chord name, counter and event log. Formatting helpers are pure and tested. */
import { strumUiConfig } from '../detection/config';

export interface StrumRow {
  timeSec: number;
  strength: number;
  /** Level above the room floor in dB, or null if the room is not measured yet. */
  aboveRoomDb: number | null;
  /** 0.3: chord name ("Am", "C", "G", "D" or "?"), confidence 0..1 and score per chord. */
  chord?: string;
  confidence?: number;
  scores?: Record<string, number>;
}

/** "12.345 s" */
export function formatStrumTime(sec: number): string {
  return `${sec.toFixed(3)} s`;
}

/** "87%" */
export function formatConfidence(c: number | undefined): string {
  return c === undefined ? '' : `${Math.round(Math.max(0, Math.min(1, c)) * 100)}%`;
}

/** "Am 0.62 · C 0.91 · G 0.30 · D 0.21" */
export function formatScores(scores: Record<string, number> | undefined): string {
  if (!scores) return '';
  return Object.entries(scores)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(' · ');
}

/** [time, chord + confidence, strength, above room] */
export function formatStrumRow(r: StrumRow): [string, string, string, string] {
  return [
    formatStrumTime(r.timeSec),
    r.chord === undefined ? '' : r.chord === '?' ? '?' : `${r.chord} ${formatConfidence(r.confidence)}`.trim(),
    `strength ${r.strength.toFixed(2)}`,
    r.aboveRoomDb === null ? 'room ?' : `+${Math.max(0, r.aboveRoomDb).toFixed(0)} dB`,
  ];
}

export interface StrumElements {
  flash: HTMLElement;
  chord: HTMLElement;
  confidence: HTMLElement;
  scores: HTMLElement;
  count: HTMLElement;
  last: HTMLElement;
  log: HTMLOListElement;
}

export interface StrumView {
  add(row: StrumRow, nowMs: number): void;
  clear(): void;
  /** Call every animation frame (turns the flash off after flashMs). */
  tick(nowMs: number): void;
  readonly count: number;
}

export function createStrumView(el: StrumElements): StrumView {
  let count = 0;
  let flashUntil = 0;
  let lit = false;
  return {
    add(row, nowMs) {
      count++;
      el.count.textContent = String(count);
      const [t, c, s, a] = formatStrumRow(row);
      el.chord.textContent = row.chord ?? '–';
      el.chord.classList.toggle('unsure', row.chord === '?');
      el.confidence.textContent = row.chord === undefined ? '' : row.chord === '?' ? `unsure · best guess ${bestOf(row.scores)}` : `${formatConfidence(row.confidence)} sure`;
      el.scores.textContent = formatScores(row.scores);
      el.last.textContent = `Last strum: ${t} · ${s} · ${a}`;
      const li = document.createElement('li');
      li.append(span(t), span(c, row.chord === '?' ? 'chord unsure' : 'chord'), span(s, 'muted'), span(a, 'muted'));
      el.log.prepend(li);
      while (el.log.childElementCount > strumUiConfig.logMaxLines) el.log.lastElementChild?.remove();
      flashUntil = nowMs + strumUiConfig.flashMs;
      if (!lit) {
        el.flash.classList.add('lit');
        lit = true;
      }
    },
    clear() {
      count = 0;
      el.count.textContent = '0';
      el.chord.textContent = '–';
      el.chord.classList.remove('unsure');
      el.confidence.textContent = '';
      el.scores.textContent = '';
      el.last.textContent = 'Waiting for the first strum…';
      el.log.replaceChildren();
    },
    tick(nowMs) {
      if (lit && nowMs >= flashUntil) {
        el.flash.classList.remove('lit');
        lit = false;
      }
    },
    get count() {
      return count;
    },
  };
}

function bestOf(scores: Record<string, number> | undefined): string {
  if (!scores) return '–';
  return Object.entries(scores).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

function span(text: string, cls?: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.textContent = text;
  if (cls) s.className = cls;
  return s;
}
