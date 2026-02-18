// Post Processing module — Luminance, Hue, Saturation, Contrast sliders
// that apply real-time color adjustments to the main preview via GLSL uniforms.

import { makeValueEditable } from './params.js';

// ---------------------------------------------------------------------------
// Post-processing values (read by ShaderRenderer each frame)
// ---------------------------------------------------------------------------

export const ppValues = {
  luminance: 1,
  hue: 0,        // radians
  saturation: 1,
  contrast: 1,
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const PP_DEFAULTS = {
  luminance: 1,
  hue: 0,
  saturation: 1,
  contrast: 1,
} as const;

// ---------------------------------------------------------------------------
// Slider config
// ---------------------------------------------------------------------------

interface PPSliderConfig {
  id: string;
  valueId: string;
  key: keyof typeof ppValues;
  defaultVal: number;
  isHue: boolean;
}

const SLIDERS: PPSliderConfig[] = [
  { id: 'pp-luminance',  valueId: 'pp-luminance-value',  key: 'luminance',  defaultVal: PP_DEFAULTS.luminance,  isHue: false },
  { id: 'pp-hue',        valueId: 'pp-hue-value',        key: 'hue',        defaultVal: PP_DEFAULTS.hue,        isHue: true  },
  { id: 'pp-saturation', valueId: 'pp-saturation-value',  key: 'saturation', defaultVal: PP_DEFAULTS.saturation, isHue: false },
  { id: 'pp-contrast',   valueId: 'pp-contrast-value',    key: 'contrast',   defaultVal: PP_DEFAULTS.contrast,   isHue: false },
];

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initPostProcess(): void {
  const resetBtn = document.getElementById('btn-reset-pp');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => resetPostProcess());
  }

  for (const cfg of SLIDERS) {
    const slider = document.getElementById(cfg.id) as HTMLInputElement | null;
    const valueSpan = document.getElementById(cfg.valueId) as HTMLSpanElement | null;
    if (!slider || !valueSpan) continue;

    // Slider input
    slider.addEventListener('input', () => {
      const raw = parseFloat(slider.value);
      if (cfg.isHue) {
        ppValues[cfg.key] = raw * Math.PI / 180;
        valueSpan.textContent = Math.round(raw).toString();
      } else {
        ppValues[cfg.key] = raw;
        valueSpan.textContent = raw.toFixed(2);
      }
    });

    // Double-click reset on slider
    slider.addEventListener('dblclick', () => {
      resetOne(cfg, slider, valueSpan);
    });

    // Double-click reset on label
    const label = slider.closest('.param-row')?.querySelector('label');
    if (label) {
      label.style.cursor = 'pointer';
      label.addEventListener('dblclick', () => {
        resetOne(cfg, slider, valueSpan);
      });
    }

    // Click-to-type on value span
    makeValueEditable(valueSpan, slider, {
      isInt: cfg.isHue,
      onCommit(value: number) {
        if (cfg.isHue) {
          ppValues[cfg.key] = value * Math.PI / 180;
          valueSpan.textContent = Math.round(value).toString();
        } else {
          ppValues[cfg.key] = value;
          valueSpan.textContent = value.toFixed(2);
        }
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

function resetOne(cfg: PPSliderConfig, slider: HTMLInputElement, valueSpan: HTMLSpanElement): void {
  ppValues[cfg.key] = cfg.isHue ? 0 : cfg.defaultVal;
  slider.value = String(cfg.defaultVal);
  valueSpan.textContent = cfg.isHue ? Math.round(cfg.defaultVal).toString() : cfg.defaultVal.toFixed(2);
}

export function resetPostProcess(): void {
  for (const cfg of SLIDERS) {
    const slider = document.getElementById(cfg.id) as HTMLInputElement | null;
    const valueSpan = document.getElementById(cfg.valueId) as HTMLSpanElement | null;
    if (!slider || !valueSpan) continue;
    resetOne(cfg, slider, valueSpan);
  }
}
