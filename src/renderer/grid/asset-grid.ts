// Asset Grid — asset grid DOM rebuild, slot element creation, slot CRUD,
// and asset-specific context menu.
// Typed version of js/shader-grid.js lines 1500-1955.

import { state } from '../core/state.js';
import { AssetRenderer } from '../renderers/asset-renderer.js';
import { assignAssetToMixer } from '../ui/mixer.js';
import { createTaggedLogger, LOG_LEVEL } from '../../shared/logger.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createTaggedLogger(LOG_LEVEL.WARN);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal electronAPI surface used by this module */
declare const window: Window & {
  electronAPI: {
    openMediaForAsset(): Promise<{
      canceled?: boolean;
      filePath: string;
      type: string;
      dataUrl?: string;
    } | null>;
    copyMediaToLibrary(filePath: string): Promise<{
      error?: string;
      mediaPath: string;
      absolutePath: string;
    }>;
    loadMediaDataUrl(mediaPath: string): Promise<{
      success: boolean;
      dataUrl?: string;
      error?: string;
    }>;
    getMediaAbsolutePath(mediaPath: string): Promise<string | null>;
    sendAssetUpdate(data: Record<string, unknown>): void;
  };
};

/** Runtime shape of an asset slot's renderer */
interface AssetRendererLike {
  canvas: HTMLCanvasElement | null;
  ctx2d: CanvasRenderingContext2D | null;
  image?: HTMLImageElement;
  mediaPath?: string | null;
  loadVideo(path: string): Promise<void>;
  loadImage(dataUrl: string): Promise<void>;
  setParams(params: Record<string, unknown>): void;
  getCustomParamValues(): Record<string, unknown>;
  dispose(): void;
  render(): void;
}

/** Runtime shape of an asset grid slot stored in state.gridSlots */
interface AssetSlotData {
  type: string;
  mediaPath: string;
  renderer: AssetRendererLike;
  customParams: Record<string, unknown>;
  label?: string;
}

/** Event listener entry tracked for cleanup */
interface ListenerEntry {
  event: string;
  handler: EventListener;
}

import { buildTabBar } from './grid-tabs.js';
import { cleanupGridVisibilityObserver, initGridVisibilityObserver, applyMaxContainerHeight } from './grid-renderer.js';
import { hideContextMenu, swapGridSlots, renameGridSlot, dragSourceIndex, setDragSourceIndex, slotEventListeners } from './shader-grid.js';
import { saveGridState } from './grid-persistence.js';
import { setStatus } from '../ui/utils.js';
import { generateCustomParamUI } from '../ui/params.js';

// =============================================================================
// Asset Grid DOM
// =============================================================================

/**
 * Rebuild the asset grid DOM for the active asset tab.
 * Tears down existing slot listeners, recreates all slot elements,
 * and appends the "+" add-slot button.
 */
export function rebuildAssetGridDOM(): void {
  const activeTab = state.shaderTabs[state.activeShaderTab] as { type?: string } | undefined;
  if (!activeTab || activeTab.type !== 'assets') return;

  const container = document.getElementById('shader-grid-container');
  if (!container) return;

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

  container.innerHTML = '';

  // Create slot elements for each asset entry
  for (let i = 0; i < state.gridSlots.length; i++) {
    const slotEl = createAssetSlotElement(i);
    container.appendChild(slotEl);

    const data = state.gridSlots[i] as AssetSlotData | null;
    if (data) {
      slotEl.classList.add('has-shader'); // reuse existing class for styling
      if (state.activeGridSlot === i) slotEl.classList.add('active');
      slotEl.title = `Asset ${i + 1}: ${data.label || data.mediaPath || 'untitled'}`;

      const labelEl = slotEl.querySelector('.slot-label');
      if (labelEl) {
        labelEl.textContent = data.label || data.mediaPath || `Asset ${i + 1}`;
      }

      // Update renderer's canvas reference to the new DOM element
      if (data.renderer) {
        const newCanvas = slotEl.querySelector('canvas') as HTMLCanvasElement | null;
        if (newCanvas) {
          data.renderer.canvas = newCanvas;
          data.renderer.ctx2d = newCanvas.getContext('2d');
        }
      }
    }
  }

  // Add the "+" button
  const addBtn = document.createElement('div');
  addBtn.className = 'grid-slot grid-add-btn';
  addBtn.title = 'Add image or video';
  const plusSign = document.createElement('span');
  plusSign.className = 'grid-add-plus';
  plusSign.textContent = '+';
  addBtn.appendChild(plusSign);
  addBtn.addEventListener('click', () => addNewAssetSlot());
  container.appendChild(addBtn);

  // Reinitialize visibility observer
  initGridVisibilityObserver();
  applyMaxContainerHeight();
}

// =============================================================================
// Asset Slot Element
// =============================================================================

/**
 * Create a single asset slot DOM element with drag, click, and context-menu
 * event handlers. Listeners are tracked in `slotEventListeners` for cleanup.
 */
function createAssetSlotElement(index: number): HTMLDivElement {
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

  const listeners: ListenerEntry[] = [];

  // Drag start
  const dragstartHandler = (e: DragEvent): void => {
    setDragSourceIndex(index);
    slot.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index.toString());
    }
  };
  slot.addEventListener('dragstart', dragstartHandler as EventListener);
  listeners.push({ event: 'dragstart', handler: dragstartHandler as EventListener });

  // Drag end
  const dragendHandler = (): void => {
    slot.classList.remove('dragging');
    setDragSourceIndex(null);
    document.querySelectorAll('.grid-slot.drag-over').forEach((s) => s.classList.remove('drag-over'));
  };
  slot.addEventListener('dragend', dragendHandler);
  listeners.push({ event: 'dragend', handler: dragendHandler });

  // Drag over
  const dragoverHandler = (e: DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  };
  slot.addEventListener('dragover', dragoverHandler as EventListener);
  listeners.push({ event: 'dragover', handler: dragoverHandler as EventListener });

  // Drag enter
  const dragenterHandler = (e: DragEvent): void => {
    e.preventDefault();
    if (dragSourceIndex !== null && dragSourceIndex !== index) {
      slot.classList.add('drag-over');
    }
  };
  slot.addEventListener('dragenter', dragenterHandler as EventListener);
  listeners.push({ event: 'dragenter', handler: dragenterHandler as EventListener });

  // Drag leave
  const dragleaveHandler = (e: DragEvent): void => {
    if (!slot.contains(e.relatedTarget as Node)) {
      slot.classList.remove('drag-over');
    }
  };
  slot.addEventListener('dragleave', dragleaveHandler as EventListener);
  listeners.push({ event: 'dragleave', handler: dragleaveHandler as EventListener });

  // Drop — swap slots
  const dropHandler = (e: DragEvent): void => {
    e.preventDefault();
    slot.classList.remove('drag-over');
    const fromIndex = parseInt(e.dataTransfer?.getData('text/plain') ?? '', 10);
    if (!isNaN(fromIndex) && fromIndex !== index) {
      swapGridSlots(fromIndex, index);
    }
  };
  slot.addEventListener('drop', dropHandler as EventListener);
  listeners.push({ event: 'drop', handler: dropHandler as EventListener });

  // Click: assign to mixer if armed, otherwise select for param editing
  const clickHandler = (): void => {
    if (state.gridSlots[index]) {
      if (state.mixerArmedChannel !== null) {
        assignAssetToMixer(state.mixerArmedChannel, index);
      } else {
        selectAssetSlot(index);
      }
    }
  };
  slot.addEventListener('click', clickHandler);
  listeners.push({ event: 'click', handler: clickHandler });

  // Right-click context menu
  const contextmenuHandler = (e: MouseEvent): void => {
    e.preventDefault();
    showAssetContextMenu(e.clientX, e.clientY, index);
  };
  slot.addEventListener('contextmenu', contextmenuHandler as EventListener);
  listeners.push({ event: 'contextmenu', handler: contextmenuHandler as EventListener });

  slotEventListeners.set(slot, listeners);
  return slot;
}

// =============================================================================
// Asset Slot CRUD
// =============================================================================

/**
 * Add a new asset slot via the file dialog.
 * Opens the media picker, appends a new empty slot, then loads the asset.
 * On failure the empty slot is removed and the grid is rebuilt.
 */
async function addNewAssetSlot(): Promise<void> {
  const result = await window.electronAPI.openMediaForAsset();
  if (!result || result.canceled) return;

  const newIndex = state.gridSlots.length;
  state.gridSlots.push(null);

  // Rebuild DOM to include the new empty slot
  rebuildAssetGridDOM();

  try {
    await assignAssetToSlot(newIndex, result.filePath, result.type, result.dataUrl);
  } catch (err: unknown) {
    // Remove the empty slot on failure
    state.gridSlots.splice(newIndex, 1);
    rebuildAssetGridDOM();
    setStatus(`Failed to load asset: ${(err as Error).message}`, 'error');
  }
}

/**
 * Assign an asset (image or video) to a grid slot.
 * Copies the file to the media library, creates an AssetRenderer,
 * loads the media, and updates the slot data and DOM.
 */
export async function assignAssetToSlot(
  slotIndex: number,
  filePath: string,
  assetType: string,
  dataUrl?: string,
  savedParams?: Record<string, unknown>,
): Promise<void> {
  // Copy to media library if not already there
  const copyResult = await window.electronAPI.copyMediaToLibrary(filePath);
  if (copyResult.error) throw new Error(copyResult.error);

  const mediaPath = copyResult.mediaPath;
  const absolutePath = copyResult.absolutePath;

  const slotEl = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`) as HTMLElement | null;
  let canvas = slotEl ? slotEl.querySelector('canvas') as HTMLCanvasElement : null;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
  }

  // Dispose existing renderer
  const existingSlot = state.gridSlots[slotIndex] as AssetSlotData | null;
  if (existingSlot?.renderer) {
    existingSlot.renderer.dispose();
  }

  const renderer = new AssetRenderer(canvas) as unknown as AssetRendererLike;
  renderer.mediaPath = mediaPath;

  if (assetType === 'video') {
    await renderer.loadVideo(absolutePath);
  } else {
    // For images: use provided dataUrl or load from library
    if (!dataUrl) {
      const loaded = await window.electronAPI.loadMediaDataUrl(mediaPath);
      if (!loaded.success) throw new Error(loaded.error || 'Failed to load media');
      dataUrl = loaded.dataUrl;
    }
    await renderer.loadImage(dataUrl!);
  }

  // Apply saved params if provided
  if (savedParams) {
    renderer.setParams(savedParams);
  }

  const fileName = mediaPath.split('/').pop()!.split('\\').pop()!;
  state.gridSlots[slotIndex] = {
    type: assetType === 'video' ? 'asset-video' : 'asset-image',
    mediaPath,
    renderer,
    customParams: renderer.getCustomParamValues(),
    label: fileName,
  };

  if (slotEl) {
    slotEl.classList.add('has-shader');
    slotEl.title = `Asset ${slotIndex + 1}: ${fileName}`;
    const labelEl = slotEl.querySelector('.slot-label');
    if (labelEl) labelEl.textContent = fileName;
  }

  saveGridState();
  setStatus(`Loaded ${assetType}: ${fileName}`, 'success');
}

/**
 * Select an asset slot: display on preview + fullscreen and show param UI.
 * Sends an asset update to the fullscreen window with either a dataUrl
 * (for images) or an absolute filePath (for videos).
 */
export async function selectAssetSlot(index: number): Promise<void> {
  const slotData = state.gridSlots[index] as AssetSlotData | null;
  if (!slotData) return;

  // Clear previous active slot highlight
  if (state.activeGridSlot !== null) {
    const prevSlot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
    if (prevSlot) prevSlot.classList.remove('active');
  }

  state.activeGridSlot = index;
  const slot = document.querySelector(`.grid-slot[data-slot="${index}"]`);
  if (slot) slot.classList.add('active');

  // Switch to asset render mode
  state.renderMode = 'asset';
  state.activeAsset = {
    renderer: slotData.renderer,
    type: slotData.type as 'image' | 'video',
    mediaPath: slotData.mediaPath,
    dataUrl: null,
  };

  // Generate asset param UI
  generateCustomParamUI();

  // Send asset to fullscreen
  const assetUpdate: Record<string, unknown> = {
    assetType: slotData.type,
    params: slotData.renderer?.getCustomParamValues?.() || {},
  };

  if (slotData.type === 'asset-image') {
    // Get dataUrl from the renderer's loaded image
    const img = slotData.renderer?.image;
    if (img) {
      assetUpdate.dataUrl = img.src;
    } else if (slotData.mediaPath) {
      try {
        const loaded = await window.electronAPI.loadMediaDataUrl(slotData.mediaPath);
        if (loaded.success) assetUpdate.dataUrl = loaded.dataUrl;
      } catch (err: unknown) {
        log.warn('Grid', 'Failed to load asset dataUrl for fullscreen:', (err as Error).message);
      }
    }
  } else if (slotData.type === 'asset-video') {
    // Get absolute file path for video
    if (slotData.mediaPath) {
      try {
        const absPath = await window.electronAPI.getMediaAbsolutePath(slotData.mediaPath);
        if (absPath) assetUpdate.filePath = absPath;
      } catch (err: unknown) {
        log.warn('Grid', 'Failed to get video path for fullscreen:', (err as Error).message);
      }
    }
  }

  window.electronAPI.sendAssetUpdate(assetUpdate);

  setStatus(`Playing asset ${index + 1}: ${slotData.label || slotData.mediaPath}`, 'success');
}

// =============================================================================
// Asset Context Menu
// =============================================================================

/**
 * Show a context menu for the given asset slot.
 * Builds the menu DOM manually (rather than using the shared helper) because
 * the "Send to Mixer" item requires a submenu which the helper does not support.
 */
function showAssetContextMenu(x: number, y: number, slotIndex: number): void {
  hideContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'grid-context-menu';

  const hasAsset = state.gridSlots[slotIndex] !== null;

  // ---- Load Image ----
  const loadImgItem = document.createElement('div');
  loadImgItem.className = 'context-menu-item';
  loadImgItem.textContent = 'Load Image...';
  loadImgItem.addEventListener('click', async () => {
    hideContextMenu();
    const result = await window.electronAPI.openMediaForAsset();
    if (result && !result.canceled && result.type === 'image') {
      // Ensure slot exists
      while (state.gridSlots.length <= slotIndex) state.gridSlots.push(null);
      try {
        await assignAssetToSlot(slotIndex, result.filePath, 'image', result.dataUrl);
        rebuildAssetGridDOM();
      } catch (err: unknown) {
        setStatus(`Failed to load image: ${(err as Error).message}`, 'error');
      }
    }
  });
  menu.appendChild(loadImgItem);

  // ---- Load Video ----
  const loadVidItem = document.createElement('div');
  loadVidItem.className = 'context-menu-item';
  loadVidItem.textContent = 'Load Video...';
  loadVidItem.addEventListener('click', async () => {
    hideContextMenu();
    const result = await window.electronAPI.openMediaForAsset();
    if (result && !result.canceled && result.type === 'video') {
      while (state.gridSlots.length <= slotIndex) state.gridSlots.push(null);
      try {
        await assignAssetToSlot(slotIndex, result.filePath, 'video');
        rebuildAssetGridDOM();
      } catch (err: unknown) {
        setStatus(`Failed to load video: ${(err as Error).message}`, 'error');
      }
    }
  });
  menu.appendChild(loadVidItem);

  // ---- Rename ----
  if (hasAsset) {
    const renameItem = document.createElement('div');
    renameItem.className = 'context-menu-item';
    renameItem.textContent = 'Rename';
    renameItem.addEventListener('click', () => {
      hideContextMenu();
      renameGridSlot(slotIndex);
    });
    menu.appendChild(renameItem);
  }

  // ---- Send to Mixer channel submenu ----
  if (hasAsset) {
    const separator = document.createElement('div');
    separator.className = 'context-menu-separator';
    menu.appendChild(separator);

    const mixerItem = document.createElement('div');
    mixerItem.className = 'context-menu-item has-submenu';
    mixerItem.textContent = 'Send to Mixer';
    const mixerArrow = document.createElement('span');
    mixerArrow.className = 'submenu-arrow';
    mixerArrow.textContent = '\u25b6';
    mixerItem.appendChild(mixerArrow);

    const mixerContent = document.createElement('div');
    mixerContent.className = 'context-submenu';
    for (let i = 0; i < state.mixerChannels.length; i++) {
      const item = document.createElement('div');
      item.className = 'context-menu-item';
      item.textContent = `Channel ${i + 1}`;
      item.addEventListener('click', () => {
        hideContextMenu();
        assignAssetToMixer(i, slotIndex);
      });
      mixerContent.appendChild(item);
    }
    mixerItem.appendChild(mixerContent);
    menu.appendChild(mixerItem);
  }

  // ---- Clear Slot ----
  if (hasAsset) {
    const separator2 = document.createElement('div');
    separator2.className = 'context-menu-separator';
    menu.appendChild(separator2);

    const clearItem = document.createElement('div');
    clearItem.className = 'context-menu-item';
    clearItem.textContent = 'Clear Slot';
    clearItem.addEventListener('click', () => {
      hideContextMenu();
      const slotData = state.gridSlots[slotIndex] as AssetSlotData | null;
      if (slotData?.renderer) {
        slotData.renderer.dispose();
      }
      state.gridSlots[slotIndex] = null;
      rebuildAssetGridDOM();
      saveGridState();
      setStatus(`Cleared asset slot ${slotIndex + 1}`, 'success');
    });
    menu.appendChild(clearItem);
  }

  // ---- Remove Slot ----
  const removeItem = document.createElement('div');
  removeItem.className = 'context-menu-item';
  removeItem.textContent = 'Remove Slot';
  removeItem.addEventListener('click', () => {
    hideContextMenu();
    const slotData = state.gridSlots[slotIndex] as AssetSlotData | null;
    if (slotData?.renderer) {
      slotData.renderer.dispose();
    }
    state.gridSlots.splice(slotIndex, 1);
    if (state.activeGridSlot === slotIndex) {
      state.activeGridSlot = null;
    } else if (state.activeGridSlot !== null && state.activeGridSlot > slotIndex) {
      state.activeGridSlot--;
    }
    rebuildAssetGridDOM();
    saveGridState();
    setStatus(`Removed asset slot ${slotIndex + 1}`, 'success');
  });
  menu.appendChild(removeItem);

  // ---- Position menu ----
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${window.innerWidth - rect.width - 5}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${window.innerHeight - rect.height - 5}px`;
  }

  // Close on click outside
  setTimeout(() => {
    const handler = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node)) {
        hideContextMenu();
        document.removeEventListener('click', handler);
      }
    };
    document.addEventListener('click', handler);
  }, 0);
}
