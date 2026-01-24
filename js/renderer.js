// Main renderer entry point
import { state } from './state.js';
import { initEditor, compileShader } from './editor.js';
import { initControls, initResizer } from './controls.js';
import { initParams, initMouseAssignment, loadParamsToSliders, generateCustomParamUI } from './params.js';
import { initPresets } from './presets.js';
import { initShaderGrid } from './shader-grid.js';
import { initIPC } from './ipc.js';
import { restoreViewState } from './view-state.js';
import { sendNDIFrame } from './ndi.js';
import { sendSyphonFrame } from './syphon.js';
import { initTileConfig, showTileConfigDialog } from './tile-config.js';
import { tileState, calculateTileBounds } from './tile-state.js';
import { setStatus } from './utils.js';
import { updateLocalPresetsUI } from './presets.js';

// Initialize application
document.addEventListener('DOMContentLoaded', async () => {
  try {
    console.log('Starting initialization...');

    // Initialize editor first (creates initial tab with default shader)
    await initEditor();
    console.log('Editor initialized');

    initRenderer();
    console.log('Renderer initialized');

    initControls();
    console.log('Controls initialized');

    initParams();
    initMouseAssignment();
    initPresets();
    initResizer();
    initIPC();
    initShaderGrid();
    initTileConfig();

    // Compile the initial shader now that renderer is ready
    compileShader();

    // Restore saved view state
    await restoreViewState();

    // Cache DOM elements and start render loop
    cacheRenderLoopElements();
    renderLoop();
    console.log('Initialization complete');
  } catch (err) {
    console.error('Initialization error:', err);
  }
});

// IPC handler for opening tile config dialog from menu
window.electronAPI.onOpenTileConfig?.(() => {
  showTileConfigDialog();
});

function initRenderer() {
  const canvas = document.getElementById('shader-canvas');

  // Initialize shader renderer (always available)
  state.shaderRenderer = new ShaderRenderer(canvas);

  // Scene renderer will be initialized lazily when needed
  state.sceneRenderer = null;

  // Start with shader renderer as default
  state.renderer = state.shaderRenderer;
  state.renderMode = 'shader';

  // Set initial resolution
  const select = document.getElementById('resolution-select');
  const [width, height] = select.value.split('x').map(Number);
  state.shaderRenderer.setResolution(width, height);
}

// Lazy initialization of ThreeSceneRenderer (called when loading a scene file)
export function ensureSceneRenderer() {
  if (state.sceneRenderer) return state.sceneRenderer;

  const canvas = document.getElementById('shader-canvas');

  try {
    if (typeof ThreeSceneRenderer !== 'undefined' && window.THREE) {
      state.sceneRenderer = new ThreeSceneRenderer(canvas);
      state.sceneRenderer.setResolution(canvas.width, canvas.height);
      return state.sceneRenderer;
    } else {
      console.error('THREE.js not available for scene rendering');
      return null;
    }
  } catch (err) {
    console.error('Failed to initialize ThreeSceneRenderer:', err.message);
    return null;
  }
}

// Switch between shader and scene renderers
export function setRenderMode(mode) {
  // Guard: renderer may not be initialized yet during startup
  if (!state.shaderRenderer) {
    state.renderMode = mode;
    return;
  }

  if (mode === state.renderMode) return;

  state.renderMode = mode;

  if (mode === 'scene') {
    const sceneRenderer = ensureSceneRenderer();
    if (!sceneRenderer) {
      console.error('Cannot switch to scene mode - ThreeSceneRenderer not available');
      state.renderMode = 'shader';
      return;
    }
    state.renderer = sceneRenderer;
    state.editor.session.setMode('ace/mode/javascript');
  } else {
    state.renderer = state.shaderRenderer;
    state.editor.session.setMode('ace/mode/glsl');
  }

  const canvas = document.getElementById('shader-canvas');
  state.renderer.setResolution(canvas.width, canvas.height);
}

// Detect render mode from file extension or content
export function detectRenderMode(filename, content) {
  if (!filename) {
    if (content.includes('function setup') && content.includes('THREE')) {
      return 'scene';
    }
    if (content.includes('void mainImage') || content.includes('void main()')) {
      return 'shader';
    }
    return 'shader';
  }

  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'jsx' || (ext === 'js' && filename.includes('.scene.'))) {
    return 'scene';
  }
  if (ext === 'glsl' || ext === 'frag' || ext === 'vert') {
    return 'shader';
  }

  if (content && content.includes('function setup')) {
    return 'scene';
  }

  return 'shader';
}

// Preview frame rate limiting
let lastPreviewFrameTime = 0;

// Cache DOM elements for render loop (avoid querySelectorAll per frame)
let cachedFpsDisplay = null;
let cachedTimeDisplay = null;
let cachedFrameDisplay = null;

function cacheRenderLoopElements() {
  cachedFpsDisplay = document.getElementById('fps-display');
  cachedTimeDisplay = document.getElementById('time-display');
  cachedFrameDisplay = document.getElementById('frame-display');
}

function renderLoop(currentTime) {
  state.animationId = requestAnimationFrame(renderLoop);

  // Render if preview is enabled OR if NDI/Syphon needs frames
  const needsRender = state.previewEnabled || state.ndiEnabled || state.syphonEnabled;

  if (!needsRender) {
    // Still update time even when preview disabled (for fullscreen sync)
    state.renderer.updateTime();
    return;
  }

  // Apply frame rate limiting when fullscreen is active
  if (state.fullscreenActive && state.previewFrameInterval > 0) {
    if (currentTime - lastPreviewFrameTime < state.previewFrameInterval) {
      return;
    }
    lastPreviewFrameTime = currentTime;
  }

  let stats;

  // Check if tiled preview mode is enabled
  if (state.tiledPreviewEnabled && tileState.tiles.length > 0) {
    stats = renderTiledPreview();
  } else {
    stats = state.renderer.render();
  }

  if (stats && state.previewEnabled) {
    // Use cached DOM elements
    if (cachedFpsDisplay) cachedFpsDisplay.textContent = `FPS: ${stats.fps}`;
    if (cachedTimeDisplay) cachedTimeDisplay.textContent = `Time: ${stats.time.toFixed(2)}s`;
    if (cachedFrameDisplay) cachedFrameDisplay.textContent = `Frame: ${stats.frame}`;
  }

  // Send frame to NDI output if enabled (skip frames to reduce load)
  if (state.ndiEnabled && state.ndiFrameCounter % state.ndiFrameSkip === 0) {
    sendNDIFrame();
  }
  if (state.ndiEnabled) state.ndiFrameCounter++;

  // Send frame to Syphon output if enabled (skip frames to reduce load)
  if (state.syphonEnabled && state.syphonFrameCounter % state.syphonFrameSkip === 0) {
    sendSyphonFrame();
  }
  if (state.syphonEnabled) state.syphonFrameCounter++;
}

// Cache for tiled preview canvas
let tiledPreviewCanvas = null;
let tiledPreviewCtx = null;
let cachedTileBounds = null;  // Cache tile bounds for click detection

// Render tiled preview using MiniShaderRenderers from grid slots
function renderTiledPreview() {
  const mainCanvas = document.getElementById('shader-canvas');
  const canvasWidth = mainCanvas.width;
  const canvasHeight = mainCanvas.height;

  // Create or get the tiled preview overlay canvas
  if (!tiledPreviewCanvas) {
    tiledPreviewCanvas = document.createElement('canvas');
    tiledPreviewCanvas.id = 'tiled-preview-canvas';
    tiledPreviewCanvas.style.position = 'absolute';
    tiledPreviewCanvas.style.top = '0';
    tiledPreviewCanvas.style.left = '0';
    tiledPreviewCanvas.style.width = '100%';
    tiledPreviewCanvas.style.height = '100%';
    tiledPreviewCanvas.style.cursor = 'pointer';
    mainCanvas.parentElement.style.position = 'relative';
    mainCanvas.parentElement.appendChild(tiledPreviewCanvas);

    // Add click handler for tile selection
    tiledPreviewCanvas.addEventListener('click', handleTileClick);
  }

  // Sync canvas size
  if (tiledPreviewCanvas.width !== canvasWidth || tiledPreviewCanvas.height !== canvasHeight) {
    tiledPreviewCanvas.width = canvasWidth;
    tiledPreviewCanvas.height = canvasHeight;
  }

  // Get 2D context
  if (!tiledPreviewCtx) {
    tiledPreviewCtx = tiledPreviewCanvas.getContext('2d');
  }

  const ctx = tiledPreviewCtx;

  // Calculate tile bounds and cache for click detection
  const bounds = calculateTileBounds(canvasWidth, canvasHeight);
  cachedTileBounds = bounds;

  // Clear with gap color
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Get time info from main renderer
  const mainStats = state.renderer.getStats?.() || { time: 0, frame: 0, fps: 60 };

  // Render each tile
  for (let i = 0; i < bounds.length; i++) {
    const tile = tileState.tiles[i];
    const bound = bounds[i];

    // Convert WebGL coords (Y up) to canvas coords (Y down)
    const drawX = bound.x;
    const drawY = canvasHeight - bound.y - bound.height;

    if (!tile || tile.gridSlotIndex === null || !tile.visible) {
      // Empty tile - render dark background
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(drawX, drawY, bound.width, bound.height);

      // Draw tile number
      ctx.fillStyle = '#444';
      ctx.font = '14px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${i + 1}`, drawX + bound.width / 2, drawY + bound.height / 2);
      continue;
    }

    // Get the grid slot's MiniShaderRenderer
    const slotData = state.gridSlots[tile.gridSlotIndex];
    if (!slotData || !slotData.renderer) {
      // No renderer - render error placeholder
      ctx.fillStyle = '#2a1a1a';
      ctx.fillRect(drawX, drawY, bound.width, bound.height);
      continue;
    }

    // Render the mini shader with tile-specific params
    const miniRenderer = slotData.renderer;

    // Apply tile's speed param (or fall back to slot's params)
    const speed = tile.params?.speed ?? slotData.params?.speed ?? 1;
    miniRenderer.setSpeed(speed);

    miniRenderer.render();

    // Draw the mini canvas to the tile region
    const miniCanvas = miniRenderer.canvas;
    if (miniCanvas) {
      ctx.drawImage(miniCanvas, drawX, drawY, bound.width, bound.height);
    }
  }

  // Draw selection highlight on selected tile
  if (state.selectedTileIndex >= 0 && state.selectedTileIndex < bounds.length) {
    const selectedBound = bounds[state.selectedTileIndex];
    const selX = selectedBound.x;
    const selY = canvasHeight - selectedBound.y - selectedBound.height;

    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth = 3;
    ctx.strokeRect(selX + 1.5, selY + 1.5, selectedBound.width - 3, selectedBound.height - 3);

    // Draw tile number indicator
    ctx.fillStyle = '#ffaa00';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`Tile ${state.selectedTileIndex + 1}`, selX + 6, selY + 4);
  }

  // Show overlay canvas
  tiledPreviewCanvas.style.display = 'block';

  return mainStats;
}

// Handle click on tiled preview to select a tile
function handleTileClick(e) {
  if (!cachedTileBounds || !tiledPreviewCanvas) return;

  const rect = tiledPreviewCanvas.getBoundingClientRect();
  const scaleX = tiledPreviewCanvas.width / rect.width;
  const scaleY = tiledPreviewCanvas.height / rect.height;

  const clickX = (e.clientX - rect.left) * scaleX;
  const clickY = (e.clientY - rect.top) * scaleY;

  // Convert to WebGL coordinates (Y up)
  const canvasHeight = tiledPreviewCanvas.height;

  // Find which tile was clicked
  for (let i = 0; i < cachedTileBounds.length; i++) {
    const bound = cachedTileBounds[i];
    // Convert bound to canvas coords (Y down)
    const boundTop = canvasHeight - bound.y - bound.height;
    const boundBottom = canvasHeight - bound.y;

    if (clickX >= bound.x && clickX < bound.x + bound.width &&
        clickY >= boundTop && clickY < boundBottom) {
      selectTile(i);
      return;
    }
  }
}

// Select a tile and update UI
export function selectTile(tileIndex) {
  state.selectedTileIndex = tileIndex;

  // Update active grid slot to match the tile's assigned shader
  const tile = tileState.tiles[tileIndex];
  if (tile && tile.gridSlotIndex !== null) {
    const slotData = state.gridSlots[tile.gridSlotIndex];
    if (slotData) {
      // Update active slot highlight in grid
      if (state.activeGridSlot !== null) {
        const prevSlot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
        if (prevSlot) prevSlot.classList.remove('active');
      }

      state.activeGridSlot = tile.gridSlotIndex;
      const slot = document.querySelector(`.grid-slot[data-slot="${tile.gridSlotIndex}"]`);
      if (slot) slot.classList.add('active');

      // Temporarily disable tiled mode to prevent param routing loop
      const wasTiledEnabled = state.tiledPreviewEnabled;
      state.tiledPreviewEnabled = false;

      // Load speed param to slider (use tile's params if set, otherwise slot's params)
      const params = tile.params || slotData.params || {};
      loadParamsToSliders(params);

      // Load custom params to main renderer and regenerate UI
      if (slotData.customParams && state.renderer?.setCustomParamValues) {
        state.renderer.setCustomParamValues(slotData.customParams);
      }

      // Regenerate custom param UI for this shader
      generateCustomParamUI();

      // Re-enable tiled mode
      state.tiledPreviewEnabled = wasTiledEnabled;

      // Update local presets UI for this shader
      updateLocalPresetsUI();

      const name = slotData.filePath?.split('/').pop() || `Slot ${tile.gridSlotIndex + 1}`;
      setStatus(`Tile ${tileIndex + 1}: ${name}`, 'success');
    } else {
      setStatus(`Tile ${tileIndex + 1} (empty slot)`, 'success');
    }
  } else {
    setStatus(`Tile ${tileIndex + 1} (empty)`, 'success');
  }
}

// Hide tiled preview overlay
export function hideTiledPreviewOverlay() {
  if (tiledPreviewCanvas) {
    tiledPreviewCanvas.style.display = 'none';
  }
}

// Show tiled preview overlay
export function showTiledPreviewOverlay() {
  if (tiledPreviewCanvas) {
    tiledPreviewCanvas.style.display = 'block';
  }
}

// Update preview frame rate limiting based on fullscreen FPS
export function updatePreviewFrameLimit() {
  if (!state.fullscreenActive) {
    state.previewFrameInterval = 0;  // No limiting when fullscreen inactive
    return;
  }

  // If fullscreen is reaching target refresh rate, allow 60fps preview
  // Otherwise limit to 30fps to reduce GPU load
  const threshold = state.fullscreenTargetFps * 0.95;  // 95% of target
  if (state.fullscreenFps >= threshold) {
    state.previewFrameInterval = 1000 / 60;  // ~16.67ms for 60fps
  } else {
    state.previewFrameInterval = 1000 / 30;  // ~33.33ms for 30fps
  }
}
