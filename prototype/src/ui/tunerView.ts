/** DOM rendering of the tuner. Formatting helpers are pure and tested; the maths lives in detection/tuner.ts. */
import { tunerConfig } from '../detection/config';
import { STANDARD_TUNING, type StringMemory, type TunerDisplay } from '../detection/tuner';

const MINUS = '−';

/** "+12 cents", "−3 cents", "0 cents" (rounded to whole cents). */
export function formatCents(cents: number): string {
  const r = Math.round(cents);
  if (r === 0) return '0 cents';
  return `${r > 0 ? '+' : MINUS}${Math.abs(r)} cents`;
}

/** Needle position across the bar in percent (0 = -range, 50 = centre, 100 = +range). */
export function needlePercent(needleCents: number, range: number): number {
  return 50 + (Math.max(-range, Math.min(range, needleCents)) / range) * 50;
}

export type TunerPhase = 'off' | 'measuring' | 'listening';

export interface TunerHint {
  text: string;
  /** Smaller explanation under the main hint. */
  sub: string;
  kind: 'idle' | 'up' | 'down' | 'ok';
}

export function tunerHint(d: TunerDisplay | null, phase: TunerPhase): TunerHint {
  if (phase === 'off') return { text: 'Tap Start', sub: 'Then pluck one string and let it ring.', kind: 'idle' };
  if (phase === 'measuring') return { text: 'Stay quiet…', sub: 'Measuring your room first.', kind: 'idle' };
  if (!d) return { text: 'Pluck one string', sub: 'Let it ring. One string at a time.', kind: 'idle' };
  if (d.direction === 'ok') return { text: 'In tune ✓', sub: 'Next string.', kind: 'ok' };
  if (d.direction === 'up') return { text: 'Tune up ↑', sub: 'Too low (flat): tighten the string slowly.', kind: 'up' };
  return { text: 'Tune down ↓', sub: 'Too high (sharp): loosen the string slowly.', kind: 'down' };
}

/** One line for Copy info: last reading per string, e.g. "E2 −3c ✓ · A2 +12c · D3 – ...". */
export function tunerSummary(a4Hz: number, memoryFor: (n: number) => StringMemory | undefined, recentlyInTune: (n: number) => boolean): string {
  const parts = STANDARD_TUNING.map((s) => {
    const m = memoryFor(s.number);
    if (!m) return `${s.label} –`;
    const c = Math.round(m.cents);
    const sign = c > 0 ? '+' : c < 0 ? MINUS : '';
    return `${s.label} ${sign}${Math.abs(c)}c${recentlyInTune(s.number) ? ' ✓' : ''}`;
  });
  return `A4 = ${a4Hz} Hz · last reading per string: ${parts.join(' · ')}`;
}

export interface TunerElements {
  note: HTMLElement;
  string: HTMLElement;
  needle: HTMLElement;
  zone: HTMLElement;
  cents: HTMLElement;
  hint: HTMLElement;
  sub: HTMLElement;
  hz: HTMLElement;
  chips: HTMLElement;
}

export interface TunerView {
  render(d: TunerDisplay | null, phase: TunerPhase, inTune: (stringNumber: number) => boolean, locked: number | null): void;
}

/** Builds the six string chips; `onPick(stringNumber)` fires on tap. */
export function createTunerView(el: TunerElements, onPick: (stringNumber: number) => void): TunerView {
  const range = tunerConfig.displayRangeCents;
  const zoneWidth = (tunerConfig.inTuneCents / range) * 50;
  el.zone.style.left = `${50 - zoneWidth}%`;
  el.zone.style.width = `${2 * zoneWidth}%`;

  const chips = new Map<number, HTMLButtonElement>();
  for (const s of STANDARD_TUNING) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'string-chip';
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', `String ${s.number}, ${s.label}`);
    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = s.name;
    const num = document.createElement('span');
    num.className = 'chip-num';
    num.textContent = String(s.number);
    b.append(name, num);
    b.addEventListener('click', () => onPick(s.number));
    chips.set(s.number, b);
    el.chips.append(b);
  }

  let lastKey = '';
  return {
    render(d, phase, inTune, locked) {
      const hint = tunerHint(d, phase);
      const chipState = STANDARD_TUNING.map((s) => `${inTune(s.number) ? 1 : 0}${locked === s.number ? 1 : 0}${d?.string.number === s.number ? 1 : 0}`).join('');
      const key = d
        ? `${d.string.number}|${d.needleCents.toFixed(1)}|${d.held}|${hint.kind}|${chipState}`
        : `none|${phase}|${locked}|${chipState}`;
      if (key === lastKey) return;
      lastKey = key;

      const lockedString = locked === null ? undefined : STANDARD_TUNING.find((s) => s.number === locked);
      if (d) {
        el.note.textContent = d.string.name;
        el.string.textContent = `String ${d.string.number} · ${d.string.label}`;
        el.cents.textContent = Math.abs(d.cents) > range ? `${formatCents(d.cents)} (off the scale)` : formatCents(d.cents);
        el.hz.textContent = `${d.hz.toFixed(1)} Hz · target ${d.targetHz.toFixed(1)} Hz${locked !== null ? ' · locked' : ''}`;
        el.needle.style.left = `${needlePercent(d.needleCents, range)}%`;
        el.needle.hidden = false;
      } else {
        el.note.textContent = lockedString ? lockedString.name : '–';
        el.string.textContent = lockedString ? `String ${lockedString.number} · ${lockedString.label} (locked)` : 'Auto: any string';
        el.cents.textContent = '-- cents';
        el.hz.textContent = locked !== null ? 'Locked. Tap the string again for automatic.' : '';
        el.needle.hidden = true;
      }
      el.note.parentElement?.classList.toggle('held', !!d?.held);
      el.hint.textContent = hint.text;
      el.hint.className = `tuner-hint ${hint.kind}`;
      el.sub.textContent = hint.sub;
      el.needle.className = `needle ${hint.kind}`;

      for (const s of STANDARD_TUNING) {
        const b = chips.get(s.number) as HTMLButtonElement;
        b.classList.toggle('done', inTune(s.number));
        b.classList.toggle('current', d?.string.number === s.number);
        b.classList.toggle('locked', locked === s.number);
        b.setAttribute('aria-pressed', String(locked === s.number));
      }
    },
  };
}
