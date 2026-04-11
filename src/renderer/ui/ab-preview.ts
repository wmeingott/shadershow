// A/B Preview Crossfade — side-by-side preview with crossfade slider.
// Each side has its own renderer (shader, scene, or composition).
// A 2D overlay canvas composites both sides based on the crossfade value
// for output to fullscreen/NDI/recording.

import { state } from '../core/state.js';
import { MiniShaderRenderer } from '../renderers/mini-shader-renderer.js';
import { ThreeSceneRenderer } from '../renderers/three-scene-renderer.js';
import { loadFileTexturesForRenderer } from '../grid/grid-renderer.js';
import { hideMixerOverlay, recallMixState, snapshotMixerState } from './mixer.js';
import { hideAssetOverlay } from '../core/render-loop.js';
import { loadParamsToSliders, generateCustomParamUI } from './params.js';
import { tilingValues, isTilingFixed, setOnTilingChanged } from './tiling.js';

import type { ParamDef, ParamValue } from '@shared/types/params.js';
import { parseShaderParams } from '@shared/param-parser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MiniRendererLike {
  compile(source: string): void;
  renderDirect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void;
  setSpeed(speed: number): void;
  setParams(params: Record<string, ParamValue>): void;
  setParam?(name: string, value: ParamValue): void;
  getCustomParamDefs?(): ParamDef[];
  getCustomParamValues?(): Record<string, ParamValue>;
  customParamValues: Record<string, ParamValue>;
  dispose?(): void;
}

interface MainRendererLike {
  getStats?(): { fps: number; time: number; frame: number };
}

interface TilingSnapshot {
  cols: number; rows: number;
  spaceX: number; spaceY: number;
  bgR: number; bgG: number; bgB: number;
}

export interface ABSide {
  renderer: MiniRendererLike | null;
  shaderCode: string | null;
  params: Record<string, ParamValue>;
  customParams: Record<string, ParamValue>;
  paramDefs: ParamDef[];
  tiling: TilingSnapshot;
  renderMode: 'shader' | 'scene' | 'composition';
  slotIndex: number | null;
  tabIndex: number | null;
  /** Stored composition data for rebuilding mixer panel on side switch */
  compositionPreset: { name: string; blendMode: string; channels: ABCompositionChannel[] } | null;
}

// ---------------------------------------------------------------------------
// Scene adapter — wraps ThreeSceneRenderer to match MiniRendererLike
// ---------------------------------------------------------------------------

class SceneABAdapter {
  private sceneRenderer: ThreeSceneRenderer;
  private sceneCanvas: HTMLCanvasElement;
  customParamValues: Record<string, ParamValue> = {};

  constructor() {
    this.sceneCanvas = document.createElement('canvas');
    this.sceneCanvas.width = 320;
    this.sceneCanvas.height = 180;
    this.sceneCanvas.style.display = 'none';
    document.body.appendChild(this.sceneCanvas);
    this.sceneRenderer = new ThreeSceneRenderer(this.sceneCanvas);
  }

  compile(source: string): void {
    this.sceneRenderer.compile(source);
  }

  getCustomParamDefs(): ParamDef[] {
    return this.sceneRenderer.getCustomParamDefs();
  }

  getCustomParamValues(): Record<string, ParamValue> {
    return this.sceneRenderer.getCustomParamValues() as Record<string, ParamValue>;
  }

  renderDirect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    if (this.sceneCanvas.width !== w || this.sceneCanvas.height !== h) {
      this.sceneCanvas.width = w;
      this.sceneCanvas.height = h;
      this.sceneRenderer.setResolution(w, h);
    }
    this.sceneRenderer.render();
    ctx.drawImage(this.sceneCanvas, x, y, w, h);
  }

  setSpeed(speed: number): void {
    this.sceneRenderer.setParams({ speed });
  }

  setParams(params: Record<string, ParamValue>): void {
    this.sceneRenderer.setParams(params);
    this.customParamValues = { ...params };
  }

  setParam(name: string, value: ParamValue): void {
    this.sceneRenderer.setParams({ [name]: value });
    this.customParamValues[name] = value;
  }

  dispose(): void {
    this.sceneRenderer.dispose();
    this.sceneCanvas.remove();
  }
}

// ---------------------------------------------------------------------------
// Composition adapter — wraps multiple MiniShaderRenderers + compositing
// ---------------------------------------------------------------------------

interface CompositionChannelData {
  shaderCode: string;
  alpha: number;
  params: Record<string, ParamValue>;
  customParams: Record<string, ParamValue>;
}

interface CompositionChannel {
  renderer: MiniShaderRenderer;
  alpha: number;
  shaderCode: string;
}

class CompositionABAdapter {
  private channels: CompositionChannel[] = [];
  private compCanvas: HTMLCanvasElement;
  private compCtx: CanvasRenderingContext2D | null = null;
  private blendMode: GlobalCompositeOperation = 'lighter';
  customParamValues: Record<string, ParamValue> = {};

  constructor() {
    this.compCanvas = document.createElement('canvas');
    this.compCanvas.width = 1;
    this.compCanvas.height = 1;
  }

  compile(_source: string): void {
    // No-op for composition; channels are set up via setupChannels
  }

  setupChannels(channelData: CompositionChannelData[], blendMode: string): void {
    this.disposeChannels();
    this.blendMode = blendMode as GlobalCompositeOperation;

    for (const ch of channelData) {
      if (!ch.shaderCode) continue;
      const canvas = createHiddenCanvas();
      const renderer = new MiniShaderRenderer(canvas, { enableEffects: true });
      try {
        renderer.compile(ch.shaderCode);
        loadFileTexturesForRenderer(renderer as unknown as Parameters<typeof loadFileTexturesForRenderer>[0]);
      } catch { continue; }
      if (ch.params?.speed !== undefined) renderer.setSpeed(ch.params.speed as number);
      if (ch.customParams && Object.keys(ch.customParams).length > 0) {
        renderer.setParams(ch.customParams);
      }
      this.channels.push({
        renderer,
        alpha: ch.alpha ?? 1.0,
        shaderCode: ch.shaderCode,
      });
    }
  }

  renderDirect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    if (this.compCanvas.width !== w || this.compCanvas.height !== h) {
      this.compCanvas.width = w;
      this.compCanvas.height = h;
      this.compCtx = null;
    }
    if (!this.compCtx) this.compCtx = this.compCanvas.getContext('2d');
    const compCtx = this.compCtx!;

    // Clear to black
    compCtx.globalCompositeOperation = 'source-over';
    compCtx.fillStyle = '#000';
    compCtx.fillRect(0, 0, w, h);
    compCtx.globalCompositeOperation = this.blendMode;

    MiniShaderRenderer.ensureSharedCanvasSize(w, h);

    // Render each channel with its alpha
    for (const ch of this.channels) {
      if (ch.alpha <= 0) continue;
      compCtx.globalAlpha = ch.alpha;
      try {
        (ch.renderer as unknown as MiniRendererLike).renderDirect(compCtx, 0, 0, w, h);
      } catch { /* ignore */ }
    }

    compCtx.globalAlpha = 1.0;
    compCtx.globalCompositeOperation = 'source-over';

    // Blit composition to target
    ctx.drawImage(this.compCanvas, x, y, w, h);
  }

  setSpeed(speed: number): void {
    for (const ch of this.channels) ch.renderer.setSpeed(speed);
  }

  setParams(params: Record<string, ParamValue>): void {
    this.customParamValues = { ...params };
  }

  setParam(name: string, value: ParamValue): void {
    this.customParamValues[name] = value;
  }

  private disposeChannels(): void {
    for (const ch of this.channels) ch.renderer.dispose();
    this.channels = [];
  }

  dispose(): void {
    this.disposeChannels();
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let sideA: ABSide = createEmptySide();
let sideB: ABSide = createEmptySide();

let abOverlayCanvas: HTMLCanvasElement | null = null;
let abOverlayCtx: CanvasRenderingContext2D | null = null;

// Side-by-side preview canvases (for visual display in preview panel)
let previewCanvasA: HTMLCanvasElement | null = null;
let previewCanvasB: HTMLCanvasElement | null = null;
let previewCtxA: CanvasRenderingContext2D | null = null;
let previewCtxB: CanvasRenderingContext2D | null = null;

const DEFAULT_TILING: TilingSnapshot = { cols: 1, rows: 1, spaceX: 0, spaceY: 0, bgR: 0, bgG: 0, bgB: 0 };

function createEmptySide(): ABSide {
  return {
    renderer: null,
    shaderCode: null,
    params: {},
    customParams: {},
    paramDefs: [],
    tiling: { ...DEFAULT_TILING },
    renderMode: 'shader',
    slotIndex: null,
    tabIndex: null,
    compositionPreset: null,
  };
}

function snapshotTiling(): TilingSnapshot {
  return { cols: tilingValues.cols, rows: tilingValues.rows, spaceX: tilingValues.spaceX, spaceY: tilingValues.spaceY, bgR: tilingValues.bgR, bgG: tilingValues.bgG, bgB: tilingValues.bgB };
}

function applyTiling(t: TilingSnapshot): void {
  tilingValues.cols = t.cols; tilingValues.rows = t.rows;
  tilingValues.spaceX = t.spaceX; tilingValues.spaceY = t.spaceY;
  tilingValues.bgR = t.bgR; tilingValues.bgG = t.bgG; tilingValues.bgB = t.bgB;
}

function tilingFromParams(params: Record<string, ParamValue>): TilingSnapshot {
  const bgHex = (params.tilingBg as unknown as string) || '#000000';
  const r = parseInt(bgHex.slice(1, 3), 16) / 255 || 0;
  const g = parseInt(bgHex.slice(3, 5), 16) / 255 || 0;
  const b = parseInt(bgHex.slice(5, 7), 16) / 255 || 0;
  return {
    cols: (params.cols as number) || 1,
    rows: (params.rows as number) || 1,
    spaceX: (params.spaceX as number) || 0,
    spaceY: (params.spaceY as number) || 0,
    bgR: r, bgG: g, bgB: b,
  };
}

function createHiddenCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 1;
  c.style.display = 'none';
  return c;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initABPreview(): void {
  // Create renderers for each side (with hidden canvases — we use renderDirect)
  sideA.renderer = new MiniShaderRenderer(createHiddenCanvas(), { enableEffects: true }) as unknown as MiniRendererLike;
  sideB.renderer = new MiniShaderRenderer(createHiddenCanvas(), { enableEffects: true }) as unknown as MiniRendererLike;
}

// ---------------------------------------------------------------------------
// Loading shaders/scenes to sides
// ---------------------------------------------------------------------------

export function loadShaderToSide(
  side: 'a' | 'b',
  code: string,
  params: Record<string, ParamValue>,
  customParams: Record<string, ParamValue>,
  renderMode: 'shader' | 'scene',
  slotIndex: number | null,
  tabIndex: number | null,
): void {
  const target = side === 'a' ? sideA : sideB;

  target.shaderCode = code;
  target.params = { ...params };
  target.customParams = { ...customParams };
  target.slotIndex = slotIndex;
  target.tabIndex = tabIndex;

  // Capture tiling from slot params (unless Fix is checked)
  if (!isTilingFixed()) {
    target.tiling = tilingFromParams(params);
  } else {
    target.tiling = snapshotTiling();
  }

  // If render mode changed, dispose old renderer and create appropriate one
  if (renderMode !== target.renderMode || !target.renderer) {
    if (target.renderer?.dispose) target.renderer.dispose();
    target.renderer = null;
  }
  target.renderMode = renderMode;

  const needsScene = renderMode === 'scene';
  const isScene = target.renderer instanceof SceneABAdapter;
  const isShader = target.renderer instanceof MiniShaderRenderer;

  if (needsScene && !isScene) {
    // Switch from shader renderer to scene adapter
    if (!(window as any).THREE) {
      console.warn('[AB] Three.js not loaded, cannot load scene to A/B side');
      return;
    }
    if (target.renderer?.dispose) target.renderer.dispose();
    target.renderer = new SceneABAdapter() as unknown as MiniRendererLike;
  } else if (!needsScene && !isShader) {
    // Switch from scene adapter to shader renderer
    if (target.renderer?.dispose) target.renderer.dispose();
    target.renderer = new MiniShaderRenderer(createHiddenCanvas(), { enableEffects: true }) as unknown as MiniRendererLike;
  } else if (!target.renderer) {
    // No renderer yet — create the right type
    if (needsScene) {
      if (!(window as any).THREE) {
        console.warn('[AB] Three.js not loaded, cannot load scene to A/B side');
        return;
      }
      target.renderer = new SceneABAdapter() as unknown as MiniRendererLike;
    } else {
      target.renderer = new MiniShaderRenderer(createHiddenCanvas(), { enableEffects: true }) as unknown as MiniRendererLike;
    }
  }

  // Parse param defs from source code (works for both shaders and scenes)
  target.paramDefs = parseShaderParams(code);

  try {
    target.renderer.compile(code);
    // Load file textures (only for shader mode; scenes handle their own)
    if (renderMode !== 'scene') {
      loadFileTexturesForRenderer(target.renderer as unknown as Parameters<typeof loadFileTexturesForRenderer>[0]);
    }
  } catch (err) {
    console.warn(`[AB] Failed to compile for side ${side}:`, err);
  }

  // Apply params
  if (params.speed !== undefined) {
    target.renderer.setSpeed(params.speed as number);
  }
  if (customParams && Object.keys(customParams).length > 0) {
    target.renderer.setParams(customParams);
  }

  // Send to fullscreen
  sendABShaderUpdate(side);
}

// ---------------------------------------------------------------------------
// Loading compositions to sides
// ---------------------------------------------------------------------------

export interface ABCompositionChannel {
  shaderCode: string | null;
  alpha: number;
  params: Record<string, ParamValue>;
  customParams: Record<string, ParamValue>;
  enabled: boolean;
}

export function loadCompositionToSide(
  side: 'a' | 'b',
  channels: ABCompositionChannel[],
  blendMode: string,
): void {
  const target = side === 'a' ? sideA : sideB;

  // Dispose old renderer
  if (target.renderer?.dispose) target.renderer.dispose();

  target.renderMode = 'composition';
  target.shaderCode = '[composition]'; // Marker so renderABFrame knows this side is active
  target.params = {};
  target.customParams = {};
  target.paramDefs = []; // Compositions don't have unified param defs
  target.tiling = isTilingFixed() ? snapshotTiling() : { ...DEFAULT_TILING };
  target.slotIndex = null;
  target.tabIndex = null;

  const adapter = new CompositionABAdapter();
  const channelData: CompositionChannelData[] = channels
    .filter(ch => ch.enabled !== false && ch.shaderCode)
    .map(ch => ({
      shaderCode: ch.shaderCode!,
      alpha: ch.alpha ?? 1.0,
      params: ch.params || {},
      customParams: ch.customParams || {},
    }));

  adapter.setupChannels(channelData, blendMode);
  target.renderer = adapter as unknown as MiniRendererLike;

  // Store composition data for mixer panel restoration on side switch
  target.compositionPreset = {
    name: 'A/B Composition',
    blendMode,
    channels: channels.map(ch => ({ ...ch })),
  };

  // Send to fullscreen
  sendABCompositionUpdate(side, channels, blendMode);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderABFrame(): { fps: number; time: number; frame: number } {
  const mainCanvas = document.getElementById('shader-canvas') as HTMLCanvasElement;
  const canvasWidth = mainCanvas.width;
  const canvasHeight = mainCanvas.height;

  // Create or get overlay canvas for composited output (used by NDI/recording)
  if (!abOverlayCanvas) {
    abOverlayCanvas = document.createElement('canvas');
    abOverlayCanvas.id = 'ab-overlay-canvas';
    abOverlayCanvas.style.cssText =
      'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);max-width:100%;max-height:100%;pointer-events:none;display:none';
    mainCanvas.parentElement!.style.position = 'relative';
    mainCanvas.parentElement!.appendChild(abOverlayCanvas);
  }

  // Sync overlay canvas size
  if (abOverlayCanvas.width !== canvasWidth || abOverlayCanvas.height !== canvasHeight) {
    abOverlayCanvas.width = canvasWidth;
    abOverlayCanvas.height = canvasHeight;
    abOverlayCtx = null;
  }
  if (!abOverlayCtx) {
    abOverlayCtx = abOverlayCanvas.getContext('2d');
  }

  // Create side-by-side preview canvases for display
  ensurePreviewCanvases();

  const crossfade = state.abCrossfade;
  const ctx = abOverlayCtx!;

  // Ensure shared MiniShaderRenderer canvas is large enough
  MiniShaderRenderer.ensureSharedCanvasSize(canvasWidth, canvasHeight);

  // Clear overlay to black
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Per-side tiling: swap tilingValues before each side's render
  const tilingFixed = isTilingFixed();

  // Render side A with alpha (1 - crossfade)
  if (sideA.renderer && sideA.shaderCode) {
    if (!tilingFixed) applyTiling(sideA.tiling);
    ctx.globalAlpha = 1.0 - crossfade;
    try {
      (sideA.renderer as MiniRendererLike).renderDirect(ctx, 0, 0, canvasWidth, canvasHeight);
    } catch (err) {
      console.warn('[AB] Side A render error:', err);
    }
  }

  // Render side B with alpha (crossfade)
  if (sideB.renderer && sideB.shaderCode) {
    if (!tilingFixed) applyTiling(sideB.tiling);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = crossfade;
    try {
      (sideB.renderer as MiniRendererLike).renderDirect(ctx, 0, 0, canvasWidth, canvasHeight);
    } catch (err) {
      console.warn('[AB] Side B render error:', err);
    }
  }

  // Restore active side's tiling so sliders stay in sync
  if (!tilingFixed) {
    const active = state.abActiveTarget === 'a' ? sideA : sideB;
    applyTiling(active.tiling);
  }

  ctx.globalAlpha = 1.0;
  ctx.globalCompositeOperation = 'source-over';
  abOverlayCanvas.style.display = 'block';

  // Also render side-by-side preview canvases for UI display
  renderSidePreviews(canvasWidth, canvasHeight);

  // Hide other overlays
  hideMixerOverlay();
  hideAssetOverlay();

  // Return stats from main renderer
  const mainStats = (state.renderer as MainRendererLike)?.getStats?.() ||
    { fps: 60, time: 0, frame: 0 };
  return mainStats;
}

function ensurePreviewCanvases(): void {
  const containerA = document.getElementById('ab-preview-a');
  const containerB = document.getElementById('ab-preview-b');
  if (!containerA || !containerB) return;

  if (!previewCanvasA) {
    previewCanvasA = document.createElement('canvas');
    previewCanvasA.className = 'ab-preview-canvas';
    containerA.appendChild(previewCanvasA);
  }

  if (!previewCanvasB) {
    previewCanvasB = document.createElement('canvas');
    previewCanvasB.className = 'ab-preview-canvas';
    containerB.appendChild(previewCanvasB);
  }
}

// Throttle side preview rendering (every N frames)
let sidePreviewCounter = 0;

function renderSidePreviews(_fullWidth: number, _fullHeight: number): void {
  // Only update side previews every 10 frames to save GPU
  sidePreviewCounter++;
  if (sidePreviewCounter % 10 !== 0) return;

  if (!previewCanvasA || !previewCanvasB) return;

  const containerA = document.getElementById('ab-preview-a');
  if (!containerA) return;

  // Small thumbnail size
  const previewW = 80;
  const previewH = 45;

  // Side A
  if (previewCanvasA.width !== previewW || previewCanvasA.height !== previewH) {
    previewCanvasA.width = previewW;
    previewCanvasA.height = previewH;
    previewCtxA = null;
  }
  if (!previewCtxA) previewCtxA = previewCanvasA.getContext('2d');

  const tilingFixed = isTilingFixed();

  if (previewCtxA && sideA.renderer && sideA.shaderCode) {
    if (!tilingFixed) applyTiling(sideA.tiling);
    MiniShaderRenderer.ensureSharedCanvasSize(previewW, previewH);
    previewCtxA.fillStyle = '#000';
    previewCtxA.fillRect(0, 0, previewW, previewH);
    try {
      (sideA.renderer as MiniRendererLike).renderDirect(previewCtxA, 0, 0, previewW, previewH);
    } catch { /* ignore */ }
  }

  // Side B
  if (previewCanvasB.width !== previewW || previewCanvasB.height !== previewH) {
    previewCanvasB.width = previewW;
    previewCanvasB.height = previewH;
    previewCtxB = null;
  }
  if (!previewCtxB) previewCtxB = previewCanvasB.getContext('2d');

  if (previewCtxB && sideB.renderer && sideB.shaderCode) {
    if (!tilingFixed) applyTiling(sideB.tiling);
    MiniShaderRenderer.ensureSharedCanvasSize(previewW, previewH);
    previewCtxB.fillStyle = '#000';
    previewCtxB.fillRect(0, 0, previewW, previewH);
    try {
      (sideB.renderer as MiniRendererLike).renderDirect(previewCtxB, 0, 0, previewW, previewH);
    } catch { /* ignore */ }
  }

  // Restore active side's tiling
  if (!tilingFixed) {
    const active = state.abActiveTarget === 'a' ? sideA : sideB;
    applyTiling(active.tiling);
  }
}

// ---------------------------------------------------------------------------
// A/B mode enable/disable
// ---------------------------------------------------------------------------

export function enableAB(): void {
  state.abEnabled = true;

  // Initialize renderers if needed
  if (!sideA.renderer) {
    sideA.renderer = new MiniShaderRenderer(createHiddenCanvas(), { enableEffects: true }) as unknown as MiniRendererLike;
  }
  if (!sideB.renderer) {
    sideB.renderer = new MiniShaderRenderer(createHiddenCanvas(), { enableEffects: true }) as unknown as MiniRendererLike;
  }

  // Register tiling change hook for A/B fullscreen sync
  setOnTilingChanged(sendABTilingToFullscreen);

  // Show A/B UI elements
  const abPreviews = document.getElementById('ab-previews');
  if (abPreviews) abPreviews.classList.remove('hidden');

  // Update active side highlight
  setActiveSide(state.abActiveTarget);

  // Update button state
  const btn = document.getElementById('btn-ab');
  if (btn) {
    btn.classList.add('active');
    btn.title = 'Disable A/B Preview';
  }
}

export function disableAB(): void {
  state.abEnabled = false;

  // Hide A/B UI elements
  const abPreviews = document.getElementById('ab-previews');
  if (abPreviews) abPreviews.classList.add('hidden');

  // Hide overlay
  hideABOverlay();

  // Update button state
  const btn = document.getElementById('btn-ab');
  if (btn) {
    btn.classList.remove('active');
    btn.title = 'Enable A/B Preview';
  }

  // Unregister tiling change hook
  setOnTilingChanged(null);

  // Tell fullscreen to exit A/B mode
  window.electronAPI?.sendABExit?.();
}

export function hideABOverlay(): void {
  if (abOverlayCanvas) {
    abOverlayCanvas.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Active target management
// ---------------------------------------------------------------------------

export function getActiveSide(): 'a' | 'b' {
  return state.abActiveTarget;
}

export function setActiveSide(side: 'a' | 'b'): void {
  const prevSide = state.abActiveTarget;

  // Save current side's param state before switching
  if (prevSide !== side) {
    saveCurrentSideParams(prevSide);
  }

  state.abActiveTarget = side;

  // Update button indicators
  const btnA = document.getElementById('ab-btn-a');
  const btnB = document.getElementById('ab-btn-b');
  if (btnA && btnB) {
    btnA.classList.toggle('active', side === 'a');
    btnB.classList.toggle('active', side === 'b');
  }

  // Update preview side highlight
  const previewA = document.getElementById('ab-preview-a');
  const previewB = document.getElementById('ab-preview-b');
  if (previewA && previewB) {
    previewA.classList.toggle('active', side === 'a');
    previewB.classList.toggle('active', side === 'b');
  }

  // Restore target side's params to UI
  if (prevSide !== side) {
    restoreTargetSideParams(side);
  }
}

function saveCurrentSideParams(side: 'a' | 'b'): void {
  const target = side === 'a' ? sideA : sideB;
  if (!target.renderer) return;

  // Capture current customParamValues from the renderer
  if (target.renderer.getCustomParamValues) {
    target.customParams = target.renderer.getCustomParamValues();
  } else {
    target.customParams = { ...target.renderer.customParamValues };
  }

  // Capture speed from the speed slider
  const speedSlider = document.getElementById('param-speed') as HTMLInputElement | null;
  if (speedSlider) {
    target.params = { ...target.params, speed: parseFloat(speedSlider.value) };
  }

  // Capture tiling state (unless Fix is checked)
  if (!isTilingFixed()) {
    target.tiling = snapshotTiling();
  }

  // Capture current mixer state for composition sides
  if (target.renderMode === 'composition') {
    const mixState = snapshotMixerState();
    target.compositionPreset = {
      name: mixState.name,
      blendMode: mixState.blendMode || 'lighter',
      channels: (mixState.channels || []).map(ch => ({
        shaderCode: ch.shaderCode || null,
        alpha: ch.alpha ?? 1.0,
        params: ch.params || {},
        customParams: ch.customParams || {},
        enabled: ch.enabled !== false,
      })),
    };
  }
}

function restoreTargetSideParams(side: 'a' | 'b'): void {
  const target = side === 'a' ? sideA : sideB;
  if (!target.shaderCode) return;

  // For shader mode: compile to state.renderer so param UI can query it
  if (target.renderMode === 'shader' && state.renderer) {
    try {
      (state.renderer as { compile?(code: string): void }).compile?.(target.shaderCode);
    } catch { /* ignore — param UI will use AB paramDefs fallback */ }
  }

  // Build merged params: start with saved params, overlay current tiling
  // so loadParamsToSliders (which internally calls loadTilingToSliders) gets correct tiling
  const tilingFixed = isTilingFixed();
  const mergedParams = { ...target.params };
  if (!tilingFixed) {
    mergedParams.cols = target.tiling.cols;
    mergedParams.rows = target.tiling.rows;
    mergedParams.spaceX = target.tiling.spaceX;
    mergedParams.spaceY = target.tiling.spaceY;
    mergedParams.tilingBg = '#' +
      Math.round(target.tiling.bgR * 255).toString(16).padStart(2, '0') +
      Math.round(target.tiling.bgG * 255).toString(16).padStart(2, '0') +
      Math.round(target.tiling.bgB * 255).toString(16).padStart(2, '0');
  }

  // Load speed, custom params, and tiling to sliders
  loadParamsToSliders(mergedParams, { skipMixerSync: true });

  // For composition mode: restore mixer panel with composition data
  if (target.renderMode === 'composition' && target.compositionPreset) {
    recallMixState(target.compositionPreset as Parameters<typeof recallMixState>[0]);
  }

  // Regenerate custom param UI (will use AB param source for scenes/compositions)
  generateCustomParamUI();
}

// ---------------------------------------------------------------------------
// Crossfade
// ---------------------------------------------------------------------------

export function setABCrossfade(value: number): void {
  state.abCrossfade = Math.max(0, Math.min(1, value));

  // Send to fullscreen
  window.electronAPI?.sendABCrossfade?.(state.abCrossfade);
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function getABOverlayCanvas(): HTMLCanvasElement | null {
  return abOverlayCanvas;
}

// ---------------------------------------------------------------------------
// A/B param source & routing
// ---------------------------------------------------------------------------

/**
 * Returns param defs and values for the active A/B side.
 * Used by params.ts to generate correct UI for scenes/compositions.
 */
export function getActiveABParamSource(): { paramDefs: ParamDef[]; paramValues: Record<string, ParamValue> } | null {
  if (!state.abEnabled) return null;
  const target = state.abActiveTarget === 'a' ? sideA : sideB;
  if (!target.shaderCode) return null;

  const paramDefs = target.paramDefs || [];
  const paramValues = target.renderer?.getCustomParamValues?.()
    || { ...target.renderer?.customParamValues }
    || target.customParams
    || {};

  return { paramDefs, paramValues };
}

/**
 * Routes a param change to the active A/B side's renderer.
 * Called from params.ts when A/B mode is active.
 */
export function handleABParamChange(name: string, value: ParamValue): void {
  const side = state.abActiveTarget;
  const target = side === 'a' ? sideA : sideB;
  if (!target.renderer) return;

  if (name === 'speed') {
    target.renderer.setSpeed(value as number);
    target.params.speed = value;
  } else if (target.renderer.setParam) {
    target.renderer.setParam(name, value);
    target.customParams[name] = value;
  } else {
    target.renderer.setParams({ [name]: value });
    target.customParams[name] = value;
  }

  // Forward to fullscreen
  window.electronAPI?.sendABParamUpdate?.({ side, name, value });
}

/** Send the active side's tiling snapshot to fullscreen (called from tiling.ts on slider change). */
export function sendABTilingToFullscreen(): void {
  if (!state.abEnabled) return;
  const side = state.abActiveTarget;
  const target = side === 'a' ? sideA : sideB;
  // Snapshot current tilingValues (which were just updated by the slider)
  target.tiling = snapshotTiling();
  window.electronAPI?.sendABTilingUpdate?.({ side, tiling: target.tiling });
}

/**
 * Called when mixer state changes (alpha, params, blend mode, channel assignment).
 * If the active A/B side is a composition, rebuild the composition from the current mixer state.
 */
export function syncMixerToABComposition(): void {
  if (!state.abEnabled) return;
  const side = state.abActiveTarget;
  const target = side === 'a' ? sideA : sideB;
  if (target.renderMode !== 'composition') return;

  // Snapshot current mixer state
  const mixState = snapshotMixerState();
  const channels: ABCompositionChannel[] = (mixState.channels || []).map(ch => ({
    shaderCode: ch.shaderCode || null,
    alpha: ch.alpha ?? 1.0,
    params: ch.params || {},
    customParams: ch.customParams || {},
    enabled: ch.enabled !== false,
  }));
  const blendMode = mixState.blendMode || 'lighter';

  // Update stored composition preset
  target.compositionPreset = { name: mixState.name, blendMode, channels };

  // Rebuild the CompositionABAdapter
  if (target.renderer?.dispose) target.renderer.dispose();
  const adapter = new CompositionABAdapter();
  const channelData: CompositionChannelData[] = channels
    .filter(ch => ch.enabled !== false && ch.shaderCode)
    .map(ch => ({
      shaderCode: ch.shaderCode!,
      alpha: ch.alpha,
      params: ch.params || {},
      customParams: ch.customParams || {},
    }));
  adapter.setupChannels(channelData, blendMode);
  target.renderer = adapter as unknown as MiniRendererLike;

  // Send updated composition to fullscreen
  sendABCompositionUpdate(side, channels, blendMode);
}

// ---------------------------------------------------------------------------
// IPC helpers — send state to fullscreen
// ---------------------------------------------------------------------------

function sendABShaderUpdate(side: 'a' | 'b'): void {
  const target = side === 'a' ? sideA : sideB;
  if (!target.shaderCode) return;

  const allParams: Record<string, ParamValue> = {
    ...target.params,
    ...target.customParams,
  };

  window.electronAPI?.sendABShaderUpdate?.({
    side,
    shaderCode: target.shaderCode,
    renderMode: target.renderMode,
    params: allParams,
    tiling: target.tiling,
  });

  // Also send crossfade value
  window.electronAPI?.sendABCrossfade?.(state.abCrossfade);
}

function sendABCompositionUpdate(
  side: 'a' | 'b',
  channels: ABCompositionChannel[],
  blendMode: string,
): void {
  const target = side === 'a' ? sideA : sideB;
  window.electronAPI?.sendABCompositionUpdate?.({
    side,
    channels: channels
      .filter(ch => ch.enabled !== false && ch.shaderCode)
      .map(ch => ({
        shaderCode: ch.shaderCode,
        alpha: ch.alpha ?? 1.0,
        params: ch.params || {},
        customParams: ch.customParams || {},
      })),
    blendMode,
    tiling: target.tiling,
  });

  // Also send crossfade value
  window.electronAPI?.sendABCrossfade?.(state.abCrossfade);
}

// ---------------------------------------------------------------------------
// Window augmentation for A/B IPC
// ---------------------------------------------------------------------------

declare const window: Window & {
  electronAPI?: {
    sendABShaderUpdate?(data: unknown): void;
    sendABCrossfade?(value: number): void;
    sendABParamUpdate?(data: unknown): void;
    sendABCompositionUpdate?(data: unknown): void;
    sendABTilingUpdate?(data: unknown): void;
    sendABExit?(): void;
  };
};
