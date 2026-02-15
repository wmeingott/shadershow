// Presets module - Local shader presets only
// Typed version of js/presets.js.

import type { ParamDef, ParamValue, ParamArrayValue } from '@shared/types/params.js';
import { state } from '../core/state.js';
import { tileState } from '../tiles/tile-state.js';

import { setStatus } from './utils.js';
import { saveGridState } from '../grid/grid-persistence.js';
import { loadParamsToSliders, generateCustomParamUI } from './params.js';
import { updateMixerChannelParam } from './mixer.js';

// ---------------------------------------------------------------------------
// window.electronAPI subset used in this module
// ---------------------------------------------------------------------------

interface PresetElectronAPI {
  sendParamUpdate(data: { name: string; value: unknown }): void;
  sendPresetSync(data: { type: string; index: number; params: Record<string, unknown> }): void;
}

declare const window: Window & { electronAPI: PresetElectronAPI };

// ---------------------------------------------------------------------------
// Cast interfaces for loosely-typed state members
// ---------------------------------------------------------------------------

interface RendererLike {
  getParams(): Record<string, unknown>;
  setParam(name: string, value: unknown): void;
  getCustomParamDefs?(): ParamDef[];
  setSpeed(v: number): void;
}

interface PresetEntry {
  params: Record<string, unknown>;
  name: string | null;
}

interface GridSlotData {
  presets?: PresetEntry[];
  params?: Record<string, unknown>;
  customParams?: Record<string, unknown>;
  renderer?: { setSpeed(v: number): void };
}

interface EditorLike {
  isFocused(): boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deep clone params to avoid shared array/object references between presets and renderer */
function cloneParams<T>(params: T): T {
  return JSON.parse(JSON.stringify(params)) as T;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function initPresets(): Promise<void> {
  // Local preset add button
  const addLocalBtn = document.getElementById('btn-add-local-preset') as HTMLElement;
  addLocalBtn.addEventListener('click', () => addLocalPreset());

  // Reset to default button
  const resetBtn = document.getElementById('btn-reset-params') as HTMLElement | null;
  if (resetBtn) {
    resetBtn.addEventListener('click', () => resetToDefaults());
  }

  // Number keys 1-9, 0 recall local presets (when editor not focused)
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const editor = state.editor as EditorLike | null;
    if (editor && editor.isFocused()) return;
    if (
      document.activeElement &&
      (document.activeElement.tagName === 'INPUT' ||
        document.activeElement.tagName === 'TEXTAREA')
    ) {
      return;
    }

    const key = e.key;
    let presetIndex = -1;
    if (key >= '1' && key <= '9') presetIndex = parseInt(key) - 1;
    else if (key === '0') presetIndex = 9;

    if (presetIndex >= 0) {
      e.preventDefault();
      recallLocalPreset(presetIndex);
    }
  });
}

/** Reset parameters to shader defaults */
export function resetToDefaults(): void {
  const renderer = state.renderer as RendererLike | null;
  if (!renderer) {
    setStatus('No shader loaded', 'error');
    return;
  }

  // Get custom param definitions with default values
  const paramDefs: ParamDef[] = renderer.getCustomParamDefs?.() || [];

  // Reset speed to 1
  renderer.setParam('speed', 1);
  const speedSlider = document.getElementById('param-speed') as HTMLInputElement | null;
  const speedValue = document.getElementById('param-speed-value') as HTMLElement | null;
  if (speedSlider) {
    speedSlider.value = '1';
    if (speedValue) speedValue.textContent = '1.00';
  }

  // Reset each custom param to its default
  paramDefs.forEach((param: ParamDef) => {
    if (param.default !== undefined) {
      renderer.setParam(param.name, param.default);
    }
  });

  // Regenerate UI to show default values
  generateCustomParamUI();

  // Update selected tile if in tiled mode
  if (state.tiledPreviewEnabled) {
    const defaultParams: Record<string, ParamValue | ParamArrayValue> = { speed: 1 };
    paramDefs.forEach((param: ParamDef) => {
      if (param.default !== undefined) {
        defaultParams[param.name] = param.default;
      }
    });
    applyParamsToSelectedTile(defaultParams);
  }

  // Sync to fullscreen
  window.electronAPI.sendParamUpdate({ name: 'speed', value: 1 });
  paramDefs.forEach((param: ParamDef) => {
    if (param.default !== undefined) {
      window.electronAPI.sendParamUpdate({ name: param.name, value: param.default });
    }
  });

  setStatus('Parameters reset to defaults', 'success');
}

/** Update local presets UI when shader selection changes */
export function updateLocalPresetsUI(): void {
  const localRow = document.getElementById('local-presets-row') as HTMLElement;
  const addBtn = document.getElementById('btn-add-local-preset') as HTMLElement;
  const hint = document.getElementById('no-shader-hint') as HTMLElement;

  // Clear existing local preset buttons
  const existingBtns = localRow.querySelectorAll('.preset-btn.local-preset');
  existingBtns.forEach((btn: Element) => btn.remove());

  if (state.activeGridSlot === null || !state.gridSlots[state.activeGridSlot]) {
    // No shader selected
    hint.classList.remove('hidden');
    addBtn.classList.add('hidden');
    return;
  }

  // Shader is selected
  hint.classList.add('hidden');
  addBtn.classList.remove('hidden');

  // Ensure presets array exists for this slot
  const slotData = state.gridSlots[state.activeGridSlot] as GridSlotData;
  if (!slotData.presets) {
    slotData.presets = [];
  }

  // Create buttons for local presets
  const presets: PresetEntry[] = slotData.presets;
  presets.forEach((_preset: PresetEntry, index: number) => {
    createLocalPresetButton(index);
  });
}

export function recallLocalPreset(index: number, fromSync: boolean = false): void {
  if (state.activeGridSlot === null || !state.gridSlots[state.activeGridSlot]) return;
  const slotData = state.gridSlots[state.activeGridSlot] as GridSlotData;
  const presets: PresetEntry[] = slotData.presets || [];
  if (index >= presets.length) return;

  const preset: PresetEntry = presets[index];
  const params: Record<string, unknown> = cloneParams(preset.params);
  // loadParamsToSliders routes to mixer channel automatically when one is selected
  loadParamsToSliders(params);

  // Update selected tile if in tiled mode
  if (state.tiledPreviewEnabled) {
    applyParamsToSelectedTile(params as Record<string, ParamValue | ParamArrayValue>);
  }

  // Update active highlighting
  updateActiveLocalPreset(index);

  // Sync to fullscreen (unless this call came from sync)
  if (!fromSync) {
    window.electronAPI.sendPresetSync({
      type: 'local',
      index: index,
      params: params as Record<string, unknown>,
    });
  }

  const name: string = preset.name || `Preset ${index + 1}`;
  setStatus(`${name} loaded`, 'success');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function addLocalPreset(): void {
  const renderer = state.renderer as RendererLike | null;
  if (state.activeGridSlot === null || !state.gridSlots[state.activeGridSlot]) {
    setStatus('Select a shader first', 'error');
    return;
  }

  const params: Record<string, unknown> = cloneParams(renderer!.getParams());
  const slotData = state.gridSlots[state.activeGridSlot] as GridSlotData;
  if (!slotData.presets) {
    slotData.presets = [];
  }

  const presetIndex: number = slotData.presets.length;
  slotData.presets.push({ params, name: null });

  createLocalPresetButton(presetIndex);
  saveGridState();
  setStatus(`Preset ${presetIndex + 1} saved`, 'success');
}

function createLocalPresetButton(index: number): void {
  const localRow = document.getElementById('local-presets-row') as HTMLElement;
  const addBtn = document.getElementById('btn-add-local-preset') as HTMLElement;

  const btn: HTMLButtonElement = document.createElement('button');
  btn.className = 'preset-btn local-preset';
  updateLocalPresetButtonLabel(btn, index);
  btn.dataset.presetIndex = String(index);
  btn.dataset.presetType = 'local';

  btn.addEventListener('click', () => recallLocalPreset(index));
  btn.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    showPresetContextMenu(e.clientX, e.clientY, index, btn);
  });

  localRow.insertBefore(btn, addBtn);
}

function updateLocalPresetButtonLabel(btn: HTMLElement, index: number): void {
  if (state.activeGridSlot === null || !state.gridSlots[state.activeGridSlot]) return;
  const slotData = state.gridSlots[state.activeGridSlot] as GridSlotData;
  const presets: PresetEntry[] = slotData.presets || [];
  const preset: PresetEntry | undefined = presets[index];
  const label: string = preset && preset.name ? preset.name : String(index + 1);
  btn.textContent = label;
  btn.title =
    preset && preset.name
      ? `${preset.name} (right-click for options)`
      : `Preset ${index + 1} (right-click for options)`;
}

function showPresetContextMenu(
  x: number,
  y: number,
  index: number,
  btn: HTMLElement,
): void {
  hidePresetContextMenu();

  const menu: HTMLDivElement = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'preset-context-menu';

  // Update option
  const updateItem: HTMLDivElement = document.createElement('div');
  updateItem.className = 'context-menu-item';
  updateItem.textContent = 'Update';
  updateItem.addEventListener('click', () => {
    hidePresetContextMenu();
    updateLocalPreset(index);
  });
  menu.appendChild(updateItem);

  // Rename option
  const renameItem: HTMLDivElement = document.createElement('div');
  renameItem.className = 'context-menu-item';
  renameItem.textContent = 'Rename...';
  renameItem.addEventListener('click', () => {
    hidePresetContextMenu();
    showRenamePresetDialog(index, btn);
  });
  menu.appendChild(renameItem);

  // Delete option
  const deleteItem: HTMLDivElement = document.createElement('div');
  deleteItem.className = 'context-menu-item';
  deleteItem.textContent = 'Delete';
  deleteItem.addEventListener('click', () => {
    hidePresetContextMenu();
    deleteLocalPreset(index, btn);
  });
  menu.appendChild(deleteItem);

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Adjust position if menu goes off screen
  const rect: DOMRect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${window.innerWidth - rect.width - 5}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${window.innerHeight - rect.height - 5}px`;
  }

  setTimeout(() => {
    document.addEventListener('click', hidePresetContextMenu, { once: true });
  }, 0);
}

function hidePresetContextMenu(): void {
  const menu = document.getElementById('preset-context-menu');
  if (menu) menu.remove();
}

function showRenamePresetDialog(index: number, btn: HTMLElement): void {
  const slotData = state.gridSlots[state.activeGridSlot!] as GridSlotData | undefined;
  const presets: PresetEntry[] = slotData?.presets || [];
  const preset: PresetEntry | undefined = presets[index];
  const defaultName: string = `Preset ${index + 1}`;
  const currentName: string = preset?.name || defaultName;

  const overlay: HTMLDivElement = document.createElement('div');
  overlay.id = 'rename-preset-overlay';
  overlay.className = 'dialog-overlay';

  const dialog: HTMLDivElement = document.createElement('div');
  dialog.className = 'rename-dialog';

  const header: HTMLDivElement = document.createElement('div');
  header.className = 'dialog-header';
  header.textContent = 'Rename Preset';
  dialog.appendChild(header);

  const input: HTMLInputElement = document.createElement('input');
  input.type = 'text';
  input.id = 'preset-name-input';
  input.value = currentName;
  input.maxLength = 12;
  input.placeholder = 'Preset name';
  dialog.appendChild(input);

  const buttons: HTMLDivElement = document.createElement('div');
  buttons.className = 'dialog-buttons';

  const cancelBtn: HTMLButtonElement = document.createElement('button');
  cancelBtn.className = 'btn-secondary';
  cancelBtn.id = 'rename-cancel';
  cancelBtn.textContent = 'Cancel';
  buttons.appendChild(cancelBtn);

  const okBtn: HTMLButtonElement = document.createElement('button');
  okBtn.className = 'btn-primary';
  okBtn.id = 'rename-ok';
  okBtn.textContent = 'OK';
  buttons.appendChild(okBtn);

  dialog.appendChild(buttons);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  input.focus();
  input.select();

  const close = (): void => overlay.remove();

  cancelBtn.onclick = close;
  okBtn.onclick = () => {
    const newName: string = input.value.trim();
    const currentSlotData = state.gridSlots[state.activeGridSlot!] as GridSlotData | undefined;
    if (currentSlotData?.presets?.[index]) {
      currentSlotData.presets[index].name = newName || null;
      updateLocalPresetButtonLabel(btn, index);
      saveGridState();
    }
    close();
  };

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') (document.getElementById('rename-ok') as HTMLElement).click();
    if (e.key === 'Escape') close();
  });

  overlay.addEventListener('click', (e: MouseEvent) => {
    if (e.target === overlay) close();
  });
}

/** Apply params to selected tile (for tiled preview mode) */
function applyParamsToSelectedTile(params: Record<string, unknown>): void {
  if (!params) return;

  const tileIndex: number = state.selectedTileIndex;
  if (tileIndex < 0 || tileIndex >= tileState.tiles.length) return;

  const tile = tileState.tiles[tileIndex];
  if (!tile || tile.gridSlotIndex === null) return;

  const slotData = state.gridSlots[tile.gridSlotIndex] as GridSlotData | undefined;
  if (!slotData) return;

  // Separate speed from custom params
  const { speed, ...customParams } = params;

  // Update tile's stored params (speed)
  if (!tile.params) tile.params = {} as Record<string, ParamValue | ParamArrayValue>;
  if (speed !== undefined) {
    (tile.params as Record<string, unknown>).speed = speed;
  }

  // Update tile's custom params
  if (!tile.customParams) tile.customParams = {} as Record<string, ParamValue | ParamArrayValue>;
  Object.assign(tile.customParams, customParams);

  // Also update the slot's params and customParams
  if (!slotData.params) slotData.params = {};
  if (speed !== undefined) {
    slotData.params.speed = speed;
  }
  if (!slotData.customParams) slotData.customParams = {};
  Object.assign(slotData.customParams, customParams);

  // Update the MiniShaderRenderer speed if available
  if (slotData.renderer && speed !== undefined) {
    slotData.renderer.setSpeed(speed as number);
  }
}

/** Apply params to selected mixer channel */
function applyParamsToMixerChannel(params: Record<string, unknown>): void {
  if (!params) return;
  for (const [name, value] of Object.entries(params)) {
    updateMixerChannelParam(name, value);
  }
}

function updateActiveLocalPreset(index: number): void {
  state.activeLocalPresetIndex = index;
  clearLocalPresetHighlight();
  const btn = document.querySelector(
    `.preset-btn.local-preset[data-preset-index="${index}"]`,
  ) as HTMLElement | null;
  if (btn) btn.classList.add('active');
}

function clearLocalPresetHighlight(): void {
  document
    .querySelectorAll('.preset-btn.local-preset')
    .forEach((btn: Element) => btn.classList.remove('active'));
}

function updateLocalPreset(index: number): void {
  const renderer = state.renderer as RendererLike | null;
  if (state.activeGridSlot === null || !state.gridSlots[state.activeGridSlot]) return;
  const slotData = state.gridSlots[state.activeGridSlot] as GridSlotData;
  const presets: PresetEntry[] | undefined = slotData.presets;
  if (!presets || index >= presets.length) return;

  const params: Record<string, unknown> = cloneParams(renderer!.getParams());
  presets[index].params = params;
  saveGridState();

  const name: string = presets[index].name || `Preset ${index + 1}`;
  setStatus(`${name} updated`, 'success');
}

function deleteLocalPreset(index: number, btnElement: HTMLElement): void {
  if (state.activeGridSlot === null || !state.gridSlots[state.activeGridSlot]) return;

  const slotData = state.gridSlots[state.activeGridSlot] as GridSlotData;
  slotData.presets!.splice(index, 1);
  btnElement.remove();

  // Re-index remaining buttons
  const localBtns = document.querySelectorAll('.preset-btn.local-preset');
  localBtns.forEach((btnEl: Element, i: number) => {
    const htmlBtn = btnEl as HTMLElement;
    htmlBtn.dataset.presetIndex = String(i);
    updateLocalPresetButtonLabel(htmlBtn, i);
    (htmlBtn as HTMLButtonElement).onclick = () => recallLocalPreset(i);
    (htmlBtn as HTMLButtonElement).oncontextmenu = (e: MouseEvent) => {
      e.preventDefault();
      showPresetContextMenu(e.clientX, e.clientY, i, htmlBtn);
    };
  });

  if (state.activeLocalPresetIndex === index) state.activeLocalPresetIndex = null;
  else if (state.activeLocalPresetIndex !== null && state.activeLocalPresetIndex > index) {
    state.activeLocalPresetIndex--;
  }

  saveGridState();
  setStatus('Preset deleted', 'success');
}
