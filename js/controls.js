// Controls module
import { state } from './state.js';
import { saveActiveSlotShader, startGridAnimation, stopGridAnimation, toggleVisualPresetsPanel, initVisualPresetsPanel } from './shader-grid.js';
import { saveViewState } from './view-state.js';
import { showSettingsDialog } from './settings.js';
import { tileState, calculateTileBounds } from './tile-state.js';
import { showTileConfigDialog, initToolbarPresetsPanel, togglePresetsPanel } from './tile-config.js';
import { toggleRecording } from './recording.js';
import { showAIAssistantDialog, initAIShortcut } from './claude-ai.js';
import { runBenchmark } from './benchmark.js';
import { log } from './logger.js';

export function initControls() {
  // New File button - show dialog
  const btnNew = document.getElementById('btn-new');
  const newFileDialog = document.getElementById('new-file-dialog');
  const newFileClose = document.getElementById('new-file-close');
  const newShaderBtn = document.getElementById('new-shader-btn');
  const newSceneBtn = document.getElementById('new-scene-btn');

  btnNew.addEventListener('click', () => {
    newFileDialog.classList.remove('hidden');
  });

  newFileClose.addEventListener('click', () => {
    newFileDialog.classList.add('hidden');
  });

  // Close on backdrop click
  newFileDialog.addEventListener('click', (e) => {
    if (e.target === newFileDialog) {
      newFileDialog.classList.add('hidden');
    }
  });

  // New Shader
  newShaderBtn.addEventListener('click', () => {
    newFileDialog.classList.add('hidden');
    window.electronAPI.newFile('shader');
  });

  // New Scene
  newSceneBtn.addEventListener('click', () => {
    newFileDialog.classList.add('hidden');
    window.electronAPI.newFile('scene');
  });

  // Open File button
  const btnOpen = document.getElementById('btn-open');
  btnOpen.addEventListener('click', () => {
    window.electronAPI.openFile();
  });

  // Play/Pause button
  const btnPlay = document.getElementById('btn-play');
  btnPlay.addEventListener('click', togglePlayback);

  // Reset button
  const btnReset = document.getElementById('btn-reset');
  btnReset.addEventListener('click', resetTime);

  // Preview toggle button
  const btnPreview = document.getElementById('btn-preview');
  btnPreview.addEventListener('click', togglePreview);

  // Grid toggle button
  const btnGrid = document.getElementById('btn-grid');
  btnGrid.addEventListener('click', toggleGrid);

  // Editor toggle button
  const btnEditor = document.getElementById('btn-editor');
  btnEditor.addEventListener('click', toggleEditor);

  // Params toggle button
  const btnParams = document.getElementById('btn-params');
  btnParams.addEventListener('click', toggleParams);

  // NDI toggle button
  const btnNdi = document.getElementById('btn-ndi');
  btnNdi.addEventListener('click', toggleNDI);

  // Recording toggle button
  const btnRecord = document.getElementById('btn-record');
  btnRecord.addEventListener('click', toggleRecording);

  // Fullscreen display selector
  const fullscreenSelect = document.getElementById('fullscreen-select');
  populateFullscreenSelect();
  fullscreenSelect.addEventListener('change', () => {
    const displayId = fullscreenSelect.value;
    if (displayId) {
      window.electronAPI.openFullscreenOnDisplay(Number(displayId));
    } else {
      window.electronAPI.closeFullscreen();
    }
  });

  // Blackout button
  const btnBlackout = document.getElementById('btn-blackout');
  btnBlackout.addEventListener('click', toggleBlackout);

  // Tiled preview button
  const btnTiled = document.getElementById('btn-tiled');
  btnTiled.addEventListener('click', toggleTiledPreview);

  // Double-click to open tile config dialog
  btnTiled.addEventListener('dblclick', showTileConfigDialog);

  // Tile presets panel toggle button
  const btnTilePresets = document.getElementById('btn-tile-presets');
  btnTilePresets.addEventListener('click', togglePresetsPanel);

  // Initialize the toolbar presets panel buttons
  initToolbarPresetsPanel();

  // Visual presets panel toggle button
  const btnVisualPresets = document.getElementById('btn-visual-presets');
  btnVisualPresets.addEventListener('click', toggleVisualPresetsPanel);

  // Initialize visual presets panel
  initVisualPresetsPanel();

  // Benchmark button
  const btnBenchmark = document.getElementById('btn-benchmark');
  btnBenchmark.addEventListener('click', runBenchmark);

  // Settings button
  const btnSettings = document.getElementById('btn-settings');
  btnSettings.addEventListener('click', showSettingsDialog);

  // AI Assistant button
  const btnAI = document.getElementById('btn-ai');
  if (btnAI) {
    btnAI.addEventListener('click', showAIAssistantDialog);
  }

  // Initialize AI keyboard shortcut (Ctrl+Shift+A)
  initAIShortcut();

  // Save shader button
  const btnSaveShader = document.getElementById('btn-save-shader');
  btnSaveShader.addEventListener('click', saveActiveSlotShader);

  // Resolution selector
  const resolutionSelect = document.getElementById('resolution-select');
  const customWidth = document.getElementById('custom-width');
  const customHeight = document.getElementById('custom-height');
  const customX = document.getElementById('custom-x');

  resolutionSelect.addEventListener('change', () => {
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
      state.renderer.setResolution(width, height);
    }
  });

  const updateResolution = () => {
    const width = parseInt(customWidth.value) || 1280;
    const height = parseInt(customHeight.value) || 720;
    state.renderer.setResolution(width, height);
  };

  customWidth.addEventListener('change', updateResolution);
  customHeight.addEventListener('change', updateResolution);
}

export function initResizer() {
  const resizer = document.getElementById('resizer');
  const resizerVertical = document.getElementById('resizer-vertical');
  const resizerBottom = document.getElementById('resizer-bottom');
  const resizerVisualPresets = document.getElementById('resizer-visual-presets');
  const editorPanel = document.getElementById('editor-panel');
  const previewPanel = document.getElementById('preview-panel');
  const bottomRow = document.getElementById('bottom-row');
  const gridPanel = document.getElementById('grid-panel');
  const paramsPanel = document.getElementById('params-panel');
  const rightPanel = document.getElementById('right-panel');
  const visualPresetsPanel = document.getElementById('visual-presets-panel');

  let activeResizer = null;

  // Editor/Right panel horizontal resizer
  resizer.addEventListener('mousedown', (e) => {
    activeResizer = 'editor';
    resizer.classList.add('dragging');
    e.preventDefault();
  });

  // Preview/Bottom row vertical resizer
  resizerVertical.addEventListener('mousedown', (e) => {
    activeResizer = 'vertical';
    resizerVertical.classList.add('dragging');
    e.preventDefault();
  });

  // Grid/Params horizontal resizer
  resizerBottom.addEventListener('mousedown', (e) => {
    activeResizer = 'bottom';
    resizerBottom.classList.add('dragging');
    e.preventDefault();
  });

  // Visual presets sidebar resizer
  resizerVisualPresets.addEventListener('mousedown', (e) => {
    activeResizer = 'visual-presets';
    resizerVisualPresets.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!activeResizer) return;

    if (activeResizer === 'editor') {
      const containerWidth = document.getElementById('main-content').offsetWidth;
      const newWidth = (e.clientX / containerWidth) * 100;
      if (newWidth >= 20 && newWidth <= 80) {
        editorPanel.style.width = `${newWidth}%`;
        state.editor.resize();
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
    } else if (activeResizer === 'visual-presets') {
      const mainContent = document.getElementById('main-content');
      const mainRect = mainContent.getBoundingClientRect();
      const newWidth = mainRect.right - e.clientX;
      if (newWidth >= 120 && newWidth <= mainRect.width * 0.8) {
        visualPresetsPanel.style.width = `${newWidth}px`;
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (activeResizer) {
      resizer.classList.remove('dragging');
      resizerVertical.classList.remove('dragging');
      resizerBottom.classList.remove('dragging');
      resizerVisualPresets.classList.remove('dragging');
      activeResizer = null;
      saveViewState();
    }
  });
}

export function togglePlayback() {
  const isPlaying = state.renderer.togglePlayback();
  const btnPlay = document.getElementById('btn-play');
  btnPlay.innerHTML = isPlaying ?
    '<span class="icon">&#10074;&#10074;</span>' :
    '<span class="icon">&#9658;</span>';
  btnPlay.title = isPlaying ? 'Pause (Space)' : 'Play (Space)';

  // Sync to fullscreen window
  const stats = state.renderer.getStats();
  window.electronAPI.sendTimeSync({
    time: stats.time,
    frame: stats.frame,
    isPlaying: stats.isPlaying
  });
}

export function resetTime() {
  state.renderer.resetTime();

  // Sync to fullscreen window
  window.electronAPI.sendTimeSync({
    time: 0,
    frame: 0,
    isPlaying: state.renderer.isPlaying
  });
}

export function togglePreview() {
  state.previewEnabled = !state.previewEnabled;
  log.debug('Controls', 'Preview:', state.previewEnabled ? 'shown' : 'hidden');
  const btnPreview = document.getElementById('btn-preview');
  const previewPanel = document.getElementById('preview-panel');

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

export function toggleGrid() {
  state.gridEnabled = !state.gridEnabled;
  log.debug('Controls', 'Grid:', state.gridEnabled ? 'shown' : 'hidden');
  const btnGrid = document.getElementById('btn-grid');
  const gridPanel = document.getElementById('grid-panel');

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

export function toggleEditor() {
  state.editorEnabled = !state.editorEnabled;
  log.debug('Controls', 'Editor:', state.editorEnabled ? 'shown' : 'hidden');
  const btnEditor = document.getElementById('btn-editor');
  const editorPanel = document.getElementById('editor-panel');

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

export function toggleParams() {
  state.paramsEnabled = !state.paramsEnabled;
  log.debug('Controls', 'Params:', state.paramsEnabled ? 'shown' : 'hidden');
  const btnParams = document.getElementById('btn-params');
  const paramsPanel = document.getElementById('params-panel');

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

export function updatePanelVisibility() {
  const rightPanel = document.getElementById('right-panel');
  const resizer = document.getElementById('resizer');
  const resizerVertical = document.getElementById('resizer-vertical');
  const resizerBottom = document.getElementById('resizer-bottom');
  const editorPanel = document.getElementById('editor-panel');
  const bottomRow = document.getElementById('bottom-row');

  const rightVisible = state.previewEnabled || state.gridEnabled || state.paramsEnabled;
  const leftVisible = state.editorEnabled;
  const bottomVisible = state.gridEnabled || state.paramsEnabled;

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
    const btnEditor = document.getElementById('btn-editor');
    btnEditor.classList.add('active');
    editorPanel.classList.remove('hidden');
    editorPanel.style.width = '100%';
    rightPanel.classList.add('hidden');
    resizer.classList.add('hidden');
  }

  state.editor.resize();
}

export function toggleNDI() {
  log.info('Controls', 'Toggling NDI output');
  window.electronAPI.toggleNDI();
}

export function openFullscreenPreview() {
  window.electronAPI.openFullscreen();
}

export async function populateFullscreenSelect() {
  const select = document.getElementById('fullscreen-select');
  if (!select) return;
  const displays = await window.electronAPI.getDisplays();
  // Keep "No Fullscreen" option, replace the rest
  const currentValue = select.value;
  select.innerHTML = '<option value="">\u26F6 No Fullscreen</option>';
  for (const d of displays) {
    const opt = document.createElement('option');
    opt.value = String(d.id);
    opt.textContent = `\u26F6 ${d.label}`;
    select.appendChild(opt);
  }
  // Restore selection if display still exists
  if (currentValue && [...select.options].some(o => o.value === currentValue)) {
    select.value = currentValue;
  }
}

export function resetFullscreenSelect() {
  const select = document.getElementById('fullscreen-select');
  if (select) select.value = '';
}

export function toggleBlackout() {
  state.blackoutEnabled = !state.blackoutEnabled;
  log.debug('Controls', 'Blackout:', state.blackoutEnabled ? 'enabled' : 'disabled');
  const btnBlackout = document.getElementById('btn-blackout');

  if (state.blackoutEnabled) {
    btnBlackout.classList.add('active');
    btnBlackout.title = 'Disable Blackout (B)';
  } else {
    btnBlackout.classList.remove('active');
    btnBlackout.title = 'Blackout Fullscreen (B)';
  }

  window.electronAPI.sendBlackout(state.blackoutEnabled);
}

export function toggleTiledPreview() {
  state.tiledPreviewEnabled = !state.tiledPreviewEnabled;
  log.info('Controls', 'Tiled preview:', state.tiledPreviewEnabled ? 'enabled' : 'disabled');
  const btnTiled = document.getElementById('btn-tiled');

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
    const overlay = document.getElementById('tiled-preview-canvas');
    if (overlay) overlay.style.display = 'none';
    // Tell fullscreen to exit tiled mode
    window.electronAPI.exitTiledMode?.();
  }
}

// Sync current tiled configuration to fullscreen window
export function syncTiledModeToFullscreen() {
  if (!state.tiledPreviewEnabled) return;

  // Build tile configuration with shader code and params
  const tiles = tileState.tiles.map((tile, index) => {
    if (!tile || tile.gridSlotIndex === null) {
      return { gridSlotIndex: null, shaderCode: null, params: null, visible: true };
    }

    const slotData = state.gridSlots[tile.gridSlotIndex];
    if (!slotData) {
      return { gridSlotIndex: tile.gridSlotIndex, shaderCode: null, params: null, visible: tile.visible };
    }

    // Merge slot and tile params
    const params = {
      speed: tile.params?.speed ?? slotData.params?.speed ?? 1,
      ...(slotData.customParams || {}),
      ...(tile.customParams || {})
    };

    return {
      gridSlotIndex: tile.gridSlotIndex,
      shaderCode: slotData.shaderCode,
      params,
      visible: tile.visible !== false
    };
  });

  const config = {
    layout: { ...tileState.layout },
    tiles
  };

  window.electronAPI.initTiledFullscreen?.(config);
}

// Initialize tile renderers for preview
function initTileRenderers() {
  cleanupTileRenderers();

  const { rows, cols } = tileState.layout;
  const tileCount = rows * cols;

  // Tiles share the slot's renderer to avoid WebGL context exhaustion
  // Each tile just stores its own params/customParams
  for (let i = 0; i < tileCount; i++) {
    const tile = tileState.tiles[i];
    if (tile && tile.gridSlotIndex !== null) {
      const slotData = state.gridSlots[tile.gridSlotIndex];
      if (slotData && slotData.renderer) {
        // Reference the slot's renderer (shared)
        state.tileRenderers[i] = slotData.renderer;
      } else {
        state.tileRenderers[i] = null;
      }
    } else {
      state.tileRenderers[i] = null;
    }
  }
}

// Cleanup tile renderers
function cleanupTileRenderers() {
  // Tiles share slot renderers, so just clear references (don't dispose)
  state.tileRenderers = [];
}

// Update a specific tile's renderer reference when assigned
export function updateTileRenderer(tileIndex) {
  if (!state.tiledPreviewEnabled) return;

  const tile = tileState.tiles[tileIndex];
  if (tile && tile.renderer) {
    // Each tile now has its own renderer
    state.tileRenderers[tileIndex] = tile.renderer;
  } else {
    state.tileRenderers[tileIndex] = null;
  }
}

// Refresh all tile renderers
export function refreshTileRenderers() {
  if (!state.tiledPreviewEnabled) return;
  initTileRenderers();
}
