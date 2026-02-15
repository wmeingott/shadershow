// Shader Grid — core slot logic: DOM creation, drag-and-drop, context menu,
// assign/select/play, save/clear/rename, export/import, tile assignment,
// and init/cleanup lifecycle.
// Typed version of js/shader-grid.js (slot-focused portions).

import { state, notifyRemoteStateChanged } from '../core/state.js';
import { createTaggedLogger, LOG_LEVEL } from '../../shared/logger.js';
import type { ParamValue } from '@shared/types/params.js';
import { MiniShaderRenderer } from '../renderers/mini-shader-renderer.js';
import { tileState, assignTile } from '../tiles/tile-state.js';
import {
  loadFileTexturesForRenderer,
  applyMaxContainerHeight,
  startGridAnimation,
  stopGridAnimation,
  reinitGridVisibilityObserver,
} from './grid-renderer.js';
import { assignShaderToMixer, addMixerChannel } from '../ui/mixer.js';
import { updateTileRenderer, refreshTileRenderers } from '../ui/controls.js';
import {
  showContextMenu as showContextMenuHelper,
  hideContextMenu as hideContextMenuHelper,
} from '../ui/context-menu.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createTaggedLogger(LOG_LEVEL.WARN);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Runtime shape of a grid slot stored in state.gridSlots */
interface GridSlotData {
  shaderCode: string;
  filePath: string | null;
  renderer: unknown;
  type: string;
  params: Record<string, unknown>;
  customParams: Record<string, unknown>;
  presets: unknown[];
  label?: string;
  thumbnail?: string;
  hasError?: boolean;
  mediaPath?: string;
}

/** Minimal MiniShaderRenderer surface used by this module */
interface MiniRendererLike {
  canvas: HTMLCanvasElement;
  ctx2d: CanvasRenderingContext2D | null;
  compile(source: string): void;
  dispose?(): void;
  setParams?(params: Record<string, unknown>): void;
  setSpeed?(speed: number): void;
  render?(): void;
  customParams?: Array<{ name: string; default: ParamValue }>;
  customParamValues?: Record<string, ParamValue>;
  setCustomParamValues?(params: Record<string, unknown>): void;
  getCustomParamValues?(): Record<string, ParamValue>;
  fileTextureDirectives?: Array<{ channel: number; textureName: string }>;
  loadFileTexture?(channel: number, dataUrl: string): Promise<unknown>;
  loadTexture?(channel: number, dataUrl: string): Promise<unknown>;
  getParams?(): Record<string, unknown>;
}

/** Minimal renderer shape for the main state.renderer */
interface MainRendererLike extends MiniRendererLike {
  reinitialize?(): void;
  resetTime?(): void;
}

/** Result from loadShaderForGrid IPC call */
interface LoadShaderResult {
  content?: string;
  filePath?: string;
  error?: string;
}

/** Result from exportButtonData IPC call */
interface ExportResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

/** Result from importButtonData IPC call */
interface ImportResult {
  canceled?: boolean;
  error?: string;
  data?: {
    type?: string;
    shaderCode?: string;
    params?: Record<string, unknown>;
    customParams?: Record<string, unknown>;
    presets?: unknown[];
    label?: string | null;
  };
}

/** Result from saveShaderToSlot IPC call */
interface SaveResult {
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// electronAPI surface used by this module
// ---------------------------------------------------------------------------

declare const window: Window & {
  electronAPI: {
    saveShaderToSlot(slotIndex: number, code: string): Promise<SaveResult>;
    deleteShaderFromSlot(slotIndex: number): Promise<unknown>;
    loadShaderForGrid(): Promise<LoadShaderResult>;
    loadFileTexture(textureName: string): Promise<{ success: boolean; dataUrl?: string }>;
    exportButtonData(format: string, data: unknown, defaultName: string): Promise<ExportResult>;
    importButtonData(format: string): Promise<ImportResult>;
    sendShaderUpdate(data: Record<string, unknown>): void;
    sendParamUpdate(data: { name: string; value: unknown }): void;
    sendBatchParamUpdate?(params: Record<string, unknown>): void;
    sendTimeSync(data: { time: number; frame: number; isPlaying: boolean }): void;
    sendAssetUpdate(data: Record<string, unknown>): void;
    assignTileShader?(tileIndex: number, slotIndexOrCode: number | string, codeOrParams?: string | Record<string, unknown>, params?: Record<string, unknown>): void;
    saveTileState?(data: Record<string, unknown>): void;
    readFileContent?(filePath: string): Promise<{ success: boolean; content?: string }>;
  };
};

import { buildTabBar } from './grid-tabs.js';
import { rebuildMixPanelDOM } from './mix-presets.js';
import { rebuildAssetGridDOM, selectAssetSlot } from './asset-grid.js';
import { cleanupGridVisibilityObserver, initGridVisibilityObserver } from './grid-renderer.js';
import { loadGridState, saveGridState, resaveAllShaderFiles } from './grid-persistence.js';
import { setStatus } from '../ui/utils.js';
import { loadParamsToSliders, generateCustomParamUI } from '../ui/params.js';
import { updateLocalPresetsUI } from '../ui/presets.js';
import { compileShader, setEditorMode } from '../ui/editor.js';
import { setRenderMode, ensureSceneRenderer, detectRenderMode } from '../core/renderer-manager.js';
import { hideAssetOverlay } from '../core/render-loop.js';
import { openInTab } from '../ui/tabs.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Index of the slot currently being dragged */
export let dragSourceIndex: number | null = null;

export function setDragSourceIndex(value: number | null): void {
  dragSourceIndex = value;
}

/**
 * Map from slot DOM element to its registered event listeners.
 * Used for cleanup to prevent memory leaks on grid rebuild.
 */
export const slotEventListeners = new Map<
  HTMLElement,
  Array<{ event: string; handler: EventListener }>
>();

/** Handler attached to `document` to close context menus on click-outside */
let documentClickHandler: ((e: Event) => void) | null = null;

/** Reference to the grid IntersectionObserver (kept in grid-renderer.ts, but
 *  we reference it locally for new-slot observation) */
let gridIntersectionObserver: IntersectionObserver | null = null;

// ---------------------------------------------------------------------------
// 1. Move / Copy shader between tabs
// ---------------------------------------------------------------------------

/**
 * Move a shader from the active tab to another tab.
 * The slot is removed from the source tab and appended to the target.
 */
async function moveShaderToTab(slotIndex: number, targetTabIndex: number): Promise<void> {
  if (targetTabIndex === state.activeShaderTab) return;
  if (targetTabIndex < 0 || targetTabIndex >= state.shaderTabs.length) return;

  const sourceTab = state.shaderTabs[state.activeShaderTab];
  const targetTab = state.shaderTabs[targetTabIndex];
  const slotData = (sourceTab.slots as unknown[])[slotIndex];

  if (!slotData) {
    setStatus('No shader to move', 'error');
    return;
  }

  // Add to target tab
  (targetTab.slots as unknown[]).push(slotData);

  // Remove from source tab (and dispose renderer)
  (sourceTab.slots as unknown[]).splice(slotIndex, 1);

  // Fix activeGridSlot if needed
  if (state.activeGridSlot === slotIndex) {
    state.activeGridSlot = null;
  } else if (state.activeGridSlot !== null && state.activeGridSlot > slotIndex) {
    state.activeGridSlot--;
  }

  // Update gridSlots reference
  state.gridSlots = sourceTab.slots as unknown[];

  // Rebuild DOM
  rebuildGridDOM();
  saveGridState();

  // Re-save shader files with updated indices
  await resaveAllShaderFiles();

  setStatus(`Moved shader to "${targetTab.name}"`, 'success');
}

/**
 * Copy a shader from the active tab to another tab.
 * The original slot remains in the source tab.
 */
async function copyShaderToTab(slotIndex: number, targetTabIndex: number): Promise<void> {
  if (targetTabIndex === state.activeShaderTab) return;
  if (targetTabIndex < 0 || targetTabIndex >= state.shaderTabs.length) return;

  const sourceTab = state.shaderTabs[state.activeShaderTab];
  const targetTab = state.shaderTabs[targetTabIndex];
  const slotData = (sourceTab.slots as unknown[])[slotIndex] as GridSlotData | null;

  if (!slotData) {
    setStatus('No shader to copy', 'error');
    return;
  }

  // Deep copy the slot data (new renderer will be created when the target tab loads)
  const copy: Record<string, unknown> = {
    shaderCode: slotData.shaderCode,
    filePath: null, // New copy gets its own file on save
    type: slotData.type || 'shader',
    params: { ...(slotData.params || {}) },
    customParams: JSON.parse(JSON.stringify(slotData.customParams || {})),
    presets: JSON.parse(JSON.stringify(slotData.presets || [])),
    renderer: null,
  };
  if (slotData.label) copy.label = slotData.label;

  (targetTab.slots as unknown[]).push(copy);
  saveGridState();

  await resaveAllShaderFiles();

  setStatus(`Copied shader to "${targetTab.name}"`, 'success');
}

// ---------------------------------------------------------------------------
// 2. Slot event listeners cleanup
// ---------------------------------------------------------------------------

/**
 * Cleanup all grid event listeners, disconnect the intersection observer,
 * and stop the grid animation loop.
 */
export function cleanupShaderGrid(): void {
  // Remove slot event listeners
  slotEventListeners.forEach((listeners, slot) => {
    listeners.forEach(({ event, handler }) => {
      slot.removeEventListener(event, handler);
    });
  });
  slotEventListeners.clear();

  // Remove document click handler
  if (documentClickHandler) {
    document.removeEventListener('click', documentClickHandler);
    documentClickHandler = null;
  }

  // Disconnect intersection observer
  cleanupGridVisibilityObserver();

  // Stop grid animation
  stopGridAnimation();
}

// ---------------------------------------------------------------------------
// 3. Grid slot DOM creation
// ---------------------------------------------------------------------------

/**
 * Create a single grid slot DOM element with drag-and-drop, click,
 * double-click, and right-click context menu handlers.
 */
function createGridSlotElement(index: number): HTMLDivElement {
  const slot = document.createElement('div');
  slot.className = 'grid-slot';
  slot.dataset.slot = String(index);
  slot.setAttribute('draggable', 'true');

  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  slot.appendChild(canvas);

  const numberSpan = document.createElement('span');
  numberSpan.className = 'slot-number';
  numberSpan.textContent = String(index + 1);
  slot.appendChild(numberSpan);

  const labelSpan = document.createElement('span');
  labelSpan.className = 'slot-label';
  slot.appendChild(labelSpan);

  // Store listeners for this slot
  const listeners: Array<{ event: string; handler: EventListener }> = [];

  // Drag start - store source index
  const dragstartHandler = (e: DragEvent): void => {
    dragSourceIndex = index;
    slot.classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', index.toString());
  };
  slot.addEventListener('dragstart', dragstartHandler as EventListener);
  listeners.push({ event: 'dragstart', handler: dragstartHandler as EventListener });

  // Drag end - cleanup
  const dragendHandler = (): void => {
    slot.classList.remove('dragging');
    dragSourceIndex = null;
    document.querySelectorAll('.grid-slot.drag-over').forEach((s) => {
      s.classList.remove('drag-over');
    });
  };
  slot.addEventListener('dragend', dragendHandler);
  listeners.push({ event: 'dragend', handler: dragendHandler });

  // Drag over - allow drop
  const dragoverHandler = (e: DragEvent): void => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
  };
  slot.addEventListener('dragover', dragoverHandler as EventListener);
  listeners.push({ event: 'dragover', handler: dragoverHandler as EventListener });

  // Drag enter - visual feedback
  const dragenterHandler = (e: DragEvent): void => {
    e.preventDefault();
    if (dragSourceIndex !== null && dragSourceIndex !== index) {
      slot.classList.add('drag-over');
    }
  };
  slot.addEventListener('dragenter', dragenterHandler as EventListener);
  listeners.push({ event: 'dragenter', handler: dragenterHandler as EventListener });

  // Drag leave - remove visual feedback
  const dragleaveHandler = (e: DragEvent): void => {
    if (!slot.contains(e.relatedTarget as Node)) {
      slot.classList.remove('drag-over');
    }
  };
  slot.addEventListener('dragleave', dragleaveHandler as EventListener);
  listeners.push({ event: 'dragleave', handler: dragleaveHandler as EventListener });

  // Drop - swap slots
  const dropHandler = (e: DragEvent): void => {
    e.preventDefault();
    slot.classList.remove('drag-over');
    const fromIndex = parseInt(e.dataTransfer!.getData('text/plain'), 10);
    if (!isNaN(fromIndex) && fromIndex !== index) {
      swapGridSlots(fromIndex, index);
    }
  };
  slot.addEventListener('drop', dropHandler as EventListener);
  listeners.push({ event: 'drop', handler: dropHandler as EventListener });

  // Left click - select slot and load parameters (or assign to mixer if armed)
  const clickHandler = (): void => {
    if (state.gridSlots[index]) {
      if (state.mixerArmedChannel !== null) {
        assignShaderToMixer(state.mixerArmedChannel, index);
      } else {
        selectGridSlot(index);
      }
    }
  };
  slot.addEventListener('click', clickHandler);
  listeners.push({ event: 'click', handler: clickHandler });

  // Double click - open shader in editor tab
  const dblclickHandler = (): void => {
    if (state.gridSlots[index]) {
      loadGridShaderToEditor(index);
    }
  };
  slot.addEventListener('dblclick', dblclickHandler);
  listeners.push({ event: 'dblclick', handler: dblclickHandler });

  // Right click - context menu
  const contextmenuHandler = (e: MouseEvent): void => {
    e.preventDefault();
    showGridContextMenu(e.clientX, e.clientY, index);
  };
  slot.addEventListener('contextmenu', contextmenuHandler as EventListener);
  listeners.push({ event: 'contextmenu', handler: contextmenuHandler as EventListener });

  slotEventListeners.set(slot, listeners);

  return slot;
}

/**
 * Create the "+" add-shader button that appears at the end of the grid.
 * Left-click opens the file picker; right-click shows a context menu with
 * "Open File...", "Add Current Shader", and "Import Shader..." options.
 */
function createAddButton(): HTMLDivElement {
  const btn = document.createElement('div');
  btn.className = 'grid-slot grid-add-btn';
  btn.title = 'Add shader to grid (right-click for options)';

  const plusSign = document.createElement('span');
  plusSign.className = 'grid-add-plus';
  plusSign.textContent = '+';
  btn.appendChild(plusSign);

  btn.addEventListener('click', async () => {
    await addNewGridSlot();
  });

  btn.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    hideContextMenu();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.id = 'grid-context-menu';

    // Open file option
    const openItem = document.createElement('div');
    openItem.className = 'context-menu-item';
    openItem.textContent = 'Open File...';
    openItem.addEventListener('click', async () => {
      hideContextMenu();
      await addNewGridSlot();
    });
    menu.appendChild(openItem);

    // Add current shader option
    const addCurrentItem = document.createElement('div');
    addCurrentItem.className = 'context-menu-item';
    const code = (state.editor as { getValue(): string } | null)?.getValue() ?? '';
    const hasCode = code && code.trim();
    if (!hasCode) addCurrentItem.classList.add('disabled');
    addCurrentItem.textContent = 'Add Current Shader';
    addCurrentItem.addEventListener('click', () => {
      hideContextMenu();
      if (!hasCode) return;

      const newIndex = state.gridSlots.length;
      state.gridSlots.push(null);

      const container = document.getElementById('shader-grid-container')!;
      const slotEl = createGridSlotElement(newIndex);
      container.insertBefore(slotEl, btn);

      if (gridIntersectionObserver) {
        gridIntersectionObserver.observe(slotEl);
      }

      assignCurrentShaderToSlot(newIndex);

      if (!state.gridSlots[newIndex]) {
        removeGridSlotElement(newIndex);
      }
    });
    menu.appendChild(addCurrentItem);

    // Import shader option
    const importItem = document.createElement('div');
    importItem.className = 'context-menu-item';
    importItem.textContent = 'Import Shader...';
    importItem.addEventListener('click', async () => {
      hideContextMenu();

      const newIndex = state.gridSlots.length;
      state.gridSlots.push(null);

      const container = document.getElementById('shader-grid-container')!;
      const slotEl = createGridSlotElement(newIndex);
      container.insertBefore(slotEl, btn);

      if (gridIntersectionObserver) {
        gridIntersectionObserver.observe(slotEl);
      }

      await importShaderSlot(newIndex);

      // Remove slot if import was canceled or failed
      if (!state.gridSlots[newIndex]) {
        removeGridSlotElement(newIndex);
      }
    });
    menu.appendChild(importItem);

    // Position menu
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 5}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 5}px`;

    setTimeout(() => {
      const handler = (ev: MouseEvent): void => {
        if (!menu.contains(ev.target as Node)) {
          hideContextMenu();
          document.removeEventListener('click', handler);
        }
      };
      document.addEventListener('click', handler);
    }, 0);
  });

  return btn;
}

// ---------------------------------------------------------------------------
// 4. Grid slot operations
// ---------------------------------------------------------------------------

/**
 * Add a new empty slot and immediately prompt the user to load a shader.
 * If the user cancels, the empty slot is removed.
 */
async function addNewGridSlot(): Promise<void> {
  const newIndex = state.gridSlots.length;
  state.gridSlots.push(null);

  const container = document.getElementById('shader-grid-container')!;
  const addBtn = container.querySelector('.grid-add-btn');

  const slotEl = createGridSlotElement(newIndex);
  container.insertBefore(slotEl, addBtn);

  // Observe new slot for visibility
  if (gridIntersectionObserver) {
    gridIntersectionObserver.observe(slotEl);
  }

  // Prompt to load a shader
  await loadShaderToSlot(newIndex);

  // If user canceled, remove the empty slot
  if (!state.gridSlots[newIndex]) {
    removeGridSlotElement(newIndex);
  }
}

/**
 * Remove a grid slot DOM element, dispose its renderer, compact state,
 * and rebuild the grid DOM.
 */
function removeGridSlotElement(index: number): void {
  // Dispose renderer
  const slotData = state.gridSlots[index] as GridSlotData | null;
  if (slotData && slotData.renderer) {
    const renderer = slotData.renderer as MiniRendererLike;
    if (renderer.dispose) {
      renderer.dispose();
    }
  }

  // Remove from state
  state.gridSlots.splice(index, 1);

  // Fix activeGridSlot reference
  if (state.activeGridSlot === index) {
    state.activeGridSlot = null;
  } else if (state.activeGridSlot !== null && state.activeGridSlot > index) {
    state.activeGridSlot--;
  }

  // Rebuild DOM (simpler than re-indexing all elements + listeners)
  rebuildGridDOM();
}

/**
 * Rebuild all grid slot DOM elements from state.
 * Delegates to rebuildMixPanelDOM or rebuildAssetGridDOM for non-shader tabs.
 */
export function rebuildGridDOM(): void {
  // If active tab is a mix panel or asset tab, delegate
  const activeTab = state.shaderTabs[state.activeShaderTab] as { type?: string } | undefined;
  if (activeTab && activeTab.type === 'mix') {
    rebuildMixPanelDOM();
    return;
  }
  if (activeTab && activeTab.type === 'assets') {
    rebuildAssetGridDOM();
    return;
  }

  const container = document.getElementById('shader-grid-container')!;

  // Build tab bar first
  buildTabBar();

  // Cleanup existing listeners
  slotEventListeners.forEach((listeners, slot) => {
    listeners.forEach(({ event, handler }) => {
      slot.removeEventListener(event, handler);
    });
  });
  slotEventListeners.clear();
  cleanupGridVisibilityObserver();

  // Clear container
  container.innerHTML = '';

  // Recreate slot elements for each state entry
  for (let i = 0; i < state.gridSlots.length; i++) {
    const slotEl = createGridSlotElement(i);
    container.appendChild(slotEl);

    const data = state.gridSlots[i] as GridSlotData | null;
    if (data) {
      slotEl.classList.add('has-shader');
      if (data.hasError) slotEl.classList.add('has-error');
      if (state.activeGridSlot === i) slotEl.classList.add('active');

      const fileName = data.filePath
        ? data.filePath.split('/').pop()!.split('\\').pop()!
        : `Slot ${i + 1}`;
      const typeLabel = data.type === 'scene' ? ' (scene)' : '';
      slotEl.title = `Slot ${i + 1}: ${fileName}${typeLabel}`;

      // Set slot label
      const labelEl = slotEl.querySelector('.slot-label') as HTMLElement | null;
      if (labelEl) {
        labelEl.textContent = data.label || fileName.replace(/\.glsl$/i, '');
      }

      // Update renderer's canvas reference to the new DOM element
      if (data.renderer) {
        const newCanvas = slotEl.querySelector('canvas') as HTMLCanvasElement;
        const renderer = data.renderer as MiniRendererLike;
        renderer.canvas = newCanvas;
        renderer.ctx2d = newCanvas.getContext('2d');
      }
    }
  }

  // Add the "+" button at the end
  container.appendChild(createAddButton());

  // Reinitialize visibility observer
  initGridVisibilityObserver();

  // Maintain stable panel height across tab switches
  applyMaxContainerHeight();
}

// ---------------------------------------------------------------------------
// 5. Grid context menu
// ---------------------------------------------------------------------------

/**
 * Show the right-click context menu for a grid slot.
 * Builds the menu DOM manually with all actions: load, assign, params,
 * rename, clear, remove, export/import, move/copy tab, tile, and mixer.
 */
function showGridContextMenu(x: number, y: number, slotIndex: number): void {
  hideContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'grid-context-menu';

  const hasShader = state.gridSlots[slotIndex] !== null;

  // Load shader option
  const loadItem = document.createElement('div');
  loadItem.className = 'context-menu-item';
  loadItem.textContent = 'Load Shader...';
  loadItem.addEventListener('click', async () => {
    hideContextMenu();
    await loadShaderToSlot(slotIndex);
  });
  menu.appendChild(loadItem);

  // Assign current shader option
  const assignItem = document.createElement('div');
  assignItem.className = 'context-menu-item';
  assignItem.textContent = 'Assign Current Shader';
  assignItem.addEventListener('click', () => {
    hideContextMenu();
    assignCurrentShaderToSlot(slotIndex);
  });
  menu.appendChild(assignItem);

  // Set current params as default option (only if has shader)
  const setParamsItem = document.createElement('div');
  setParamsItem.className = `context-menu-item${hasShader ? '' : ' disabled'}`;
  setParamsItem.textContent = 'Set Current Params as Default';
  if (hasShader) {
    setParamsItem.addEventListener('click', () => {
      hideContextMenu();
      setCurrentParamsAsDefault(slotIndex);
    });
  }
  menu.appendChild(setParamsItem);

  // Rename label option (only if has shader)
  const renameItem = document.createElement('div');
  renameItem.className = `context-menu-item${hasShader ? '' : ' disabled'}`;
  renameItem.textContent = 'Rename';
  if (hasShader) {
    renameItem.addEventListener('click', () => {
      hideContextMenu();
      renameGridSlot(slotIndex);
    });
  }
  menu.appendChild(renameItem);

  // Clear option (only if has shader)
  const clearItem = document.createElement('div');
  clearItem.className = `context-menu-item${hasShader ? '' : ' disabled'}`;
  clearItem.textContent = 'Clear Slot';
  if (hasShader) {
    clearItem.addEventListener('click', () => {
      hideContextMenu();
      clearGridSlot(slotIndex);
    });
  }
  menu.appendChild(clearItem);

  // Remove slot option
  const removeItem = document.createElement('div');
  removeItem.className = 'context-menu-item';
  removeItem.textContent = 'Remove Slot';
  removeItem.addEventListener('click', async () => {
    hideContextMenu();
    // Delete the shader file first
    await window.electronAPI.deleteShaderFromSlot(slotIndex);
    removeGridSlotElement(slotIndex);
    saveGridState();
    // Re-save all shader files with updated indices
    await resaveAllShaderFiles();
    setStatus(`Removed slot ${slotIndex + 1}`, 'success');
  });
  menu.appendChild(removeItem);

  // Export/Import separator
  const exportSep = document.createElement('div');
  exportSep.className = 'context-menu-separator';
  menu.appendChild(exportSep);

  // Export Shader
  const exportItem = document.createElement('div');
  exportItem.className = `context-menu-item${hasShader ? '' : ' disabled'}`;
  exportItem.textContent = 'Export Shader...';
  if (hasShader) {
    exportItem.addEventListener('click', () => {
      hideContextMenu();
      exportShaderSlot(slotIndex);
    });
  }
  menu.appendChild(exportItem);

  // Import Shader
  const importItem = document.createElement('div');
  importItem.className = 'context-menu-item';
  importItem.textContent = 'Import Shader...';
  importItem.addEventListener('click', () => {
    hideContextMenu();
    importShaderSlot(slotIndex);
  });
  menu.appendChild(importItem);

  // Move/Copy to Tab submenus (only shader tabs, not mix tabs)
  if (hasShader) {
    const otherShaderTabs: number[] = [];
    for (let i = 0; i < state.shaderTabs.length; i++) {
      if (i === state.activeShaderTab) continue;
      const tab = state.shaderTabs[i] as { type?: string };
      if (tab.type === 'mix' || tab.type === 'assets') continue;
      otherShaderTabs.push(i);
    }

    if (otherShaderTabs.length > 0) {
      const separator1 = document.createElement('div');
      separator1.className = 'context-menu-separator';
      menu.appendChild(separator1);

      // Move to Tab
      const moveSubmenu = document.createElement('div');
      moveSubmenu.className = 'context-menu-item has-submenu';
      moveSubmenu.textContent = 'Move to Tab';
      const moveArrow = document.createElement('span');
      moveArrow.className = 'submenu-arrow';
      moveArrow.textContent = '\u25b6';
      moveSubmenu.appendChild(moveArrow);

      const moveContent = document.createElement('div');
      moveContent.className = 'context-submenu';
      for (const i of otherShaderTabs) {
        const item = document.createElement('div');
        item.className = 'context-menu-item';
        item.textContent = state.shaderTabs[i].name;
        item.addEventListener('click', () => {
          hideContextMenu();
          moveShaderToTab(slotIndex, i);
        });
        moveContent.appendChild(item);
      }
      moveSubmenu.appendChild(moveContent);
      menu.appendChild(moveSubmenu);

      // Copy to Tab
      const copySubmenu = document.createElement('div');
      copySubmenu.className = 'context-menu-item has-submenu';
      copySubmenu.textContent = 'Copy to Tab';
      const copyArrow = document.createElement('span');
      copyArrow.className = 'submenu-arrow';
      copyArrow.textContent = '\u25b6';
      copySubmenu.appendChild(copyArrow);

      const copyContent = document.createElement('div');
      copyContent.className = 'context-submenu';
      for (const i of otherShaderTabs) {
        const item = document.createElement('div');
        item.className = 'context-menu-item';
        item.textContent = state.shaderTabs[i].name;
        item.addEventListener('click', () => {
          hideContextMenu();
          copyShaderToTab(slotIndex, i);
        });
        copyContent.appendChild(item);
      }
      copySubmenu.appendChild(copyContent);
      menu.appendChild(copySubmenu);
    }
  }

  // Send to Tile submenu (only if has shader and tiles are configured)
  if (hasShader && tileState.tiles.length > 0) {
    const separator = document.createElement('div');
    separator.className = 'context-menu-separator';
    menu.appendChild(separator);

    const { rows, cols } = tileState.layout;
    const tileCount = rows * cols;

    // Create "Send to Tile" submenu container
    const tileSubmenu = document.createElement('div');
    tileSubmenu.className = 'context-menu-item has-submenu';
    tileSubmenu.textContent = 'Send to Tile';

    const submenuArrow = document.createElement('span');
    submenuArrow.className = 'submenu-arrow';
    submenuArrow.textContent = '\u25b6';
    tileSubmenu.appendChild(submenuArrow);

    const submenuContent = document.createElement('div');
    submenuContent.className = 'context-submenu';

    for (let i = 0; i < tileCount; i++) {
      const tileItem = document.createElement('div');
      tileItem.className = 'context-menu-item';
      const currentSlot = tileState.tiles[i]?.gridSlotIndex;
      const tileLabel =
        currentSlot !== null && currentSlot !== undefined
          ? `Tile ${i + 1} (Slot ${currentSlot + 1})`
          : `Tile ${i + 1} (Empty)`;
      tileItem.textContent = tileLabel;

      tileItem.addEventListener('click', () => {
        hideContextMenu();
        assignShaderToTile(slotIndex, i);
      });

      submenuContent.appendChild(tileItem);
    }

    tileSubmenu.appendChild(submenuContent);
    menu.appendChild(tileSubmenu);
  }

  // Send to Mix Channel submenu (only if has shader)
  if (hasShader) {
    const mixSeparator = document.createElement('div');
    mixSeparator.className = 'context-menu-separator';
    menu.appendChild(mixSeparator);

    const mixSubmenu = document.createElement('div');
    mixSubmenu.className = 'context-menu-item has-submenu';
    mixSubmenu.textContent = 'Send to Mix Channel';

    const mixArrow = document.createElement('span');
    mixArrow.className = 'submenu-arrow';
    mixArrow.textContent = '\u25b6';
    mixSubmenu.appendChild(mixArrow);

    const mixContent = document.createElement('div');
    mixContent.className = 'context-submenu';

    for (let i = 0; i < state.mixerChannels.length; i++) {
      const ch = state.mixerChannels[i];
      const mixItem = document.createElement('div');
      mixItem.className = 'context-menu-item';
      const chLabel =
        ch.slotIndex !== null
          ? `Ch ${i + 1} (Slot ${ch.slotIndex + 1})`
          : `Ch ${i + 1} (Empty)`;
      mixItem.textContent = chLabel;

      mixItem.addEventListener('click', () => {
        hideContextMenu();
        assignShaderToMixer(i, slotIndex);
      });
      mixContent.appendChild(mixItem);
    }

    // Add "New Channel" option if under the max
    if (state.mixerChannels.length < 8) {
      const newChItem = document.createElement('div');
      newChItem.className = 'context-menu-item';
      newChItem.textContent = '+ New Channel';
      newChItem.addEventListener('click', () => {
        hideContextMenu();
        const newIndex = addMixerChannel();
        if (newIndex !== null) {
          assignShaderToMixer(newIndex, slotIndex);
        }
      });
      mixContent.appendChild(newChItem);
    }

    mixSubmenu.appendChild(mixContent);
    menu.appendChild(mixSubmenu);
  }

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Adjust position if menu goes off screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${window.innerWidth - rect.width - 5}px`;
  }
  if (rect.bottom > window.innerHeight) {
    const newTop = Math.max(5, window.innerHeight - rect.height - 5);
    menu.style.top = `${newTop}px`;
    // If menu is taller than viewport, make it scrollable
    if (rect.height > window.innerHeight - 10) {
      menu.style.maxHeight = `${window.innerHeight - 10}px`;
      menu.style.overflowY = 'auto';
    }
  }

  // Reposition submenus on hover to stay within viewport
  menu.querySelectorAll('.has-submenu').forEach((item) => {
    item.addEventListener('mouseenter', () => {
      const sub = item.querySelector('.context-submenu') as HTMLElement | null;
      if (!sub) return;
      // Reset positioning before measuring
      sub.style.left = '100%';
      sub.style.right = '';
      sub.style.top = '-4px';
      sub.style.maxHeight = '';
      sub.style.overflowY = '';

      const subRect = sub.getBoundingClientRect();
      // Flip to left side if overflowing right
      if (subRect.right > window.innerWidth) {
        sub.style.left = '';
        sub.style.right = '100%';
      }
      // Shift up if overflowing bottom
      if (subRect.bottom > window.innerHeight) {
        const shift = subRect.bottom - window.innerHeight + 5;
        sub.style.top = `${-4 - shift}px`;
      }
      // Make scrollable if taller than viewport
      if (subRect.height > window.innerHeight - 10) {
        sub.style.maxHeight = `${window.innerHeight - 10}px`;
        sub.style.overflowY = 'auto';
      }
    });
  });
}

/**
 * Remove the grid context menu from the DOM if present.
 */
export function hideContextMenu(): void {
  const menu = document.getElementById('grid-context-menu');
  if (menu) {
    menu.remove();
  }
}

// ---------------------------------------------------------------------------
// 6. Tile assignment
// ---------------------------------------------------------------------------

/**
 * Assign a shader slot to a tile.
 * Updates tile state, renderer, syncs to fullscreen if tiled mode is active,
 * and persists the tile state.
 */
function assignShaderToTile(slotIndex: number, tileIndex: number): void {
  const slotData = state.gridSlots[slotIndex] as GridSlotData | null;
  if (!slotData) {
    setStatus('No shader in slot', 'error');
    return;
  }

  // Update tile state with copies of slot's params
  // Tiles share the slot's renderer but have their own param copies
  assignTile(
    tileIndex,
    slotIndex,
    slotData.params as Record<string, ParamValue> | null,
    slotData.customParams as Record<string, ParamValue> | null,
  );

  // Update tile renderer reference (points to slot's renderer)
  updateTileRenderer(tileIndex);

  // Sync to fullscreen if tiled mode is active
  if (state.tiledPreviewEnabled && slotData.shaderCode) {
    const allParams: Record<string, unknown> = {
      speed: slotData.params?.speed ?? 1,
      ...(slotData.customParams || {}),
    };
    window.electronAPI.assignTileShader?.(tileIndex, slotData.shaderCode, allParams);
  }

  // Save tile state
  saveTileState();

  setStatus(`Assigned slot ${slotIndex + 1} to tile ${tileIndex + 1}`, 'success');
}

/**
 * Save tile state to file via the main process.
 */
function saveTileState(): void {
  const saveData = {
    layout: { ...tileState.layout },
    tiles: tileState.tiles.map((t) => ({
      gridSlotIndex: t.gridSlotIndex,
      params: t.params ? { ...t.params } : null,
      customParams: t.customParams ? { ...t.customParams } : null,
      visible: t.visible,
    })),
  };
  window.electronAPI.saveTileState?.(saveData);
}

// ---------------------------------------------------------------------------
// 7. Param defaults
// ---------------------------------------------------------------------------

/**
 * Capture the current main renderer parameters and save them
 * as the default parameters for the specified slot.
 */
function setCurrentParamsAsDefault(slotIndex: number): void {
  const slotData = state.gridSlots[slotIndex] as GridSlotData | null;
  if (!slotData) return;

  // Get current params from the main renderer
  const renderer = state.renderer as MiniRendererLike;
  const currentParams = renderer.getParams ? renderer.getParams() : {};

  // Update the slot's params
  slotData.params = { ...currentParams };

  // Save grid state
  saveGridState();

  setStatus(`Saved current params as default for slot ${slotIndex + 1}`, 'success');
}

// ---------------------------------------------------------------------------
// 8. Slot swap
// ---------------------------------------------------------------------------

/**
 * Swap two grid slots: exchange data in state, recreate renderers for
 * both slots on their new canvases, update visual state, and persist.
 */
export async function swapGridSlots(fromIndex: number, toIndex: number): Promise<void> {
  const fromSlot = document.querySelector(`.grid-slot[data-slot="${fromIndex}"]`) as HTMLElement;
  const toSlot = document.querySelector(`.grid-slot[data-slot="${toIndex}"]`) as HTMLElement;
  const fromCanvas = fromSlot.querySelector('canvas') as HTMLCanvasElement;
  const toCanvas = toSlot.querySelector('canvas') as HTMLCanvasElement;

  // Swap data in state
  const fromData = state.gridSlots[fromIndex] as GridSlotData | null;
  const toData = state.gridSlots[toIndex] as GridSlotData | null;
  state.gridSlots[fromIndex] = toData;
  state.gridSlots[toIndex] = fromData;

  // Update active slot reference if needed
  if (state.activeGridSlot === fromIndex) {
    state.activeGridSlot = toIndex;
  } else if (state.activeGridSlot === toIndex) {
    state.activeGridSlot = fromIndex;
  }

  // Recreate renderers for swapped slots (they need new canvas references)
  if (state.gridSlots[fromIndex]) {
    const data = state.gridSlots[fromIndex] as GridSlotData;
    if (data.type === 'scene') {
      // Redraw scene thumbnail from stored dataUrl
      const ctx = fromCanvas.getContext('2d')!;
      if (data.thumbnail) {
        drawThumbnailFromDataUrl(ctx, fromCanvas, data.thumbnail);
      } else {
        drawScenePlaceholder(ctx, fromCanvas.width, fromCanvas.height);
      }
    } else if (data.type === 'asset-image' || data.type === 'asset-video') {
      // Asset renderers need their canvas reference updated
      if (data.renderer) {
        const renderer = data.renderer as MiniRendererLike;
        renderer.canvas = fromCanvas;
        renderer.ctx2d = fromCanvas.getContext('2d');
        if (renderer.render) renderer.render();
      }
    } else {
      // Dispose old renderer before creating new one
      if (data.renderer) {
        const oldRenderer = data.renderer as MiniRendererLike;
        if (oldRenderer.dispose) oldRenderer.dispose();
      }
      const newRenderer = new MiniShaderRenderer(fromCanvas);
      try {
        newRenderer.compile(data.shaderCode);
        loadFileTexturesForRenderer(newRenderer as unknown as Parameters<typeof loadFileTexturesForRenderer>[0]);
        // Restore custom param values on the new renderer
        if (data.customParams && Object.keys(data.customParams).length > 0) {
          (newRenderer as unknown as MiniRendererLike).setParams?.(data.customParams);
        }
        data.renderer = newRenderer;
      } catch (err) {
        console.warn(`Failed to recompile shader for slot ${fromIndex + 1}:`, err);
      }
    }
  }

  if (state.gridSlots[toIndex]) {
    const data = state.gridSlots[toIndex] as GridSlotData;
    if (data.type === 'scene') {
      // Redraw scene thumbnail from stored dataUrl
      const ctx = toCanvas.getContext('2d')!;
      if (data.thumbnail) {
        drawThumbnailFromDataUrl(ctx, toCanvas, data.thumbnail);
      } else {
        drawScenePlaceholder(ctx, toCanvas.width, toCanvas.height);
      }
    } else if (data.type === 'asset-image' || data.type === 'asset-video') {
      if (data.renderer) {
        const renderer = data.renderer as MiniRendererLike;
        renderer.canvas = toCanvas;
        renderer.ctx2d = toCanvas.getContext('2d');
        if (renderer.render) renderer.render();
      }
    } else {
      // Dispose old renderer before creating new one
      if (data.renderer) {
        const oldRenderer = data.renderer as MiniRendererLike;
        if (oldRenderer.dispose) oldRenderer.dispose();
      }
      const newRenderer = new MiniShaderRenderer(toCanvas);
      try {
        newRenderer.compile(data.shaderCode);
        loadFileTexturesForRenderer(newRenderer as unknown as Parameters<typeof loadFileTexturesForRenderer>[0]);
        // Restore custom param values on the new renderer
        if (data.customParams && Object.keys(data.customParams).length > 0) {
          (newRenderer as unknown as MiniRendererLike).setParams?.(data.customParams);
        }
        data.renderer = newRenderer;
      } catch (err) {
        console.warn(`Failed to recompile shader for slot ${toIndex + 1}:`, err);
      }
    }
  }

  // Update visual state for fromSlot
  updateSlotVisualState(fromIndex, fromSlot);

  // Update visual state for toSlot
  updateSlotVisualState(toIndex, toSlot);

  // Clear canvases for empty slots
  if (!state.gridSlots[fromIndex]) {
    const ctx = fromCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, fromCanvas.width, fromCanvas.height);
  }
  if (!state.gridSlots[toIndex]) {
    const ctx = toCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, toCanvas.width, toCanvas.height);
  }

  // Save shader files to new locations
  if (state.gridSlots[fromIndex]) {
    await window.electronAPI.saveShaderToSlot(fromIndex, (state.gridSlots[fromIndex] as GridSlotData).shaderCode);
  } else {
    await window.electronAPI.deleteShaderFromSlot(fromIndex);
  }

  if (state.gridSlots[toIndex]) {
    await window.electronAPI.saveShaderToSlot(toIndex, (state.gridSlots[toIndex] as GridSlotData).shaderCode);
  } else {
    await window.electronAPI.deleteShaderFromSlot(toIndex);
  }

  // Save grid state
  saveGridState();

  setStatus(`Swapped slot ${fromIndex + 1} with slot ${toIndex + 1}`, 'success');
}

// ---------------------------------------------------------------------------
// 9. Slot visual update
// ---------------------------------------------------------------------------

/**
 * Update the CSS classes and title attribute of a slot element
 * based on its current data in state.gridSlots.
 */
function updateSlotVisualState(index: number, slot: HTMLElement): void {
  const data = state.gridSlots[index] as GridSlotData | null;

  if (data) {
    slot.classList.add('has-shader');
    const typeLabel = data.type === 'scene' ? ' (scene)' : '';
    slot.title = data.filePath
      ? `Slot ${index + 1}: ${data.filePath.split('/').pop()!.split('\\').pop()!}${typeLabel}`
      : `Slot ${index + 1}: Current ${data.type === 'scene' ? 'scene' : 'shader'}`;
  } else {
    slot.classList.remove('has-shader');
    slot.title = `Slot ${index + 1} - Right-click for options`;
  }

  // Update active state
  if (state.activeGridSlot === index) {
    slot.classList.add('active');
  } else {
    slot.classList.remove('active');
  }
}

// ---------------------------------------------------------------------------
// 10. Export / Import individual slot
// ---------------------------------------------------------------------------

/**
 * Export a single shader slot to a file via the main process.
 */
async function exportShaderSlot(slotIndex: number): Promise<void> {
  const slotData = state.gridSlots[slotIndex] as GridSlotData | null;
  if (!slotData) return;

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

  const defaultName = slotData.label || `slot-${slotIndex + 1}`;
  const result = await window.electronAPI.exportButtonData('shadershow-shader', exportData, defaultName);
  if (result.success) {
    setStatus(
      `Exported shader to ${result.filePath!.split('/').pop()!.split('\\').pop()!}`,
      'success',
    );
  } else if (result.error) {
    setStatus(`Export failed: ${result.error}`, 'error');
  }
}

/**
 * Import a shader from file into the specified slot.
 */
async function importShaderSlot(slotIndex: number): Promise<void> {
  const result = await window.electronAPI.importButtonData('shadershow-shader');
  if (result.canceled) return;
  if (result.error) {
    setStatus(`Import failed: ${result.error}`, 'error');
    return;
  }

  const data = result.data!;
  try {
    if (data.type === 'scene' || isSceneCode(data.shaderCode || '')) {
      await assignSceneToSlot(
        slotIndex,
        data.shaderCode || '',
        null,
        false,
        data.params || null,
        data.presets || null,
        data.customParams || null,
      );
    } else {
      await assignShaderToSlot(
        slotIndex,
        data.shaderCode || '',
        null,
        false,
        data.params || null,
        data.presets || null,
        data.customParams || null,
      );
    }
    if (data.label) {
      (state.gridSlots[slotIndex] as GridSlotData).label = data.label;
      const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
      const labelEl = slot?.querySelector('.slot-label') as HTMLElement | null;
      if (labelEl) labelEl.textContent = data.label;
      saveGridState();
    }
    setStatus(`Imported shader to slot ${slotIndex + 1}`, 'success');
  } catch (err) {
    setStatus(`Import failed: ${(err as Error).message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// 11. Load / Assign operations
// ---------------------------------------------------------------------------

/**
 * Prompt the user to load a shader file and assign it to the given slot.
 */
async function loadShaderToSlot(slotIndex: number): Promise<void> {
  const result = await window.electronAPI.loadShaderForGrid();
  if (result && result.content) {
    // Check if this is a Three.js scene file
    const isScene =
      (result.filePath &&
        (result.filePath.endsWith('.jsx') || result.filePath.includes('.scene.js'))) ||
      isSceneCode(result.content);

    if (isScene) {
      assignSceneToSlot(slotIndex, result.content, result.filePath || null);
    } else {
      assignShaderToSlot(slotIndex, result.content, result.filePath || null);
    }
  } else if (result && result.error) {
    setStatus(`Failed to load shader: ${result.error}`, 'error');
  }
}

/**
 * Assign the shader currently in the editor to the given slot.
 */
function assignCurrentShaderToSlot(slotIndex: number): void {
  const code = (state.editor as { getValue(): string } | null)?.getValue() ?? '';
  const isScene = (state as { renderMode: string }).renderMode === 'scene' || isSceneCode(code);

  if (isScene) {
    assignSceneToSlot(slotIndex, code, null);
  } else {
    assignShaderToSlot(slotIndex, code, null);
  }
}

/**
 * Detect if code is a Three.js scene (contains `function setup` and `THREE`/`scene`).
 */
export function isSceneCode(code: string): boolean {
  return code.includes('function setup') && (code.includes('THREE') || code.includes('scene'));
}

// ---------------------------------------------------------------------------
// 12. Assign shader / scene / failed shader to slot
// ---------------------------------------------------------------------------

/**
 * Assign a GLSL shader to a grid slot.
 * Creates a MiniShaderRenderer, compiles the shader, populates custom params,
 * and optionally saves to disk.
 */
export async function assignShaderToSlot(
  slotIndex: number,
  shaderCode: string,
  filePath: string | null,
  skipSave: boolean = false,
  params: Record<string, unknown> | null = null,
  presets: unknown[] | null = null,
  customParams: Record<string, unknown> | null = null,
): Promise<void> {
  log.debug('Grid', `assignShaderToSlot: slot=${slotIndex}, codeLen=${shaderCode?.length || 0}, file=${filePath || 'none'}`);
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`) as HTMLElement;
  const canvas = slot.querySelector('canvas') as HTMLCanvasElement;

  // Clean up existing renderer to prevent memory leaks
  const existingData = state.gridSlots[slotIndex] as GridSlotData | null;
  if (existingData && existingData.renderer) {
    const oldRenderer = existingData.renderer as MiniRendererLike;
    if (oldRenderer.dispose) {
      oldRenderer.dispose();
    }
  }

  // Create mini renderer for this slot
  const miniRenderer = new MiniShaderRenderer(canvas);

  // Use provided params or capture current params for speed
  const slotParams = params || { speed: 1 };

  try {
    miniRenderer.compile(shaderCode);
    // Load file textures asynchronously (non-blocking for grid)
    loadFileTexturesForRenderer(miniRenderer as unknown as Parameters<typeof loadFileTexturesForRenderer>[0]);

    // Get custom params: start with defaults from the shader, then overlay any saved values
    // This ensures all params have values even if saved state is incomplete
    let slotCustomParams: Record<string, unknown> = {};

    // First, populate with defaults from shader's @param definitions
    const typedRenderer = miniRenderer as unknown as MiniRendererLike;
    for (const param of typedRenderer.customParams || []) {
      slotCustomParams[param.name] = Array.isArray(param.default)
        ? [...param.default]
        : param.default;
    }

    // Then overlay any provided/saved custom params
    if (customParams && Object.keys(customParams).length > 0) {
      Object.assign(slotCustomParams, customParams);
    }

    state.gridSlots[slotIndex] = {
      shaderCode,
      filePath,
      renderer: miniRenderer,
      type: 'shader',
      params: { ...slotParams },
      customParams: slotCustomParams,
      presets: presets || [],
    };
    slot.classList.add('has-shader');
    slot.classList.remove('has-error'); // Clear any previous error state
    const displayName = filePath
      ? filePath.split('/').pop()!.split('\\').pop()!
      : 'Current shader';
    slot.title = `Slot ${slotIndex + 1}: ${displayName}`;

    // Set label on the slot element
    const labelEl = slot.querySelector('.slot-label') as HTMLElement | null;
    if (labelEl) {
      const slotData = state.gridSlots[slotIndex] as GridSlotData;
      labelEl.textContent = slotData.label || displayName.replace(/\.glsl$/i, '');
    }

    if (!skipSave) {
      // Save shader code to individual file
      await window.electronAPI.saveShaderToSlot(slotIndex, shaderCode);
      setStatus(`Shader assigned to slot ${slotIndex + 1}`, 'success');
      saveGridState();
    }
  } catch (err) {
    if (!skipSave) {
      setStatus(`Failed to compile shader for slot ${slotIndex + 1}: ${(err as Error).message}`, 'error');
    }
    throw err;
  }
}

/**
 * Assign a Three.js scene to a grid slot with a static snapshot thumbnail.
 */
export async function assignSceneToSlot(
  slotIndex: number,
  sceneCode: string,
  filePath: string | null,
  skipSave: boolean = false,
  params: Record<string, unknown> | null = null,
  presets: unknown[] | null = null,
  customParams: Record<string, unknown> | null = null,
  thumbnail: string | null = null,
): Promise<void> {
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`) as HTMLElement;
  const canvas = slot.querySelector('canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;

  // Clean up existing slot data
  if (state.gridSlots[slotIndex]) {
    state.gridSlots[slotIndex] = null;
  }

  // Use provided params or capture current params
  const slotParams = params || { speed: 1 };
  let savedThumbnail = thumbnail || null;

  if (skipSave) {
    // During load: restore saved thumbnail or show placeholder
    if (savedThumbnail) {
      drawThumbnailFromDataUrl(ctx, canvas, savedThumbnail);
    } else {
      drawScenePlaceholder(ctx, canvas.width, canvas.height);
    }
  } else {
    // Interactive assignment: try to render a snapshot and capture it
    const sceneRenderer = await ensureSceneRenderer();
    if (sceneRenderer) {
      try {
        sceneRenderer.reinitialize?.();
        sceneRenderer.compile(sceneCode);
        sceneRenderer.resetTime?.();
        if (sceneRenderer.render) sceneRenderer.render();

        const mainCanvas = document.getElementById('shader-canvas') as HTMLCanvasElement;
        ctx.drawImage(mainCanvas, 0, 0, mainCanvas.width, mainCanvas.height, 0, 0, canvas.width, canvas.height);
        // Capture thumbnail as dataUrl for persistence
        savedThumbnail = canvas.toDataURL('image/jpeg', 0.7);
      } catch (err) {
        console.warn(`Scene snapshot failed for slot ${slotIndex + 1}:`, (err as Error).message);
        drawScenePlaceholder(ctx, canvas.width, canvas.height);
      }
    } else {
      drawScenePlaceholder(ctx, canvas.width, canvas.height);
    }
  }

  // Store scene data (no mini renderer for scenes)
  state.gridSlots[slotIndex] = {
    shaderCode: sceneCode,
    filePath,
    renderer: null,
    type: 'scene',
    params: { ...slotParams },
    customParams: customParams || {},
    presets: presets || [],
    thumbnail: savedThumbnail,
  };

  slot.classList.add('has-shader');
  slot.classList.remove('has-error');
  slot.title = filePath
    ? `Slot ${slotIndex + 1}: ${filePath.split('/').pop()!.split('\\').pop()!} (scene)`
    : `Slot ${slotIndex + 1}: Current scene`;

  if (!skipSave) {
    await window.electronAPI.saveShaderToSlot(slotIndex, sceneCode);
    setStatus(`Scene assigned to slot ${slotIndex + 1}`, 'success');
    saveGridState();
  }
}

/**
 * Store a shader that failed to compile so the user can still edit it.
 * Draws an error indicator on the canvas instead of a rendered thumbnail.
 */
export function assignFailedShaderToSlot(
  slotIndex: number,
  shaderCode: string,
  filePath: string | null,
  savedData: Partial<GridSlotData> = {},
): void {
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`) as HTMLElement;
  const canvas = slot.querySelector('canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;

  // Draw error indicator on canvas
  ctx.fillStyle = '#331111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ff4444';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ERROR', canvas.width / 2, canvas.height / 2 - 8);
  ctx.font = '10px sans-serif';
  ctx.fillText('Click to fix', canvas.width / 2, canvas.height / 2 + 8);

  // Store shader data (without renderer) so it can be edited
  state.gridSlots[slotIndex] = {
    shaderCode,
    filePath,
    renderer: null, // No renderer - compilation failed
    type: savedData.type || 'shader',
    params: savedData.params || {},
    customParams: savedData.customParams || {},
    presets: savedData.presets || [],
    hasError: true, // Flag to indicate this slot has an error
  };

  slot.classList.add('has-shader');
  slot.classList.add('has-error');
  const fileName = filePath
    ? filePath.split('/').pop()!.split('\\').pop()!
    : 'shader';
  slot.title = `Slot ${slotIndex + 1}: ${fileName} (ERROR - click to edit)`;
}

// ---------------------------------------------------------------------------
// 13. Rename / Clear / Save slot
// ---------------------------------------------------------------------------

/**
 * Show an inline rename input in the slot label area.
 */
export function renameGridSlot(slotIndex: number): void {
  const data = state.gridSlots[slotIndex] as GridSlotData | null;
  if (!data) return;

  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  const labelEl = slot?.querySelector('.slot-label') as HTMLElement | null;
  if (!labelEl) return;

  const currentName =
    data.label ||
    (data.filePath
      ? data.filePath.split('/').pop()!.split('\\').pop()!.replace(/\.glsl$/i, '')
      : `Slot ${slotIndex + 1}`);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'shader-tab-rename-input';
  input.value = currentName;
  input.style.width = '90%';

  const finishRename = (): void => {
    const newName = input.value.trim() || currentName;
    data.label = newName;
    labelEl.textContent = newName;
    if (input.parentNode === labelEl) {
      labelEl.removeChild(input);
    }
    labelEl.textContent = newName;
    saveGridState();
  };

  input.addEventListener('blur', finishRename);
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = currentName;
      input.blur();
    }
  });

  labelEl.textContent = '';
  labelEl.appendChild(input);
  input.focus();
  input.select();
}

/**
 * Clear a grid slot: dispose its renderer, remove shader from disk,
 * and reset the slot's visual state.
 */
async function clearGridSlot(slotIndex: number): Promise<void> {
  // Dispose renderer
  const slotData = state.gridSlots[slotIndex] as GridSlotData | null;
  if (slotData && slotData.renderer) {
    const renderer = slotData.renderer as MiniRendererLike;
    if (renderer.dispose) {
      renderer.dispose();
    }
  }

  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`) as HTMLElement | null;
  state.gridSlots[slotIndex] = null;
  if (slot) {
    slot.classList.remove('has-shader');
    slot.classList.remove('has-error');
    slot.title = `Slot ${slotIndex + 1} - Right-click to assign shader`;

    // Clear label
    const labelEl = slot.querySelector('.slot-label') as HTMLElement | null;
    if (labelEl) labelEl.textContent = '';

    // Clear canvas
    const canvas = slot.querySelector('canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  // Delete shader file
  await window.electronAPI.deleteShaderFromSlot(slotIndex);

  // Clear active slot if this was it
  if (state.activeGridSlot === slotIndex) {
    state.activeGridSlot = null;
    updateLocalPresetsUI();
    updateSaveButtonState();
  }

  setStatus(`Cleared slot ${slotIndex + 1}`, 'success');

  // Save grid state
  saveGridState();
}

/**
 * Save the current editor content back to the active grid slot and file.
 */
export async function saveActiveSlotShader(): Promise<void> {
  if (state.activeGridSlot === null) {
    setStatus('No slot selected', 'error');
    return;
  }

  const slotData = state.gridSlots[state.activeGridSlot] as GridSlotData | null;
  if (!slotData) {
    setStatus('No content in active slot', 'error');
    return;
  }

  const code = (state.editor as { getValue(): string } | null)?.getValue() ?? '';
  const isScene = slotData.type === 'scene';

  // Update the slot's code
  slotData.shaderCode = code;

  // Also update the renderer/snapshot in the slot
  try {
    if (isScene) {
      // For scenes, re-render the snapshot
      const sceneRenderer = await ensureSceneRenderer();
      if (sceneRenderer) {
        sceneRenderer.reinitialize?.();
        sceneRenderer.compile(code);
        sceneRenderer.resetTime?.();
        if (sceneRenderer.render) sceneRenderer.render();

        // Update the slot canvas with new snapshot
        const slot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
        const canvas = slot?.querySelector('canvas') as HTMLCanvasElement | null;
        const mainCanvas = document.getElementById('shader-canvas') as HTMLCanvasElement;
        if (canvas) {
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(mainCanvas, 0, 0, mainCanvas.width, mainCanvas.height, 0, 0, canvas.width, canvas.height);
        }
      }
    } else {
      // For shaders, recompile the mini renderer
      if (slotData.renderer) {
        const renderer = slotData.renderer as MiniRendererLike;
        renderer.compile(code);
      }
    }
  } catch (err) {
    // Don't fail the save if compilation fails
    console.warn(`${isScene ? 'Scene' : 'Shader'} compilation warning:`, (err as Error).message);
  }

  // Save to file
  const result = await window.electronAPI.saveShaderToSlot(state.activeGridSlot, code);
  const typeLabel = isScene ? 'Scene' : 'Shader';
  if (result.success) {
    setStatus(`${typeLabel} saved to slot ${state.activeGridSlot + 1}`, 'success');
  } else {
    setStatus(`Failed to save ${typeLabel.toLowerCase()}: ${result.error}`, 'error');
  }
}

/**
 * Update the save button's enabled/disabled state based on whether
 * there is an active grid slot with content.
 */
export function updateSaveButtonState(): void {
  const btnSaveShader = document.getElementById('btn-save-shader') as HTMLButtonElement | null;
  if (!btnSaveShader) return;

  if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
    btnSaveShader.disabled = false;
    btnSaveShader.title = `Save Shader to Slot ${state.activeGridSlot + 1} (Ctrl+S)`;
  } else {
    btnSaveShader.disabled = true;
    btnSaveShader.title = 'Save Shader to Active Slot (select a slot first)';
  }
}

// ---------------------------------------------------------------------------
// 14. Init
// ---------------------------------------------------------------------------

/**
 * Initialize the shader grid: cleanup previous state, set up the
 * document click handler for context menus, load grid state from disk,
 * and rebuild DOM if needed.
 */
export async function initShaderGrid(): Promise<void> {
  // Cleanup any existing listeners first
  cleanupShaderGrid();

  // Close context menu when clicking elsewhere
  documentClickHandler = hideContextMenu;
  document.addEventListener('click', documentClickHandler);

  // Load saved grid state (this will create DOM slots dynamically)
  await loadGridState();

  // If no slots were loaded, rebuild DOM with just the add button
  if (state.gridSlots.length === 0) {
    rebuildGridDOM();
  }
}

// ---------------------------------------------------------------------------
// 15. Load / Select / Play shader
// ---------------------------------------------------------------------------

/**
 * Load a grid shader into the editor as a new tab (or activate existing tab).
 * Double-click behavior.
 */
export async function loadGridShaderToEditor(slotIndex: number): Promise<void> {
  const slotData = state.gridSlots[slotIndex] as GridSlotData | null;
  if (!slotData) return;
  log.debug('Grid', `loadGridShaderToEditor: slot=${slotIndex}, type=${slotData.type || 'shader'}`);

  // Clear previous active slot highlight
  if (state.activeGridSlot !== null) {
    const prevSlot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
    if (prevSlot) prevSlot.classList.remove('active');
  }

  // Set new active slot
  state.activeGridSlot = slotIndex;
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`) as HTMLElement;
  slot.classList.add('active');

  // Determine type and title (detect from content as fallback)
  const detectedType = detectRenderMode(slotData.filePath, slotData.shaderCode);
  const isScene = slotData.type === 'scene' || detectedType === 'scene';
  if (isScene && slotData.type !== 'scene') slotData.type = 'scene';
  const slotName = slotData.filePath
    ? slotData.filePath.split('/').pop()!.split('\\').pop()!
    : `Slot ${slotIndex + 1}`;
  const typeLabel = isScene ? 'scene' : 'shader';

  // Open in a new tab (or activate existing tab for this slot)
  openInTab({
    content: slotData.shaderCode,
    filePath: slotData.filePath,
    type: isScene ? 'scene' : 'shader',
    title: slotName,
    slotIndex: slotIndex,
    activate: true,
  });

  // Load saved custom param values if available (after tab is activated and compiled)
  setTimeout(() => {
    if (slotData.customParams && !isScene) {
      const renderer = state.renderer as MiniRendererLike;
      renderer.setCustomParamValues?.(slotData.customParams);
      generateCustomParamUI(); // Regenerate UI to reflect loaded values
    }
  }, 100);

  // Load speed to slider if present
  if (slotData.params) {
    loadParamsToSliders(slotData.params);
  }

  // Update local presets UI for this shader
  updateLocalPresetsUI();

  // Update save button state
  updateSaveButtonState();

  setStatus(`Editing ${slotName} (${typeLabel} slot ${slotIndex + 1})`, 'success');
}

/**
 * Select a grid slot: load shader into preview and show its parameters.
 * Single-click behavior. Compiles the shader to the main renderer,
 * loads params, syncs to fullscreen.
 */
export async function selectGridSlot(slotIndex: number): Promise<void> {
  const slotData = state.gridSlots[slotIndex] as GridSlotData | null;
  if (!slotData) return;

  // If this is an asset slot, delegate to selectAssetSlot
  if (slotData.type === 'asset-image' || slotData.type === 'asset-video') {
    selectAssetSlot(slotIndex);
    return;
  }

  log.debug('Grid', `selectGridSlot: slot=${slotIndex}, type=${slotData.type || 'shader'}`);

  // Clear asset mode if previously active
  if (state.renderMode === 'asset') {
    state.activeAsset = null;
    hideAssetOverlay();
    window.electronAPI.sendAssetUpdate({ clear: true });
  }

  // If this slot is assigned to a mixer channel, select that channel instead of clearing
  const mixerBtns = document.querySelectorAll('#mixer-channels .mixer-btn');
  let foundMixerCh = false;
  for (let i = 0; i < state.mixerChannels.length; i++) {
    const ch = state.mixerChannels[i];
    if (ch.slotIndex === slotIndex && (ch as unknown as { tabIndex: number }).tabIndex === state.activeShaderTab) {
      // Select this mixer channel
      state.mixerSelectedChannel = i;
      mixerBtns.forEach((b) => b.classList.remove('selected'));
      mixerBtns[i]?.classList.add('selected');
      foundMixerCh = true;
      break;
    }
  }
  if (!foundMixerCh) {
    state.mixerSelectedChannel = null;
    mixerBtns.forEach((b) => b.classList.remove('selected'));
  }

  // Clear previous active slot highlight
  if (state.activeGridSlot !== null) {
    const prevSlot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
    if (prevSlot) prevSlot.classList.remove('active');
  }

  // Set active slot
  state.activeGridSlot = slotIndex;
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`) as HTMLElement | null;
  if (slot) slot.classList.add('active');

  const isScene = slotData.type === 'scene';
  const slotName = slotData.filePath
    ? slotData.filePath.split('/').pop()!.split('\\').pop()!
    : `Slot ${slotIndex + 1}`;

  // Switch render mode if needed
  if (isScene) {
    await setRenderMode('scene');
  } else {
    await setRenderMode('shader');
  }

  // Always compile the shader to state.renderer so we can read @param definitions
  // and generate the correct parameter UI
  try {
    const renderer = state.renderer as MiniRendererLike;
    renderer.compile(slotData.shaderCode);
    // Load file textures for the main renderer (builtin textures are loaded by compile)
    loadFileTexturesForRenderer(renderer as unknown as Parameters<typeof loadFileTexturesForRenderer>[0]);
  } catch (err) {
    log.warn('Grid', `Failed to compile for preview: ${(err as Error).message}`);
  }

  // If tiled preview is enabled, also assign shader to selected tile
  if (state.tiledPreviewEnabled) {
    assignShaderToTile(slotIndex, state.selectedTileIndex);
  }

  // Load params to sliders (works for both tiled and non-tiled mode)
  if (slotData.params) {
    loadParamsToSliders(slotData.params);
  }

  // Load custom params if available
  if (slotData.customParams && !isScene) {
    // Load to main renderer
    const renderer = state.renderer as MiniRendererLike;
    if (renderer?.setCustomParamValues) {
      renderer.setCustomParamValues(slotData.customParams);
    }
    // Also load to MiniShaderRenderer for tiled preview
    const slotRenderer = slotData.renderer as MiniRendererLike | null;
    if (slotRenderer?.setParams) {
      slotRenderer.setParams(slotData.customParams);
    }
  }

  // Regenerate custom param UI based on the shader's @param definitions
  generateCustomParamUI();

  // Update local presets UI for this shader
  updateLocalPresetsUI();

  // Update save button state
  updateSaveButtonState();

  // Sync to fullscreen window if open
  const mainRenderer = state.renderer as MiniRendererLike;
  const allParams: Record<string, unknown> = {
    ...(slotData.params || {}),
    ...(slotData.customParams || mainRenderer.getCustomParamValues?.() || {}),
  };

  if (state.tiledPreviewEnabled) {
    // In tiled mode, update the specific tile
    if (window.electronAPI.assignTileShader) {
      window.electronAPI.assignTileShader(state.selectedTileIndex, slotIndex, slotData.shaderCode, allParams);
    }
  } else {
    // In normal mode, update the main fullscreen
    window.electronAPI.sendShaderUpdate({
      shaderCode: slotData.shaderCode,
      renderMode: isScene ? 'scene' : 'shader',
      params: allParams,
    });

    if (window.electronAPI.sendBatchParamUpdate) {
      window.electronAPI.sendBatchParamUpdate(allParams);
    }
  }

  const tileInfo = state.tiledPreviewEnabled ? ` -> tile ${state.selectedTileIndex + 1}` : '';
  setStatus(`Playing ${slotName} (slot ${slotIndex + 1}${tileInfo})`, 'success');
  notifyRemoteStateChanged();
}

/**
 * Play a grid shader: open it in an editor tab and send to fullscreen.
 * Used for explicit "play" action vs. single-click select.
 */
export function playGridShader(slotIndex: number): void {
  const slotData = state.gridSlots[slotIndex] as GridSlotData | null;
  if (!slotData) return;

  // If tiled preview is enabled, assign to selected tile instead
  if (state.tiledPreviewEnabled) {
    assignShaderToTile(slotIndex, state.selectedTileIndex);
    return;
  }

  // Clear previous active slot highlight
  if (state.activeGridSlot !== null) {
    const prevSlot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
    if (prevSlot) prevSlot.classList.remove('active');
  }

  // Set active slot
  state.activeGridSlot = slotIndex;
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`) as HTMLElement | null;
  if (slot) slot.classList.add('active');

  // Check if this is a scene (detect from content as fallback)
  const detectedType = detectRenderMode(slotData.filePath, slotData.shaderCode);
  const isScene = slotData.type === 'scene' || detectedType === 'scene';
  if (isScene && slotData.type !== 'scene') slotData.type = 'scene';
  const slotName = slotData.filePath
    ? slotData.filePath.split('/').pop()!.split('\\').pop()!
    : `Slot ${slotIndex + 1}`;

  // Open in a new tab (or activate existing tab for this slot)
  openInTab({
    content: slotData.shaderCode,
    filePath: slotData.filePath,
    type: isScene ? 'scene' : 'shader',
    title: slotName,
    slotIndex: slotIndex,
    activate: true,
  });

  // Load speed to slider if present
  if (slotData.params) {
    loadParamsToSliders(slotData.params);
  }

  // Update local presets UI for this shader
  updateLocalPresetsUI();

  // Update save button state
  updateSaveButtonState();

  // Load saved custom param values if available (after tab is activated)
  setTimeout(() => {
    if (slotData.customParams && !isScene) {
      const renderer = state.renderer as MiniRendererLike;
      renderer.setCustomParamValues?.(slotData.customParams);
      generateCustomParamUI(); // Regenerate to reflect loaded values
    }
  }, 100);

  // Batch all params for fullscreen to reduce IPC overhead
  const mainRenderer = state.renderer as MiniRendererLike;
  const allParams: Record<string, unknown> = {
    ...(slotData.params || {}),
    ...(slotData.customParams || mainRenderer.getCustomParamValues?.() || {}),
  };

  // Send to fullscreen window (if open) with all params included
  const fullscreenState: Record<string, unknown> = {
    shaderCode: slotData.shaderCode,
    time: 0,
    frame: 0,
    isPlaying: true,
    channels: state.channelState,
    params: allParams,
    renderMode: isScene ? 'scene' : 'shader',
  };
  window.electronAPI.sendShaderUpdate(fullscreenState);
  window.electronAPI.sendTimeSync({ time: 0, frame: 0, isPlaying: true });

  // Send batched params in single IPC call (fullscreen will apply them from the state above,
  // but we also send individually for any param listeners that expect per-param updates)
  // Use a single batch call if available, otherwise fall back to individual calls
  if (window.electronAPI.sendBatchParamUpdate) {
    window.electronAPI.sendBatchParamUpdate(allParams);
  } else {
    // Fall back to individual calls for backwards compatibility
    Object.entries(allParams).forEach(([name, value]) => {
      window.electronAPI.sendParamUpdate({ name, value });
    });
  }

  const typeLabel = isScene ? 'scene' : 'shader';
  setStatus(`Playing ${typeLabel}: ${slotName}`, 'success');
}

// ---------------------------------------------------------------------------
// 16. Draw helpers
// ---------------------------------------------------------------------------

/**
 * Draw a saved thumbnail dataUrl onto a mini canvas.
 */
function drawThumbnailFromDataUrl(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  dataUrl: string,
): void {
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.onerror = () => {
    drawScenePlaceholder(ctx, canvas.width, canvas.height);
  };
  img.src = dataUrl;
}

/**
 * Draw a static scene placeholder on a mini canvas.
 */
function drawScenePlaceholder(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.fillStyle = '#0a0a1a';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#6688cc';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Scene', width / 2, height / 2);
}
