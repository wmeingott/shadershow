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
// Fullscreen sync
// ---------------------------------------------------------------------------

declare const window: Window & { electronAPI?: { sendPostProcessUpdate?(data: typeof ppValues): void } };

function sendPPToFullscreen(): void {
  window.electronAPI?.sendPostProcessUpdate?.(ppValues);
}

// ---------------------------------------------------------------------------
// Slider config
// ---------------------------------------------------------------------------

interface PPSliderConfig {
  id: string;
  valueId: string;
  key: keyof typeof ppValues;
  defaultVal: number;
  isInt: boolean;
  toStored: (raw: number) => number;
  toDisplay: (raw: number) => string;
}

function identity(v: number): number { return v; }
function fmtFloat(v: number): string { return v.toFixed(2); }
function fmtInt(v: number): string { return Math.round(v).toString(); }

const SLIDERS: PPSliderConfig[] = [
  { id: 'pp-luminance',  valueId: 'pp-luminance-value',  key: 'luminance',  defaultVal: 1, isInt: false, toStored: identity,                    toDisplay: fmtFloat },
  { id: 'pp-hue',        valueId: 'pp-hue-value',        key: 'hue',        defaultVal: 0, isInt: true,  toStored: (v) => v * Math.PI / 180,    toDisplay: fmtInt },
  { id: 'pp-saturation', valueId: 'pp-saturation-value',  key: 'saturation', defaultVal: 1, isInt: false, toStored: identity,                    toDisplay: fmtFloat },
  { id: 'pp-contrast',   valueId: 'pp-contrast-value',    key: 'contrast',   defaultVal: 1, isInt: false, toStored: identity,                    toDisplay: fmtFloat },
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

    slider.addEventListener('input', () => {
      const raw = parseFloat(slider.value);
      ppValues[cfg.key] = cfg.toStored(raw);
      valueSpan.textContent = cfg.toDisplay(raw);
      sendPPToFullscreen();
    });

    slider.addEventListener('dblclick', () => {
      resetOne(cfg, slider, valueSpan);
    });

    const label = slider.closest('.param-row')?.querySelector('label');
    if (label) {
      label.style.cursor = 'pointer';
      label.addEventListener('dblclick', () => {
        resetOne(cfg, slider, valueSpan);
      });
    }

    makeValueEditable(valueSpan, slider, {
      isInt: cfg.isInt,
      onCommit(value: number) {
        ppValues[cfg.key] = cfg.toStored(value);
        valueSpan.textContent = cfg.toDisplay(value);
        sendPPToFullscreen();
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

function resetOne(cfg: PPSliderConfig, slider: HTMLInputElement, valueSpan: HTMLSpanElement): void {
  ppValues[cfg.key] = cfg.toStored(cfg.defaultVal);
  slider.value = String(cfg.defaultVal);
  valueSpan.textContent = cfg.toDisplay(cfg.defaultVal);
  sendPPToFullscreen();
}

export function resetPostProcess(): void {
  for (const cfg of SLIDERS) {
    const slider = document.getElementById(cfg.id) as HTMLInputElement | null;
    const valueSpan = document.getElementById(cfg.valueId) as HTMLSpanElement | null;
    if (!slider || !valueSpan) continue;
    resetOne(cfg, slider, valueSpan);
  }
}
