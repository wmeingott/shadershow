// Main renderer entry point
import { state } from './state.js';
import { initEditor, compileShader } from './editor.js';
import { initControls, initResizer } from './controls.js';
import { initParams, initMouseAssignment } from './params.js';
import { initPresets } from './presets.js';
import { initShaderGrid } from './shader-grid.js';
import { initIPC } from './ipc.js';
import { restoreViewState } from './view-state.js';
import { sendNDIFrame } from './ndi.js';
import { sendSyphonFrame } from './syphon.js';
import { initTileConfig, showTileConfigDialog } from './tile-config.js';
import { tileState, calculateTileBounds } from './tile-state.js';

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
    tiledPreviewCanvas.style.pointerEvents = 'none';
    mainCanvas.parentElement.style.position = 'relative';
    mainCanvas.parentElement.appendChild(tiledPreviewCanvas);
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

  // Calculate tile bounds
  const bounds = calculateTileBounds(canvasWidth, canvasHeight);

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

    // Render the mini shader
    const miniRenderer = slotData.renderer;
    miniRenderer.render();

    // Draw the mini canvas to the tile region
    const miniCanvas = miniRenderer.canvas;
    if (miniCanvas) {
      ctx.drawImage(miniCanvas, drawX, drawY, bound.width, bound.height);
    }
  }

  // Show overlay canvas
  tiledPreviewCanvas.style.display = 'block';

  return mainStats;
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
