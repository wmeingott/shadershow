// Grid Persistence — save/load grid state, tabbed and legacy format migration,
// preset import, and shader file re-save.
// Typed version of js/shader-grid.js lines 3307-4045.

import { state } from '../core/state.js';
import { createTaggedLogger, LOG_LEVEL } from '../../shared/logger.js';
import { AssetRenderer } from '../renderers/asset-renderer.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createTaggedLogger(LOG_LEVEL.WARN);

// ---------------------------------------------------------------------------
// Electron API surface used by this module
// ---------------------------------------------------------------------------

declare const window: Window & {
  electronAPI: {
    saveGridState(data: unknown): void;
    loadGridState(): Promise<SavedGridState | unknown[] | null>;
    readFileContent(filePath: string): Promise<{ success: boolean; content?: string } | null>;
    saveShaderToSlot(index: number, code: string): Promise<void>;
    deleteShaderFromSlot(index: number): Promise<void>;
    getMediaAbsolutePath(mediaPath: string): Promise<string>;
    loadMediaDataUrl(mediaPath: string): Promise<{ success: boolean; dataUrl?: string }>;
  };
};

// ---------------------------------------------------------------------------
// External function stubs — implemented elsewhere, resolved at runtime
// ---------------------------------------------------------------------------

declare function rebuildGridDOM(): void;
declare function rebuildMixPanelDOM(): void;
declare function rebuildAssetGridDOM(): void;
declare function rebuildVisualPresetsDOM(): void;
declare function assignShaderToSlot(
  slotIndex: number, code: string, filePath: string | null,
  skipSave?: boolean, params?: unknown, presets?: unknown, customParams?: unknown,
): Promise<void>;
declare function assignSceneToSlot(
  slotIndex: number, code: string, filePath: string | null,
  skipSave?: boolean, params?: unknown, presets?: unknown, customParams?: unknown,
  thumbnail?: string | null,
): Promise<void>;
declare function assignFailedShaderToSlot(
  slotIndex: number, code: string, filePath: string | null,
  savedData?: Record<string, unknown>,
): void;
declare function detectRenderMode(filePath: string | null, code: string): string | null;
declare function setStatus(msg: string, type?: string): void;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShaderTabLike {
  name: string;
  type?: string;
  slots?: unknown[];
  mixPresets?: unknown[];
}

interface SavedGridState {
  version: number;
  activeTab: number;
  activeSection: string;
  tabs: SavedTabData[];
  visualPresets: unknown[];
}

interface SavedTabData {
  name: string;
  type?: string;
  slots?: SavedSlotData[];
  mixPresets?: unknown[];
  visualPresets?: unknown[];
}

interface SavedSlotData {
  shaderCode?: string;
  filePath?: string;
  type?: string;
  params?: Record<string, unknown>;
  customParams?: Record<string, unknown>;
  presets?: unknown[];
  label?: string;
  thumbnail?: string;
  mediaPath?: string;
}

/** Runtime shape of a mix-channel entry stored inside a mix-preset. */
interface MixChannelData {
  alpha: number;
  params: Record<string, unknown>;
  customParams: Record<string, unknown>;
  shaderCode?: string;
  assetType?: string;
  mediaPath?: string;
}

/** Runtime shape of a mix-preset stored in a mix tab. */
interface MixPresetData {
  name: string;
  blendMode: string;
  thumbnail?: string | null;
  channels: (MixChannelData | null)[];
}

/** Runtime shape of a visual preset stored in state.visualPresets. */
interface VisualPresetData {
  name: string;
  thumbnail?: string | null;
  renderMode: string;
  shaderCode: string;
  params: Record<string, unknown>;
  customParams: Record<string, unknown>;
  mixerEnabled: boolean;
  mixerBlendMode?: string;
  mixerChannels?: (MixChannelData | null)[];
}

/** Runtime shape of an asset slot stored in an assets tab. */
interface AssetSlotData {
  type: string;
  mediaPath: string;
  customParams: Record<string, unknown>;
  label?: string;
  renderer?: AssetRenderer;
}

// ---------------------------------------------------------------------------
// Helpers — cast dynamic state properties
// ---------------------------------------------------------------------------

function getTabs(): ShaderTabLike[] {
  return state.shaderTabs as ShaderTabLike[];
}

function getActiveSection(): string {
  return (state as Record<string, unknown>).activeSection as string || 'shaders';
}

function setActiveSection(section: string): void {
  (state as Record<string, unknown>).activeSection = section;
}

// ---------------------------------------------------------------------------
// saveGridState
// ---------------------------------------------------------------------------

export function saveGridState(): void {
  const tabs = getTabs();
  log.debug(
    'Grid',
    `saveGridState: ${tabs.length} tab(s), ${(state.visualPresets || []).length} visual preset(s)`,
  );

  // Save all tabs with embedded shader code
  const tabsState = tabs.map((tab) => {
    if (tab.type === 'mix') {
      return {
        name: tab.name,
        type: 'mix' as const,
        mixPresets: ((tab.mixPresets || []) as MixPresetData[]).map((preset) => ({
          name: preset.name,
          blendMode: preset.blendMode,
          thumbnail: preset.thumbnail || null,
          channels: preset.channels.map((ch) => {
            if (!ch) return null;
            const saved: Record<string, unknown> = {
              alpha: ch.alpha,
              params: ch.params,
              customParams: ch.customParams || {},
            };
            if (ch.assetType) {
              saved.assetType = ch.assetType;
              saved.mediaPath = ch.mediaPath;
            } else {
              saved.shaderCode = ch.shaderCode;
            }
            return saved;
          }),
        })),
      };
    }

    if (tab.type === 'assets') {
      return {
        name: tab.name,
        type: 'assets' as const,
        slots: ((tab.slots || []) as (AssetSlotData | null)[]).map((slot) => {
          if (!slot) return null;
          const saved: Record<string, unknown> = {
            type: slot.type,
            mediaPath: slot.mediaPath,
            customParams: slot.customParams || {},
          };
          if (slot.label) saved.label = slot.label;
          return saved;
        }),
      };
    }

    // Shader / default tab
    return {
      name: tab.name,
      type: tab.type || 'shaders',
      slots: ((tab.slots || []) as (Record<string, unknown> | null)[]).map((slot) => {
        if (!slot) return null;
        const saved: Record<string, unknown> = {
          shaderCode: slot.shaderCode,
          filePath: slot.filePath,
          params: slot.params,
          customParams: (slot.customParams as Record<string, unknown>) || {},
          presets: (slot.presets as unknown[]) || [],
          type: (slot.type as string) || 'shader',
        };
        if (slot.label) saved.label = slot.label;
        if (slot.thumbnail) saved.thumbnail = slot.thumbnail;
        return saved;
      }),
    };
  });

  // Serialize visual presets at top level
  const serializedVisualPresets = ((state.visualPresets || []) as VisualPresetData[]).map((preset) => {
    const saved: Record<string, unknown> = {
      name: preset.name,
      thumbnail: preset.thumbnail || null,
      renderMode: preset.renderMode,
      shaderCode: preset.shaderCode,
      params: preset.params,
      customParams: preset.customParams || {},
      mixerEnabled: preset.mixerEnabled || false,
    };
    if (preset.mixerEnabled) {
      saved.mixerBlendMode = preset.mixerBlendMode;
      saved.mixerChannels = (preset.mixerChannels || []).map((ch) => {
        if (!ch) return null;
        const chSaved: Record<string, unknown> = {
          alpha: ch.alpha,
          params: ch.params,
          customParams: ch.customParams || {},
        };
        if (ch.assetType) {
          chSaved.assetType = ch.assetType;
          chSaved.mediaPath = ch.mediaPath;
        } else {
          chSaved.shaderCode = ch.shaderCode;
        }
        return chSaved;
      });
    }
    return saved;
  });

  const gridState = {
    version: 2,
    activeTab: state.activeShaderTab,
    activeSection: getActiveSection(),
    tabs: tabsState,
    visualPresets: serializedVisualPresets,
  };

  window.electronAPI.saveGridState(gridState);
}

// ---------------------------------------------------------------------------
// loadGridState
// ---------------------------------------------------------------------------

export async function loadGridState(): Promise<void> {
  log.info('Grid', 'loadGridState: loading saved state');
  const savedState = await window.electronAPI.loadGridState();

  // Handle empty state
  if (!savedState) {
    state.shaderTabs = [{ name: 'My Shaders', slots: [] }];
    state.activeShaderTab = 0;
    setActiveSection('shaders');
    state.gridSlots = state.shaderTabs[0].slots;
    rebuildGridDOM();
    return;
  }

  // Check if this is the new tabbed format (version 2) or old array format
  if (
    (savedState as SavedGridState).version === 2 &&
    (savedState as SavedGridState).tabs
  ) {
    // New tabbed format
    await loadTabbedGridState(savedState as SavedGridState);
  } else if (Array.isArray(savedState)) {
    // Old format — migrate to new tabbed format
    setActiveSection('shaders');
    await loadLegacyGridState(savedState as SavedSlotData[]);
  } else {
    // Unknown format, start fresh
    state.shaderTabs = [{ name: 'My Shaders', slots: [] }];
    state.activeShaderTab = 0;
    setActiveSection('shaders');
    state.gridSlots = state.shaderTabs[0].slots;
    rebuildGridDOM();
  }
}

// ---------------------------------------------------------------------------
// loadTabbedGridState (private)
// ---------------------------------------------------------------------------

async function loadTabbedGridState(savedState: SavedGridState): Promise<void> {
  state.shaderTabs = [];
  state.visualPresets = [];
  let totalLoaded = 0;
  const allFailedSlots: string[] = [];

  for (let tabIndex = 0; tabIndex < savedState.tabs.length; tabIndex++) {
    const tabData = savedState.tabs[tabIndex];

    // Handle mix tabs — just load preset data directly
    if (tabData.type === 'mix') {
      const tab: ShaderTabLike = {
        name: tabData.name || `Mixes ${tabIndex + 1}`,
        type: 'mix',
        mixPresets: tabData.mixPresets || [],
      };
      (state.shaderTabs as ShaderTabLike[]).push(tab);
      totalLoaded += (tab.mixPresets || []).length;
      continue;
    }

    // Migrate legacy presets tabs — merge into top-level state.visualPresets
    if (tabData.type === 'presets') {
      const legacyPresets = tabData.visualPresets || [];
      (state.visualPresets as unknown[]).push(...legacyPresets);
      totalLoaded += legacyPresets.length;
      continue;
    }

    // Handle asset tabs — restore AssetRenderers from media library
    if (tabData.type === 'assets') {
      const compactSlots = (tabData.slots || []).filter(
        (s): s is SavedSlotData => !!(s && s.mediaPath),
      );
      const tab: ShaderTabLike = {
        name: tabData.name || `Assets ${tabIndex + 1}`,
        type: 'assets',
        slots: new Array(compactSlots.length).fill(null),
      };
      (state.shaderTabs as ShaderTabLike[]).push(tab);

      state.activeShaderTab = tabIndex;
      state.gridSlots = tab.slots!;
      rebuildAssetGridDOM();

      for (let i = 0; i < compactSlots.length; i++) {
        const slotData = compactSlots[i];
        try {
          const isVideo = slotData.type === 'asset-video';
          const absolutePath = await window.electronAPI.getMediaAbsolutePath(slotData.mediaPath!);

          const slotEl = document.querySelector(`.grid-slot[data-slot="${i}"]`);
          const canvas: HTMLCanvasElement = slotEl
            ? slotEl.querySelector('canvas') as HTMLCanvasElement
            : document.createElement('canvas');
          if (!slotEl) {
            canvas.width = 160;
            canvas.height = 90;
          }

          const renderer = new AssetRenderer(canvas);
          (renderer as unknown as Record<string, unknown>).mediaPath = slotData.mediaPath;

          if (isVideo) {
            await renderer.loadVideo(absolutePath);
          } else {
            const loaded = await window.electronAPI.loadMediaDataUrl(slotData.mediaPath!);
            if (loaded.success && loaded.dataUrl) {
              await renderer.loadImage(loaded.dataUrl);
            }
          }

          if (slotData.customParams) {
            renderer.setParams(slotData.customParams as Record<string, number>);
          }

          tab.slots![i] = {
            type: slotData.type,
            mediaPath: slotData.mediaPath,
            renderer,
            customParams: renderer.getCustomParamValues(),
            label: slotData.label,
          };
          totalLoaded++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn('Grid', `Failed to load asset ${tab.name} slot ${i + 1}: ${msg}`);
          allFailedSlots.push(`${tab.name}:${i + 1}`);
        }
      }
      continue;
    }

    // Shader / default tab
    const tab: ShaderTabLike = {
      name: tabData.name || `Tab ${tabIndex + 1}`,
      type: tabData.type || 'shaders',
      slots: [],
    };

    // Compact: only keep slots with shader data or a file path to load from
    const compactSlots = (tabData.slots || []).filter(
      (s): s is SavedSlotData => !!(s && (s.shaderCode || s.filePath)),
    );

    // Initialize slots array
    tab.slots = new Array(compactSlots.length).fill(null);
    (state.shaderTabs as ShaderTabLike[]).push(tab);

    // Temporarily set as active for loading (so assignShaderToSlot works)
    state.activeShaderTab = tabIndex;
    state.gridSlots = tab.slots;

    // Build DOM for this tab
    rebuildGridDOM();

    // Load shaders into this tab
    for (let i = 0; i < compactSlots.length; i++) {
      const slotData = compactSlots[i];
      try {
        // If shaderCode is missing but filePath exists, try to read the file
        let code = slotData.shaderCode;
        if (!code && slotData.filePath) {
          const result = await window.electronAPI.readFileContent(slotData.filePath);
          if (result && result.success && result.content) {
            code = result.content;
          } else {
            log.warn(
              'Grid',
              `Could not read file for ${tab.name} slot ${i + 1}: ${slotData.filePath}`,
            );
          }
        }
        if (!code) {
          allFailedSlots.push(`${tab.name}:${i + 1}`);
          continue;
        }

        // Detect type from content if not explicitly set (handles legacy data)
        const detectedType = detectRenderMode(slotData.filePath || null, code);
        const isScene = slotData.type === 'scene' || detectedType === 'scene';
        if (isScene) {
          await assignSceneToSlot(
            i, code, slotData.filePath || null, true,
            slotData.params, slotData.presets, slotData.customParams,
            slotData.thumbnail || null,
          );
        } else {
          await assignShaderToSlot(
            i, code, slotData.filePath || null, true,
            slotData.params, slotData.presets, slotData.customParams,
          );
        }
        // Restore custom label if saved
        if (slotData.label && state.gridSlots[i]) {
          (state.gridSlots[i] as Record<string, unknown>).label = slotData.label;
        }
        totalLoaded++;
      } catch (err: unknown) {
        assignFailedShaderToSlot(
          i,
          slotData.shaderCode || '',
          slotData.filePath || null,
          slotData as unknown as Record<string, unknown>,
        );
        allFailedSlots.push(`${tab.name}:${i + 1}`);
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Grid', `Failed to compile ${tab.name} slot ${i + 1}: ${msg}`);
      }
    }
  }

  // If no tabs were loaded, create default
  if (state.shaderTabs.length === 0) {
    state.shaderTabs = [{ name: 'My Shaders', slots: [] }];
  }

  // Load top-level visual presets (merge with any migrated from legacy tabs)
  if (savedState.visualPresets && savedState.visualPresets.length > 0) {
    (state.visualPresets as unknown[]).push(...savedState.visualPresets);
  }

  // Restore active section and tab
  let activeSection = savedState.activeSection || 'shaders';
  // If section was 'presets' (legacy), fall back to 'shaders'
  if (activeSection === 'presets') activeSection = 'shaders';
  setActiveSection(activeSection);
  state.activeShaderTab = Math.min(
    savedState.activeTab || 0,
    state.shaderTabs.length - 1,
  );
  const restoredTab = (state.shaderTabs as ShaderTabLike[])[state.activeShaderTab];
  // Sync section with actual tab type
  if (restoredTab.type === 'mix') setActiveSection('mix');
  else if (restoredTab.type === 'assets') setActiveSection('assets');
  else setActiveSection('shaders');
  state.gridSlots = restoredTab.type === 'mix' ? [] : (restoredTab.slots || []);

  // Rebuild DOM for active tab
  if (restoredTab.type === 'mix') {
    rebuildMixPanelDOM();
  } else if (restoredTab.type === 'assets') {
    rebuildAssetGridDOM();
  } else {
    rebuildGridDOM();
  }

  // Rebuild visual presets panel if enabled
  if (state.visualPresetsEnabled) {
    rebuildVisualPresetsDOM();
  }

  if (allFailedSlots.length > 0) {
    log.warn(
      'Grid',
      `loadTabbedGridState: ${allFailedSlots.length} failed slot(s): ${allFailedSlots.join(', ')}`,
    );
    setStatus(
      `Restored ${totalLoaded} items, ${allFailedSlots.length} failed`,
      'success',
    );
  } else if (totalLoaded > 0) {
    setStatus(
      `Restored ${totalLoaded} item${totalLoaded > 1 ? 's' : ''} across ${state.shaderTabs.length} tab${state.shaderTabs.length > 1 ? 's' : ''}`,
      'success',
    );
  }
  log.info(
    'Grid',
    `loadTabbedGridState: loaded ${totalLoaded} item(s) across ${state.shaderTabs.length} tab(s), ${(state.visualPresets || []).length} visual preset(s)`,
  );
}

// ---------------------------------------------------------------------------
// loadLegacyGridState (private)
// ---------------------------------------------------------------------------

async function loadLegacyGridState(gridState: SavedSlotData[]): Promise<void> {
  log.info('Grid', `loadLegacyGridState: migrating ${gridState.length} slot(s) to tabbed format`);

  // Only load slots that have actual shader data or a file path (compact the array)
  const compactState: SavedSlotData[] = [];
  for (let i = 0; i < gridState.length; i++) {
    if (gridState[i] && (gridState[i].shaderCode || gridState[i].filePath)) {
      compactState.push(gridState[i]);
    }
  }

  // Create single "My Shaders" tab with all slots
  state.shaderTabs = [{ name: 'My Shaders', slots: new Array(compactState.length).fill(null) }];
  state.activeShaderTab = 0;
  state.gridSlots = state.shaderTabs[0].slots;

  // Build DOM first so assignShaderToSlot can find the elements
  rebuildGridDOM();

  let loadedCount = 0;
  const failedSlots: number[] = [];

  for (let i = 0; i < compactState.length; i++) {
    const slotData = compactState[i];
    try {
      // If shaderCode is missing but filePath exists, try to read the file
      let code = slotData.shaderCode;
      if (!code && slotData.filePath) {
        const result = await window.electronAPI.readFileContent(slotData.filePath);
        if (result && result.success && result.content) code = result.content;
      }
      if (!code) {
        failedSlots.push(i + 1);
        continue;
      }

      const detectedType = detectRenderMode(slotData.filePath || null, code);
      const isScene = slotData.type === 'scene' || detectedType === 'scene';
      if (isScene) {
        await assignSceneToSlot(
          i, code, slotData.filePath || null, true,
          slotData.params, slotData.presets, slotData.customParams,
        );
      } else {
        await assignShaderToSlot(
          i, code, slotData.filePath || null, true,
          slotData.params, slotData.presets, slotData.customParams,
        );
      }
      loadedCount++;
    } catch (err: unknown) {
      // Store the shader anyway so user can edit it
      assignFailedShaderToSlot(
        i,
        slotData.shaderCode || '',
        slotData.filePath || null,
        slotData as unknown as Record<string, unknown>,
      );
      failedSlots.push(i + 1);
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('Grid', `Failed to compile slot ${i + 1}: ${msg}`);
    }
  }

  // Save in new format
  saveGridState();

  if (failedSlots.length > 0) {
    setStatus(
      `Migrated ${loadedCount} items, ${failedSlots.length} failed to compile (slots: ${failedSlots.join(', ')})`,
      'success',
    );
  } else if (loadedCount > 0) {
    setStatus(
      `Migrated ${loadedCount} item${loadedCount > 1 ? 's' : ''} to tabbed format`,
      'success',
    );
  }
}

// ---------------------------------------------------------------------------
// loadGridPresetsFromData
// ---------------------------------------------------------------------------

export async function loadGridPresetsFromData(
  gridState: unknown,
  filePath: string,
): Promise<void> {
  if (!gridState || !Array.isArray(gridState)) {
    setStatus('Invalid grid presets file', 'error');
    return;
  }

  // Dispose all existing renderers
  for (let i = 0; i < state.gridSlots.length; i++) {
    const slot = state.gridSlots[i] as Record<string, unknown> | null;
    if (slot && slot.renderer) {
      const renderer = slot.renderer as { dispose?: () => void };
      if (renderer.dispose) {
        renderer.dispose();
      }
    }
  }

  // Compact: only keep entries with shader data
  const compactState = (gridState as SavedSlotData[]).filter(
    (s): s is SavedSlotData => !!(s && s.shaderCode),
  );

  // Reset state
  state.gridSlots = new Array(compactState.length).fill(null);
  state.activeGridSlot = null;
  rebuildGridDOM();

  // Load new presets
  let loadedCount = 0;
  for (let i = 0; i < compactState.length; i++) {
    const slotData = compactState[i];
    try {
      const detectedType = detectRenderMode(slotData.filePath || null, slotData.shaderCode!);
      const isScene = slotData.type === 'scene' || detectedType === 'scene';
      if (isScene) {
        await assignSceneToSlot(
          i, slotData.shaderCode!, slotData.filePath || null, true,
          slotData.params, slotData.presets, slotData.customParams,
        );
      } else {
        await assignShaderToSlot(
          i, slotData.shaderCode!, slotData.filePath || null, true,
          slotData.params, slotData.presets, slotData.customParams,
        );
      }
      loadedCount++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Failed to load ${slotData.type || 'shader'} in slot ${i + 1}:`, msg);
    }
  }

  const fileName = filePath.split('/').pop()!.split('\\').pop()!;
  if (loadedCount > 0) {
    setStatus(
      `Loaded ${loadedCount} shader${loadedCount > 1 ? 's' : ''} from ${fileName}`,
      'success',
    );
    // Save as current state
    await resaveAllShaderFiles();
    saveGridState();
  } else {
    setStatus(`No valid shaders found in ${fileName}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// resaveAllShaderFiles
// ---------------------------------------------------------------------------

export async function resaveAllShaderFiles(): Promise<void> {
  // Collect all slots across all tabs with their global indices
  let totalSlots = 0;
  const allSlots: { globalIndex: number; slot: Record<string, unknown> | null }[] = [];
  for (const tab of ((state.shaderTabs || []) as ShaderTabLike[])) {
    for (let i = 0; i < (tab.slots || []).length; i++) {
      allSlots.push({
        globalIndex: totalSlots,
        slot: (tab.slots || [])[i] as Record<string, unknown> | null,
      });
      totalSlots++;
    }
  }

  // Delete files at all indices up to a generous upper bound
  const maxIndex = Math.max(totalSlots + 50, 100);
  const deletePromises: Promise<void>[] = [];
  for (let i = 0; i < maxIndex; i++) {
    deletePromises.push(window.electronAPI.deleteShaderFromSlot(i));
  }
  await Promise.all(deletePromises);

  // Save all tabs' shader files in parallel using global indices
  const savePromises: Promise<void>[] = [];
  for (const { globalIndex, slot } of allSlots) {
    if (slot && slot.shaderCode) {
      savePromises.push(
        window.electronAPI.saveShaderToSlot(globalIndex, slot.shaderCode as string),
      );
    }
  }
  await Promise.all(savePromises);
}
