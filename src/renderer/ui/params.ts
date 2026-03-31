// Parameters module — Custom shader parameter UI.
// Typed version of js/params.js.

import { state } from '../core/state.js';
import type { ParamDef, ParamValue, ParamArrayValue, ParamBinding } from '@shared/types/params.js';
import type { AssetParamDef } from '../renderers/asset-renderer.js';
import { tileState } from '../tiles/tile-state.js';
import { ASSET_PARAM_DEFS, VIDEO_PARAM_DEFS } from '../renderers/asset-renderer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal electronAPI surface used by this module */
declare const window: Window & {
  electronAPI: {
    sendParamUpdate(data: { name: string; value: unknown }): void;
    updateTileParam?(tileIndex: number, paramName: string, value: ParamValue): void;
    setArtNetMappings?(mappings: Array<{ dmxChannel: number; target: unknown }>): void;
  };
};

/** Minimal renderer surface for param interactions */
interface RendererSurface {
  setParam(name: string, value: ParamValue): void;
  getCustomParamDefs(): ParamDef[];
  getCustomParamValues(): Record<string, ParamValue | ParamArrayValue>;
  setBindingEnabled?(paramName: string, enabled: boolean): void;
  getBindingEnabled?(paramName: string): boolean | null;
  getBoundValue?(paramName: string): number | null;
  getBindingStates?(): Record<string, boolean>;
  setBindingStates?(states: Record<string, boolean>): void;
}

/** Grid slot data (runtime shape) */
interface GridSlotLike {
  params?: Record<string, ParamValue> | null;
  customParams?: Record<string, ParamValue> | null;
  renderer?: {
    setSpeed?(speed: number): void;
    setParam?(name: string, value: ParamValue): void;
    getCustomParamDefs?(): AssetParamDef[];
  } | null;
  type?: string;
  label?: string;
  mediaPath?: string;
  shaderCode?: string | null;
  filePath?: string | null;
}

/** Shader tab with slots */
interface ShaderTabLike {
  name: string;
  slots?: Array<GridSlotLike | null>;
}

/** Mixer channel runtime shape */
interface MixerChannelRuntime {
  slotIndex: number | null;
  tabIndex?: number | null;
  alpha: number;
  params: Record<string, ParamValue>;
  customParams: Record<string, ParamValue | ParamArrayValue>;
  renderer: unknown | null;
  shaderCode: string | null;
  assetType?: string | null;
}

/** Color picker input with custom swap callback */
interface ColorPickerInput extends HTMLInputElement {
  _colorSwapApply: (rgb: number[]) => void;
}

import { updateMixerChannelParam } from './mixer.js';
import { saveGridState } from '../grid/grid-persistence.js';
import { setStatus } from './utils.js';
import { parseShaderParams } from '@shared/param-parser.js';
import { loadTilingToSliders } from './tiling.js';
import { showContextMenu, hideContextMenu } from './context-menu.js';
import { getActiveABParamSource, handleABParamChange } from './ab-preview.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let saveGridStateTimeout: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 500;

let usingCustomParams = false;
let draggedColor: number[] | null = null;
let abParamValuesOverride: Record<string, ParamValue | ParamArrayValue> | null = null;

let rightDragState: {
  rgb: number[];
  paramName: string;
  arrayIndex: number | null;
  sourcePicker: ColorPickerInput;
} | null = null;
let rightDragTarget: ColorPickerInput | null = null;

let rightDragListenersInit = false;
let rightSwapOccurred = false;

const selectedColorPickers = new Set<ColorPickerInput>();

// Binding animation: track bound slider elements for periodic value updates
interface BoundSliderEntry {
  paramName: string;
  slider: HTMLInputElement;
  valueDisplay: HTMLSpanElement;
  toggleBtn: HTMLButtonElement;
  isInt: boolean;
}
const boundSliders: BoundSliderEntry[] = [];
let bindingAnimationId: number | null = null;

function startBindingAnimation(): void {
  if (bindingAnimationId !== null) return;
  const update = () => {
    const renderer = state.renderer as RendererSurface | null;
    if (!renderer || boundSliders.length === 0) {
      bindingAnimationId = null;
      return;
    }
    for (const entry of boundSliders) {
      const enabled = renderer.getBindingEnabled?.(entry.paramName);
      const boundVal = renderer.getBoundValue?.(entry.paramName);
      if (enabled && boundVal !== null && boundVal !== undefined) {
        entry.slider.value = String(boundVal);
        entry.valueDisplay.textContent = entry.isInt
          ? Math.round(boundVal).toString()
          : boundVal.toFixed(2);
        if (!entry.slider.classList.contains('bound')) entry.slider.classList.add('bound');
      } else {
        if (entry.slider.classList.contains('bound')) entry.slider.classList.remove('bound');
      }
      // Update toggle button active state
      entry.toggleBtn.classList.toggle('active', !!enabled);
    }
    bindingAnimationId = requestAnimationFrame(update);
  };
  bindingAnimationId = requestAnimationFrame(update);
}

function stopBindingAnimation(): void {
  if (bindingAnimationId !== null) {
    cancelAnimationFrame(bindingAnimationId);
    bindingAnimationId = null;
  }
  boundSliders.length = 0;
}

const MIXER_CHANNEL_COLORS = [
  '#4a9eff', '#ff6b6b', '#51cf66', '#ffd43b',
  '#cc5de8', '#ff922b', '#22b8cf', '#ff8787'
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function debouncedSaveGridState(): void {
  if (saveGridStateTimeout) clearTimeout(saveGridStateTimeout);
  saveGridStateTimeout = setTimeout(() => {
    saveGridState();
    saveGridStateTimeout = null;
  }, SAVE_DEBOUNCE_MS);
}

function channels(): MixerChannelRuntime[] {
  return state.mixerChannels as MixerChannelRuntime[];
}

function tabs(): ShaderTabLike[] {
  return state.shaderTabs as ShaderTabLike[];
}

function slots(): Array<GridSlotLike | null> {
  return state.gridSlots as Array<GridSlotLike | null>;
}

function getRenderer(): RendererSurface {
  return state.renderer as RendererSurface;
}

/** Get current custom param values, respecting A/B mode override */
function getCurrentParamValues(): Record<string, ParamValue | ParamArrayValue> {
  if (state.abEnabled) {
    const abSource = getActiveABParamSource();
    if (abSource) return abSource.paramValues;
  }
  return getRenderer().getCustomParamValues();
}

// ---------------------------------------------------------------------------
// Right-click drag listeners
// ---------------------------------------------------------------------------

function initRightDragListeners(): void {
  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!rightDragState) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const picker = el?.closest?.('.color-picker-input') as ColorPickerInput | null;
    if (picker !== rightDragTarget) {
      rightDragTarget?.classList.remove('color-swap-target');
      rightDragTarget = (picker && picker !== rightDragState.sourcePicker) ? picker : null;
      rightDragTarget?.classList.add('color-swap-target');
    }
  });

  document.addEventListener('mouseup', (e: MouseEvent) => {
    if (!rightDragState || e.button !== 2) return;
    const source = rightDragState;
    source.sourcePicker.classList.remove('color-dragging');

    if (rightDragTarget) {
      rightDragTarget.classList.remove('color-swap-target');
      const targetRgb = hexToRgb(rightDragTarget.value);
      const sourceRgb = [...source.rgb];
      rightDragTarget._colorSwapApply(sourceRgb);
      source.sourcePicker._colorSwapApply(targetRgb);
      rightSwapOccurred = true;
    }

    rightDragState = null;
    rightDragTarget = null;
  });
}

// ---------------------------------------------------------------------------
// Array color picker selection
// ---------------------------------------------------------------------------

function selectArrayColorPickers(arrayName: string, mode: 'odd' | 'even' | 'all' | 'none'): void {
  const container = document.getElementById('custom-params-container');
  if (!container) return;

  const pickers = [...container.querySelectorAll(
    `.color-picker-input[data-array-name="${arrayName}"]`
  )] as ColorPickerInput[];

  // Clear existing selection of these pickers
  for (const picker of pickers) {
    selectedColorPickers.delete(picker);
    picker.classList.remove('color-selected');
  }

  for (const picker of pickers) {
    const idx = parseInt(picker.dataset.arrayIndex!, 10);
    // 1-based convention: odd positions (1st,3rd,5th) = indices 0,2,4
    const select = mode === 'all'
      || (mode === 'odd' && idx % 2 === 0)
      || (mode === 'even' && idx % 2 === 1);
    if (select) {
      selectedColorPickers.add(picker);
      picker.classList.add('color-selected');
    }
  }
}

// ---------------------------------------------------------------------------
// Value editing
// ---------------------------------------------------------------------------

export function makeValueEditable(
  span: HTMLSpanElement,
  slider: HTMLInputElement,
  opts: { isInt?: boolean; onCommit: (value: number) => void }
): void {
  span.style.cursor = 'pointer';
  span.title = 'Click to edit';

  span.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    if (span.querySelector('input')) return;

    const currentText = span.textContent || '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'param-value-input';
    input.value = currentText;

    span.textContent = '';
    span.appendChild(input);
    input.focus();
    input.select();

    function commit(): void {
      const raw = input.value.trim();
      const parsed = opts.isInt ? parseInt(raw, 10) : parseFloat(raw);
      if (isNaN(parsed)) {
        revert();
        return;
      }
      const min = parseFloat(slider.min);
      const max = parseFloat(slider.max);
      const clamped = Math.min(max, Math.max(min, parsed));
      slider.value = String(clamped);
      span.textContent = opts.isInt ? Math.round(clamped).toString() : clamped.toFixed(2);
      opts.onCommit(clamped);
    }

    function revert(): void {
      span.textContent = currentText;
    }

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); revert(); }
    });
    input.addEventListener('blur', commit);
  });
}

// ---------------------------------------------------------------------------
// Color conversion
// ---------------------------------------------------------------------------

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => {
    const hex = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

function hexToRgb(hex: string): number[] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    return [
      parseInt(result[1], 16) / 255,
      parseInt(result[2], 16) / 255,
      parseInt(result[3], 16) / 255
    ];
  }
  return [1, 1, 1];
}

// ---------------------------------------------------------------------------
// Speed / tile param sync
// ---------------------------------------------------------------------------

function syncSpeedToActiveSlot(value: number): void {
  if (state.activeGridSlot !== null && slots()[state.activeGridSlot]) {
    const slot = slots()[state.activeGridSlot]!;
    if (!slot.params) slot.params = {};
    slot.params.speed = value;
    if (slot.renderer?.setSpeed) {
      slot.renderer.setSpeed(value);
    }
  }
}

function updateSelectedTileParam(paramName: string, value: ParamValue): void {
  if (!state.tiledPreviewEnabled) return;

  const tileIndex = state.selectedTileIndex;
  if (tileIndex < 0 || tileIndex >= tileState.tiles.length) return;

  const tile = tileState.tiles[tileIndex];
  if (!tile || tile.gridSlotIndex === null) return;

  if (!tile.params) tile.params = {};
  (tile.params as Record<string, ParamValue>)[paramName] = value;

  window.electronAPI.updateTileParam?.(tileIndex, paramName, value);
  debouncedSaveGridState();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initParams(): void {
  const speedSlider = document.getElementById('param-speed') as HTMLInputElement | null;
  const speedValue = document.getElementById('param-speed-value') as HTMLSpanElement | null;

  if (speedSlider && speedValue) {
    const speedLabel = speedSlider.closest('.param-row')?.querySelector('label');
    if (speedLabel) {
      speedLabel.style.cursor = 'pointer';
      speedLabel.title = 'Double-click to reset';
      speedLabel.addEventListener('dblclick', () => {
        speedSlider.value = '1';
        speedValue.textContent = '1.00';
        if (state.abEnabled) {
          handleABParamChange('speed', 1);
        } else {
          getRenderer().setParam('speed', 1);
          window.electronAPI.sendParamUpdate({ name: 'speed', value: 1 });
          if (state.mixerSelectedChannel !== null) {
            updateMixerChannelParam('speed', 1);
          } else {
            syncSpeedToActiveSlot(1);
          }
        }
        updateSelectedTileParam('speed', 1);
      });
    }

    speedSlider.addEventListener('input', () => {
      const value = parseFloat(speedSlider.value);
      speedValue.textContent = value.toFixed(2);
      if (state.abEnabled) {
        handleABParamChange('speed', value);
      } else {
        getRenderer().setParam('speed', value);
        window.electronAPI.sendParamUpdate({ name: 'speed', value });
        if (state.mixerSelectedChannel !== null) {
          updateMixerChannelParam('speed', value);
        } else {
          syncSpeedToActiveSlot(value);
        }
      }
      updateSelectedTileParam('speed', value);
    });

    makeValueEditable(speedValue, speedSlider, {
      onCommit(value: number) {
        if (state.abEnabled) {
          handleABParamChange('speed', value);
        } else {
          getRenderer().setParam('speed', value);
          window.electronAPI.sendParamUpdate({ name: 'speed', value });
          if (state.mixerSelectedChannel !== null) {
            updateMixerChannelParam('speed', value);
          } else {
            syncSpeedToActiveSlot(value);
          }
        }
        updateSelectedTileParam('speed', value);
      }
    });

    const paramsPanel = document.getElementById('params-panel');
    if (paramsPanel) {
      paramsPanel.addEventListener('click', (e: MouseEvent) => {
        if (selectedColorPickers.size === 0) return;
        if ((e.target as HTMLElement).closest('.color-picker-input')) return;
        for (const picker of selectedColorPickers) {
          picker.classList.remove('color-selected');
        }
        selectedColorPickers.clear();
      });
    }

    speedSlider.addEventListener('dblclick', () => {
      speedSlider.value = '1';
      speedValue.textContent = '1.00';
      if (state.abEnabled) {
        handleABParamChange('speed', 1);
      } else {
        getRenderer().setParam('speed', 1);
        window.electronAPI.sendParamUpdate({ name: 'speed', value: 1 });
        if (state.mixerSelectedChannel !== null) {
          updateMixerChannelParam('speed', 1);
        } else {
          syncSpeedToActiveSlot(1);
        }
      }
      updateSelectedTileParam('speed', 1);
    });
  }

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!e.ctrlKey || !e.altKey) return;
    const code = e.code;
    if (code !== 'KeyA' && code !== 'KeyE' && code !== 'KeyO') return;
    const key = code.charAt(3).toLowerCase();

    e.preventDefault();
    const container = document.getElementById('custom-params-container');
    if (!container) return;

    const pickers = [...container.querySelectorAll('.color-picker-input')] as ColorPickerInput[];
    if (pickers.length === 0) return;

    for (const picker of selectedColorPickers) {
      picker.classList.remove('color-selected');
    }
    selectedColorPickers.clear();

    pickers.forEach((picker, i) => {
      const select = key === 'a'
        || (key === 'e' && i % 2 === 1)
        || (key === 'o' && i % 2 === 0);
      if (select) {
        selectedColorPickers.add(picker);
        picker.classList.add('color-selected');
      }
    });
  });
}

export function initMouseAssignment(): void {
  // Kept for API compatibility
}

export function loadParamsToSliders(
  params: Record<string, ParamValue> | null,
  { skipMixerSync = false }: { skipMixerSync?: boolean } = {}
): void {
  if (!params) return;

  if (params.speed !== undefined) {
    const speedSlider = document.getElementById('param-speed') as HTMLInputElement | null;
    const speedValueEl = document.getElementById('param-speed-value') as HTMLSpanElement | null;
    if (speedSlider) {
      speedSlider.value = String(params.speed);
      if (speedValueEl) speedValueEl.textContent = (params.speed as number).toFixed(2);
      if (state.renderer) getRenderer().setParam('speed', params.speed);
      if (!skipMixerSync && state.mixerSelectedChannel !== null) {
        updateMixerChannelParam('speed', params.speed);
      }
      updateSelectedTileParam('speed', params.speed);
    }
  }

  // Load tiling params (cols/rows), resets to 1×1 if absent
  loadTilingToSliders(params as Record<string, unknown>);

  if (state.renderer) {
    Object.entries(params).forEach(([name, value]) => {
      if (name !== 'speed' && name !== 'cols' && name !== 'rows' && name !== 'spaceX' && name !== 'spaceY' && name !== 'tilingBg') {
        getRenderer().setParam(name, value);
        if (!skipMixerSync && state.mixerSelectedChannel !== null) {
          updateMixerChannelParam(name, value);
        }
        if (state.tiledPreviewEnabled) {
          updateSelectedTileParam(name, value);
        }
      }
    });
  }

  generateCustomParamUI();
}

export function updateParamLabels(_paramNames: string[]): void {
  // No longer needed
}

export function resetParamLabels(): void {
  // No longer needed
}

// =============================================================================
// Dynamic Custom Parameter UI Generation
// =============================================================================

export function generateCustomParamUI(): void {
  const container = document.getElementById('custom-params-container');
  if (!container) return;

  if (state.mixerEnabled && channels().some(ch =>
    ch.renderer || (ch.slotIndex !== null && ch.tabIndex != null)
  )) {
    generateMixerParamsUI(container);
    return;
  }

  const activeSlot = state.activeGridSlot !== null ? slots()[state.activeGridSlot] : null;
  if (activeSlot && activeSlot.type?.startsWith('asset-') && activeSlot.renderer) {
    generateAssetParamUI(container, activeSlot);
    return;
  }

  // A/B mode: use param defs/values from the active AB side
  // This is essential for scenes/compositions where state.renderer can't provide param defs
  if (state.abEnabled) {
    const abSource = getActiveABParamSource();
    if (abSource && abSource.paramDefs.length > 0) {
      renderCustomParamUI(container, abSource.paramDefs, abSource.paramValues);
      return;
    }
  }

  if (!state.renderer) return;

  const params = getRenderer().getCustomParamDefs();
  const values = getRenderer().getCustomParamValues();
  renderCustomParamUI(container, params, values);
}

function renderCustomParamUI(
  container: HTMLElement,
  params: ParamDef[],
  values: Record<string, ParamValue | ParamArrayValue>,
): void {
  stopBindingAnimation();
  selectedColorPickers.clear();
  container.innerHTML = '';

  if (params.length === 0) {
    usingCustomParams = false;
    return;
  }

  usingCustomParams = true;

  // Store values so createParamControl can read them via the getter override
  abParamValuesOverride = values;

  const scalarParams = params.filter(p => !p.isArray && !p.structParent);
  const arrayParams = params.filter(p => p.isArray);
  const structParams = params.filter(p => p.structParent);

  if (scalarParams.length > 0) {
    const section = createParamSection('Shader Parameters');
    scalarParams.forEach(param => {
      const control = createParamControl(param);
      if (control) section.appendChild(control);
    });
    container.appendChild(section);
  }

  arrayParams.forEach(param => {
    const section = createParamSection(param.description || param.name);
    const arrayControls = createArrayParamControls(param);
    arrayControls.forEach(control => section.appendChild(control));
    container.appendChild(section);
  });

  // Group struct params by parent, then by array index
  if (structParams.length > 0) {
    const groups = new Map<string, ParamDef[]>();
    for (const p of structParams) {
      const key = p.structParent!;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }

    for (const [parentName, group] of groups) {
      const section = createParamSection(parentName);
      let lastIndex: number | undefined;

      for (const param of group) {
        if (param.structIndex !== undefined && param.structIndex !== lastIndex) {
          lastIndex = param.structIndex;
          const indexLabel = document.createElement('div');
          indexLabel.className = 'params-section-title';
          indexLabel.textContent = `[${param.structIndex}]`;
          indexLabel.style.marginTop = lastIndex > 0 ? '6px' : '0';
          indexLabel.style.fontSize = '11px';
          indexLabel.style.opacity = '0.7';
          section.appendChild(indexLabel);
        }
        const control = createStructFieldControl(param);
        if (control) section.appendChild(control);
      }

      container.appendChild(section);
    }
  }

  // Clear override after rendering
  abParamValuesOverride = null;

  // Start binding animation if any bound sliders were registered
  if (boundSliders.length > 0) {
    startBindingAnimation();
  }

  // Auto-sync dmx: directive mappings to Art-Net manager
  syncDmxMappingsFromParams(params);
}

export function loadCustomParamsToUI(): void {
  if (!state.renderer || !usingCustomParams) return;
  generateCustomParamUI();
}

export function isUsingCustomParams(): boolean {
  return usingCustomParams;
}

// ---------------------------------------------------------------------------
// DMX directive auto-sync
// ---------------------------------------------------------------------------

/** Component count for GLSL types */
const GLSL_COMPONENTS: Record<string, number> = {
  float: 1, int: 1, vec2: 2, vec3: 3, vec4: 4, color: 3,
};

/**
 * Sync dmx: directive mappings to the Art-Net manager.
 * Creates ArtNetMapping entries for each param with a dmxChannel field,
 * merges with existing non-param mappings, and pushes to main process.
 */
function syncDmxMappingsFromParams(params: ParamDef[]): void {
  const dmxParams = params.filter(p => p.dmxChannel !== undefined);
  if (dmxParams.length === 0) return;
  if (!window.electronAPI?.setArtNetMappings) return;

  const mappings: Array<{ dmxChannel: number; target: { type: string; name?: string } }> = [];

  for (const param of dmxParams) {
    const components = GLSL_COMPONENTS[param.type] || 1;
    const baseChannel = param.dmxChannel!;

    if (components === 1) {
      // Scalar: single mapping (speed param gets special target type)
      mappings.push({
        dmxChannel: baseChannel,
        target: param.name === 'speed'
          ? { type: 'speed' }
          : { type: 'param', name: param.name },
      });
    } else {
      // Vector: one mapping per component using consecutive channels
      const suffixes = ['x', 'y', 'z', 'w'].slice(0, components);
      for (let i = 0; i < components; i++) {
        const ch = baseChannel + i;
        if (ch > 512) break;
        mappings.push({
          dmxChannel: ch,
          target: { type: 'param', name: `${param.name}.${suffixes[i]}` },
        });
      }
    }
  }

  window.electronAPI.setArtNetMappings(mappings);
}

// ---------------------------------------------------------------------------
// Param section / control builders
// ---------------------------------------------------------------------------

function createParamSection(title: string): HTMLDivElement {
  const section = document.createElement('div');
  section.className = 'params-section';

  const titleEl = document.createElement('div');
  titleEl.className = 'params-section-title';
  titleEl.textContent = title;
  section.appendChild(titleEl);

  return section;
}

function createParamControl(
  param: ParamDef,
  index: number | null = null,
  arrayName: string | null = null
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'param-row';

  const paramName = arrayName ? arrayName : param.name;

  const label = document.createElement('label');
  label.textContent = index !== null ? `${index}` : param.name;
  if (param.description && index === null) {
    label.title = param.description;
  }
  label.style.cursor = 'pointer';
  label.addEventListener('dblclick', () => {
    const defaultVal = index !== null ? (param.default as ParamArrayValue)[index] : param.default;
    updateCustomParamValue(paramName, defaultVal as ParamValue, index);
    generateCustomParamUI();
  });
  row.appendChild(label);

  const values = abParamValuesOverride || getRenderer().getCustomParamValues();
  const currentValue = index !== null
    ? (values[paramName] as ParamArrayValue)[index]
    : values[paramName];

  switch (param.type) {
    case 'int':
    case 'float':
      createSliderControl(row, param, currentValue as number, paramName, index);
      break;
    case 'vec2':
      createVec2Control(row, param, currentValue as number[], paramName, index);
      break;
    case 'color':
      createColorControl(row, param, currentValue as number[], paramName, index);
      break;
    case 'vec3':
      createVec3Control(row, param, currentValue as number[], paramName, index);
      break;
    case 'vec4':
      createVec4Control(row, param, currentValue as number[], paramName, index);
      break;
  }

  return row;
}

type ValueChangeFn = (paramName: string, value: ParamValue, arrayIndex: number | null) => void;
type GetFullValueFn = () => number[];

function createSliderControl(
  row: HTMLDivElement,
  param: ParamDef | AssetParamDef,
  value: number,
  paramName: string,
  arrayIndex: number | null,
  onValueChange?: ValueChangeFn
): void {
  const isInt = param.type === 'int';
  const pMin = arrayIndex !== null && (param as any).mins?.[arrayIndex] !== undefined ? (param as any).mins[arrayIndex] : param.min;
  const pMax = arrayIndex !== null && (param as any).maxs?.[arrayIndex] !== undefined ? (param as any).maxs[arrayIndex] : param.max;
  const min = pMin !== null && pMin !== undefined ? pMin : (isInt ? 0 : 0);
  const max = pMax !== null && pMax !== undefined ? pMax : (isInt ? 10 : 1);
  const step = isInt ? 1 : 0.01;
  const update = onValueChange || ((name: string, val: ParamValue, idx: number | null) => updateCustomParamValue(name, val, idx));

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);

  const valueDisplay = document.createElement('span');
  valueDisplay.className = 'param-value';
  valueDisplay.textContent = isInt ? Math.round(value).toString() : value.toFixed(2);

  slider.addEventListener('input', () => {
    const newValue = isInt ? parseInt(slider.value, 10) : parseFloat(slider.value);
    valueDisplay.textContent = isInt ? newValue.toString() : newValue.toFixed(2);
    update(paramName, newValue, arrayIndex);
  });

  slider.addEventListener('dblclick', () => {
    const defaultVal = arrayIndex !== null ? (param.default as number[])[arrayIndex] : param.default as number;
    slider.value = String(defaultVal);
    valueDisplay.textContent = isInt ? Math.round(defaultVal).toString() : (defaultVal as number).toFixed(2);
    update(paramName, defaultVal as number, arrayIndex);
  });

  makeValueEditable(valueDisplay, slider, {
    isInt,
    onCommit(newValue: number) {
      valueDisplay.textContent = isInt ? newValue.toString() : newValue.toFixed(2);
      update(paramName, newValue, arrayIndex);
    }
  });

  row.appendChild(slider);
  row.appendChild(valueDisplay);

  // Add binding toggle button if param has a binding
  const binding = (param as ParamDef).binding;
  if (binding && arrayIndex === null) {
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'bind-toggle';
    toggleBtn.textContent = 'B';
    toggleBtn.title = `Bind to ${binding.source}` +
      (binding.mode === 'add' ? ' (add)' : '') +
      (binding.smooth > 0 ? ` smooth=${binding.smooth}` : '');

    const renderer = state.renderer as RendererSurface | null;
    const isEnabled = renderer?.getBindingEnabled?.(paramName) ?? (binding.toggle === 'on' || binding.toggle === 'always');
    if (isEnabled) toggleBtn.classList.add('active');
    if (binding.toggle === 'always') {
      toggleBtn.classList.add('always');
      toggleBtn.disabled = true;
    }

    toggleBtn.addEventListener('click', () => {
      if (binding.toggle === 'always') return;
      const r = state.renderer as RendererSurface | null;
      if (!r) return;
      const current = r.getBindingEnabled?.(paramName) ?? false;
      r.setBindingEnabled?.(paramName, !current);
      toggleBtn.classList.toggle('active', !current);
      // When disabling, restore base value to slider
      if (current) {
        const base = r.getCustomParamValues()[paramName];
        if (typeof base === 'number') {
          slider.value = String(base);
          valueDisplay.textContent = isInt ? Math.round(base).toString() : base.toFixed(2);
        }
        slider.classList.remove('bound');
      }
      // Save binding states to slot data
      if (state.activeGridSlot !== null && slots()[state.activeGridSlot]) {
        const slot = slots()[state.activeGridSlot]! as Record<string, unknown>;
        const allStates = r.getBindingStates?.() || {};
        if (Object.keys(allStates).length > 0) {
          slot.bindingStates = allStates;
        } else {
          delete slot.bindingStates;
        }
      }
      debouncedSaveGridState();
    });

    row.appendChild(toggleBtn);

    // Register for binding animation updates
    boundSliders.push({ paramName, slider, valueDisplay, toggleBtn, isInt });
  }
}

function createVec2Control(
  row: HTMLDivElement,
  param: ParamDef,
  value: number[],
  paramName: string,
  arrayIndex: number | null,
  onValueChange?: ValueChangeFn,
  getFullValue?: GetFullValueFn
): void {
  const min = param.min !== null ? param.min : 0;
  const max = param.max !== null ? param.max : 1;
  const update = onValueChange || ((name: string, val: ParamValue, idx: number | null) => updateCustomParamValue(name, val, idx));
  const getVal = getFullValue || (() => {
    const vals = getCurrentParamValues();
    return arrayIndex !== null ? [...(vals[paramName] as number[][])[arrayIndex]] : [...(vals[paramName] as number[])];
  });

  // Coerce value elements to numbers (VP presets may store non-numeric types)
  const safeValue = Array.isArray(value) ? value.map(Number) : [0, 0];

  ['X', 'Y'].forEach((axis, i) => {
    const subLabel = document.createElement('label');
    subLabel.textContent = axis;
    subLabel.style.minWidth = '12px';
    row.appendChild(subLabel);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = '0.01';
    slider.value = String(safeValue[i]);
    slider.style.width = '60px';

    const valueDisplay = document.createElement('span');
    valueDisplay.className = 'param-value';
    valueDisplay.textContent = (safeValue[i] || 0).toFixed(2);

    slider.addEventListener('input', () => {
      const newValue = parseFloat(slider.value);
      valueDisplay.textContent = newValue.toFixed(2);
      const fullValue = getVal();
      fullValue[i] = newValue;
      update(paramName, fullValue, arrayIndex);
    });

    makeValueEditable(valueDisplay, slider, {
      isInt: false,
      onCommit(newValue: number) {
        valueDisplay.textContent = newValue.toFixed(2);
        const fullValue = getVal();
        fullValue[i] = newValue;
        update(paramName, fullValue, arrayIndex);
      }
    });

    row.appendChild(slider);
    row.appendChild(valueDisplay);
  });
}

function createColorControl(
  row: HTMLDivElement,
  param: ParamDef,
  value: number[],
  paramName: string,
  arrayIndex: number | null,
  onValueChange?: ValueChangeFn,
  getFullValue?: GetFullValueFn
): void {
  row.className = 'color-row color-picker-row';
  const update = onValueChange || ((name: string, val: ParamValue, idx: number | null) => updateCustomParamValue(name, val, idx));
  const getVal = getFullValue || (() => {
    const vals = getCurrentParamValues();
    return arrayIndex !== null ? [...(vals[paramName] as number[][])[arrayIndex]] : [...(vals[paramName] as number[])];
  });

  // Coerce value elements to numbers (VP presets may store non-numeric types)
  const safeValue = Array.isArray(value) ? value.map(Number) : [0, 0, 0];

  const colorPicker = document.createElement('input') as ColorPickerInput;
  colorPicker.type = 'color';
  colorPicker.className = 'color-picker-input';
  colorPicker.value = rgbToHex(safeValue[0], safeValue[1], safeValue[2]);
  colorPicker.title = 'Click to pick color';

  const slidersDiv = document.createElement('div');
  slidersDiv.className = 'color-sliders';

  const channelNames = ['R', 'G', 'B'];
  const classes = ['color-red', 'color-green', 'color-blue'];
  const sliders: HTMLInputElement[] = [];

  channelNames.forEach((channel, i) => {
    const sliderWrapper = document.createElement('div');
    sliderWrapper.className = 'color-slider-wrapper';

    const subLabel = document.createElement('label');
    subLabel.textContent = channel;
    subLabel.className = classes[i];
    sliderWrapper.appendChild(subLabel);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.01';
    slider.value = String(safeValue[i]);
    sliders.push(slider);

    slider.addEventListener('input', () => {
      const fullValue = getVal();
      fullValue[i] = parseFloat(slider.value);
      colorPicker.value = rgbToHex(fullValue[0], fullValue[1], fullValue[2]);
      update(paramName, fullValue, arrayIndex);
    });

    sliderWrapper.appendChild(slider);
    slidersDiv.appendChild(sliderWrapper);
  });

  colorPicker.addEventListener('click', (e: MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      if (selectedColorPickers.has(colorPicker)) {
        selectedColorPickers.delete(colorPicker);
        colorPicker.classList.remove('color-selected');
      } else {
        selectedColorPickers.add(colorPicker);
        colorPicker.classList.add('color-selected');
      }
    }
  });

  colorPicker.addEventListener('input', () => {
    const rgb = hexToRgb(colorPicker.value);
    sliders.forEach((slider, i) => { slider.value = String(rgb[i]); });
    update(paramName, rgb, arrayIndex);

    if (selectedColorPickers.has(colorPicker)) {
      for (const picker of selectedColorPickers) {
        if (picker === colorPicker) continue;
        picker._colorSwapApply(rgb);
      }
    }
  });

  colorPicker._colorSwapApply = (rgb: number[]) => {
    colorPicker.value = rgbToHex(rgb[0], rgb[1], rgb[2]);
    sliders.forEach((slider, i) => { slider.value = String(rgb[i]); });
    update(paramName, rgb, arrayIndex);
  };

  // Tag array color pickers for selection queries
  if (arrayIndex !== null) {
    colorPicker.dataset.arrayName = paramName;
    colorPicker.dataset.arrayIndex = String(arrayIndex);
  }

  if (!rightDragListenersInit) {
    initRightDragListeners();
    rightDragListenersInit = true;
  }
  colorPicker.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    // Skip if a drag-swap just happened
    if (rightSwapOccurred) { rightSwapOccurred = false; return; }
    // Show selection context menu for array color pickers
    if (arrayIndex === null) return;
    hideContextMenu('color-select-menu');
    showContextMenu(e.clientX, e.clientY, [
      {
        label: 'Select Odd',
        action: () => selectArrayColorPickers(paramName, 'odd'),
      },
      {
        label: 'Select Even',
        action: () => selectArrayColorPickers(paramName, 'even'),
      },
      { separator: true },
      {
        label: 'Select All',
        action: () => selectArrayColorPickers(paramName, 'all'),
      },
      {
        label: 'Deselect All',
        action: () => selectArrayColorPickers(paramName, 'none'),
      },
    ], { menuId: 'color-select-menu' });
  });
  colorPicker.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 2) return;
    e.preventDefault();
    const rgb = getVal();
    rightDragState = { rgb: [...rgb], paramName, arrayIndex, sourcePicker: colorPicker };
    colorPicker.classList.add('color-dragging');
  });

  colorPicker.draggable = true;
  colorPicker.addEventListener('dragstart', (e: DragEvent) => {
    draggedColor = [...getVal()];
    e.dataTransfer!.effectAllowed = 'copy';
    colorPicker.classList.add('color-dragging');
  });
  colorPicker.addEventListener('dragend', () => {
    draggedColor = null;
    colorPicker.classList.remove('color-dragging');
  });
  colorPicker.addEventListener('dragover', (e: DragEvent) => {
    if (draggedColor) {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      colorPicker.classList.add('color-drop-target');
    }
  });
  colorPicker.addEventListener('dragleave', () => {
    colorPicker.classList.remove('color-drop-target');
  });
  colorPicker.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    colorPicker.classList.remove('color-drop-target');
    if (!draggedColor) return;
    const rgb = [...draggedColor];
    colorPicker.value = rgbToHex(rgb[0], rgb[1], rgb[2]);
    sliders.forEach((slider, i) => { slider.value = String(rgb[i]); });
    update(paramName, rgb, arrayIndex);
  });

  row.appendChild(colorPicker);
  row.appendChild(slidersDiv);
}

function createVec3Control(
  row: HTMLDivElement,
  param: ParamDef,
  value: number[],
  paramName: string,
  arrayIndex: number | null,
  onValueChange?: ValueChangeFn,
  getFullValue?: GetFullValueFn
): void {
  const min = param.min !== null ? param.min : 0;
  const max = param.max !== null ? param.max : 1;
  const update = onValueChange || ((name: string, val: ParamValue, idx: number | null) => updateCustomParamValue(name, val, idx));
  const getVal = getFullValue || (() => {
    const vals = getCurrentParamValues();
    return arrayIndex !== null ? [...(vals[paramName] as number[][])[arrayIndex]] : [...(vals[paramName] as number[])];
  });

  // Coerce value elements to numbers (VP presets may store non-numeric types)
  const safeValue = Array.isArray(value) ? value.map(Number) : [0, 0, 0];

  ['X', 'Y', 'Z'].forEach((axis, i) => {
    const subLabel = document.createElement('label');
    subLabel.textContent = axis;
    subLabel.style.minWidth = '12px';
    row.appendChild(subLabel);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = '0.01';
    slider.value = String(safeValue[i]);
    slider.style.width = '50px';

    const valueDisplay = document.createElement('span');
    valueDisplay.className = 'param-value';
    valueDisplay.textContent = (safeValue[i] || 0).toFixed(2);

    slider.addEventListener('input', () => {
      const newValue = parseFloat(slider.value);
      valueDisplay.textContent = newValue.toFixed(2);
      const fullValue = getVal();
      fullValue[i] = newValue;
      update(paramName, fullValue, arrayIndex);
    });

    makeValueEditable(valueDisplay, slider, {
      isInt: false,
      onCommit(newValue: number) {
        valueDisplay.textContent = newValue.toFixed(2);
        const fullValue = getVal();
        fullValue[i] = newValue;
        update(paramName, fullValue, arrayIndex);
      }
    });

    row.appendChild(slider);
    row.appendChild(valueDisplay);
  });
}

function createVec4Control(
  row: HTMLDivElement,
  param: ParamDef,
  value: number[],
  paramName: string,
  arrayIndex: number | null,
  onValueChange?: ValueChangeFn,
  getFullValue?: GetFullValueFn
): void {
  const min = param.min !== null ? param.min : 0;
  const max = param.max !== null ? param.max : 1;
  const update = onValueChange || ((name: string, val: ParamValue, idx: number | null) => updateCustomParamValue(name, val, idx));
  const getVal = getFullValue || (() => {
    const vals = getCurrentParamValues();
    return arrayIndex !== null ? [...(vals[paramName] as number[][])[arrayIndex]] : [...(vals[paramName] as number[])];
  });

  // Coerce value elements to numbers (VP presets may store non-numeric types)
  const safeValue = Array.isArray(value) ? value.map(Number) : [0, 0, 0, 0];

  ['X', 'Y', 'Z', 'W'].forEach((axis, i) => {
    const subLabel = document.createElement('label');
    subLabel.textContent = axis;
    subLabel.style.minWidth = '12px';
    row.appendChild(subLabel);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = '0.01';
    slider.value = String(safeValue[i]);
    slider.style.width = '50px';

    const valueDisplay = document.createElement('span');
    valueDisplay.className = 'param-value';
    valueDisplay.textContent = (safeValue[i] || 0).toFixed(2);

    slider.addEventListener('input', () => {
      const newValue = parseFloat(slider.value);
      valueDisplay.textContent = newValue.toFixed(2);
      const fullValue = getVal();
      fullValue[i] = newValue;
      update(paramName, fullValue, arrayIndex);
    });

    makeValueEditable(valueDisplay, slider, {
      isInt: false,
      onCommit(newValue: number) {
        valueDisplay.textContent = newValue.toFixed(2);
        const fullValue = getVal();
        fullValue[i] = newValue;
        update(paramName, fullValue, arrayIndex);
      }
    });

    row.appendChild(slider);
    row.appendChild(valueDisplay);
  });
}

function createStructFieldControl(param: ParamDef): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'param-row';

  const label = document.createElement('label');
  label.textContent = param.description || param.structField || param.name;
  label.style.cursor = 'pointer';
  label.addEventListener('dblclick', () => {
    updateCustomParamValue(param.name, param.default as ParamValue, null);
    generateCustomParamUI();
  });
  row.appendChild(label);

  const values = abParamValuesOverride || getRenderer().getCustomParamValues();
  const currentValue = values[param.name];

  switch (param.type) {
    case 'int':
    case 'float':
      createSliderControl(row, param, currentValue as number, param.name, null);
      break;
    case 'vec2':
      createVec2Control(row, param, currentValue as number[], param.name, null);
      break;
    case 'color':
      createColorControl(row, param, currentValue as number[], param.name, null);
      break;
    case 'vec3':
      createVec3Control(row, param, currentValue as number[], param.name, null);
      break;
    case 'vec4':
      createVec4Control(row, param, currentValue as number[], param.name, null);
      break;
  }

  return row;
}

function createArrayParamControls(param: ParamDef): HTMLDivElement[] {
  const controls: HTMLDivElement[] = [];
  for (let i = 0; i < (param.arraySize || 0); i++) {
    const control = createParamControl(param, i, param.name);
    controls.push(control);
  }
  return controls;
}

// ---------------------------------------------------------------------------
// Custom param value updates
// ---------------------------------------------------------------------------

function updateCustomParamValue(
  paramName: string,
  value: ParamValue,
  arrayIndex: number | null = null
): void {
  // In A/B mode, route param changes to the active side's renderer
  if (state.abEnabled) {
    let fullValue: ParamValue = value;
    if (arrayIndex !== null) {
      const values = getCurrentParamValues();
      const arr = values[paramName];
      if (arr && Array.isArray(arr)) {
        (arr as ParamValue[])[arrayIndex] = value;
        fullValue = arr as ParamValue;
      }
    }
    handleABParamChange(paramName, fullValue);
    updateSelectedTileParam(paramName, fullValue);
    return;
  }

  if (!state.renderer) return;

  if (arrayIndex !== null) {
    const values = getRenderer().getCustomParamValues();
    const arr = values[paramName];
    if (arr && Array.isArray(arr)) {
      (arr as ParamValue[])[arrayIndex] = value;
      getRenderer().setParam(paramName, arr as ParamValue);
    }
  } else {
    getRenderer().setParam(paramName, value);
  }

  const fullValue = arrayIndex !== null
    ? getRenderer().getCustomParamValues()[paramName]
    : value;
  window.electronAPI.sendParamUpdate({ name: paramName, value: fullValue });

  const paramValue = getRenderer().getCustomParamValues()[paramName] as ParamValue;
  if (state.mixerSelectedChannel !== null) {
    updateMixerChannelParam(paramName, paramValue);
  } else if (state.activeGridSlot !== null && slots()[state.activeGridSlot]) {
    const slot = slots()[state.activeGridSlot]!;
    if (!slot.customParams) slot.customParams = {};
    slot.customParams[paramName] = paramValue;
    if (slot.renderer?.setParam) {
      slot.renderer.setParam(paramName, paramValue);
    }
    debouncedSaveGridState();
  }

  if (state.tiledPreviewEnabled) {
    const tileIndex = state.selectedTileIndex;
    if (tileIndex >= 0 && tileIndex < tileState.tiles.length) {
      const tile = tileState.tiles[tileIndex];
      if (tile && tile.gridSlotIndex !== null) {
        if (!tile.customParams) tile.customParams = {};
        (tile.customParams as Record<string, ParamValue>)[paramName] = fullValue as ParamValue;
        window.electronAPI.updateTileParam?.(tileIndex, paramName, fullValue as ParamValue);
      }
    }
  }
}

// =============================================================================
// Asset Parameter UI (non-mixer standalone)
// =============================================================================

function generateAssetParamUI(container: HTMLElement, slotData: GridSlotLike): void {
  selectedColorPickers.clear();
  container.innerHTML = '';
  usingCustomParams = true;

  const assetRenderer = slotData.renderer;
  if (!assetRenderer) return;

  const params = assetRenderer.getCustomParamDefs?.() || [];
  if (params.length === 0) return;

  const section = createParamSection(`Asset: ${slotData.label || slotData.mediaPath || 'untitled'}`);

  params.forEach((param: AssetParamDef) => {
    const row = document.createElement('div');
    row.className = 'param-row';

    const label = document.createElement('label');
    label.textContent = param.name;
    if (param.description) label.title = param.description;
    row.appendChild(label);

    const currentValue = slotData.customParams?.[param.name] !== undefined
      ? slotData.customParams[param.name] as number
      : param.default;

    const isInt = param.type === 'int';
    const min = param.min !== undefined ? param.min : 0;
    const max = param.max !== undefined ? param.max : (isInt ? 10 : 1);
    const step = param.step || (isInt ? 1 : 0.01);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(currentValue);

    const valueDisplay = document.createElement('span');
    valueDisplay.className = 'param-value';
    valueDisplay.textContent = isInt ? Math.round(currentValue).toString() : Number(currentValue).toFixed(2);

    const updateParam = (name: string, val: number): void => {
      assetRenderer.setParam?.(name, val);
      if (slotData.customParams) slotData.customParams[name] = val;
      if (state.renderMode === 'asset') {
        window.electronAPI.sendParamUpdate({ name, value: val });
      }
      debouncedSaveGridState();
    };

    slider.addEventListener('input', () => {
      const newValue = isInt ? parseInt(slider.value, 10) : parseFloat(slider.value);
      valueDisplay.textContent = isInt ? newValue.toString() : newValue.toFixed(2);
      updateParam(param.name, newValue);
    });

    slider.addEventListener('dblclick', () => {
      slider.value = String(param.default);
      valueDisplay.textContent = isInt ? Math.round(param.default).toString() : Number(param.default).toFixed(2);
      updateParam(param.name, param.default);
    });

    row.appendChild(slider);
    row.appendChild(valueDisplay);
    section.appendChild(row);
  });

  container.appendChild(section);
}

// =============================================================================
// Mixer Multi-Channel Parameter UI
// =============================================================================

function generateMixerParamsUI(container: HTMLElement): void {
  selectedColorPickers.clear();
  container.innerHTML = '';
  usingCustomParams = true;

  for (let i = 0; i < channels().length; i++) {
    const ch = channels()[i];

    const hasSource = ch.renderer || (ch.slotIndex !== null && ch.tabIndex != null);
    if (!hasSource) continue;

    let slotData: GridSlotLike | null = null;
    if (ch.slotIndex !== null && ch.tabIndex != null) {
      const tab = tabs()[ch.tabIndex];
      slotData = tab?.slots?.[ch.slotIndex] || null;
    }
    const isAsset = ch.assetType || slotData?.type?.startsWith('asset-');

    let params: ParamDef[] | AssetParamDef[];
    if (isAsset) {
      const isVideo = ch.assetType === 'asset-video' || slotData?.type === 'asset-video';
      params = isVideo ? [...ASSET_PARAM_DEFS, ...VIDEO_PARAM_DEFS] : [...ASSET_PARAM_DEFS];
    } else {
      let shaderCode = ch.shaderCode;
      if (!shaderCode && slotData) {
        shaderCode = slotData.shaderCode || null;
      }
      if (!shaderCode) continue;

      params = parseShaderParams(shaderCode);
      if (params.length === 0) continue;
    }

    let filename: string | null = null;
    if (slotData) {
      filename = isAsset
        ? (slotData.label || slotData.mediaPath || null)
        : (slotData.filePath?.split('/').pop()?.split('\\').pop() || null);
    }
    const channelLabel = `Ch ${i + 1}: ${filename || (isAsset ? 'Asset' : 'Mix Preset')}`;
    const accentColor = MIXER_CHANNEL_COLORS[i % MIXER_CHANNEL_COLORS.length];

    const section = document.createElement('div');
    section.className = 'params-section mixer-channel-section';
    section.style.borderLeftColor = accentColor;

    const titleEl = document.createElement('div');
    titleEl.className = 'params-section-title mixer-channel-title';
    titleEl.textContent = channelLabel;
    titleEl.style.color = accentColor;

    if (state.mixerSelectedChannel === i) {
      section.classList.add('mixer-channel-selected');
    }

    titleEl.style.cursor = 'pointer';
    titleEl.addEventListener('click', () => {
      const btns = document.querySelectorAll('#mixer-channels .mixer-btn');
      btns.forEach(b => b.classList.remove('selected'));
      btns[i]?.classList.add('selected');
      state.mixerSelectedChannel = i;

      container.querySelectorAll('.mixer-channel-section').forEach(s =>
        s.classList.remove('mixer-channel-selected')
      );
      section.classList.add('mixer-channel-selected');
    });

    section.appendChild(titleEl);

    const scalarParams = params.filter((p: ParamDef | AssetParamDef) => !(p as ParamDef).isArray);
    const arrayParams = params.filter((p: ParamDef | AssetParamDef) => (p as ParamDef).isArray);

    scalarParams.forEach((param: ParamDef | AssetParamDef) => {
      const control = createMixerParamControl(param as ParamDef, i, ch, null, null);
      if (control) section.appendChild(control);
    });

    arrayParams.forEach((param: ParamDef | AssetParamDef) => {
      const p = param as ParamDef;
      const arrayTitle = document.createElement('div');
      arrayTitle.className = 'params-section-title';
      arrayTitle.textContent = p.description || p.name;
      arrayTitle.style.marginTop = '8px';
      section.appendChild(arrayTitle);
      for (let ai = 0; ai < (p.arraySize || 0); ai++) {
        const control = createMixerParamControl(p, i, ch, ai, p.name);
        if (control) section.appendChild(control);
      }
    });

    container.appendChild(section);
  }
}

function createMixerParamControl(
  param: ParamDef,
  channelIndex: number,
  ch: MixerChannelRuntime,
  arrayIndex: number | null,
  arrayName: string | null
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'param-row';

  const paramName = arrayName || param.name;

  const label = document.createElement('label');
  label.textContent = arrayIndex !== null ? `${arrayIndex}` : param.name;
  if (param.description && arrayIndex === null) {
    label.title = param.description;
  }
  label.style.cursor = 'pointer';
  label.addEventListener('dblclick', () => {
    const defaultVal = arrayIndex !== null ? (param.default as ParamArrayValue)[arrayIndex] : param.default;
    updateMixerChannelParamDirect(channelIndex, paramName, defaultVal as ParamValue, arrayIndex);
    generateCustomParamUI();
  });
  row.appendChild(label);

  let currentValue: ParamValue;
  if (arrayIndex !== null) {
    const arr = ch.customParams[paramName];
    currentValue = arr ? (arr as ParamArrayValue)[arrayIndex] : (param.default as ParamArrayValue)[arrayIndex];
  } else {
    currentValue = ch.customParams[paramName] !== undefined
      ? ch.customParams[paramName] as ParamValue
      : param.default as ParamValue;
  }

  const onValueChange: ValueChangeFn = (name, val, idx) => updateMixerChannelParamDirect(channelIndex, name, val, idx);
  const getFullValueFn: GetFullValueFn = () => getMixerParamValue(ch, paramName, arrayIndex);

  switch (param.type) {
    case 'int':
    case 'float':
      createSliderControl(row, param, currentValue as number, paramName, arrayIndex, onValueChange);
      break;
    case 'vec2':
      createVec2Control(row, param, currentValue as number[], paramName, arrayIndex, onValueChange, getFullValueFn);
      break;
    case 'color':
      createColorControl(row, param, currentValue as number[], paramName, arrayIndex, onValueChange, getFullValueFn);
      break;
    case 'vec3':
      createVec3Control(row, param, currentValue as number[], paramName, arrayIndex, onValueChange, getFullValueFn);
      break;
    case 'vec4':
      createVec4Control(row, param, currentValue as number[], paramName, arrayIndex, onValueChange, getFullValueFn);
      break;
  }

  return row;
}

function getMixerParamValue(ch: MixerChannelRuntime, paramName: string, arrayIndex: number | null): number[] {
  const val = ch.customParams[paramName];
  if (arrayIndex !== null && Array.isArray(val)) {
    return Array.isArray((val as ParamArrayValue)[arrayIndex]) ? [...((val as number[][])[arrayIndex])] : [(val as number[])[arrayIndex]];
  }
  return Array.isArray(val) ? [...(val as number[])] : [val as number];
}

function updateMixerChannelParamDirect(
  channelIndex: number,
  paramName: string,
  value: ParamValue,
  arrayIndex: number | null
): void {
  const ch = channels()[channelIndex];
  if (!ch) return;

  if (arrayIndex !== null) {
    if (!ch.customParams[paramName]) ch.customParams[paramName] = [] as unknown as ParamValue;
    (ch.customParams[paramName] as ParamArrayValue)[arrayIndex] = value;
  } else {
    ch.customParams[paramName] = value;
  }

  const fullValue = ch.customParams[paramName];

  // Sync to fullscreen via IPC
  (window.electronAPI as { sendMixerParamUpdate?: (d: Record<string, unknown>) => void })
    .sendMixerParamUpdate?.({ channelIndex, paramName, value: fullValue });

  if (ch.slotIndex !== null && ch.tabIndex != null) {
    const tab = tabs()[ch.tabIndex];
    const slotData = tab?.slots?.[ch.slotIndex];
    if (slotData?.renderer?.setParam) {
      slotData.renderer.setParam(paramName, fullValue as ParamValue);
    }
  }

  if (state.mixerSelectedChannel === channelIndex && state.renderer) {
    getRenderer().setParam(paramName, fullValue as ParamValue);
    window.electronAPI.sendParamUpdate({ name: paramName, value: fullValue });
  }

  debouncedSaveGridState();
}
