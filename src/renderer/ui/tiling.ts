// Tiling module — Cols/Rows shader repetition with spacing and background.
// Values are saved per-shader in slot.params.

import { state } from '../core/state.js';
import { saveGridState } from '../grid/grid-persistence.js';
import { makeValueEditable } from './params.js';

// ---------------------------------------------------------------------------
// Tiling values (read by ShaderRenderer each frame)
// ---------------------------------------------------------------------------

export const tilingValues = {
  cols: 1,
  rows: 1,
  spaceX: 0,
  spaceY: 0,
  bgR: 0,
  bgG: 0,
  bgB: 0,
};

// ---------------------------------------------------------------------------
// Fullscreen sync
// ---------------------------------------------------------------------------

declare const window: Window & { electronAPI?: { sendTilingUpdate?(data: typeof tilingValues): void } };

// Optional hook called after every tiling change (registered by ab-preview for A/B sync)
let _onTilingChanged: (() => void) | null = null;
export function setOnTilingChanged(cb: (() => void) | null): void {
  _onTilingChanged = cb;
}

function sendTilingToFullscreen(): void {
  window.electronAPI?.sendTilingUpdate?.(tilingValues);
  _onTilingChanged?.();
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface SlotLike {
  params?: Record<string, unknown> | null;
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

function debouncedSave(): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => { saveGridState(); saveTimeout = null; }, 500);
}

function syncToActiveSlot(key: string, value: unknown): void {
  if (state.activeGridSlot === null) return;
  const slot = (state.gridSlots as Array<SlotLike | null>)[state.activeGridSlot];
  if (!slot) return;
  if (!slot.params) slot.params = {};
  slot.params[key] = value;
  debouncedSave();
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => {
    const h = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
    return h.length === 1 ? '0' + h : h;
  };
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

/** Return tiling values in the format used by slot.params (for preset save/recall). */
export function getTilingParams(): Record<string, unknown> {
  return {
    cols: tilingValues.cols,
    rows: tilingValues.rows,
    spaceX: tilingValues.spaceX,
    spaceY: tilingValues.spaceY,
    tilingBg: rgbToHex(tilingValues.bgR, tilingValues.bgG, tilingValues.bgB),
  };
}

// ---------------------------------------------------------------------------
// Fix-values guard
// ---------------------------------------------------------------------------

/** Returns true when the "Fix" checkbox is checked (tiling should not be overwritten by presets). */
export function isTilingFixed(): boolean {
  const cb = document.getElementById('tiling-fix-values') as HTMLInputElement | null;
  return cb?.checked ?? false;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initTiling(): void {
  const resetBtn = document.getElementById('btn-reset-tiling');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => resetTiling());
  }

  // Cols / Rows sliders
  for (const cfg of [
    { id: 'tiling-cols', valueId: 'tiling-cols-value', key: 'cols' as const, def: 1 },
    { id: 'tiling-rows', valueId: 'tiling-rows-value', key: 'rows' as const, def: 1 },
  ]) {
    const slider = document.getElementById(cfg.id) as HTMLInputElement | null;
    const valueSpan = document.getElementById(cfg.valueId) as HTMLSpanElement | null;
    if (!slider || !valueSpan) continue;

    slider.addEventListener('input', () => {
      const val = parseInt(slider.value, 10);
      tilingValues[cfg.key] = val;
      valueSpan.textContent = val.toString();
      syncToActiveSlot(cfg.key, val);
      sendTilingToFullscreen();
    });

    slider.addEventListener('dblclick', () => {
      tilingValues[cfg.key] = cfg.def;
      slider.value = String(cfg.def);
      valueSpan.textContent = String(cfg.def);
      syncToActiveSlot(cfg.key, cfg.def);
      sendTilingToFullscreen();
    });

    const label = slider.closest('.param-row')?.querySelector('label');
    if (label) {
      label.style.cursor = 'pointer';
      label.addEventListener('dblclick', () => {
        tilingValues[cfg.key] = cfg.def;
        slider.value = String(cfg.def);
        valueSpan.textContent = String(cfg.def);
        syncToActiveSlot(cfg.key, cfg.def);
        sendTilingToFullscreen();
      });
    }

    makeValueEditable(valueSpan, slider, {
      isInt: true,
      onCommit(value: number) {
        tilingValues[cfg.key] = value;
        valueSpan.textContent = value.toString();
        syncToActiveSlot(cfg.key, value);
        sendTilingToFullscreen();
      },
    });
  }

  // Space X / Space Y sliders
  for (const cfg of [
    { id: 'tiling-space-x', valueId: 'tiling-space-x-value', key: 'spaceX' as const },
    { id: 'tiling-space-y', valueId: 'tiling-space-y-value', key: 'spaceY' as const },
  ]) {
    const slider = document.getElementById(cfg.id) as HTMLInputElement | null;
    const valueSpan = document.getElementById(cfg.valueId) as HTMLSpanElement | null;
    if (!slider || !valueSpan) continue;

    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      tilingValues[cfg.key] = val;
      valueSpan.textContent = val.toFixed(2);
      syncToActiveSlot(cfg.key, val);
      sendTilingToFullscreen();
    });

    slider.addEventListener('dblclick', () => {
      tilingValues[cfg.key] = 0;
      slider.value = '0';
      valueSpan.textContent = '0.00';
      syncToActiveSlot(cfg.key, 0);
      sendTilingToFullscreen();
    });

    const label = slider.closest('.param-row')?.querySelector('label');
    if (label) {
      label.style.cursor = 'pointer';
      label.addEventListener('dblclick', () => {
        tilingValues[cfg.key] = 0;
        slider.value = '0';
        valueSpan.textContent = '0.00';
        syncToActiveSlot(cfg.key, 0);
        sendTilingToFullscreen();
      });
    }

    makeValueEditable(valueSpan, slider, {
      isInt: false,
      onCommit(value: number) {
        tilingValues[cfg.key] = value;
        valueSpan.textContent = value.toFixed(2);
        syncToActiveSlot(cfg.key, value);
        sendTilingToFullscreen();
      },
    });
  }

  // Background color picker
  const bgPicker = document.getElementById('tiling-bg') as HTMLInputElement | null;
  if (bgPicker) {
    bgPicker.addEventListener('input', () => {
      const [r, g, b] = hexToRgb(bgPicker.value);
      tilingValues.bgR = r;
      tilingValues.bgG = g;
      tilingValues.bgB = b;
      syncToActiveSlot('tilingBg', bgPicker.value);
      sendTilingToFullscreen();
    });

    const label = bgPicker.closest('.param-row')?.querySelector('label');
    if (label) {
      label.style.cursor = 'pointer';
      label.addEventListener('dblclick', () => {
        tilingValues.bgR = 0;
        tilingValues.bgG = 0;
        tilingValues.bgB = 0;
        bgPicker.value = '#000000';
        syncToActiveSlot('tilingBg', '#000000');
        sendTilingToFullscreen();
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Load / Reset
// ---------------------------------------------------------------------------

/** Load tiling from slot params. Resets to defaults when keys are absent. Skips when "Fix" is checked. */
export function loadTilingToSliders(params: Record<string, unknown> | null): void {
  if (isTilingFixed()) return;
  tilingValues.cols = (params?.cols as number) || 1;
  tilingValues.rows = (params?.rows as number) || 1;
  tilingValues.spaceX = (params?.spaceX as number) || 0;
  tilingValues.spaceY = (params?.spaceY as number) || 0;

  const bgHex = (params?.tilingBg as string) || '#000000';
  const [r, g, b] = hexToRgb(bgHex);
  tilingValues.bgR = r;
  tilingValues.bgG = g;
  tilingValues.bgB = b;

  // Update sliders
  const colsSlider = document.getElementById('tiling-cols') as HTMLInputElement | null;
  const colsValue = document.getElementById('tiling-cols-value') as HTMLSpanElement | null;
  if (colsSlider) colsSlider.value = String(tilingValues.cols);
  if (colsValue) colsValue.textContent = tilingValues.cols.toString();

  const rowsSlider = document.getElementById('tiling-rows') as HTMLInputElement | null;
  const rowsValue = document.getElementById('tiling-rows-value') as HTMLSpanElement | null;
  if (rowsSlider) rowsSlider.value = String(tilingValues.rows);
  if (rowsValue) rowsValue.textContent = tilingValues.rows.toString();

  const spxSlider = document.getElementById('tiling-space-x') as HTMLInputElement | null;
  const spxValue = document.getElementById('tiling-space-x-value') as HTMLSpanElement | null;
  if (spxSlider) spxSlider.value = String(tilingValues.spaceX);
  if (spxValue) spxValue.textContent = tilingValues.spaceX.toFixed(2);

  const spySlider = document.getElementById('tiling-space-y') as HTMLInputElement | null;
  const spyValue = document.getElementById('tiling-space-y-value') as HTMLSpanElement | null;
  if (spySlider) spySlider.value = String(tilingValues.spaceY);
  if (spyValue) spyValue.textContent = tilingValues.spaceY.toFixed(2);

  const bgPicker = document.getElementById('tiling-bg') as HTMLInputElement | null;
  if (bgPicker) bgPicker.value = bgHex;

  sendTilingToFullscreen();
}

export function resetTiling(): void {
  tilingValues.cols = 1;
  tilingValues.rows = 1;
  tilingValues.spaceX = 0;
  tilingValues.spaceY = 0;
  tilingValues.bgR = 0;
  tilingValues.bgG = 0;
  tilingValues.bgB = 0;

  const colsSlider = document.getElementById('tiling-cols') as HTMLInputElement | null;
  const colsValue = document.getElementById('tiling-cols-value') as HTMLSpanElement | null;
  if (colsSlider) colsSlider.value = '1';
  if (colsValue) colsValue.textContent = '1';

  const rowsSlider = document.getElementById('tiling-rows') as HTMLInputElement | null;
  const rowsValue = document.getElementById('tiling-rows-value') as HTMLSpanElement | null;
  if (rowsSlider) rowsSlider.value = '1';
  if (rowsValue) rowsValue.textContent = '1';

  const spxSlider = document.getElementById('tiling-space-x') as HTMLInputElement | null;
  const spxValue = document.getElementById('tiling-space-x-value') as HTMLSpanElement | null;
  if (spxSlider) spxSlider.value = '0';
  if (spxValue) spxValue.textContent = '0.00';

  const spySlider = document.getElementById('tiling-space-y') as HTMLInputElement | null;
  const spyValue = document.getElementById('tiling-space-y-value') as HTMLSpanElement | null;
  if (spySlider) spySlider.value = '0';
  if (spyValue) spyValue.textContent = '0.00';

  const bgPicker = document.getElementById('tiling-bg') as HTMLInputElement | null;
  if (bgPicker) bgPicker.value = '#000000';

  syncToActiveSlot('cols', 1);
  syncToActiveSlot('rows', 1);
  syncToActiveSlot('spaceX', 0);
  syncToActiveSlot('spaceY', 0);
  syncToActiveSlot('tilingBg', '#000000');

  sendTilingToFullscreen();
}
