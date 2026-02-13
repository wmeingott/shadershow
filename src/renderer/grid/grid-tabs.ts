// Grid Tabs — Section bar, tab bar, tab switching, tab CRUD, tab context menu,
// and tab-level export/import for shaders and compositions.
// Typed version of js/shader-grid.js lines 81-658.

import { state, notifyRemoteStateChanged } from '../core/state.js';
import { createTaggedLogger, LOG_LEVEL } from '../../shared/logger.js';
import {
  showContextMenu as showContextMenuHelper,
  hideContextMenu as hideContextMenuHelper,
} from '../ui/context-menu.js';
import { fileTextureCache } from './grid-renderer.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createTaggedLogger(LOG_LEVEL.WARN);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Runtime shape of a shader tab — extends the base ShaderTab with optional fields. */
export interface ShaderTabLike {
  name: string;
  type?: string;
  slots?: unknown[];
  mixPresets?: unknown[];
}

/** Minimal slot shape used during import/export and deletion. */
interface SlotData {
  type?: string;
  shaderCode?: string;
  params?: Record<string, unknown>;
  customParams?: Record<string, unknown>;
  presets?: unknown[];
  label?: string | null;
  renderer?: { dispose?: () => void } | null;
}

/** Shape of a mix preset stored in a mix tab. */
interface MixPreset {
  name: string;
  blendMode?: string;
  channels?: unknown[];
  thumbnail?: string | null;
}

/** Shape of an imported shader item from electronAPI. */
interface ImportedShaderItem {
  data: {
    type?: string;
    shaderCode?: string;
    params?: Record<string, unknown>;
    customParams?: Record<string, unknown>;
    presets?: unknown[];
    label?: string | null;
  };
  fileName: string;
}

/** Shape of an imported composition item from electronAPI. */
interface ImportedCompItem {
  data: {
    name?: string;
    blendMode?: string;
    channels?: unknown[];
    thumbnail?: string | null;
  };
  fileName: string;
}

/** Bulk export result from electronAPI. */
interface BulkExportResult {
  success: boolean;
  exported: number;
  folder?: string;
  errors: string[];
  error?: string;
}

/** Bulk import result from electronAPI. */
interface BulkImportResult {
  canceled?: boolean;
  error?: string;
  items: ImportedShaderItem[] | ImportedCompItem[];
  errors: string[];
  sourceFolder?: string;
}

/** Texture export result from electronAPI. */
interface TextureExportResult {
  exported: number;
}

/** Texture import result from electronAPI. */
interface TextureImportResult {
  imported: number;
  skipped?: string[];
}

// ---------------------------------------------------------------------------
// electronAPI surface used by this module
// ---------------------------------------------------------------------------

declare const window: Window & {
  electronAPI: {
    exportButtonDataBulk(
      format: string,
      items: { data: unknown; fileName: string }[],
    ): Promise<BulkExportResult>;
    importButtonDataBulk(format: string): Promise<BulkImportResult>;
    exportTexturesToFolder(
      folder: string,
      names: string[],
    ): Promise<TextureExportResult>;
    importTexturesFromFolder(
      sourceFolder: string,
    ): Promise<TextureImportResult>;
  };
};

// ---------------------------------------------------------------------------
// Stubs for unconverted modules
// ---------------------------------------------------------------------------

declare function stopGridAnimation(): void;
declare function cleanupGridVisibilityObserver(): void;
declare function startGridAnimation(): void;
declare function rebuildMixPanelDOM(): void;
declare function rebuildAssetGridDOM(): void;
declare function rebuildGridDOM(): void;
declare function saveGridState(): void;
declare function hideContextMenu(): void;
declare function updateSaveButtonState(): void;
declare function isSceneCode(code: string): boolean;
declare function assignShaderToSlot(
  slotIndex: number,
  code: string,
  filePath: string | null,
  isInitialLoad: boolean,
  params?: Record<string, unknown>,
  presets?: unknown[],
  customParams?: Record<string, unknown>,
): Promise<void>;
declare function assignSceneToSlot(
  slotIndex: number,
  code: string,
  filePath: string | null,
  isInitialLoad: boolean,
  params?: Record<string, unknown>,
  presets?: unknown[],
  customParams?: Record<string, unknown>,
): Promise<void>;
declare function setStatus(msg: string, type?: string): void;
declare function updateLocalPresetsUI(): void;

// ---------------------------------------------------------------------------
// Helpers — cast state.shaderTabs to runtime shape
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
// Section bar (Shaders / Assets / Composition)
// ---------------------------------------------------------------------------

function buildSectionBar(): void {
  const gridPanel = document.getElementById('grid-panel');
  if (!gridPanel) return;

  let sectionBar = document.getElementById('grid-section-bar');

  if (!sectionBar) {
    sectionBar = document.createElement('div');
    sectionBar.id = 'grid-section-bar';
    sectionBar.className = 'grid-section-bar';
    gridPanel.insertBefore(sectionBar, gridPanel.firstChild);
  }

  sectionBar.innerHTML = '';
  const activeSection = getActiveSection();

  const sections = [
    { id: 'shaders', label: 'Shaders' },
    { id: 'assets', label: 'Assets' },
    { id: 'mix', label: 'Composition' },
  ];

  for (const sec of sections) {
    const btn = document.createElement('div');
    btn.className = `grid-section-tab${sec.id === activeSection ? ' active' : ''}`;
    btn.textContent = sec.label;
    btn.addEventListener('click', () => switchSection(sec.id));
    sectionBar.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// Switch between Shaders / Assets / Composition sections
// ---------------------------------------------------------------------------

function switchSection(section: string): void {
  if (getActiveSection() === section) return;
  log.debug('Grid', `switchSection: ${section}`);
  setActiveSection(section);

  const tabs = getTabs();

  // Find the first tab matching this section
  const matchingIndex = tabs.findIndex((t) => {
    if (section === 'mix') return t.type === 'mix';
    if (section === 'assets') return t.type === 'assets';
    return t.type !== 'mix' && t.type !== 'assets';
  });

  if (matchingIndex >= 0) {
    switchShaderTab(matchingIndex);
  } else {
    // No tabs of this type exist -- create one
    if (section === 'mix') {
      addNewMixTab();
    } else if (section === 'assets') {
      addNewAssetTab();
    } else {
      addNewShaderTab();
    }
  }
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

export function buildTabBar(): void {
  const gridPanel = document.getElementById('grid-panel');
  if (!gridPanel) return;

  // Build section bar above
  buildSectionBar();

  let tabBar = document.getElementById('shader-grid-tabs');

  if (!tabBar) {
    tabBar = document.createElement('div');
    tabBar.id = 'shader-grid-tabs';
    tabBar.className = 'shader-grid-tabs';
    // Insert after section bar
    const sectionBar = document.getElementById('grid-section-bar');
    if (sectionBar && sectionBar.nextSibling) {
      gridPanel.insertBefore(tabBar, sectionBar.nextSibling);
    } else {
      gridPanel.insertBefore(tabBar, gridPanel.firstChild);
    }
  }

  tabBar.innerHTML = '';

  // Filter tabs by active section
  const activeSection = getActiveSection();
  const tabs = getTabs();

  // Create tabs only for the active section
  tabs.forEach((tab, index) => {
    const tabType = tab.type || 'shaders';
    // Only show tabs belonging to the current section
    if (activeSection === 'mix' && tabType !== 'mix') return;
    if (activeSection === 'assets' && tabType !== 'assets') return;
    if (activeSection === 'shaders' && (tabType === 'mix' || tabType === 'assets')) return;

    const tabEl = document.createElement('div');
    tabEl.className = `shader-grid-tab${index === state.activeShaderTab ? ' active' : ''}`;
    tabEl.dataset.tabIndex = String(index);
    tabEl.textContent = tab.name;

    const isMix = tabType === 'mix';
    const isAsset = tabType === 'assets';
    const count = isMix
      ? (tab.mixPresets || []).length
      : (tab.slots || []).filter((s) => s).length;
    const countLabel = isMix ? 'mixes' : isAsset ? 'assets' : 'shaders';
    tabEl.title = `${tab.name} (${count} ${countLabel})`;

    // Click to switch tab
    tabEl.addEventListener('click', () => switchShaderTab(index));

    // Right-click for tab context menu
    tabEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showTabContextMenu(e.clientX, e.clientY, index);
    });

    // Double-click to rename
    tabEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      renameShaderTab(index);
    });

    tabBar.appendChild(tabEl);
  });

  // Add "+" button -- creates tab of current section type
  const addTabBtn = document.createElement('div');
  addTabBtn.className = 'shader-grid-tab add-tab';
  addTabBtn.textContent = '+';
  const sectionLabels: Record<string, string> = {
    mix: 'Add new mix panel',
    assets: 'Add new asset tab',
    shaders: 'Add new shader tab',
  };
  addTabBtn.title = sectionLabels[activeSection] || 'Add new tab';
  addTabBtn.addEventListener('click', () => {
    if (activeSection === 'mix') {
      addNewMixTab();
    } else if (activeSection === 'assets') {
      addNewAssetTab();
    } else {
      addNewShaderTab();
    }
  });
  tabBar.appendChild(addTabBtn);
}

// ---------------------------------------------------------------------------
// Switch to a different shader tab
// ---------------------------------------------------------------------------

export function switchShaderTab(tabIndex: number): void {
  const tabs = getTabs();
  if (tabIndex < 0 || tabIndex >= tabs.length) return;

  // Stop grid animation while switching
  stopGridAnimation();

  // Cleanup current tab's renderers from DOM
  cleanupGridVisibilityObserver();

  // Update active tab and section
  state.activeShaderTab = tabIndex;
  const tab = tabs[tabIndex];
  log.debug('Grid', `switchShaderTab: index=${tabIndex}, type=${tab?.type || 'shaders'}, name="${tab?.name}"`);

  if (tab.type === 'mix') setActiveSection('mix');
  else if (tab.type === 'assets') setActiveSection('assets');
  else setActiveSection('shaders');

  if (tab.type === 'mix') {
    state.gridSlots = [];
    state.activeGridSlot = null;
    rebuildMixPanelDOM();
  } else if (tab.type === 'assets') {
    state.gridSlots = tab.slots || [];
    state.activeGridSlot = null;
    rebuildAssetGridDOM();
  } else {
    state.gridSlots = tab.slots || [];
    state.activeGridSlot = null;
    rebuildGridDOM();
  }

  // Rebuild tab bar to update active state
  buildTabBar();

  // Restart animation if grid is visible (shader and asset tabs)
  if (state.gridEnabled && tab.type !== 'mix') {
    startGridAnimation();
  }

  // Update presets UI
  updateLocalPresetsUI();
  updateSaveButtonState();

  setStatus(`Switched to "${tab.name}"`, 'success');
  notifyRemoteStateChanged();
}

// ---------------------------------------------------------------------------
// Add a new shader tab
// ---------------------------------------------------------------------------

function addNewShaderTab(): void {
  const tabs = getTabs();
  const newName = `Tab ${tabs.length + 1}`;
  log.info('Grid', `addNewShaderTab: "${newName}"`);
  tabs.push({ name: newName, slots: [] });

  // Switch to new tab
  switchShaderTab(tabs.length - 1);

  // Save state
  saveGridState();

  setStatus(`Created new tab "${newName}"`, 'success');
}

// ---------------------------------------------------------------------------
// Rename a shader tab (inline input)
// ---------------------------------------------------------------------------

function renameShaderTab(tabIndex: number): void {
  const tabs = getTabs();
  const tab = tabs[tabIndex];
  if (!tab) return;

  // Create inline input for renaming
  const tabBar = document.getElementById('shader-grid-tabs');
  if (!tabBar) return;
  const tabEl = tabBar.querySelector(`[data-tab-index="${tabIndex}"]`) as HTMLElement | null;
  if (!tabEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'shader-tab-rename-input';
  input.value = tab.name;

  const finishRename = (): void => {
    const newName = input.value.trim() || tab.name;
    tab.name = newName;
    buildTabBar();
    saveGridState();
  };

  input.addEventListener('blur', finishRename);
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = tab.name;
      input.blur();
    }
  });

  tabEl.textContent = '';
  tabEl.appendChild(input);
  input.focus();
  input.select();
}

// ---------------------------------------------------------------------------
// Delete a shader tab
// ---------------------------------------------------------------------------

async function deleteShaderTab(tabIndex: number): Promise<void> {
  const tabs = getTabs();

  if (tabs.length <= 1) {
    setStatus('Cannot delete the last tab', 'error');
    return;
  }

  const tab = tabs[tabIndex];
  const isMix = tab.type === 'mix';
  const itemCount = isMix
    ? (tab.mixPresets || []).length
    : (tab.slots || []).filter((s) => s).length;
  const itemLabel = isMix ? 'mix preset(s)' : 'shader(s)';
  log.info('Grid', `deleteShaderTab: "${tab.name}" with ${itemCount} ${itemLabel}`);

  if (itemCount > 0) {
    if (!confirm(`Delete "${tab.name}" with ${itemCount} ${itemLabel}?`)) {
      return;
    }
  }

  // Dispose renderers in this tab (only for shader/asset tabs)
  if (!isMix && tab.slots) {
    for (const slot of tab.slots) {
      const s = slot as SlotData | null;
      if (s && s.renderer && s.renderer.dispose) {
        s.renderer.dispose();
      }
    }
  }

  // Remove the tab
  tabs.splice(tabIndex, 1);

  // Try to find another tab in the same section
  const tabType = tab.type || 'shaders';
  const sameSection = tabs.findIndex((t) => (t.type || 'shaders') === tabType);

  if (sameSection >= 0) {
    state.activeShaderTab = sameSection;
  } else {
    // No tabs left in this section -- switch to shaders
    setActiveSection('shaders');
    state.activeShaderTab = 0;
  }

  // Update gridSlots reference
  const newActiveTab = tabs[state.activeShaderTab];
  state.gridSlots = newActiveTab.type === 'mix' ? [] : (newActiveTab.slots || []);

  // Rebuild UI
  if (newActiveTab.type === 'mix') {
    rebuildMixPanelDOM();
  } else if (newActiveTab.type === 'assets') {
    rebuildAssetGridDOM();
  } else {
    rebuildGridDOM();
  }
  buildTabBar();
  saveGridState();

  setStatus(`Deleted tab "${tab.name}"`, 'success');
}

// ---------------------------------------------------------------------------
// Tab context menu
// ---------------------------------------------------------------------------

function showTabContextMenu(x: number, y: number, tabIndex: number): void {
  hideContextMenu();

  const tabs = getTabs();
  const tab = tabs[tabIndex];
  const tabType = tab?.type || 'shaders';

  const items: Array<{
    label?: string;
    action?: () => void;
    disabled?: boolean;
    separator?: boolean;
  }> = [
    { label: 'Rename Tab', action: () => renameShaderTab(tabIndex) },
    {
      label: 'Delete Tab',
      action: () => deleteShaderTab(tabIndex),
      disabled: tabs.length <= 1,
    },
    { separator: true },
  ];

  if (tabType === 'mix') {
    const hasPresets = (tab.mixPresets || []).length > 0;
    items.push({
      label: 'Export All Compositions...',
      action: () => exportTabMixPresets(tabIndex),
      disabled: !hasPresets,
    });
    items.push({
      label: 'Import Compositions...',
      action: () => importTabMixPresets(tabIndex),
    });
  } else if (tabType !== 'assets') {
    const hasSlots = (tab.slots || []).some((s) => s !== null);
    items.push({
      label: 'Export All Shaders...',
      action: () => exportTabShaders(tabIndex),
      disabled: !hasSlots,
    });
    items.push({
      label: 'Import Shaders...',
      action: () => importTabShaders(tabIndex),
    });
  }

  showContextMenuHelper(x, y, items);
}

function hideTabContextMenu(): void {
  hideContextMenuHelper();
}

// ---------------------------------------------------------------------------
// Texture directive extraction
// ---------------------------------------------------------------------------

function extractTextureNames(shaderCode: string | undefined): Set<string> {
  const names = new Set<string>();
  if (!shaderCode) return names;
  const regex = /^\s*\/\/\s*@texture\s+iChannel[0-3]\s+texture:(\w+)/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(shaderCode)) !== null) {
    names.add(match[1]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Tab-level bulk export: shaders
// ---------------------------------------------------------------------------

async function exportTabShaders(tabIndex: number): Promise<void> {
  const tabs = getTabs();
  const tab = tabs[tabIndex];
  if (!tab || tab.type === 'mix' || tab.type === 'assets') return;

  const slots = (tab.slots || []) as SlotData[];
  const items: { data: unknown; fileName: string }[] = [];
  const allTextureNames = new Set<string>();

  for (let i = 0; i < slots.length; i++) {
    const slotData = slots[i];
    if (!slotData) continue;

    const exportData = {
      format: 'shadershow-shader',
      version: 1,
      type: slotData.type || 'shader',
      shaderCode: slotData.shaderCode,
      params: slotData.params || {},
      customParams: slotData.customParams || {},
      presets: slotData.presets || [],
      label: slotData.label || null,
    };
    const fileName = slotData.label || `slot-${i + 1}`;
    items.push({ data: exportData, fileName });

    // Collect texture references
    for (const name of extractTextureNames(slotData.shaderCode)) {
      allTextureNames.add(name);
    }
  }

  if (items.length === 0) {
    setStatus('No shaders to export', 'error');
    return;
  }

  const result = await window.electronAPI.exportButtonDataBulk('shadershow-shader', items);
  if (result.success) {
    // Copy referenced textures into textures/ subfolder
    let texMsg = '';
    if (allTextureNames.size > 0 && result.folder) {
      const texResult = await window.electronAPI.exportTexturesToFolder(
        result.folder,
        [...allTextureNames],
      );
      if (texResult.exported > 0) {
        texMsg = `, ${texResult.exported} texture(s)`;
      }
    }
    setStatus(`Exported ${result.exported} shader(s)${texMsg} to folder`, 'success');
    if (result.errors.length > 0) {
      log.warn('Grid', `Export errors: ${result.errors.join(', ')}`);
    }
  } else if (result.error) {
    setStatus(`Export failed: ${result.error}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Tab-level bulk import: shaders
// ---------------------------------------------------------------------------

async function importTabShaders(tabIndex: number): Promise<void> {
  const tabs = getTabs();
  const tab = tabs[tabIndex];
  if (!tab || tab.type === 'mix' || tab.type === 'assets') return;

  const result = await window.electronAPI.importButtonDataBulk('shadershow-shader');
  if (result.canceled) return;
  if (result.error) {
    setStatus(`Import failed: ${result.error}`, 'error');
    return;
  }

  if (result.items.length === 0) {
    setStatus('No valid shader files found', 'error');
    return;
  }

  // Import textures from textures/ subfolder next to the selected files
  let texMsg = '';
  if (result.sourceFolder) {
    const texResult = await window.electronAPI.importTexturesFromFolder(result.sourceFolder);
    if (texResult.imported > 0) {
      texMsg = `, ${texResult.imported} texture(s) imported`;
      // Clear texture cache so newly imported textures get loaded
      fileTextureCache.clear();
    }
    if (texResult.skipped?.length) {
      log.info('Grid', `Skipped existing textures: ${texResult.skipped.join(', ')}`);
    }
  }

  // Switch to the target tab so assignShaderToSlot operates on the right slots
  const prevTab = state.activeShaderTab;
  if (tabIndex !== prevTab) {
    switchShaderTab(tabIndex);
  }

  let imported = 0;
  for (const item of result.items as ImportedShaderItem[]) {
    const data = item.data;
    // Add a new slot for each imported shader
    const slotIndex = state.gridSlots.length;
    state.gridSlots.push(null);
    rebuildGridDOM();

    try {
      if (data.type === 'scene' || (data.shaderCode && isSceneCode(data.shaderCode))) {
        await assignSceneToSlot(
          slotIndex,
          data.shaderCode || '',
          null,
          false,
          data.params,
          data.presets,
          data.customParams,
        );
      } else {
        await assignShaderToSlot(
          slotIndex,
          data.shaderCode || '',
          null,
          false,
          data.params,
          data.presets,
          data.customParams,
        );
      }
      if (data.label) {
        const slot = state.gridSlots[slotIndex] as SlotData | null;
        if (slot) slot.label = data.label;
        const slotEl = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
        const labelEl = slotEl?.querySelector('.slot-label');
        if (labelEl) labelEl.textContent = data.label;
      }
      imported++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Grid', `Failed to import shader "${item.fileName}": ${message}`);
    }
  }

  saveGridState();
  setStatus(
    `Imported ${imported} shader(s)${texMsg}${result.errors.length > 0 ? ` (${result.errors.length} failed)` : ''}`,
    'success',
  );
}

// ---------------------------------------------------------------------------
// Tab-level bulk export: compositions (mix presets)
// ---------------------------------------------------------------------------

async function exportTabMixPresets(tabIndex: number): Promise<void> {
  const tabs = getTabs();
  const tab = tabs[tabIndex];
  if (!tab || tab.type !== 'mix') return;

  const presets = (tab.mixPresets || []) as MixPreset[];
  if (presets.length === 0) {
    setStatus('No compositions to export', 'error');
    return;
  }

  const items = presets.map((preset) => {
    const exportData = {
      format: 'shadershow-comp',
      version: 1,
      name: preset.name,
      blendMode: preset.blendMode,
      channels: preset.channels,
      thumbnail: preset.thumbnail,
    };
    const fileName = preset.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    return { data: exportData, fileName };
  });

  const result = await window.electronAPI.exportButtonDataBulk('shadershow-comp', items);
  if (result.success) {
    setStatus(`Exported ${result.exported} composition(s) to folder`, 'success');
    if (result.errors.length > 0) {
      log.warn('Grid', `Export errors: ${result.errors.join(', ')}`);
    }
  } else if (result.error) {
    setStatus(`Export failed: ${result.error}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Tab-level bulk import: compositions (mix presets)
// ---------------------------------------------------------------------------

async function importTabMixPresets(tabIndex: number): Promise<void> {
  const tabs = getTabs();
  const tab = tabs[tabIndex];
  if (!tab || tab.type !== 'mix') return;

  const result = await window.electronAPI.importButtonDataBulk('shadershow-comp');
  if (result.canceled) return;
  if (result.error) {
    setStatus(`Import failed: ${result.error}`, 'error');
    return;
  }

  if (result.items.length === 0) {
    setStatus('No valid composition files found', 'error');
    return;
  }

  if (!tab.mixPresets) tab.mixPresets = [];

  let imported = 0;
  for (const item of result.items as ImportedCompItem[]) {
    const data = item.data;
    (tab.mixPresets as MixPreset[]).push({
      name: data.name || `Mix ${(tab.mixPresets as MixPreset[]).length + 1}`,
      blendMode: data.blendMode || 'lighter',
      channels: data.channels || [],
      thumbnail: data.thumbnail || null,
    });
    imported++;
  }

  // Refresh UI if this is the active tab
  if (tabIndex === state.activeShaderTab) {
    rebuildMixPanelDOM();
  }
  saveGridState();
  setStatus(
    `Imported ${imported} composition(s)${result.errors.length > 0 ? ` (${result.errors.length} failed)` : ''}`,
    'success',
  );
}

// ---------------------------------------------------------------------------
// Add new mix tab
// ---------------------------------------------------------------------------

function addNewMixTab(): void {
  const tabs = getTabs();
  const mixTabCount = tabs.filter((t) => t.type === 'mix').length;
  const newName = `Mixes ${mixTabCount + 1}`;
  log.info('Grid', `addNewMixTab: "${newName}"`);
  tabs.push({ name: newName, type: 'mix', mixPresets: [] });

  switchShaderTab(tabs.length - 1);
  saveGridState();

  setStatus(`Created mix panel "${newName}"`, 'success');
}

// ---------------------------------------------------------------------------
// Add new asset tab
// ---------------------------------------------------------------------------

function addNewAssetTab(): void {
  const tabs = getTabs();
  const assetTabCount = tabs.filter((t) => t.type === 'assets').length;
  const newName = `Assets ${assetTabCount + 1}`;
  log.info('Grid', `addNewAssetTab: "${newName}"`);
  tabs.push({ name: newName, type: 'assets', slots: [] });

  switchShaderTab(tabs.length - 1);
  saveGridState();

  setStatus(`Created asset tab "${newName}"`, 'success');
}
