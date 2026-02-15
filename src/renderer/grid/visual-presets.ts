// Visual Presets — full scene snapshots (shader code, params, mixer state).
// Typed version of the visual-presets portion of js/shader-grid.js (lines 993-1397).

import { state, notifyRemoteStateChanged } from '../core/state.js';
import type { MixPreset } from '../ui/mixer.js';
import { isMixerActive, captureMixerThumbnail, recallMixState, resetMixer } from '../ui/mixer.js';
import { showContextMenu as showContextMenuHelper } from '../ui/context-menu.js';
import { saveViewState } from '../ui/view-state.js';
import { createTaggedLogger } from '@shared/logger.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createTaggedLogger();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal electronAPI surface used by this module */
declare const window: Window & {
  electronAPI: {
    sendBatchParamUpdate(params: Record<string, unknown>): void;
    exportButtonData(
      format: string,
      data: Record<string, unknown>,
      defaultName: string,
    ): Promise<{ success?: boolean; error?: string }>;
    importButtonData(
      format: string,
    ): Promise<{ canceled?: boolean; error?: string; data?: Record<string, unknown> }>;
  };
};

import { saveGridState } from './grid-persistence.js';
import { hideContextMenu } from './shader-grid.js';
import { setStatus } from '../ui/utils.js';
import { compileShader } from '../ui/editor.js';
import { setRenderMode, ensureSceneRenderer, detectRenderMode } from '../core/renderer-manager.js';
import { loadParamsToSliders, generateCustomParamUI } from '../ui/params.js';

// ---------------------------------------------------------------------------
// Local interfaces
// ---------------------------------------------------------------------------

/** Serialised visual preset stored in state.visualPresets */
interface VisualPreset {
  name: string;
  thumbnail: string | null;
  renderMode: string;
  shaderCode: string;
  params: Record<string, unknown>;
  customParams: Record<string, unknown>;
  mixerEnabled: boolean;
  mixerBlendMode?: string;
  mixerChannels?: (SerializedMixerChannel | null)[];
}

/** Shape of a serialized mixer channel inside a visual preset */
interface SerializedMixerChannel {
  shaderCode?: string;
  assetType?: string;
  mediaPath?: string;
  alpha: number;
  params: Record<string, unknown>;
  customParams: Record<string, unknown>;
}

/** Runtime mixer channel shape as stored in state.mixerChannels */
interface MixerChannelLike {
  slotIndex: number | null;
  tabIndex?: number | null;
  alpha: number;
  params: Record<string, unknown>;
  customParams: Record<string, unknown>;
  renderer: unknown | null;
  shaderCode: string | null;
  assetType?: string | null;
  mediaPath?: string;
}

/** Runtime shape of a shader tab stored in state.shaderTabs */
interface ShaderTabLike {
  name: string;
  slots: Array<{
    shaderCode?: string;
    type?: string;
    mediaPath?: string;
    [key: string]: unknown;
  } | null>;
}

/** Minimal main renderer surface */
interface RendererLike {
  _lastShaderSource?: string;
  sceneSource?: string;
  getCustomParamValues?(): Record<string, unknown>;
  setCustomParamValues?(values: Record<string, unknown>): void;
  reinitialize?(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function presets(): VisualPreset[] {
  return state.visualPresets as VisualPreset[];
}

function renderer(): RendererLike | null {
  return state.renderer as RendererLike | null;
}

function editor(): { getValue(): string; setValue(value: string, cursorPos?: number): void } | null {
  return state.editor as { getValue(): string; setValue(value: string, cursorPos?: number): void } | null;
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function buildVisualPresetTooltip(preset: VisualPreset): string {
  const parts: string[] = [preset.name || 'Preset'];
  if (preset.renderMode) parts.push(`Mode: ${preset.renderMode}`);
  if (preset.mixerEnabled) parts.push('Mixer: ON');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Thumbnail capture
// ---------------------------------------------------------------------------

function captureVisualPresetThumbnail(): string | null {
  // If mixer is active, capture the composite
  if (isMixerActive()) {
    return captureMixerThumbnail();
  }
  // Otherwise capture the main shader canvas
  const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement | null;
  if (!canvas || canvas.width === 0) return null;
  const thumbW = 240;
  const thumbH = Math.round(thumbW * canvas.height / canvas.width) || 135;
  const tmp = document.createElement('canvas');
  tmp.width = thumbW;
  tmp.height = thumbH;
  const ctx = tmp.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, thumbW, thumbH);
  return tmp.toDataURL('image/jpeg', 0.7);
}

// ---------------------------------------------------------------------------
// Mixer channel serialization
// ---------------------------------------------------------------------------

export function serializeMixerChannels(): (SerializedMixerChannel | null)[] {
  const channels = state.mixerChannels as MixerChannelLike[];
  return channels.map((ch) => {
    if (ch.slotIndex === null && ch.tabIndex == null && !ch.renderer) return null;

    let slotData: ShaderTabLike['slots'][number] = null;
    if (ch.slotIndex !== null && ch.tabIndex != null) {
      const srcTab = (state.shaderTabs as ShaderTabLike[])[ch.tabIndex];
      slotData = srcTab?.slots?.[ch.slotIndex] || null;
    }

    const isAsset = ch.assetType || slotData?.type?.startsWith('asset-');
    if (isAsset) {
      return {
        assetType: ch.assetType || slotData?.type,
        mediaPath: slotData?.mediaPath || ch.mediaPath,
        alpha: ch.alpha,
        params: { ...ch.params },
        customParams: { ...ch.customParams },
      };
    }

    let shaderCode = ch.shaderCode;
    if (!shaderCode && slotData) {
      shaderCode = slotData.shaderCode || null;
    }
    if (!shaderCode) return null;

    return {
      shaderCode,
      alpha: ch.alpha,
      params: { ...ch.params },
      customParams: { ...ch.customParams },
    };
  });
}

// ---------------------------------------------------------------------------
// DOM — rebuild preset buttons
// ---------------------------------------------------------------------------

export function rebuildVisualPresetsDOM(): void {
  rebuildVpTabBar();

  const container = document.getElementById('visual-presets-container');
  if (!container) return;

  container.innerHTML = '';

  const list = presets() || [];
  for (let i = 0; i < list.length; i++) {
    const preset = list[i];
    const btn = document.createElement('div');
    btn.className = 'visual-preset-btn';
    btn.dataset.presetIndex = String(i);
    btn.title = buildVisualPresetTooltip(preset);

    const thumb = document.createElement('div');
    thumb.className = 'visual-preset-thumb';
    if (preset.thumbnail) {
      thumb.style.backgroundImage = `url(${preset.thumbnail})`;
    }
    btn.appendChild(thumb);

    const label = document.createElement('span');
    label.className = 'visual-preset-label';
    label.textContent = preset.name || `Preset ${i + 1}`;
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      recallVisualPreset(i);
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showVisualPresetContextMenu(e.clientX, e.clientY, i);
    });

    container.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// VP Tab Bar
// ---------------------------------------------------------------------------

function rebuildVpTabBar(): void {
  const tabBar = document.querySelector('.vp-tabs');
  if (!tabBar) return;

  tabBar.innerHTML = '';
  state.vpTabs.forEach((tab: { name: string; presets: unknown[] }, index: number) => {
    const tabEl = document.createElement('button');
    tabEl.className = `vp-tab${index === state.activeVpTab ? ' active' : ''}`;
    tabEl.dataset.vpTabIndex = String(index);
    tabEl.textContent = tab.name;
    tabEl.addEventListener('click', () => switchVpTab(index));
    tabEl.addEventListener('dblclick', () => renameVpTab(index));
    tabEl.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      showVpTabContextMenu(e.clientX, e.clientY, index);
    });
    tabBar.appendChild(tabEl);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'vp-tab vp-tab-add';
  addBtn.textContent = '+';
  addBtn.title = 'Add VP tab';
  addBtn.addEventListener('click', addVpTab);
  tabBar.appendChild(addBtn);
}

function switchVpTab(index: number): void {
  if (index < 0 || index >= state.vpTabs.length) return;
  state.activeVpTab = index;
  rebuildVisualPresetsDOM();
  saveGridState();
}

function addVpTab(): void {
  const name = `VPs ${state.vpTabs.length + 1}`;
  state.vpTabs.push({ name, presets: [] });
  state.activeVpTab = state.vpTabs.length - 1;
  rebuildVisualPresetsDOM();
  saveGridState();
}

function renameVpTab(index: number): void {
  const tabBar = document.querySelector('.vp-tabs');
  const tabEl = tabBar?.children[index] as HTMLElement | undefined;
  if (!tabEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'shader-tab-rename-input';
  input.value = state.vpTabs[index].name;

  const finishRename = (): void => {
    const newName = input.value.trim() || state.vpTabs[index].name;
    state.vpTabs[index].name = newName;
    rebuildVpTabBar();
    saveGridState();
  };

  input.addEventListener('blur', finishRename);
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { input.value = state.vpTabs[index].name; input.blur(); }
  });

  tabEl.textContent = '';
  tabEl.appendChild(input);
  input.focus();
  input.select();
}

function showVpTabContextMenu(x: number, y: number, index: number): void {
  hideContextMenu();
  const items: { label: string; action: () => void }[] = [
    { label: 'Rename Tab', action: () => renameVpTab(index) },
  ];
  if (state.vpTabs.length > 1) {
    items.push({ label: 'Delete Tab', action: () => deleteVpTab(index) });
  }
  showContextMenuHelper(x, y, items);
}

function deleteVpTab(index: number): void {
  if (state.vpTabs.length <= 1) return;
  state.vpTabs.splice(index, 1);
  if (state.activeVpTab >= state.vpTabs.length) {
    state.activeVpTab = state.vpTabs.length - 1;
  }
  rebuildVisualPresetsDOM();
  saveGridState();
}

// ---------------------------------------------------------------------------
// Panel toggle & init
// ---------------------------------------------------------------------------

export function toggleVisualPresetsPanel(): void {
  state.visualPresetsEnabled = !state.visualPresetsEnabled;
  log.debug('Grid', `toggleVisualPresetsPanel: ${state.visualPresetsEnabled ? 'open' : 'closed'}`);
  const panel = document.getElementById('visual-presets-panel');
  const resizer = document.getElementById('resizer-visual-presets');
  const btn = document.getElementById('btn-visual-presets');

  if (state.visualPresetsEnabled) {
    panel?.classList.remove('hidden');
    resizer?.classList.remove('hidden');
    btn?.classList.add('active');
    rebuildVisualPresetsDOM();
  } else {
    panel?.classList.add('hidden');
    resizer?.classList.add('hidden');
    btn?.classList.remove('active');
  }

  saveViewState();
}

export function initVisualPresetsPanel(): void {
  const saveBtn = document.getElementById('visual-presets-save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      saveVisualPreset();
    });
  }

  // Activate the tab content (there's only one content div, shared across tabs)
  const content = document.querySelector('.vp-tab-content');
  if (content) content.classList.add('active');
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

async function saveVisualPreset(): Promise<void> {
  // Capture shader/scene code from the renderer (which reflects the active content,
  // even if the editor hasn't been updated via double-click/edit)
  const r = renderer();
  const shaderCode =
    r?._lastShaderSource ||
    r?.sceneSource ||
    (editor() ? editor()!.getValue() : '');

  if (!shaderCode) {
    setStatus('No shader loaded to save as preset', 'error');
    return;
  }

  // Ensure the shader is compiled (editor change may still be debounced)
  if (state.compileTimeout) {
    clearTimeout(state.compileTimeout);
    state.compileTimeout = null;
    await compileShader();
  }

  // Get speed param from slider
  const speedSlider = document.getElementById('param-speed') as HTMLInputElement | null;
  const speed = speedSlider ? parseFloat(speedSlider.value) : 1.0;

  // Get custom params from main renderer
  const customParams = r?.getCustomParamValues?.() || {};

  const mixerActive = isMixerActive();
  const preset: VisualPreset = {
    name: `Preset ${(presets() || []).length + 1}`,
    thumbnail: captureVisualPresetThumbnail(),
    renderMode: state.renderMode || 'shader',
    shaderCode,
    params: { speed },
    customParams: { ...customParams },
    mixerEnabled: mixerActive,
    mixerBlendMode: mixerActive ? state.mixerBlendMode : undefined,
    mixerChannels: mixerActive ? serializeMixerChannels() : undefined,
  };

  presets().push(preset);
  log.info('Grid', `saveVisualPreset: "${preset.name}" (mode=${preset.renderMode}, mixer=${preset.mixerEnabled})`);

  rebuildVisualPresetsDOM();
  saveGridState();

  setStatus(`Saved visual preset "${preset.name}"`, 'success');
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

export async function recallVisualPreset(presetIndex: number): Promise<void> {
  const preset = presets()?.[presetIndex];
  if (!preset) return;
  log.info('Grid', `recallVisualPreset: "${preset.name}" index=${presetIndex}`);
  try {
    // 1. Switch render mode -- detect actual mode from code content to handle
    //    presets saved with mismatched renderMode (e.g. GLSL code saved as 'scene')
    const detectedMode = detectRenderMode(null, preset.shaderCode);
    const targetMode = detectedMode || preset.renderMode || 'shader';
    if (state.renderMode !== targetMode) {
      await setRenderMode(targetMode);
    } else if (targetMode === 'scene') {
      // Same mode but scene: reinitialize so compile starts fresh
      const sceneRenderer = (await ensureSceneRenderer()) as RendererLike | null;
      if (sceneRenderer) sceneRenderer.reinitialize?.();
    }

    // 2. Load shader/scene code into editor and compile via full pipeline
    const ed = editor();
    if (ed && preset.shaderCode) {
      ed.setValue(preset.shaderCode, -1);
      // Cancel debounced compile set by setValue's change event
      if (state.compileTimeout) clearTimeout(state.compileTimeout);
      // Use the full compile pipeline (handles textures, custom params, fullscreen sync)
      await compileShader();
    }

    // 3. Restore params (speed etc.)
    if (preset.params) {
      loadParamsToSliders(preset.params, { skipMixerSync: true });
    }

    // 4. Restore custom params
    const r = renderer();
    if (preset.customParams && r?.setCustomParamValues) {
      r.setCustomParamValues(preset.customParams);
    }

    // 5. Regenerate custom param UI
    generateCustomParamUI();

    // 6. Restore mixer state or reset
    if (preset.mixerEnabled && preset.mixerChannels) {
      recallMixState({
        name: preset.name,
        blendMode: preset.mixerBlendMode,
        channels: preset.mixerChannels,
      } as MixPreset);
    } else {
      resetMixer();
    }

    // 7. Sync params to fullscreen
    const allParams: Record<string, unknown> = {
      ...(preset.params || {}),
      ...(preset.customParams || {}),
    };
    if (window.electronAPI.sendBatchParamUpdate) {
      window.electronAPI.sendBatchParamUpdate(allParams);
    }

    // Update active highlight
    const vpContainer = document.getElementById('visual-presets-container');
    if (vpContainer) {
      vpContainer.querySelectorAll('.visual-preset-btn').forEach((btn) => {
        btn.classList.remove('active');
      });
      const activeBtn = vpContainer.querySelector(`[data-preset-index="${presetIndex}"]`);
      if (activeBtn) activeBtn.classList.add('active');
    }

    setStatus(`Recalled visual preset "${preset.name}"`, 'success');
    notifyRemoteStateChanged();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Grid', `recallVisualPreset failed: ${message}`, err);
    setStatus(`Failed to recall preset: ${message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

function showVisualPresetContextMenu(x: number, y: number, presetIndex: number): void {
  hideContextMenu();

  showContextMenuHelper(x, y, [
    { label: 'Update with Current State', action: () => updateVisualPreset(presetIndex) },
    { label: 'Rename', action: () => renameVisualPreset(presetIndex) },
    { label: 'Delete', action: () => deleteVisualPreset(presetIndex) },
    { separator: true },
    { label: 'Export Visual Preset...', action: () => exportVisualPreset(presetIndex) },
    { label: 'Import Visual Preset...', action: () => importVisualPreset(presetIndex) },
  ]);
}

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------

async function exportVisualPreset(presetIndex: number): Promise<void> {
  const preset = presets()?.[presetIndex];
  if (!preset) return;

  const exportData: Record<string, unknown> = {
    format: 'shadershow-vis',
    version: 1,
    name: preset.name,
    renderMode: preset.renderMode,
    shaderCode: preset.shaderCode,
    params: preset.params || {},
    customParams: preset.customParams || {},
    mixerEnabled: preset.mixerEnabled || false,
    mixerBlendMode: preset.mixerBlendMode,
    mixerChannels: preset.mixerChannels,
    thumbnail: preset.thumbnail,
  };

  const defaultName = preset.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const result = await window.electronAPI.exportButtonData('shadershow-vis', exportData, defaultName);
  if (result.success) {
    setStatus(`Exported visual preset "${preset.name}"`, 'success');
  } else if (result.error) {
    setStatus(`Export failed: ${result.error}`, 'error');
  }
}

async function importVisualPreset(presetIndex: number): Promise<void> {
  const result = await window.electronAPI.importButtonData('shadershow-vis');
  if (result.canceled) return;
  if (result.error) {
    setStatus(`Import failed: ${result.error}`, 'error');
    return;
  }

  const data = result.data as Record<string, unknown> | undefined;
  if (!data) return;

  const preset: VisualPreset = {
    name: (data.name as string) || `Preset ${presetIndex + 1}`,
    renderMode: (data.renderMode as string) || 'shader',
    shaderCode: data.shaderCode as string,
    params: (data.params as Record<string, unknown>) || {},
    customParams: (data.customParams as Record<string, unknown>) || {},
    mixerEnabled: (data.mixerEnabled as boolean) || false,
    mixerBlendMode: data.mixerBlendMode as string | undefined,
    mixerChannels: data.mixerChannels as (SerializedMixerChannel | null)[] | undefined,
    thumbnail: (data.thumbnail as string) || null,
  };

  if (!state.visualPresets) state.visualPresets = [];
  const list = presets();
  if (presetIndex < list.length) {
    list[presetIndex] = preset;
  } else {
    list.push(preset);
  }

  rebuildVisualPresetsDOM();
  saveGridState();
  setStatus(`Imported visual preset "${preset.name}"`, 'success');
}

// ---------------------------------------------------------------------------
// Update / Rename / Delete
// ---------------------------------------------------------------------------

function updateVisualPreset(presetIndex: number): void {
  const preset = presets()?.[presetIndex];
  if (!preset) return;

  const r = renderer();
  const shaderCode =
    r?._lastShaderSource ||
    r?.sceneSource ||
    (editor() ? editor()!.getValue() : '');

  if (!shaderCode) {
    setStatus('No shader loaded to update preset', 'error');
    return;
  }

  const speedSlider = document.getElementById('param-speed') as HTMLInputElement | null;
  const speed = speedSlider ? parseFloat(speedSlider.value) : 1.0;
  const customParams = r?.getCustomParamValues?.() || {};
  const mixerActive = isMixerActive();

  preset.thumbnail = captureVisualPresetThumbnail();
  preset.renderMode = state.renderMode || 'shader';
  preset.shaderCode = shaderCode;
  preset.params = { speed };
  preset.customParams = { ...customParams };
  preset.mixerEnabled = mixerActive;
  preset.mixerBlendMode = mixerActive ? state.mixerBlendMode : undefined;
  preset.mixerChannels = mixerActive ? serializeMixerChannels() : undefined;

  log.info('Grid', `updateVisualPreset: "${preset.name}" index=${presetIndex}`);
  rebuildVisualPresetsDOM();
  saveGridState();
  setStatus(`Updated visual preset "${preset.name}"`, 'success');
}

function renameVisualPreset(presetIndex: number): void {
  const preset = presets()?.[presetIndex];
  if (!preset) return;

  const vpContainer = document.getElementById('visual-presets-container');
  const btn = vpContainer?.querySelector(`[data-preset-index="${presetIndex}"]`);
  if (!btn) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'shader-tab-rename-input';
  input.value = preset.name;
  input.style.width = '90%';

  const finishRename = (): void => {
    const newName = input.value.trim() || preset.name;
    preset.name = newName;
    rebuildVisualPresetsDOM();
    saveGridState();
  };

  input.addEventListener('blur', finishRename);
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = preset.name;
      input.blur();
    }
  });

  btn.innerHTML = '';
  btn.appendChild(input);
  input.focus();
  input.select();
}

function deleteVisualPreset(presetIndex: number): void {
  const preset = presets()?.[presetIndex];
  if (!preset) return;
  log.info('Grid', `deleteVisualPreset: "${preset.name}" index=${presetIndex}`);

  presets().splice(presetIndex, 1);
  rebuildVisualPresetsDOM();
  saveGridState();

  setStatus(`Deleted visual preset "${preset.name}"`, 'success');
}
