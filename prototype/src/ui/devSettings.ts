/** Slider definitions for the Developer drawer (pure data, no DOM). */
import type { LiveOnsetSettings } from '../detection/config';

export interface SliderSpec {
  key: keyof LiveOnsetSettings;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  decimals: number;
}

export const SLIDERS: readonly SliderSpec[] = [
  {
    key: 'thresholdDelta',
    label: 'Threshold δ (base)',
    help: 'Higher = needs a sharper strum. Lower = catches softer strums but may trigger on noise.',
    min: 0.02, max: 0.6, step: 0.01, unit: '', decimals: 2,
  },
  {
    key: 'thresholdLambda',
    label: 'Threshold λ (adaptive)',
    help: 'How much recent activity raises the bar. Higher = fewer double triggers while strings ring.',
    min: 0, max: 4, step: 0.1, unit: '×', decimals: 1,
  },
  {
    key: 'minInterOnsetMs',
    label: 'Strum merge window',
    help: 'Sounds closer than this to the start of a strum count as the same strum (a slow strum hits the strings over ~100 ms). Fast down-up strumming (125 ms apart) needs it below 125 ms.',
    min: 30, max: 200, step: 5, unit: ' ms', decimals: 0,
  },
  {
    key: 'minAboveRoomDb',
    label: 'Must be louder than the room by',
    help: 'Strums quieter than room noise + this are ignored.',
    min: 0, max: 30, step: 1, unit: ' dB', decimals: 0,
  },
];

export function formatSetting(spec: SliderSpec, value: number): string {
  return `${value.toFixed(spec.decimals)}${spec.unit}`;
}

/** Keeps a slider value inside its range and on its step grid. */
export function clampToSpec(spec: SliderSpec, value: number): number {
  if (!Number.isFinite(value)) return spec.min;
  const v = Math.min(spec.max, Math.max(spec.min, value));
  const steps = Math.round((v - spec.min) / spec.step);
  return Number((spec.min + steps * spec.step).toFixed(6));
}
