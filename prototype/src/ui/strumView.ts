/** DOM rendering of the strum flash, counter and event log. Formatting helpers are pure and tested. */
import { strumUiConfig } from '../detection/config';

export interface StrumRow {
  timeSec: number;
  strength: number;
  /** Level above the room floor in dB, or null if the room is not measured yet. */
  aboveRoomDb: number | null;
}

/** "12.345 s" */
export function formatStrumTime(sec: number): string {
  return `${sec.toFixed(3)} s`;
}

export function formatStrumRow(r: StrumRow): [string, string, string] {
  return [
    formatStrumTime(r.timeSec),
    `strength ${r.strength.toFixed(2)}`,
    r.aboveRoomDb === null ? 'room ?' : `+${Math.max(0, r.aboveRoomDb).toFixed(0)} dB`,
  ];
}

export interface StrumElements {
  flash: HTMLElement;
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
      const [t, s, a] = formatStrumRow(row);
      el.last.textContent = `Last strum: ${t} · ${s} · ${a}`;
      const li = document.createElement('li');
      li.append(span(t), span(s, 'muted'), span(a, 'muted'));
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

function span(text: string, cls?: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.textContent = text;
  if (cls) s.className = cls;
  return s;
}
