// RenderLoop — main requestAnimationFrame loop with tiled preview, asset preview,
// and frame-sending for NDI / Syphon / Recording.
// Typed version of the render-loop portion of js/renderer.js (lines 208–652).

import { state } from './state.js';
import { tileState, calculateTileBounds } from '../tiles/tile-state.js';
import { MiniShaderRenderer } from '../renderers/mini-shader-renderer.js';
import { sendOutputFrames } from '../ipc/frame-sender.js';
import { createTaggedLogger, LOG_LEVEL } from '../../shared/logger.js';

import type { ParamValue } from '@shared/types/params.js';

// ---------------------------------------------------------------------------
// Window augmentation
// ---------------------------------------------------------------------------

declare const window: Window & {
  _previewTileDbg?: boolean;
};

import { isMixerActive, renderMixerComposite, hideMixerOverlay } from '../ui/mixer.js';
import { renderABFrame, hideABOverlay } from '../ui/ab-preview.js';
import { loadParamsToSliders, generateCustomParamUI } from '../ui/params.js';
import { updateLocalPresetsUI } from '../ui/presets.js';
import { setStatus } from '../ui/utils.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createTaggedLogger(LOG_LEVEL.WARN);

// ---------------------------------------------------------------------------
// Local interfaces (runtime shapes)
// ---------------------------------------------------------------------------

/** Stats returned from a render pass */
interface RenderStats {
  fps: number;
  time: number;
  frame: number;
}

/** Beat detector attached to the main renderer */
interface BeatDetectorLike {
  getBPM(): number;
}

/** Minimal main renderer surface used by the render loop */
interface MainRendererLike {
  render(): RenderStats;
  updateTime(): void;
  getStats?(): RenderStats;
  compile(source: string): void;
  setResolution(width: number, height: number): void;
  setCustomParamValues(params: Record<string, ParamValue>): void;
  beatDetector?: BeatDetectorLike | null;
}

/** Minimal MiniShaderRenderer surface used for tiled preview */
interface MiniRendererLike {
  renderDirect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void;
  setSpeed(speed: number): void;
  setParams(params: Record<string, ParamValue>): void;
  resetCustomParams?(): void;
}

/** Asset renderer surface used for asset preview */
interface AssetRendererLike {
  renderDirect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void;
}

/** Grid slot data (runtime shape) */
interface GridSlotLike {
  shaderCode?: string | null;
  filePath?: string | null;
  params?: Record<string, ParamValue> | null;
  customParams?: Record<string, ParamValue> | null;
  renderer?: MiniRendererLike | null;
  type?: string;
}

/** Tile bounds returned by calculateTileBounds */
interface TileBounds {
  tileIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Preview frame rate limiting
// ---------------------------------------------------------------------------

let lastPreviewFrameTime = 0;

// ---------------------------------------------------------------------------
// Cached DOM elements for the render loop (avoid querySelectorAll per frame)
// ---------------------------------------------------------------------------

let cachedFpsDisplay: HTMLElement | null = null;
let cachedTimeDisplay: HTMLElement | null = null;
let cachedFrameDisplay: HTMLElement | null = null;
let cachedChannelSlots: (HTMLElement | null)[] = [null, null, null, null];
let cachedShaderCanvas: HTMLCanvasElement | null = null;
let lastStatsDomUpdate = 0;
let lastFpsText = '';
let lastTimeText = '';
let lastFrameText = '';
let lastBpmText = '';

const STATS_DOM_UPDATE_INTERVAL = 250;

// Tile bounds cache — avoids recalculating every frame
let _cachedPreviewTileBounds: TileBounds[] | null = null;
let _cachedPreviewTileW = 0;
let _cachedPreviewTileH = 0;
let _cachedPreviewTileCount = 0;

export function cacheRenderLoopElements(): void {
  cachedFpsDisplay = document.getElementById('fps-display');
  cachedTimeDisplay = document.getElementById('time-display');
  cachedFrameDisplay = document.getElementById('frame-display');
  cachedShaderCanvas = document.getElementById('shader-canvas') as HTMLCanvasElement | null;
  for (let i = 0; i < 4; i++) {
    cachedChannelSlots[i] = document.getElementById(`channel-${i}`);
  }
}


// ---------------------------------------------------------------------------
// Main render loop (requestAnimationFrame callback)
// ---------------------------------------------------------------------------

export function renderLoop(currentTime: DOMHighResTimeStamp): void {
  state.animationId = requestAnimationFrame(renderLoop);

  // Render if preview is enabled OR if NDI/Syphon/Recording needs frames
  const needsRender =
    state.previewEnabled ||
    state.ndiEnabled ||
    state.syphonEnabled ||
    state.recordingEnabled;

  if (!needsRender) {
    // Still update time even when preview disabled (for fullscreen sync)
    (state.renderer as MainRendererLike).updateTime();
    return;
  }

  // Apply frame rate limiting when fullscreen is active
  // (never while recording — FFmpeg expects a constant 60 fps on its pipe
  // input; throttling to 30 fps would make recordings play back too fast)
  if (state.fullscreenActive && state.previewFrameInterval > 0 && !state.recordingEnabled) {
    if (currentTime - lastPreviewFrameTime < state.previewFrameInterval) {
      return;
    }
    lastPreviewFrameTime = currentTime;
  }

  let stats: RenderStats | undefined;

  // Check A/B first, then tiled, then mixer, then normal
  try {
    if (state.abEnabled) {
      stats = renderABFrame();
      // AB handles hiding other overlays internally
    } else if (state.tiledPreviewEnabled && tileState.tiles.length > 0) {
      stats = renderTiledPreview();
      hideMixerOverlay();
      hideAssetOverlay();
      hideABOverlay();
    } else if (isMixerActive()) {
      stats = renderMixerComposite();
      hideAssetOverlay();
      hideABOverlay();
    } else if (state.renderMode === 'asset' && state.activeAsset) {
      stats = renderAssetPreview();
      hideABOverlay();
    } else {
      stats = (state.renderer as MainRendererLike).render();
      hideMixerOverlay();
      hideAssetOverlay();
      hideABOverlay();
    }
  } catch (err) {
    log.error('Renderer', 'Render error:', err);
  }

  if (stats && state.previewEnabled && currentTime - lastStatsDomUpdate >= STATS_DOM_UPDATE_INTERVAL) {
    lastStatsDomUpdate = currentTime;

    // Use cached DOM elements and avoid redundant text writes.
    const fpsText = `FPS: ${stats.fps}`;
    const timeText = `Time: ${stats.time.toFixed(2)}s`;
    const frameText = `Frame: ${stats.frame}`;
    if (cachedFpsDisplay && fpsText !== lastFpsText) {
      cachedFpsDisplay.textContent = fpsText;
      lastFpsText = fpsText;
    }
    if (cachedTimeDisplay && timeText !== lastTimeText) {
      cachedTimeDisplay.textContent = timeText;
      lastTimeText = timeText;
    }
    if (cachedFrameDisplay && frameText !== lastFrameText) {
      cachedFrameDisplay.textContent = frameText;
      lastFrameText = frameText;
    }

    // Update BPM display on audio channel slots
    const bd = (state.renderer as MainRendererLike).beatDetector;
    if (bd) {
      const bpmText = String(Math.round(bd.getBPM()));
      if (bpmText !== lastBpmText) {
        for (let i = 0; i < 4; i++) {
          const slot = cachedChannelSlots[i];
          if (slot && slot.classList.contains('has-audio')) {
            slot.textContent = bpmText;
          }
        }
        lastBpmText = bpmText;
      }
    }
  }

  // Capture once per rendered frame, then fan the same pixels out to all due outputs.
  const sendNDI = state.ndiEnabled && state.ndiFrameCounter % state.ndiFrameSkip === 0;
  const sendSyphon = state.syphonEnabled && state.syphonFrameCounter % state.syphonFrameSkip === 0;
  const sendRecording = state.recordingEnabled && state.recordingFrameCounter % state.recordingFrameSkip === 0;
  if (sendNDI || sendSyphon || sendRecording) {
    sendOutputFrames({
      ndi: sendNDI,
      syphon: sendSyphon,
      recording: sendRecording,
    });
  }

  // Update output frame counters after scheduling capture.
  if (state.ndiEnabled) state.ndiFrameCounter++;
  if (state.syphonEnabled) state.syphonFrameCounter++;
  if (state.recordingEnabled) state.recordingFrameCounter++;
}

// ---------------------------------------------------------------------------
// Asset preview overlay
// ---------------------------------------------------------------------------

let assetOverlayCanvas: HTMLCanvasElement | null = null;
let assetOverlayCtx: CanvasRenderingContext2D | null = null;

function renderAssetPreview(): RenderStats {
  const mainCanvas = cachedShaderCanvas || (cachedShaderCanvas = document.getElementById('shader-canvas') as HTMLCanvasElement);
  const canvasWidth = mainCanvas.width;
  const canvasHeight = mainCanvas.height;

  if (!assetOverlayCanvas) {
    assetOverlayCanvas = document.createElement('canvas');
    assetOverlayCanvas.id = 'asset-overlay-canvas';
    assetOverlayCanvas.style.cssText =
      'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);max-width:100%;max-height:100%';
    (mainCanvas.parentElement as HTMLElement).style.position = 'relative';
    (mainCanvas.parentElement as HTMLElement).appendChild(assetOverlayCanvas);
  }

  if (
    assetOverlayCanvas.width !== canvasWidth ||
    assetOverlayCanvas.height !== canvasHeight
  ) {
    assetOverlayCanvas.width = canvasWidth;
    assetOverlayCanvas.height = canvasHeight;
    assetOverlayCtx = null;
  }

  if (!assetOverlayCtx) {
    assetOverlayCtx = assetOverlayCanvas.getContext('2d');
  }

  const ctx = assetOverlayCtx!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const asset = state.activeAsset;
  if (asset && asset.renderer) {
    (asset.renderer as AssetRendererLike).renderDirect(
      ctx,
      0,
      0,
      canvasWidth,
      canvasHeight,
    );
  }

  assetOverlayCanvas.style.display = 'block';
  hideMixerOverlay();

  // Return stats from main renderer for FPS display
  return (
    (state.renderer as MainRendererLike).getStats?.() || {
      fps: 60,
      time: 0,
      frame: 0,
    }
  );
}

export function hideAssetOverlay(): void {
  if (assetOverlayCanvas) {
    assetOverlayCanvas.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Tiled preview overlay
// ---------------------------------------------------------------------------

let tiledPreviewCanvas: HTMLCanvasElement | null = null;
let tiledPreviewCtx: CanvasRenderingContext2D | null = null;
let cachedTileBounds: TileBounds[] | null = null;
let tiledCtxInitialized = false;

/**
 * Render tiled preview using MiniShaderRenderers from grid slots.
 * OPTIMIZED: Avoids per-frame canvas resizing and reduces GPU->CPU syncs.
 */
function renderTiledPreview(): RenderStats {
  const mainCanvas = cachedShaderCanvas || (cachedShaderCanvas = document.getElementById('shader-canvas') as HTMLCanvasElement);
  const canvasWidth = mainCanvas.width;
  const canvasHeight = mainCanvas.height;

  // Create or get the tiled preview overlay canvas
  if (!tiledPreviewCanvas) {
    tiledPreviewCanvas = document.createElement('canvas');
    tiledPreviewCanvas.id = 'tiled-preview-canvas';
    tiledPreviewCanvas.style.position = 'absolute';
    tiledPreviewCanvas.style.top = '50%';
    tiledPreviewCanvas.style.left = '50%';
    tiledPreviewCanvas.style.transform = 'translate(-50%, -50%)';
    tiledPreviewCanvas.style.maxWidth = '100%';
    tiledPreviewCanvas.style.maxHeight = '100%';
    tiledPreviewCanvas.style.cursor = 'pointer';
    (mainCanvas.parentElement as HTMLElement).style.position = 'relative';
    (mainCanvas.parentElement as HTMLElement).appendChild(tiledPreviewCanvas);

    // Add click handler for tile selection
    tiledPreviewCanvas.addEventListener('click', handleTileClick);
  }

  // Sync canvas size (reset context initialization flag if size changed)
  if (
    tiledPreviewCanvas.width !== canvasWidth ||
    tiledPreviewCanvas.height !== canvasHeight
  ) {
    tiledPreviewCanvas.width = canvasWidth;
    tiledPreviewCanvas.height = canvasHeight;
    tiledPreviewCtx = null;
    tiledCtxInitialized = false;
  }

  // Get 2D context
  if (!tiledPreviewCtx) {
    tiledPreviewCtx = tiledPreviewCanvas.getContext('2d');
    tiledCtxInitialized = false;
  }

  const ctx = tiledPreviewCtx!;

  // Initialize 2D context properties once (avoid per-frame font parsing)
  if (!tiledCtxInitialized) {
    ctx.font = '14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    tiledCtxInitialized = true;
  }

  // Calculate tile bounds (cached, recalculated only on size/layout change)
  const tileCount = tileState.tiles.length;
  if (!_cachedPreviewTileBounds || _cachedPreviewTileW !== canvasWidth || _cachedPreviewTileH !== canvasHeight || _cachedPreviewTileCount !== tileCount) {
    _cachedPreviewTileBounds = calculateTileBounds(canvasWidth, canvasHeight);
    _cachedPreviewTileW = canvasWidth;
    _cachedPreviewTileH = canvasHeight;
    _cachedPreviewTileCount = tileCount;
  }
  const bounds = _cachedPreviewTileBounds;
  cachedTileBounds = bounds;

  // OPTIMIZATION: Find max tile dimensions and ensure shared canvas is sized once
  let maxTileWidth = 0;
  let maxTileHeight = 0;
  for (const bound of bounds) {
    if (bound.width > maxTileWidth) maxTileWidth = bound.width;
    if (bound.height > maxTileHeight) maxTileHeight = bound.height;
  }
  // Ensure shared WebGL canvas is large enough for all tiles (avoids per-tile resizing)
  MiniShaderRenderer.ensureSharedCanvasSize(maxTileWidth, maxTileHeight);

  // Clear with gap color
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Get time info from main renderer
  const mainStats: RenderStats =
    (state.renderer as MainRendererLike).getStats?.() || {
      time: 0,
      frame: 0,
      fps: 60,
    };

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

      // Draw tile number (font already set)
      ctx.fillStyle = '#444';
      ctx.fillText(
        `${i + 1}`,
        drawX + bound.width / 2,
        drawY + bound.height / 2,
      );
      continue;
    }

    // Get the slot's MiniShaderRenderer (shared, but we apply tile-specific params)
    const slotData = (state.gridSlots as GridSlotLike[])[tile.gridSlotIndex];
    if (!slotData || !slotData.renderer) {
      // No renderer - render error placeholder
      ctx.fillStyle = '#2a1a1a';
      ctx.fillRect(drawX, drawY, bound.width, bound.height);
      continue;
    }

    // Use slot's renderer but apply tile-specific params before rendering
    const miniRenderer = slotData.renderer;

    try {
      // Reset custom params to defaults before applying tile-specific ones
      if (miniRenderer.resetCustomParams) {
        miniRenderer.resetCustomParams();
      }

      // Apply tile's params (speed and custom params)
      const speed =
        (tile.params as Record<string, ParamValue> | null)?.speed ??
        slotData.params?.speed ??
        1;
      miniRenderer.setSpeed(speed as number);

      // Apply slot's custom params, then tile's overrides (tile takes precedence)
      // Avoids object spread allocation per tile per frame
      const slotCustom = slotData.customParams as Record<string, ParamValue> | null;
      const tileCustom = tile.customParams as Record<string, ParamValue> | null;
      if (slotCustom) miniRenderer.setParams(slotCustom);
      if (tileCustom) miniRenderer.setParams(tileCustom);

      // Debug: log tile info once
      if (!window._previewTileDbg) {
        log.debug(
          'Renderer',
          `Preview tile ${i}: canvas=${canvasWidth}x${canvasHeight}, bound=(${bound.x},${bound.y},${bound.width},${bound.height}), draw=(${drawX},${drawY})`,
        );
      }

      // OPTIMIZED: Use renderDirect to avoid canvas resizing per tile
      // This renders directly to the overlay context without thrashing shared canvas size
      miniRenderer.renderDirect(ctx, drawX, drawY, bound.width, bound.height);
    } catch (err) {
      log.error('Renderer', `Tile ${i} render error:`, err);
      ctx.fillStyle = '#3a1a1a';
      ctx.fillRect(drawX, drawY, bound.width, bound.height);
      ctx.fillStyle = '#ff6666';
      ctx.fillText(
        'Error',
        drawX + bound.width / 2,
        drawY + bound.height / 2,
      );
    }
  }

  // Draw selection highlight on selected tile
  if (
    state.selectedTileIndex >= 0 &&
    state.selectedTileIndex < bounds.length
  ) {
    const selectedBound = bounds[state.selectedTileIndex];
    const selX = selectedBound.x;
    const selY = canvasHeight - selectedBound.y - selectedBound.height;

    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth = 3;
    ctx.strokeRect(
      selX + 1.5,
      selY + 1.5,
      selectedBound.width - 3,
      selectedBound.height - 3,
    );

    // Draw tile number indicator (use save/restore to avoid per-frame font state thrashing)
    ctx.save();
    ctx.fillStyle = '#ffaa00';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(
      `Tile ${state.selectedTileIndex + 1}`,
      selX + 6,
      selY + 4,
    );
    ctx.restore();
  }

  // Show overlay canvas
  tiledPreviewCanvas.style.display = 'block';

  window._previewTileDbg = true; // Only log once

  return mainStats;
}

// ---------------------------------------------------------------------------
// Tile click handling
// ---------------------------------------------------------------------------

function handleTileClick(e: MouseEvent): void {
  if (!cachedTileBounds || !tiledPreviewCanvas) return;

  const rect = tiledPreviewCanvas.getBoundingClientRect();
  const scaleX = tiledPreviewCanvas.width / rect.width;
  const scaleY = tiledPreviewCanvas.height / rect.height;

  const clickX = (e.clientX - rect.left) * scaleX;
  const clickY = (e.clientY - rect.top) * scaleY;

  // Convert to canvas coordinates for hit testing
  const canvasHeight = tiledPreviewCanvas.height;

  // Find which tile was clicked
  for (let i = 0; i < cachedTileBounds.length; i++) {
    const bound = cachedTileBounds[i];
    // Convert bound to canvas coords (Y down)
    const boundTop = canvasHeight - bound.y - bound.height;
    const boundBottom = canvasHeight - bound.y;

    if (
      clickX >= bound.x &&
      clickX < bound.x + bound.width &&
      clickY >= boundTop &&
      clickY < boundBottom
    ) {
      selectTile(i);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Tile selection
// ---------------------------------------------------------------------------

export function selectTile(tileIndex: number): void {
  state.selectedTileIndex = tileIndex;

  // Update active grid slot to match the tile's assigned shader
  const tile = tileState.tiles[tileIndex];
  if (tile && tile.gridSlotIndex !== null) {
    const slotData = (state.gridSlots as GridSlotLike[])[tile.gridSlotIndex];
    if (slotData) {
      // Update active slot highlight in grid
      if (state.activeGridSlot !== null) {
        const prevSlot = document.querySelector(
          `.grid-slot[data-slot="${state.activeGridSlot}"]`,
        );
        if (prevSlot) prevSlot.classList.remove('active');
      }

      state.activeGridSlot = tile.gridSlotIndex;
      const slot = document.querySelector(
        `.grid-slot[data-slot="${tile.gridSlotIndex}"]`,
      );
      if (slot) slot.classList.add('active');

      // Temporarily disable tiled mode to prevent param routing loop
      const wasTiledEnabled = state.tiledPreviewEnabled;
      state.tiledPreviewEnabled = false;

      // Compile the shader to state.renderer so we can read @param definitions
      const isScene = slotData.type === 'scene';
      if (!isScene && slotData.shaderCode) {
        try {
          (state.renderer as MainRendererLike).compile(slotData.shaderCode);
        } catch (err) {
          log.warn(
            'Renderer',
            'Failed to compile shader for param UI:',
            (err as Error).message,
          );
        }
      }

      // Load speed param to slider (use tile's own params, fallback to slot's params)
      const params: Record<string, ParamValue> =
        (tile.params as Record<string, ParamValue> | null) ||
        slotData.params ||
        {};
      loadParamsToSliders(params);

      // Load custom params to main renderer (use tile's own customParams, fallback to slot's)
      const customParams =
        (tile.customParams as Record<string, ParamValue> | null) ||
        slotData.customParams;
      if (customParams && (state.renderer as MainRendererLike).setCustomParamValues) {
        (state.renderer as MainRendererLike).setCustomParamValues(customParams);
      }

      // Regenerate custom param UI for this shader
      generateCustomParamUI();

      // Re-enable tiled mode
      state.tiledPreviewEnabled = wasTiledEnabled;

      // Update local presets UI for this shader
      updateLocalPresetsUI();

      const name =
        slotData.filePath?.split('/').pop()?.split('\\').pop() ||
        `Slot ${tile.gridSlotIndex + 1}`;
      setStatus(`Tile ${tileIndex + 1}: ${name}`, 'success');
    } else {
      setStatus(`Tile ${tileIndex + 1} (empty slot)`, 'success');
    }
  } else {
    setStatus(`Tile ${tileIndex + 1} (empty)`, 'success');
  }
}

// ---------------------------------------------------------------------------
// Adaptive preview frame rate limiting
// ---------------------------------------------------------------------------

export function updatePreviewFrameLimit(): void {
  if (!state.fullscreenActive) {
    state.previewFrameInterval = 0; // No limiting when fullscreen inactive
    return;
  }

  // Steady 30 fps while the show output runs. The previous reactive scheme
  // (60 fps whenever fullscreen hit its target) oscillated: preview load made
  // fullscreen miss frames, throttle kicked in, fullscreen recovered, preview
  // sped up again — visible as periodic stutter in the output.
  state.previewFrameInterval = 1000 / 30;
}
