/** DOM rendering of the level meter. All maths lives in detection/level.ts and detection/noiseFloor.ts. */
import { levelConfig, noiseFloorConfig } from '../detection/config';
import { isClipLit, meterFraction, meterZone, type MeterState } from '../detection/level';
import { aboveRoomDb, isAboveRoom, roomZoneTopDb } from '../detection/noiseFloor';

const SCALE_MARKS_DB = [-60, -48, -36, -24, -12, -6, 0];
const MINUS = '−';

export interface RoomInfo {
  /** Current noise floor (dBFS), null while measuring or before Start. */
  floorDb: number | null;
  /** True during the "Stay quiet..." measurement. */
  measuring: boolean;
  /** Countdown for the quiet measurement. */
  remainingMs: number;
}

export interface MeterView {
  render(state: MeterState, nowMs: number, active: boolean, room: RoomInfo): void;
}

export interface MeterElements {
  fill: HTMLElement;
  roomFill: HTMLElement;
  roomZone: HTMLElement;
  floorMark: HTMLElement;
  peak: HTMLElement;
  db: HTMLElement;
  peakDb: HTMLElement;
  clip: HTMLElement;
  scale: HTMLElement;
  chip: HTMLElement;
  roomDb: HTMLElement;
  aboveDb: HTMLElement;
}

export function createMeterView(root: MeterElements): MeterView {
  const floor = levelConfig.meterFloorDb;
  root.scale.replaceChildren(
    ...SCALE_MARKS_DB.filter((d) => d >= floor).map((d) => {
      const s = document.createElement('span');
      s.textContent = String(d);
      s.style.left = `${meterFraction(d, floor) * 100}%`;
      return s;
    }),
  );
  const pct = (db: number) => `${meterFraction(db, floor) * 100}%`;

  return {
    render(state, nowMs, active, room) {
      const clipping = isClipLit(state, nowMs, levelConfig.clipHoldMs);
      const margin = noiseFloorConfig.roomMarginDb;
      const above = active && !room.measuring && isAboveRoom(state.levelDb, room.floorDb, margin);

      // Fill: grey unless clearly above the room. When above, the part inside the
      // room zone stays grey (roomFill overlay) and only the rest is coloured.
      const zone = above || clipping ? meterZone(state.levelDb, clipping, levelConfig) : 'muted';
      root.fill.style.width = pct(state.levelDb);
      root.fill.className = `meter-fill ${zone}`;

      const hasFloor = active && room.floorDb !== null && !room.measuring;
      const zoneTop = hasFloor ? roomZoneTopDb(room.floorDb as number, margin) : floor;
      root.roomZone.hidden = !hasFloor;
      root.floorMark.hidden = !hasFloor;
      root.roomFill.hidden = !hasFloor;
      if (hasFloor) {
        root.roomZone.style.width = pct(zoneTop);
        root.floorMark.style.left = pct(room.floorDb as number);
        root.roomFill.style.width = pct(Math.min(state.levelDb, zoneTop));
      }

      root.peak.style.left = pct(state.peakHoldDb);
      root.clip.classList.toggle('lit', clipping);
      root.db.textContent = active ? `${fmtDb(state.levelDb, floor)} dB` : '-- dB';
      root.peakDb.textContent = active ? fmtDb(state.peakHoldDb, floor) : '--';

      // Status chip + room readouts.
      if (!active) {
        setChip(root.chip, 'off', 'Not listening');
      } else if (room.measuring) {
        setChip(root.chip, 'measuring', `Stay quiet… ${Math.max(1, Math.ceil(room.remainingMs / 1000))}`);
      } else if (above) {
        setChip(root.chip, 'sound', 'Sound!');
      } else {
        setChip(root.chip, 'quiet', 'Quiet');
      }
      root.roomDb.textContent = hasFloor ? `${signed(room.floorDb as number)} dB` : room.measuring ? 'measuring…' : '--';
      root.aboveDb.textContent = hasFloor
        ? `+${aboveRoomDb(state.levelDb, room.floorDb as number).toFixed(0)} dB`
        : '--';
    },
  };
}

function setChip(el: HTMLElement, kind: string, text: string): void {
  el.className = `chip ${kind}`;
  if (el.textContent !== text) el.textContent = text;
}

function signed(db: number): string {
  const r = Math.round(db);
  return r < 0 ? `${MINUS}${-r}` : String(r);
}

function fmtDb(db: number, floor: number): string {
  return db <= floor ? `<${floor}` : db.toFixed(1);
}
