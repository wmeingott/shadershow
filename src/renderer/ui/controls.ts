// Controls module — toolbar buttons, resizer panels, fullscreen/tiled management.
// Typed version of js/controls.js.

import { state } from '../core/state.js';
import { tileState, calculateTileBounds } from '../tiles/tile-state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Resizer panel currently being dragged */
type ActiveResizer = 'editor' | 'vertical' | 'bottom' | null;

/** Display descriptor returned by electronAPI.getDisplays */
interface DisplayInfo {
  id: number;
  label: string;
}

/** Time-sync payload sent to the fullscreen window */
interface TimeSyncPayload {
  time: number;
  frame: number;
  isPlaying: boolean;
}

/** Renderer stats returned by state.renderer.getStats() */
interface RendererStats {
  time: number;
  frame: number;
  isPlaying: boolean;
}

/** Minimal ShaderRenderer surface used by this module */
interface RendererLike {
  togglePlayback(): boolean;
  resetTime(): void;
  isPlaying: boolean;
  getStats(): RendererStats;
  setResolution(width: number, height: number): void;
  resize(): void;
}

/** Minimal Ace editor surface used by this module */
interface EditorLike {
  resize(): void;
}

/** Grid slot data shape used in syncTiledModeToFullscreen / initTileRenderers */
interface GridSlotData {
  shaderCode?: string | null;
  params?: Record<string, unknown> | null;
  customParams?: Record<string, unknown> | null;
  renderer?: unknown;
  [key: string]: unknown;
}

/** Runtime tile with optional renderer (extends the persisted TileConfig) */
interface RuntimeTile {
  gridSlotIndex: number | null;
  params?: Record<string, unknown> | null;
  customParams?: Record<string, unknown> | null;
  visible: boolean;
  renderer?: unknown;
}

/** Tile configuration sent to the fullscreen window */
interface TileFullscreenEntry {
  gridSlotIndex: number | null;
  shaderCode: string | null;
  params: Record<string, unknown> | null;
  visible: boolean;
}

interface TileFullscreenConfig {
  layout: { rows: number; cols: number; gaps: number };
  tiles: TileFullscreenEntry[];
}

// ---------------------------------------------------------------------------
// Minimal electronAPI surface used by this module
// ---------------------------------------------------------------------------

declare const window: Window & {
  electronAPI: {
    newFile(kind: string): void;
    openFile(): void;
    toggleNDI(): void;
    openFullscreen(): void;
    openFullscreenOnDisplay(displayId: number): void;
    closeFullscreen(): void;
    sendTimeSync(payload: TimeSyncPayload): void;
    sendBlackout(enabled: boolean): void;
    getDisplays(): Promise<DisplayInfo[]>;
    initTiledFullscreen?(config: TileFullscreenConfig): void;
    exitTiledMode?(): void;
    assignTileShader?(tileIndex: number, code: string): void;
  };
};

// ---------------------------------------------------------------------------
// External module stubs (not yet converted to TS)
// ---------------------------------------------------------------------------

declare function saveActiveSlotShader(): void;
declare function startGridAnimation(): void;
declare function stopGridAnimation(): void;
declare function toggleVisualPresetsPanel(): void;
declare function initVisualPresetsPanel(): void;
declare function saveViewState(): void;
declare function showSettingsDialog(): void;
declare function showTileConfigDialog(): void;
declare function initToolbarPresetsPanel(): void;
declare function togglePresetsPanel(): void;
declare function toggleRecording(): void;
declare function showAIAssistantDialog(): void;
declare function initAIShortcut(): void;
declare function runBenchmark(): void;

const log = {
  debug(..._a: unknown[]): void { /* noop */ },
  info(..._a: unknown[]): void { /* noop */ },
  warn(..._a: unknown[]): void { /* noop */ },
  error(..._a: unknown[]): void { /* noop */ },
};

// ---------------------------------------------------------------------------
// Helpers — typed accessors for state properties
// ---------------------------------------------------------------------------

function getRenderer(): RendererLike {
  return state.renderer as RendererLike;
}

function getEditor(): EditorLike {
  return state.editor as EditorLike;
}

function getGridSlot(index: number): GridSlotData | null {
  return (state.gridSlots as GridSlotData[])[index] ?? null;
}

function getTile(index: number): RuntimeTile | null {
  return (tileState.tiles as RuntimeTile[])[index] ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initControls(): void {
  // New File button - show dialog
  const btnNew = document.getElementById('btn-new') as HTMLButtonElement;
  const newFileDialog = document.getElementById('new-file-dialog') as HTMLElement;
  const newFileClose = document.getElementById('new-file-close') as HTMLButtonElement;
  const newShaderBtn = document.getElementById('new-shader-btn') as HTMLButtonElement;
  const newSceneBtn = document.getElementById('new-scene-btn') as HTMLButtonElement;

  btnNew.addEventListener('click', (): void => {
    newFileDialog.classList.remove('hidden');
  });

  newFileClose.addEventListener('click', (): void => {
    newFileDialog.classList.add('hidden');
  });

  // Close on backdrop click
  newFileDialog.addEventListener('click', (e: MouseEvent): void => {
    if (e.target === newFileDialog) {
      newFileDialog.classList.add('hidden');
    }
  });

  // New Shader
  newShaderBtn.addEventListener('click', (): void => {
    newFileDialog.classList.add('hidden');
    window.electronAPI.newFile('shader');
  });

  // New Scene
  newSceneBtn.addEventListener('click', (): void => {
    newFileDialog.classList.add('hidden');
    window.electronAPI.newFile('scene');
  });

  // Open File button
  const btnOpen = document.getElementById('btn-open') as HTMLButtonElement;
  btnOpen.addEventListener('click', (): void => {
    window.electronAPI.openFile();
  });

  // Play/Pause button
  const btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
  btnPlay.addEventListener('click', togglePlayback);

  // Reset button
  const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
  btnReset.addEventListener('click', resetTime);

  // Preview toggle button
  const btnPreview = document.getElementById('btn-preview') as HTMLButtonElement;
  btnPreview.addEventListener('click', togglePreview);

  // Grid toggle button
  const btnGrid = document.getElementById('btn-grid') as HTMLButtonElement;
  btnGrid.addEventListener('click', toggleGrid);

  // Editor toggle button
  const btnEditor = document.getElementById('btn-editor') as HTMLButtonElement;
  btnEditor.addEventListener('click', toggleEditor);

  // Params toggle button
  const btnParams = document.getElementById('btn-params') as HTMLButtonElement;
  btnParams.addEventListener('click', toggleParams);

  // NDI toggle button
  const btnNdi = document.getElementById('btn-ndi') as HTMLButtonElement;
  btnNdi.addEventListener('click', toggleNDI);

  // Recording toggle button
  const btnRecord = document.getElementById('btn-record') as HTMLButtonElement;
  btnRecord.addEventListener('click', toggleRecording);

  // Fullscreen display selector
  const fullscreenSelect = document.getElementById('fullscreen-select') as HTMLSelectElement;
  populateFullscreenSelect();
  fullscreenSelect.addEventListener('change', (): void => {
    const displayId = fullscreenSelect.value;
    if (displayId) {
      window.electronAPI.openFullscreenOnDisplay(Number(displayId));
    } else {
      window.electronAPI.closeFullscreen();
    }
  });

  // Blackout button
  const btnBlackout = document.getElementById('btn-blackout') as HTMLButtonElement;
  btnBlackout.addEventListener('click', toggleBlackout);

  // Tiled preview button
  const btnTiled = document.getElementById('btn-tiled') as HTMLButtonElement;
  btnTiled.addEventListener('click', toggleTiledPreview);

  // Double-click to open tile config dialog
  btnTiled.addEventListener('dblclick', showTileConfigDialog);

  // Tile presets panel toggle button
  const btnTilePresets = document.getElementById('btn-tile-presets') as HTMLButtonElement;
  btnTilePresets.addEventListener('click', togglePresetsPanel);

  // Initialize the toolbar presets panel buttons
  initToolbarPresetsPanel();

  // Visual presets panel toggle button
  const btnVisualPresets = document.getElementById('btn-visual-presets') as HTMLButtonElement;
  btnVisualPresets.addEventListener('click', toggleVisualPresetsPanel);

  // Initialize visual presets panel
  initVisualPresetsPanel();

  // Benchmark button
  const btnBenchmark = document.getElementById('btn-benchmark') as HTMLButtonElement;
  btnBenchmark.addEventListener('click', runBenchmark);

  // Settings button
  const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement;
  btnSettings.addEventListener('click', showSettingsDialog);

  // AI Assistant button
  const btnAI = document.getElementById('btn-ai') as HTMLButtonElement | null;
  if (btnAI) {
    btnAI.addEventListener('click', showAIAssistantDialog);
  }

  // Initialize AI keyboard shortcut (Ctrl+Shift+A)
  initAIShortcut();

  // Save shader button
  const btnSaveShader = document.getElementById('btn-save-shader') as HTMLButtonElement;
  btnSaveShader.addEventListener('click', saveActiveSlotShader);

  // Resolution selector
  const resolutionSelect = document.getElementById('resolution-select') as HTMLSelectElement;
  const customWidth = document.getElementById('custom-width') as HTMLInputElement;
  const customHeight = document.getElementById('custom-height') as HTMLInputElement;
  const customX = document.getElementById('custom-x') as HTMLElement;

  resolutionSelect.addEventListener('change', (): void => {
    if (resolutionSelect.value === 'custom') {
      customWidth.classList.remove('hidden');
      customHeight.classList.remove('hidden');
      customX.classList.remove('hidden');
      updateResolution();
    } else {
      customWidth.classList.add('hidden');
      customHeight.classList.add('hidden');
      customX.classList.add('hidden');
      const [width, height] = resolutionSelect.value.split('x').map(Number);
      getRenderer().setResolution(width, height);
    }
  });

  const updateResolution = (): void => {
    const width = parseInt(customWidth.value) || 1280;
    const height = parseInt(customHeight.value) || 720;
    getRenderer().setResolution(width, height);
  };

  customWidth.addEventListener('change', updateResolution);
  customHeight.addEventListener('change', updateResolution);
}

export function initResizer(): void {
  const resizer = document.getElementById('resizer') as HTMLElement;
  const resizerVertical = document.getElementById('resizer-vertical') as HTMLElement;
  const resizerBottom = document.getElementById('resizer-bottom') as HTMLElement;
  const editorPanel = document.getElementById('editor-panel') as HTMLElement;
  const previewPanel = document.getElementById('preview-panel') as HTMLElement;
  const bottomRow = document.getElementById('bottom-row') as HTMLElement;
  const gridPanel = document.getElementById('grid-panel') as HTMLElement;
  const _paramsPanel = document.getElementById('params-panel') as HTMLElement;
  const rightPanel = document.getElementById('right-panel') as HTMLElement;

  let activeResizer: ActiveResizer = null;

  // Editor/Right panel horizontal resizer
  resizer.addEventListener('mousedown', (e: MouseEvent): void => {
    activeResizer = 'editor';
    resizer.classList.add('dragging');
    e.preventDefault();
  });

  // Preview/Bottom row vertical resizer
  resizerVertical.addEventListener('mousedown', (e: MouseEvent): void => {
    activeResizer = 'vertical';
    resizerVertical.classList.add('dragging');
    e.preventDefault();
  });

  // Grid/Params horizontal resizer
  resizerBottom.addEventListener('mousedown', (e: MouseEvent): void => {
    activeResizer = 'bottom';
    resizerBottom.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e: MouseEvent): void => {
    if (!activeResizer) return;

    if (activeResizer === 'editor') {
      const containerWidth = (document.getElementById('main-content') as HTMLElement).offsetWidth;
      const newWidth = (e.clientX / containerWidth) * 100;
      if (newWidth >= 20 && newWidth <= 80) {
        editorPanel.style.width = `${newWidth}%`;
        getEditor().resize();
      }
    } else if (activeResizer === 'vertical') {
      const rightPanelRect = rightPanel.getBoundingClientRect();
      const relativeY = e.clientY - rightPanelRect.top;
      const totalHeight = rightPanelRect.height;
      const minPreviewHeight = 100;
      const minBottomHeight = 200;

      if (relativeY >= minPreviewHeight && relativeY <= totalHeight - minBottomHeight) {
        previewPanel.style.flex = 'none';
        previewPanel.style.height = `${relativeY}px`;
      }
    } else if (activeResizer === 'bottom') {
      const bottomRowRect = bottomRow.getBoundingClientRect();
      const relativeX = e.clientX - bottomRowRect.left;
      const minGridWidth = 200;
      const minParamsWidth = 200;

      if (relativeX >= minGridWidth && relativeX <= bottomRowRect.width - minParamsWidth) {
        gridPanel.style.flex = 'none';
        gridPanel.style.width = `${relativeX}px`;
      }
    }
  });

  document.addEventListener('mouseup', (): void => {
    if (activeResizer) {
      resizer.classList.remove('dragging');
      resizerVertical.classList.remove('dragging');
      resizerBottom.classList.remove('dragging');
      activeResizer = null;
      saveViewState();
    }
  });
}

export function togglePlayback(): void {
  const isPlaying: boolean = getRenderer().togglePlayback();
  const btnPlay = document.getElementById('btn-play') as HTMLElement;
  btnPlay.innerHTML = isPlaying
    ? '<span class="icon">&#10074;&#10074;</span>'
    : '<span class="icon">&#9658;</span>';
  btnPlay.title = isPlaying ? 'Pause (Space)' : 'Play (Space)';

  // Sync to fullscreen window
  const stats: RendererStats = getRenderer().getStats();
  window.electronAPI.sendTimeSync({
    time: stats.time,
    frame: stats.frame,
    isPlaying: stats.isPlaying,
  });
}

export function resetTime(): void {
  getRenderer().resetTime();

  // Sync to fullscreen window
  window.electronAPI.sendTimeSync({
    time: 0,
    frame: 0,
    isPlaying: getRenderer().isPlaying,
  });
}

export function togglePreview(): void {
  state.previewEnabled = !state.previewEnabled;
  log.debug('Controls', 'Preview:', state.previewEnabled ? 'shown' : 'hidden');
  const btnPreview = document.getElementById('btn-preview') as HTMLElement;
  const previewPanel = document.getElementById('preview-panel') as HTMLElement;

  if (state.previewEnabled) {
    btnPreview.classList.add('active');
    btnPreview.title = 'Disable Preview';
    previewPanel.classList.remove('hidden');
  } else {
    btnPreview.classList.remove('active');
    btnPreview.title = 'Enable Preview';
    previewPanel.classList.add('hidden');
  }

  updatePanelVisibility();
  saveViewState();
}

export function toggleGrid(): void {
  state.gridEnabled = !state.gridEnabled;
  log.debug('Controls', 'Grid:', state.gridEnabled ? 'shown' : 'hidden');
  const btnGrid = document.getElementById('btn-grid') as HTMLElement;
  const gridPanel = document.getElementById('grid-panel') as HTMLElement;

  if (state.gridEnabled) {
    btnGrid.classList.add('active');
    btnGrid.title = 'Hide Shader Grid';
    gridPanel.classList.remove('hidden');
    startGridAnimation();
  } else {
    btnGrid.classList.remove('active');
    btnGrid.title = 'Show Shader Grid';
    gridPanel.classList.add('hidden');
    stopGridAnimation();
  }

  updatePanelVisibility();
  saveViewState();
}

export function toggleEditor(): void {
  state.editorEnabled = !state.editorEnabled;
  log.debug('Controls', 'Editor:', state.editorEnabled ? 'shown' : 'hidden');
  const btnEditor = document.getElementById('btn-editor') as HTMLElement;
  const editorPanel = document.getElementById('editor-panel') as HTMLElement;

  if (state.editorEnabled) {
    btnEditor.classList.add('active');
    btnEditor.title = 'Hide Editor';
    editorPanel.classList.remove('hidden');
  } else {
    btnEditor.classList.remove('active');
    btnEditor.title = 'Show Editor';
    editorPanel.classList.add('hidden');
  }

  updatePanelVisibility();
  saveViewState();
}

export function toggleParams(): void {
  state.paramsEnabled = !state.paramsEnabled;
  log.debug('Controls', 'Params:', state.paramsEnabled ? 'shown' : 'hidden');
  const btnParams = document.getElementById('btn-params') as HTMLElement;
  const paramsPanel = document.getElementById('params-panel') as HTMLElement;

  if (state.paramsEnabled) {
    btnParams.classList.add('active');
    btnParams.title = 'Hide Parameters';
    paramsPanel.classList.remove('hidden');
  } else {
    btnParams.classList.remove('active');
    btnParams.title = 'Show Parameters';
    paramsPanel.classList.add('hidden');
  }

  updatePanelVisibility();
  saveViewState();
}

export function updatePanelVisibility(): void {
  const rightPanel = document.getElementById('right-panel') as HTMLElement;
  const resizer = document.getElementById('resizer') as HTMLElement;
  const resizerVertical = document.getElementById('resizer-vertical') as HTMLElement;
  const resizerBottom = document.getElementById('resizer-bottom') as HTMLElement;
  const editorPanel = document.getElementById('editor-panel') as HTMLElement;
  const bottomRow = document.getElementById('bottom-row') as HTMLElement;

  const rightVisible: boolean = state.previewEnabled || state.gridEnabled || state.paramsEnabled;
  const leftVisible: boolean = state.editorEnabled;
  const bottomVisible: boolean = state.gridEnabled || state.paramsEnabled;

  // Show/hide vertical resizer between preview and bottom row
  if (state.previewEnabled && bottomVisible) {
    resizerVertical.classList.remove('hidden');
  } else {
    resizerVertical.classList.add('hidden');
  }

  // Show/hide bottom row and horizontal resizer
  if (bottomVisible) {
    bottomRow.classList.remove('hidden');
    // Show resizer between grid and params only if both visible
    if (state.gridEnabled && state.paramsEnabled) {
      resizerBottom.classList.remove('hidden');
    } else {
      resizerBottom.classList.add('hidden');
    }
  } else {
    bottomRow.classList.add('hidden');
    resizerBottom.classList.add('hidden');
  }

  if (!rightVisible && leftVisible) {
    // Only editor - full width
    rightPanel.classList.add('hidden');
    resizer.classList.add('hidden');
    editorPanel.style.width = '100%';
  } else if (rightVisible && !leftVisible) {
    // Only right panel - full width
    rightPanel.classList.remove('hidden');
    rightPanel.style.width = '100%';
    resizer.classList.add('hidden');
    editorPanel.style.width = '';
  } else if (rightVisible && leftVisible) {
    // Both visible - restore editor width or use default
    rightPanel.classList.remove('hidden');
    rightPanel.style.width = '';
    resizer.classList.remove('hidden');
    if (!editorPanel.style.width || editorPanel.style.width === '100%') {
      editorPanel.style.width = '50%';
    }
  } else {
    // Neither visible - show editor by default
    state.editorEnabled = true;
    const btnEditor = document.getElementById('btn-editor') as HTMLElement;
    btnEditor.classList.add('active');
    editorPanel.classList.remove('hidden');
    editorPanel.style.width = '100%';
    rightPanel.classList.add('hidden');
    resizer.classList.add('hidden');
  }

  getEditor().resize();
}

export function toggleNDI(): void {
  log.info('Controls', 'Toggling NDI output');
  window.electronAPI.toggleNDI();
}

export function openFullscreenPreview(): void {
  window.electronAPI.openFullscreen();
}

export async function populateFullscreenSelect(): Promise<void> {
  const select = document.getElementById('fullscreen-select') as HTMLSelectElement | null;
  if (!select) return;
  const displays: DisplayInfo[] = await window.electronAPI.getDisplays();
  // Keep "No Fullscreen" option, replace the rest
  const currentValue: string = select.value;
  select.innerHTML = '<option value="">\u26F6 No Fullscreen</option>';
  for (const d of displays) {
    const opt: HTMLOptionElement = document.createElement('option');
    opt.value = String(d.id);
    opt.textContent = `\u26F6 ${d.label}`;
    select.appendChild(opt);
  }
  // Restore selection if display still exists
  if (currentValue && [...select.options].some((o: HTMLOptionElement) => o.value === currentValue)) {
    select.value = currentValue;
  }
}

export function resetFullscreenSelect(): void {
  const select = document.getElementById('fullscreen-select') as HTMLSelectElement | null;
  if (select) select.value = '';
}

export function toggleBlackout(): void {
  state.blackoutEnabled = !state.blackoutEnabled;
  log.debug('Controls', 'Blackout:', state.blackoutEnabled ? 'enabled' : 'disabled');
  const btnBlackout = document.getElementById('btn-blackout') as HTMLElement;

  if (state.blackoutEnabled) {
    btnBlackout.classList.add('active');
    btnBlackout.title = 'Disable Blackout (B)';
  } else {
    btnBlackout.classList.remove('active');
    btnBlackout.title = 'Blackout Fullscreen (B)';
  }

  window.electronAPI.sendBlackout(state.blackoutEnabled);
}

export function toggleTiledPreview(): void {
  state.tiledPreviewEnabled = !state.tiledPreviewEnabled;
  log.info('Controls', 'Tiled preview:', state.tiledPreviewEnabled ? 'enabled' : 'disabled');
  const btnTiled = document.getElementById('btn-tiled') as HTMLElement;

  if (state.tiledPreviewEnabled) {
    btnTiled.classList.add('active');
    btnTiled.title = 'Disable Tiled Preview (double-click for config)';
    initTileRenderers();
    // Sync tiled mode to fullscreen
    syncTiledModeToFullscreen();
  } else {
    btnTiled.classList.remove('active');
    btnTiled.title = 'Toggle Tiled Preview';
    cleanupTileRenderers();
    // Hide tiled preview overlay by directly accessing DOM
    const overlay = document.getElementById('tiled-preview-canvas') as HTMLElement | null;
    if (overlay) overlay.style.display = 'none';
    // Tell fullscreen to exit tiled mode
    window.electronAPI.exitTiledMode?.();
  }
}

// Sync current tiled configuration to fullscreen window
export function syncTiledModeToFullscreen(): void {
  if (!state.tiledPreviewEnabled) return;

  // Build tile configuration with shader code and params
  const tiles: TileFullscreenEntry[] = (tileState.tiles as RuntimeTile[]).map(
    (tile: RuntimeTile, _index: number): TileFullscreenEntry => {
      if (!tile || tile.gridSlotIndex === null) {
        return { gridSlotIndex: null, shaderCode: null, params: null, visible: true };
      }

      const slotData: GridSlotData | null = getGridSlot(tile.gridSlotIndex);
      if (!slotData) {
        return { gridSlotIndex: tile.gridSlotIndex, shaderCode: null, params: null, visible: tile.visible };
      }

      // Merge slot and tile params
      const params: Record<string, unknown> = {
        speed: tile.params?.speed ?? slotData.params?.speed ?? 1,
        ...(slotData.customParams || {}),
        ...(tile.customParams || {}),
      };

      return {
        gridSlotIndex: tile.gridSlotIndex,
        shaderCode: slotData.shaderCode ?? null,
        params,
        visible: tile.visible !== false,
      };
    },
  );

  const config: TileFullscreenConfig = {
    layout: { ...tileState.layout },
    tiles,
  };

  window.electronAPI.initTiledFullscreen?.(config);
}

// Initialize tile renderers for preview
function initTileRenderers(): void {
  cleanupTileRenderers();

  const { rows, cols } = tileState.layout;
  const tileCount: number = rows * cols;

  // Tiles share the slot's renderer to avoid WebGL context exhaustion
  // Each tile just stores its own params/customParams
  for (let i = 0; i < tileCount; i++) {
    const tile: RuntimeTile | null = getTile(i);
    if (tile && tile.gridSlotIndex !== null) {
      const slotData: GridSlotData | null = getGridSlot(tile.gridSlotIndex);
      if (slotData && slotData.renderer) {
        // Reference the slot's renderer (shared)
        (state.tileRenderers as unknown[])[i] = slotData.renderer;
      } else {
        (state.tileRenderers as unknown[])[i] = null;
      }
    } else {
      (state.tileRenderers as unknown[])[i] = null;
    }
  }
}

// Cleanup tile renderers
function cleanupTileRenderers(): void {
  // Tiles share slot renderers, so just clear references (don't dispose)
  state.tileRenderers = [];
}

// Update a specific tile's renderer reference when assigned
export function updateTileRenderer(tileIndex: number): void {
  if (!state.tiledPreviewEnabled) return;

  const tile: RuntimeTile | null = getTile(tileIndex);
  if (tile && tile.renderer) {
    // Each tile now has its own renderer
    (state.tileRenderers as unknown[])[tileIndex] = tile.renderer;
  } else {
    (state.tileRenderers as unknown[])[tileIndex] = null;
  }
}

// Refresh all tile renderers
export function refreshTileRenderers(): void {
  if (!state.tiledPreviewEnabled) return;
  initTileRenderers();
}
