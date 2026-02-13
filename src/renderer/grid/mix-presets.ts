// Mix Presets — mix preset panel DOM, CRUD operations, context menu,
// and export/import for mix compositions.
// Typed version of js/shader-grid.js lines 660-991.

import { state } from '../core/state.js';
import { showContextMenu as showContextMenuHelper } from '../ui/context-menu.js';
import { isMixerActive, captureMixerThumbnail, recallMixState } from '../ui/mixer.js';
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
    exportButtonData(
      format: string,
      data: Record<string, unknown>,
      defaultName: string,
    ): Promise<{ success: boolean; error?: string }>;
    importButtonData(
      format: string,
    ): Promise<{ canceled?: boolean; error?: string; data?: Record<string, unknown> }>;
  };
};

/** External functions wired up by the app entry point */
declare function buildTabBar(): void;
declare function cleanupGridVisibilityObserver(): void;
declare function applyMaxContainerHeight(): void;
declare function hideContextMenu(): void;
declare function saveGridState(): void;
declare function setStatus(msg: string, type?: string): void;

/** Slot event listener tracking (owned by grid-renderer, declared here) */
declare const slotEventListeners: Map<
  HTMLElement,
  Array<{ event: string; handler: EventListener }>
>;

// ---------------------------------------------------------------------------
// Local interfaces
// ---------------------------------------------------------------------------

interface ShaderTabLike {
  name: string;
  type?: string;
  slots?: unknown[];
  mixPresets?: MixPresetData[];
}

interface MixPresetData {
  name: string;
  blendMode: string;
  channels: (MixPresetChannel | null)[];
  thumbnail: string | null;
}

interface MixPresetChannel {
  shaderCode?: string;
  assetType?: string;
  mediaPath?: string;
  alpha: number;
  params: Record<string, unknown>;
  customParams: Record<string, unknown>;
}

interface MixerChannelLike {
  slotIndex: number | null;
  tabIndex?: number | null;
  alpha: number;
  params: Record<string, unknown>;
  customParams: Record<string, unknown>;
  renderer: unknown;
  shaderCode?: string | null;
  assetType?: string;
  mediaPath?: string;
}

// ---------------------------------------------------------------------------
// Helpers — typed access to the loosely-typed global state
// ---------------------------------------------------------------------------

/** Return the active shader tab cast to a ShaderTabLike. */
function getActiveMixTab(): ShaderTabLike | null {
  const tab = (state.shaderTabs as ShaderTabLike[])[state.activeShaderTab];
  if (!tab || tab.type !== 'mix') return null;
  return tab;
}

// ---------------------------------------------------------------------------
// Mix Panel DOM
// ---------------------------------------------------------------------------

/**
 * Build the mix preset panel DOM.
 * Replaces the shader grid content when a mix tab is active.
 */
export function rebuildMixPanelDOM(): void {
  const container = document.getElementById('shader-grid-container');
  if (!container) return;

  // Build tab bar first
  buildTabBar();

  // Cleanup grid-specific event listeners
  slotEventListeners.forEach((listeners, slot) => {
    listeners.forEach(({ event, handler }) => {
      slot.removeEventListener(event, handler);
    });
  });
  slotEventListeners.clear();
  cleanupGridVisibilityObserver();

  // Clear container
  container.innerHTML = '';

  const tab = getActiveMixTab();
  if (!tab) return;

  // Append mix preset buttons directly into container (same as shader grid slots)
  const presets = tab.mixPresets || [];
  for (let i = 0; i < presets.length; i++) {
    const preset = presets[i];
    const btn = document.createElement('div');
    btn.className = 'mix-preset-btn';
    btn.dataset.presetIndex = String(i);
    btn.title = buildMixPresetTooltip(preset);

    const thumb = document.createElement('div');
    thumb.className = 'mix-preset-thumb';
    if (preset.thumbnail) {
      thumb.style.backgroundImage = `url(${preset.thumbnail})`;
    }
    btn.appendChild(thumb);

    const label = document.createElement('span');
    label.className = 'mix-preset-label';
    label.textContent = preset.name || `Mix ${i + 1}`;
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      recallMixPresetFromTab(i);
    });
    btn.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      showMixPresetContextMenu(e.clientX, e.clientY, i);
    });

    container.appendChild(btn);
  }

  // Add "+" button to save current mix state
  const addBtn = document.createElement('div');
  addBtn.className = 'mix-preset-btn mix-add-btn';
  addBtn.textContent = '+';
  addBtn.title = 'Save current mixer state as a preset';
  addBtn.addEventListener('click', () => {
    saveMixPreset();
  });
  container.appendChild(addBtn);

  // Maintain stable panel height across tab switches
  applyMaxContainerHeight();
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

/**
 * Build a tooltip string for a mix preset.
 */
function buildMixPresetTooltip(preset: MixPresetData): string {
  const channelCount = preset.channels.filter((ch) => ch !== null).length;
  return `${preset.name} — ${channelCount} channel(s), blend: ${preset.blendMode || 'lighter'}`;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Snapshot the current mixer state into a new mix preset.
 */
function saveMixPreset(): void {
  const tab = getActiveMixTab();
  if (!tab) return;

  // Check that the mixer has at least one active channel
  if (!isMixerActive()) {
    setStatus('Mixer has no active channels to save', 'error');
    return;
  }

  const channels: (MixPresetChannel | null)[] = (
    state.mixerChannels as MixerChannelLike[]
  ).map((ch) => {
    if (ch.slotIndex === null && ch.tabIndex == null && !ch.renderer) return null;

    // Look up slot data for grid-assigned channels
    let slotData: Record<string, unknown> | null = null;
    if (ch.slotIndex !== null && ch.tabIndex != null) {
      const srcTab = (state.shaderTabs as ShaderTabLike[])[ch.tabIndex];
      slotData = (srcTab?.slots?.[ch.slotIndex] as Record<string, unknown>) || null;
    }

    // Check if this is an asset channel
    const isAsset =
      ch.assetType ||
      (typeof slotData?.type === 'string' && (slotData.type as string).startsWith('asset-'));
    if (isAsset) {
      return {
        assetType: ch.assetType || (slotData?.type as string | undefined),
        mediaPath: (slotData?.mediaPath as string | undefined) || ch.mediaPath,
        alpha: ch.alpha,
        params: { ...ch.params },
        customParams: { ...ch.customParams },
      };
    }

    // Shader channel — get shader code
    let shaderCode = ch.shaderCode;
    if (!shaderCode && slotData) {
      shaderCode = slotData.shaderCode as string | null | undefined;
    }
    if (!shaderCode) return null;

    return {
      shaderCode,
      alpha: ch.alpha,
      params: { ...ch.params },
      customParams: { ...ch.customParams },
    };
  });

  const presetName = `Mix ${(tab.mixPresets || []).length + 1}`;
  const thumbnail = captureMixerThumbnail();
  const preset: MixPresetData = {
    name: presetName,
    blendMode: state.mixerBlendMode,
    channels,
    thumbnail,
  };

  if (!tab.mixPresets) tab.mixPresets = [];
  tab.mixPresets.push(preset);
  log.info(
    'Grid',
    `saveMixPreset: "${presetName}" with ${channels.filter((c) => c !== null).length} channel(s)`,
  );

  rebuildMixPanelDOM();
  saveGridState();

  setStatus(`Saved mix preset "${presetName}"`, 'success');
}

/**
 * Recall a mix preset and load it into the mixer.
 */
function recallMixPresetFromTab(presetIndex: number): void {
  const tab = getActiveMixTab();
  if (!tab) return;

  const preset = tab.mixPresets?.[presetIndex];
  if (!preset) return;

  recallMixState(preset as Parameters<typeof recallMixState>[0]);

  // Update active highlight on buttons
  const grid = document.getElementById('shader-grid-container');
  if (grid) {
    grid.querySelectorAll('.mix-preset-btn').forEach((btn) => {
      btn.classList.remove('active');
    });
    const activeBtn = grid.querySelector(`[data-preset-index="${presetIndex}"]`);
    if (activeBtn) activeBtn.classList.add('active');
  }
}

/**
 * Update a mix preset with the current mixer state.
 */
function updateMixPreset(presetIndex: number): void {
  const tab = getActiveMixTab();
  if (!tab) return;

  if (!isMixerActive()) {
    setStatus('Mixer has no active channels to save', 'error');
    return;
  }

  const preset = tab.mixPresets?.[presetIndex];
  if (!preset) return;

  const channels: (MixPresetChannel | null)[] = (
    state.mixerChannels as MixerChannelLike[]
  ).map((ch) => {
    if (ch.slotIndex === null && ch.tabIndex == null && !ch.renderer) return null;

    let shaderCode = ch.shaderCode;
    if (!shaderCode && ch.slotIndex !== null && ch.tabIndex != null) {
      const srcTab = (state.shaderTabs as ShaderTabLike[])[ch.tabIndex];
      const slotData = srcTab?.slots?.[ch.slotIndex] as Record<string, unknown> | undefined;
      shaderCode = slotData?.shaderCode as string | undefined;
    }
    if (!shaderCode) return null;

    return {
      shaderCode,
      alpha: ch.alpha,
      params: { ...ch.params },
      customParams: { ...ch.customParams },
    };
  });

  preset.blendMode = state.mixerBlendMode;
  preset.channels = channels;
  preset.thumbnail = captureMixerThumbnail();

  rebuildMixPanelDOM();
  saveGridState();
  setStatus(`Updated mix preset "${preset.name}"`, 'success');
}

/**
 * Rename a mix preset inline.
 */
function renameMixPreset(presetIndex: number): void {
  const tab = getActiveMixTab();
  if (!tab) return;

  const preset = tab.mixPresets?.[presetIndex];
  if (!preset) return;

  const grid = document.getElementById('shader-grid-container');
  const btn = grid?.querySelector(`[data-preset-index="${presetIndex}"]`) as HTMLElement | null;
  if (!btn) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'shader-tab-rename-input';
  input.value = preset.name;
  input.style.width = '90%';

  const finishRename = (): void => {
    const newName = input.value.trim() || preset.name;
    preset.name = newName;
    rebuildMixPanelDOM();
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

/**
 * Delete a mix preset.
 */
function deleteMixPreset(presetIndex: number): void {
  const tab = getActiveMixTab();
  if (!tab) return;

  const preset = tab.mixPresets?.[presetIndex];
  if (!preset) return;

  tab.mixPresets!.splice(presetIndex, 1);
  rebuildMixPanelDOM();
  saveGridState();

  setStatus(`Deleted mix preset "${preset.name}"`, 'success');
}

// ---------------------------------------------------------------------------
// Context Menu
// ---------------------------------------------------------------------------

/**
 * Show context menu for a mix preset button.
 */
function showMixPresetContextMenu(x: number, y: number, presetIndex: number): void {
  hideContextMenu();

  const tab = getActiveMixTab();
  if (!tab) return;

  showContextMenuHelper(x, y, [
    { label: 'Update with Current Mix', action: () => updateMixPreset(presetIndex) },
    { label: 'Rename', action: () => renameMixPreset(presetIndex) },
    { label: 'Delete', action: () => deleteMixPreset(presetIndex) },
    { separator: true },
    { label: 'Export Composition...', action: () => exportMixPreset(presetIndex) },
    { label: 'Import Composition...', action: () => importMixPreset(presetIndex) },
  ]);
}

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------

/**
 * Export a mix preset as a .shadershow-comp file.
 */
async function exportMixPreset(presetIndex: number): Promise<void> {
  const tab = getActiveMixTab();
  if (!tab) return;

  const preset = tab.mixPresets?.[presetIndex];
  if (!preset) return;

  const exportData: Record<string, unknown> = {
    format: 'shadershow-comp',
    version: 1,
    name: preset.name,
    blendMode: preset.blendMode,
    channels: preset.channels,
    thumbnail: preset.thumbnail,
  };

  const defaultName = preset.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const result = await window.electronAPI.exportButtonData('shadershow-comp', exportData, defaultName);
  if (result.success) {
    setStatus(`Exported composition "${preset.name}"`, 'success');
  } else if (result.error) {
    setStatus(`Export failed: ${result.error}`, 'error');
  }
}

/**
 * Import a mix preset from a .shadershow-comp file.
 */
async function importMixPreset(presetIndex: number): Promise<void> {
  const tab = getActiveMixTab();
  if (!tab) return;

  const result = await window.electronAPI.importButtonData('shadershow-comp');
  if (result.canceled) return;
  if (result.error) {
    setStatus(`Import failed: ${result.error}`, 'error');
    return;
  }

  const data = result.data as Record<string, unknown> | undefined;
  if (!data) return;

  const preset: MixPresetData = {
    name: (data.name as string) || `Mix ${presetIndex + 1}`,
    blendMode: (data.blendMode as string) || 'lighter',
    channels: (data.channels as (MixPresetChannel | null)[]) || [],
    thumbnail: (data.thumbnail as string | null) || null,
  };

  if (!tab.mixPresets) tab.mixPresets = [];
  if (presetIndex < tab.mixPresets.length) {
    tab.mixPresets[presetIndex] = preset;
  } else {
    tab.mixPresets.push(preset);
  }

  rebuildMixPanelDOM();
  saveGridState();
  setStatus(`Imported composition "${preset.name}"`, 'success');
}
