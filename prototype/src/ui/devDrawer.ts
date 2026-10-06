/** Developer drawer: live sliders for the strum detector. */
import type { LiveOnsetSettings } from '../detection/config';
import { clampToSpec, formatSetting, SLIDERS } from './devSettings';

export interface DevDrawer {
  /** Sets all sliders (e.g. "Reset to defaults") without firing onChange. */
  set(values: LiveOnsetSettings): void;
}

export function createDevDrawer(
  root: HTMLElement,
  initial: LiveOnsetSettings,
  onChange: (patch: Partial<LiveOnsetSettings>) => void,
): DevDrawer {
  const inputs = new Map<keyof LiveOnsetSettings, { input: HTMLInputElement; out: HTMLOutputElement }>();
  for (const spec of SLIDERS) {
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    const id = `slider-${spec.key}`;
    const label = document.createElement('label');
    label.htmlFor = id;
    const name = document.createElement('span');
    name.textContent = spec.label;
    const out = document.createElement('output');
    out.htmlFor.add(id);
    label.append(name, out);
    const input = document.createElement('input');
    input.type = 'range';
    input.id = id;
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    const help = document.createElement('p');
    help.className = 'small';
    help.textContent = spec.help;
    input.addEventListener('input', () => {
      const v = clampToSpec(spec, Number(input.value));
      out.value = formatSetting(spec, v);
      onChange({ [spec.key]: v });
    });
    wrap.append(label, input, help);
    root.appendChild(wrap);
    inputs.set(spec.key, { input, out });
  }

  const drawer: DevDrawer = {
    set(values) {
      for (const spec of SLIDERS) {
        const el = inputs.get(spec.key)!;
        const v = clampToSpec(spec, values[spec.key]);
        el.input.value = String(v);
        el.out.value = formatSetting(spec, v);
      }
    },
  };
  drawer.set(initial);
  return drawer;
}
