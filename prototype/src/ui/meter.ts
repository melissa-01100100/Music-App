/** DOM rendering of the level meter. All maths lives in detection/level.ts. */
import { levelConfig } from '../detection/config';
import { isClipLit, meterFraction, meterZone, type MeterState } from '../detection/level';

const SCALE_MARKS_DB = [-60, -48, -36, -24, -12, -6, 0];

export interface MeterView {
  render(state: MeterState, nowMs: number, active: boolean): void;
}

export function createMeterView(root: {
  fill: HTMLElement;
  peak: HTMLElement;
  db: HTMLElement;
  peakDb: HTMLElement;
  clip: HTMLElement;
  scale: HTMLElement;
}): MeterView {
  const floor = levelConfig.meterFloorDb;
  root.scale.replaceChildren(
    ...SCALE_MARKS_DB.filter((d) => d >= floor).map((d) => {
      const s = document.createElement('span');
      s.textContent = String(d);
      s.style.left = `${meterFraction(d, floor) * 100}%`;
      return s;
    }),
  );

  return {
    render(state, nowMs, active) {
      const clipping = isClipLit(state, nowMs, levelConfig.clipHoldMs);
      const zone = meterZone(state.levelDb, clipping, levelConfig);
      root.fill.style.width = `${meterFraction(state.levelDb, floor) * 100}%`;
      root.fill.className = `meter-fill ${zone}`;
      root.peak.style.left = `${meterFraction(state.peakHoldDb, floor) * 100}%`;
      root.clip.classList.toggle('lit', clipping);
      root.db.textContent = active ? `${fmtDb(state.levelDb, floor)} dB` : '-- dB';
      root.peakDb.textContent = active ? fmtDb(state.peakHoldDb, floor) : '--';
    },
  };
}

function fmtDb(db: number, floor: number): string {
  return db <= floor ? `<${floor}` : db.toFixed(1);
}
