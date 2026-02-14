// =============================================================================
// Fullscreen Renderer — TypeScript conversion
// Receives shader state from main window and renders at native resolution.
// Supports tiled mode, mixer mode, standalone assets, preset bar, FPS tracking.
// =============================================================================

import { Logger, LOG_LEVEL } from '@shared/logger.js';
import type { TextureDirective, ParamValue, ParamArrayValue, ParamValues } from '@shared/types/params.js';
import type { CompileResult } from '@shared/types/renderer.js';
import { computeCropDraw, updateVideoLoop } from '@renderer/renderers/gl-utils.js';
import { ShaderRenderer } from '@renderer/renderers/shader-renderer.js';
import { ThreeSceneRenderer } from '@renderer/renderers/three-scene-renderer.js';
import { TileRenderer } from '@renderer/renderers/tile-renderer.js';
import type { TileBounds, TileSharedState } from '@renderer/renderers/tile-renderer.js';

// =============================================================================
// Logger
// =============================================================================

const log = new Logger('FullscreenRenderer', LOG_LEVEL.WARN);

// =============================================================================
// electronAPI declaration
// =============================================================================

/** Render mode for the fullscreen window */
type RenderMode = 'shader' | 'scene' | 'asset';

/** Channel info for loading textures/video/camera/audio */
interface ChannelInfo {
  type: 'image' | 'video' | 'camera' | 'audio' | 'file-texture';
  dataUrl?: string;
  filePath?: string;
  name?: string;
}

/** Preset entry (local or global) */
interface PresetEntry {
  name?: string;
  params: ParamValues;
}

/** Tile info from config */
interface TileInfo {
  shaderCode: string | null;
  params: ParamValues | null;
  visible?: boolean;
  gridSlotIndex?: number | null;
}

/** Tile layout configuration */
interface TileLayoutConfig {
  rows: number;
  cols: number;
  gaps: number;
}

/** Preview resolution for aspect ratio correction */
interface PreviewResolution {
  width: number;
  height: number;
}

/** Render offset (aspect correction) */
interface RenderOffset {
  x: number;
  y: number;
}

/** Render size (aspect corrected) */
interface RenderSize {
  width: number;
  height: number;
}

/** Tile configuration stored at module level */
interface TileConfig {
  layout: TileLayoutConfig;
  tiles: TileInfo[];
  previewResolution?: PreviewResolution;
  renderOffset?: RenderOffset;
  renderSize?: RenderSize;
}

/** Mixer channel config for init */
interface MixerChannelConfig {
  shaderCode?: string;
  params?: ParamValues;
  alpha?: number;
}

/** Mixer init config */
interface MixerConfig {
  blendMode?: GlobalCompositeOperation;
  channels?: MixerChannelConfig[];
}

/** Asset entry for mixer or standalone */
interface AssetEntry {
  source: HTMLImageElement | HTMLVideoElement;
  type: 'asset-image' | 'asset-video';
  params: Record<string, number>;
}

// =============================================================================
// IPC payload interfaces
// =============================================================================

interface InitFullscreenState {
  renderMode?: RenderMode;
  shaderCode?: string;
  time?: number;
  frame?: number;
  isPlaying?: boolean;
  channels?: (ChannelInfo | null)[];
  params?: ParamValues;
  localPresets?: PresetEntry[];
  activeLocalPresetIndex?: number | null;
  tiledConfig?: TileConfig;
  mixerConfig?: MixerConfig;
}

interface ShaderUpdateData {
  renderMode?: RenderMode;
  shaderCode?: string;
}

interface TimeSyncData {
  time?: number;
  frame?: number;
  isPlaying?: boolean;
}

interface ParamUpdateData {
  name: string;
  value: ParamValue | ParamArrayValue;
}

interface PresetSyncData {
  type: 'local' | 'global';
  index: number;
  params: ParamValues;
}

interface AssetUpdateData {
  assetType?: 'asset-image' | 'asset-video';
  dataUrl?: string;
  filePath?: string;
  params?: Record<string, number>;
  clear?: boolean;
}

interface MixerParamData {
  channelIndex: number;
  paramName: string;
  value: ParamValue | ParamArrayValue;
}

interface MixerAlphaData {
  channelIndex: number;
  alpha: number;
}

interface MixerBlendModeData {
  blendMode: GlobalCompositeOperation;
}

interface MixerChannelUpdateData {
  channelIndex: number;
  shaderCode?: string;
  params?: ParamValues;
  clear?: boolean;
  assetType?: 'asset-image' | 'asset-video';
  dataUrl?: string;
  filePath?: string;
}

interface TiledConfig extends TileConfig {}

interface TileLayout {
  rows: number;
  cols: number;
  gaps: number;
}

interface TileAssignData {
  tileIndex: number;
  shaderCode: string | null;
  params: ParamValues | null;
}

interface TileParamUpdateData {
  tileIndex: number;
  name: string;
  value: ParamValue | ParamArrayValue;
}

// =============================================================================
// electronAPI window augmentation
// =============================================================================

declare const window: Window & {
  electronAPI: {
    getDisplayRefreshRate(): Promise<number>;
    loadFileTexture(name: string): Promise<{ success: boolean; dataUrl: string }>;
    sendFullscreenFps(fps: number): void;
    sendPresetSync(data: { type: string; index: number; params: ParamValues }): void;
    onInitFullscreen(cb: (state: InitFullscreenState) => void): void;
    onShaderUpdate(cb: (data: ShaderUpdateData) => void): void;
    onTimeSync(cb: (data: TimeSyncData) => void): void;
    onParamUpdate(cb: (data: ParamUpdateData) => void): void;
    onBatchParamUpdate?(cb: (params: Record<string, ParamValue | ParamArrayValue>) => void): void;
    onPresetSync(cb: (data: PresetSyncData) => void): void;
    onBlackout(cb: (enabled: boolean) => void): void;
    onAssetUpdate?(cb: (data: AssetUpdateData) => void): void;
    onMixerParamUpdate?(cb: (data: MixerParamData) => void): void;
    onMixerAlphaUpdate?(cb: (data: MixerAlphaData) => void): void;
    onMixerBlendMode?(cb: (data: MixerBlendModeData) => void): void;
    onMixerChannelUpdate?(cb: (data: MixerChannelUpdateData) => void): void;
    onInitTiledFullscreen?(cb: (config: TiledConfig) => void): void;
    onTileLayoutUpdate?(cb: (layout: TileLayout) => void): void;
    onTileAssign?(cb: (data: TileAssignData) => void): void;
    onTileParamUpdate?(cb: (data: TileParamUpdateData) => void): void;
    onExitTiledMode?(cb: () => void): void;
  };
  loadThreeJS(): Promise<void>;
};

// =============================================================================
// Module-level state
// =============================================================================

/** Union type for the active renderer (ShaderRenderer or ThreeSceneRenderer) */
type ActiveRenderer = ShaderRenderer | ThreeSceneRenderer;

let renderer: ActiveRenderer | null = null;
let shaderRenderer: ShaderRenderer | null = null;
let sceneRenderer: ThreeSceneRenderer | null = null;
let renderMode: RenderMode = 'shader';
let animationId: number = 0;
let localPresets: PresetEntry[] = [];
let activeLocalPresetIndex: number | null = null;
let presetBarTimeout: ReturnType<typeof setTimeout> | null = null;
let blackoutEnabled: boolean = false;

// Asset tiling start time
const _fsStartTime: number = performance.now();

// FPS tracking
let frameCount: number = 0;
let lastFpsTime: number = performance.now();
let currentFps: number = 0;
let targetRefreshRate: number = 60;
let lastFrameTime: number = 0;
let minFrameInterval: number = 0;

// Tiled mode state
let tiledMode: boolean = false;
let tileRenderers: TileRenderer[] = [];
let tileConfig: TileConfig | null = null;
let sharedGL: WebGL2RenderingContext | null = null;

// Mixer mode state
let mixerMode: boolean = false;
let mixerRenderers: (TileRenderer | null)[] = [];
let mixerBlendMode: GlobalCompositeOperation = 'lighter';
let mixerChannelAlphas: number[] = [];
let mixerSelectedChannel: number = -1;
let mixerOverlayCanvas: HTMLCanvasElement | null = null;
let mixerOverlayCtx: CanvasRenderingContext2D | null = null;

// Asset mixer state
let mixerAssets: (AssetEntry | null)[] = [];

// Standalone asset state
let standaloneAsset: AssetEntry | null = null;
let standaloneOverlayCanvas: HTMLCanvasElement | null = null;
let standaloneOverlayCtx: CanvasRenderingContext2D | null = null;

// Reused Date object to avoid allocation per frame
const reusedDate: Date = new Date();
// Pre-allocated resolutions array for shared state (avoid per-frame allocation)
const _sharedResolutions: Float32Array = new Float32Array(12);

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Prepare shared render state from shaderRenderer (used by tiled + mixer modes).
 */
function prepareSharedState(): TileSharedState {
  const sr = shaderRenderer!;
  const now: number = performance.now();
  const time: number = (now - sr.startTime) / 1000;
  const timeDelta: number = (now - sr.lastFrameTime) / 1000;
  sr.lastFrameTime = now;

  reusedDate.setTime(Date.now());
  const dateValues: Float32Array = new Float32Array([
    reusedDate.getFullYear(),
    reusedDate.getMonth(),
    reusedDate.getDate(),
    reusedDate.getHours() * 3600 + reusedDate.getMinutes() * 60 + reusedDate.getSeconds() + reusedDate.getMilliseconds() / 1000,
  ]);

  sr.updateVideoTextures();

  for (let i = 0; i < 4; i++) {
    _sharedResolutions[i * 3] = sr.channelResolutions[i][0];
    _sharedResolutions[i * 3 + 1] = sr.channelResolutions[i][1];
    _sharedResolutions[i * 3 + 2] = sr.channelResolutions[i][2];
  }

  return {
    time,
    timeDelta,
    frame: sr.frameCount,
    mouse: sr.mouse,
    date: dateValues,
    channelTextures: sr.channelTextures,
    channelResolutions: _sharedResolutions,
  };
}

/**
 * Load file textures for a renderer after compile (reads from data/textures/ via IPC).
 */
async function loadFileTexturesForRenderer(
  targetRenderer: { fileTextureDirectives?: TextureDirective[]; loadTexture(channel: number, dataUrl: string): Promise<unknown> },
): Promise<void> {
  if (!targetRenderer.fileTextureDirectives || targetRenderer.fileTextureDirectives.length === 0) return;
  for (const { channel, textureName } of targetRenderer.fileTextureDirectives) {
    try {
      const result = await window.electronAPI.loadFileTexture(textureName);
      if (result.success) {
        await targetRenderer.loadTexture(channel, result.dataUrl);
      }
    } catch (err: unknown) {
      log.error(`Failed to load file texture "${textureName}":`, err);
    }
  }
}

/**
 * Lazy-initialize ThreeSceneRenderer (Three.js is lazy-loaded in fullscreen).
 */
async function ensureSceneRenderer(): Promise<ThreeSceneRenderer> {
  if (sceneRenderer) return sceneRenderer;
  const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement;
  await window.loadThreeJS();
  sceneRenderer = new ThreeSceneRenderer(canvas);
  sceneRenderer.setResolution(window.innerWidth, window.innerHeight);
  // Restore ShaderRenderer GL state after Three.js creates its WebGLRenderer
  shaderRenderer!.reinitialize();
  return sceneRenderer;
}

// =============================================================================
// Preset bar
// =============================================================================

function showPresetBar(): void {
  const bar = document.getElementById('preset-bar');
  if (!bar) return;
  bar.classList.add('visible');
  document.body.style.cursor = 'default';

  if (presetBarTimeout !== null) {
    clearTimeout(presetBarTimeout);
  }
  presetBarTimeout = setTimeout(() => {
    bar.classList.remove('visible');
    document.body.style.cursor = 'none';
  }, 3000);
}

function handlePresetKey(e: KeyboardEvent): void {
  const key: string = e.key;
  if (key >= '1' && key <= '9') {
    const index: number = parseInt(key, 10) - 1;
    if (index < localPresets.length) {
      recallLocalPreset(index);
    }
  }
}

function recallLocalPreset(index: number, fromSync: boolean = false): void {
  if (index >= localPresets.length) return;
  const preset: PresetEntry = localPresets[index];
  const params: ParamValues = preset.params || (preset as unknown as ParamValues);

  Object.keys(params).forEach((name: string) => {
    renderer!.setParam(name, params[name]);
  });

  activeLocalPresetIndex = index;
  updatePresetHighlights();

  // Sync back to main window (unless this call came from sync)
  if (!fromSync) {
    window.electronAPI.sendPresetSync({
      type: 'local',
      index,
      params,
    });
  }
}

function updatePresetHighlights(): void {
  document.querySelectorAll('#local-presets .preset-btn').forEach((btn: Element, i: number) => {
    btn.classList.toggle('active', i === activeLocalPresetIndex);
  });
}

function createPresetButtons(): void {
  const localContainer = document.getElementById('local-presets');
  if (!localContainer) return;

  // Clear existing buttons (keep labels)
  localContainer.querySelectorAll('.preset-btn').forEach((btn: Element) => btn.remove());

  // Create local preset buttons
  localPresets.forEach((preset: PresetEntry, index: number) => {
    const btn: HTMLButtonElement = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = preset.name || String(index + 1);
    btn.title = `Shader preset ${index + 1} (Key ${index + 1})`;
    btn.addEventListener('click', () => recallLocalPreset(index));
    if (index === activeLocalPresetIndex) btn.classList.add('active');
    localContainer.appendChild(btn);
  });
}

// =============================================================================
// Channel loading
// =============================================================================

async function loadChannel(index: number, channel: ChannelInfo): Promise<void> {
  try {
    switch (channel.type) {
      case 'image':
        if (channel.dataUrl) {
          await renderer!.loadTexture!(index, channel.dataUrl);
        }
        break;
      case 'video':
        if (channel.filePath) {
          await renderer!.loadVideo!(index, channel.filePath);
        }
        break;
      case 'camera':
        await renderer!.loadCamera!(index);
        break;
      case 'audio':
        await renderer!.loadAudio!(index);
        break;
      case 'file-texture':
        if (channel.name) {
          try {
            const result = await window.electronAPI.loadFileTexture(channel.name);
            if (result.success) {
              await renderer!.loadTexture!(index, result.dataUrl);
            }
          } catch (texErr: unknown) {
            log.error(`Failed to load file texture "${channel.name}":`, texErr);
          }
        }
        break;
    }
  } catch (err: unknown) {
    log.error(`Failed to load channel ${index}:`, err);
  }
}

// =============================================================================
// Shared Asset Drawing (crop + keep aspect ratio)
// =============================================================================

function drawAssetWithCrop(
  ctx: CanvasRenderingContext2D,
  source: HTMLImageElement | HTMLVideoElement,
  params: Record<string, number>,
  canvasW: number,
  canvasH: number,
): void {
  const natW: number = (source as HTMLImageElement).naturalWidth
    || (source as HTMLVideoElement).videoWidth
    || source.width;
  const natH: number = (source as HTMLImageElement).naturalHeight
    || (source as HTMLVideoElement).videoHeight
    || source.height;
  const crop = computeCropDraw(natW, natH, params, canvasW, canvasH);
  if (!crop) return;
  const { x = 0, y = 0, repeatX = 1, repeatY = 1, speedX = 0, speedY = 0 } = params;

  if (repeatX <= 1 && repeatY <= 1 && speedX === 0 && speedY === 0) {
    ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, x, y, crop.drawW, crop.drawH);
  } else {
    const tileW: number = crop.drawW / repeatX;
    const tileH: number = crop.drawH / repeatY;
    const elapsed: number = (performance.now() - _fsStartTime) / 1000;
    const offX: number = tileW > 0 ? ((speedX * elapsed) % tileW + tileW) % tileW : 0;
    const offY: number = tileH > 0 ? ((speedY * elapsed) % tileH + tileH) % tileH : 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, crop.drawW, crop.drawH);
    ctx.clip();
    for (let row = -1; row <= repeatY; row++) {
      for (let col = -1; col <= repeatX; col++) {
        ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh,
          x + col * tileW + offX, y + row * tileH + offY, tileW, tileH);
      }
    }
    ctx.restore();
  }
}

// =============================================================================
// Standalone Asset Functions
// =============================================================================

function renderStandaloneAsset(): void {
  const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement;

  if (!standaloneOverlayCanvas) {
    standaloneOverlayCanvas = document.createElement('canvas');
    standaloneOverlayCanvas.id = 'standalone-asset-canvas';
    standaloneOverlayCanvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1';
    const parent = canvas.parentElement;
    if (parent) {
      parent.style.position = 'relative';
      parent.appendChild(standaloneOverlayCanvas);
    }
  }

  if (standaloneOverlayCanvas.width !== canvas.width || standaloneOverlayCanvas.height !== canvas.height) {
    standaloneOverlayCanvas.width = canvas.width;
    standaloneOverlayCanvas.height = canvas.height;
    standaloneOverlayCtx = null;
  }

  if (!standaloneOverlayCtx) {
    standaloneOverlayCtx = standaloneOverlayCanvas.getContext('2d');
  }

  const ctx = standaloneOverlayCtx;
  if (!ctx) return;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const asset = standaloneAsset;
  if (asset && asset.source) {
    if (asset.type === 'asset-video') {
      updateVideoLoop(asset.source as HTMLVideoElement, asset.params);
    }
    try {
      drawAssetWithCrop(ctx, asset.source, asset.params, canvas.width, canvas.height);
    } catch (_err: unknown) {
      // Source may not be loaded yet
    }
  }

  standaloneOverlayCanvas.style.display = 'block';
  if (mixerOverlayCanvas) mixerOverlayCanvas.style.display = 'none';
}

function clearStandaloneAsset(): void {
  if (standaloneAsset?.source instanceof HTMLVideoElement) {
    standaloneAsset.source.pause();
    standaloneAsset.source.removeAttribute('src');
    standaloneAsset.source.load();
  }
  standaloneAsset = null;
  if (standaloneOverlayCanvas) standaloneOverlayCanvas.style.display = 'none';
}

// =============================================================================
// Tiled Mode Functions
// =============================================================================

function initTiledMode(config: TileConfig): void {
  const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement;

  tiledMode = true;
  tileConfig = config;

  // Use the same WebGL context as shaderRenderer (critical for texture sharing)
  if (!sharedGL) {
    sharedGL = shaderRenderer!.gl;
  }

  // Clear existing tile renderers
  disposeTileRenderers();

  // Calculate tile bounds - use preview resolution aspect ratio if available
  let renderWidth: number = canvas.width;
  let renderHeight: number = canvas.height;
  let offsetX: number = 0;
  let offsetY: number = 0;

  if (config.previewResolution) {
    const previewAspect: number = config.previewResolution.width / config.previewResolution.height;
    const canvasAspect: number = canvas.width / canvas.height;

    if (canvasAspect > previewAspect) {
      // Canvas is wider - pillarbox (black bars on sides)
      renderWidth = Math.floor(canvas.height * previewAspect);
      offsetX = Math.floor((canvas.width - renderWidth) / 2);
    } else {
      // Canvas is taller - letterbox (black bars on top/bottom)
      renderHeight = Math.floor(canvas.width / previewAspect);
      offsetY = Math.floor((canvas.height - renderHeight) / 2);
    }
    log.info(`Aspect ratio correction: preview=${previewAspect.toFixed(2)}, canvas=${canvasAspect.toFixed(2)}`);
    log.info(`Render area: ${renderWidth}x${renderHeight} at offset (${offsetX},${offsetY})`);
  }

  // Store offset for rendering
  tileConfig.renderOffset = { x: offsetX, y: offsetY };
  tileConfig.renderSize = { width: renderWidth, height: renderHeight };

  // Calculate tile bounds within the aspect-corrected area
  const bounds: TileBounds[] = calculateTileBounds(
    renderWidth,
    renderHeight,
    config.layout.rows,
    config.layout.cols,
    config.layout.gaps,
  );

  // Apply offset to bounds
  bounds.forEach((b: TileBounds) => {
    b.x += offsetX;
    b.y += offsetY;
  });

  // Create TileRenderer for each tile
  tileRenderers = bounds.map((b: TileBounds) => new TileRenderer(sharedGL!, b));

  // Compile shaders for tiles that have assignments
  if (config.tiles) {
    config.tiles.forEach((tile: TileInfo | null, index: number) => {
      if (tile && tile.shaderCode && index < tileRenderers.length) {
        try {
          tileRenderers[index].compile(tile.shaderCode);
          if (tile.params) {
            tileRenderers[index].setParams(tile.params);
          }
        } catch (err: unknown) {
          log.error(`Failed to compile shader for tile ${index}:`, err);
        }
      }
    });
  }
}

function calculateTileBounds(
  canvasWidth: number,
  canvasHeight: number,
  rows: number,
  cols: number,
  gaps: number,
): TileBounds[] {
  const bounds: TileBounds[] = [];

  const totalGapX: number = gaps * (cols - 1);
  const totalGapY: number = gaps * (rows - 1);
  const tileWidth: number = Math.floor((canvasWidth - totalGapX) / cols);
  const tileHeight: number = Math.floor((canvasHeight - totalGapY) / rows);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tileIndex: number = row * cols + col;
      const x: number = col * (tileWidth + gaps);
      // WebGL has Y=0 at bottom, so flip the row order
      const y: number = (rows - 1 - row) * (tileHeight + gaps);

      bounds.push({
        tileIndex,
        x,
        y,
        width: tileWidth,
        height: tileHeight,
      });
    }
  }

  return bounds;
}

function updateTileLayout(layout: TileLayout): void {
  if (!tiledMode || !tileConfig) return;

  const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement;
  tileConfig.layout = layout;

  const bounds: TileBounds[] = calculateTileBounds(
    canvas.width,
    canvas.height,
    layout.rows,
    layout.cols,
    layout.gaps,
  );

  // Resize existing renderers or create new ones
  const newCount: number = layout.rows * layout.cols;
  const oldCount: number = tileRenderers.length;

  // Update bounds for existing renderers
  for (let i = 0; i < Math.min(oldCount, newCount); i++) {
    tileRenderers[i].setBounds(bounds[i]);
  }

  // Create new renderers if needed
  for (let i = oldCount; i < newCount; i++) {
    tileRenderers.push(new TileRenderer(sharedGL!, bounds[i]));
  }

  // Remove excess renderers
  for (let i = newCount; i < oldCount; i++) {
    tileRenderers[i].dispose();
  }
  tileRenderers.length = newCount;

  // Update tile config tiles array
  while (tileConfig.tiles.length < newCount) {
    tileConfig.tiles.push({ gridSlotIndex: null, params: null, visible: true, shaderCode: null });
  }
  tileConfig.tiles.length = newCount;
}

function assignTileShader(tileIndex: number, shaderCode: string | null, params: ParamValues | null): void {
  if (tileIndex < 0 || tileIndex >= tileRenderers.length) return;

  log.info(`assignTileShader: tile ${tileIndex}, hasShader: ${!!shaderCode}`);

  // Handle clearing a tile
  if (!shaderCode) {
    tileRenderers[tileIndex].program = null;
    if (tileConfig && tileConfig.tiles && tileIndex < tileConfig.tiles.length) {
      tileConfig.tiles[tileIndex] = {
        ...tileConfig.tiles[tileIndex],
        shaderCode: null,
        params: null,
      };
    }
    return;
  }

  try {
    tileRenderers[tileIndex].compile(shaderCode);
    if (params) {
      tileRenderers[tileIndex].setParams(params);
    }

    // Update config
    if (tileConfig && tileConfig.tiles && tileIndex < tileConfig.tiles.length) {
      tileConfig.tiles[tileIndex] = {
        ...tileConfig.tiles[tileIndex],
        shaderCode,
        params,
      };
    }
    log.info(`Tile ${tileIndex} shader updated successfully`);
  } catch (err: unknown) {
    log.error(`Failed to assign shader to tile ${tileIndex}:`, err);
  }
}

function updateTileParam(tileIndex: number, name: string, value: ParamValue | ParamArrayValue): void {
  if (tileIndex < 0 || tileIndex >= tileRenderers.length) return;
  tileRenderers[tileIndex].setParam(name, value);
}

function renderTiledFrame(): void {
  const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement;

  if (!tiledMode || !sharedGL || tileRenderers.length === 0) {
    return;
  }

  const gl: WebGL2RenderingContext = sharedGL;

  // Recalculate bounds based on current canvas size (fixes resize issues)
  const layout: TileLayoutConfig = tileConfig?.layout || { rows: 2, cols: 2, gaps: 4 };

  // Get render area (with aspect ratio correction if configured)
  let renderWidth: number = canvas.width;
  let renderHeight: number = canvas.height;
  let offsetX: number = 0;
  let offsetY: number = 0;

  if (tileConfig?.renderOffset && tileConfig?.renderSize) {
    offsetX = tileConfig.renderOffset.x;
    offsetY = tileConfig.renderOffset.y;
    renderWidth = tileConfig.renderSize.width;
    renderHeight = tileConfig.renderSize.height;
  }

  const freshBounds: TileBounds[] = calculateTileBounds(
    renderWidth,
    renderHeight,
    layout.rows,
    layout.cols,
    layout.gaps,
  );

  // Apply offset to bounds
  freshBounds.forEach((b: TileBounds) => {
    b.x += offsetX;
    b.y += offsetY;
  });

  // Update tile renderer bounds
  for (let i = 0; i < tileRenderers.length && i < freshBounds.length; i++) {
    tileRenderers[i].setBounds(freshBounds[i]);
  }

  // Clear entire canvas (gaps will show as black)
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Prepare shared state for all tiles
  const sharedState: TileSharedState = prepareSharedState();

  // Render each visible tile
  for (let index = 0; index < tileRenderers.length; index++) {
    const tileRenderer: TileRenderer = tileRenderers[index];
    const tileInfo: TileInfo | undefined = tileConfig?.tiles?.[index];
    const isVisible: boolean = tileInfo?.visible !== false;

    // Render shader if available
    if (isVisible && tileRenderer.program) {
      try {
        tileRenderer.render(sharedState);
      } catch (err: unknown) {
        log.error(`Tile ${index} render error:`, err);
      }
    }
  }

  if (shaderRenderer!.isPlaying) {
    shaderRenderer!.frameCount++;
  }
}

function disposeTileRenderers(): void {
  tileRenderers.forEach((tr: TileRenderer) => tr.dispose());
  tileRenderers = [];
}

function exitTiledMode(): void {
  tiledMode = false;
  disposeTileRenderers();
  tileConfig = null;
}

// =============================================================================
// Mixer Mode Functions
// =============================================================================

function initMixerMode(config: MixerConfig): void {
  const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement;

  mixerMode = true;
  mixerBlendMode = (config.blendMode || 'lighter') as GlobalCompositeOperation;

  // Use the same WebGL context as shaderRenderer
  if (!sharedGL) {
    sharedGL = shaderRenderer!.gl;
  }

  // Dispose existing mixer renderers
  mixerRenderers.forEach((r: TileRenderer | null) => { if (r) r.dispose(); });
  const channelCount: number = (config.channels || []).length;
  mixerRenderers = new Array<TileRenderer | null>(channelCount).fill(null);
  mixerChannelAlphas = new Array<number>(channelCount).fill(1);

  // Create 2D overlay canvas for compositing
  initMixerModeIfNeeded(canvas);

  const gl: WebGL2RenderingContext = sharedGL;

  for (let i = 0; i < channelCount; i++) {
    const channelConfig: MixerChannelConfig | undefined = config.channels?.[i];
    if (!channelConfig || !channelConfig.shaderCode) continue;

    const bounds: TileBounds = { tileIndex: i, x: 0, y: 0, width: canvas.width, height: canvas.height };
    const tr: TileRenderer = new TileRenderer(gl, bounds);

    try {
      tr.compile(channelConfig.shaderCode);
      loadFileTexturesForRenderer(tr);
      if (channelConfig.params) {
        tr.setParams(channelConfig.params);
      }
    } catch (err: unknown) {
      log.error(`Failed to compile mixer channel ${i}:`, err);
    }

    mixerChannelAlphas[i] = channelConfig.alpha ?? 1;
    mixerRenderers[i] = tr;
    mixerSelectedChannel = i;
  }
}

function renderMixerFrame(): void {
  const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement;

  const hasChannels: boolean = mixerRenderers.some(Boolean) || mixerAssets.some(Boolean);
  if (!mixerOverlayCanvas || !mixerOverlayCtx || !hasChannels) return;

  // Ensure overlay matches canvas size
  if (mixerOverlayCanvas.width !== canvas.width || mixerOverlayCanvas.height !== canvas.height) {
    mixerOverlayCanvas.width = canvas.width;
    mixerOverlayCanvas.height = canvas.height;
    mixerOverlayCtx = mixerOverlayCanvas.getContext('2d');

    // Update TileRenderer bounds
    mixerRenderers.forEach((tr: TileRenderer | null) => {
      if (tr) {
        tr.setBounds({ tileIndex: tr.bounds.tileIndex, x: 0, y: 0, width: canvas.width, height: canvas.height });
      }
    });
  }

  const ctx = mixerOverlayCtx;
  const gl = sharedGL;
  if (!ctx || !gl) return;

  // Prepare shared state (same as tiled mode)
  const sharedState: TileSharedState = prepareSharedState();

  // Clear 2D overlay to opaque black
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Set blend mode for compositing
  ctx.globalCompositeOperation = mixerBlendMode;

  // Ensure clean GL state for mixer rendering
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  // Render each active channel (shaders + assets)
  const maxChannels: number = Math.max(mixerRenderers.length, mixerAssets.length);
  for (let i = 0; i < maxChannels; i++) {
    const alpha: number = i < mixerChannelAlphas.length ? mixerChannelAlphas[i] : 1;
    if (alpha <= 0) continue;

    // Check for asset channel first
    const asset: AssetEntry | null = i < mixerAssets.length ? mixerAssets[i] : null;
    if (asset && asset.source) {
      if (asset.type === 'asset-video') {
        updateVideoLoop(asset.source as HTMLVideoElement, asset.params);
      }
      ctx.globalAlpha = alpha;
      try {
        drawAssetWithCrop(ctx, asset.source, asset.params, canvas.width, canvas.height);
      } catch (_err: unknown) {
        // Image may not be loaded yet
      }
      continue;
    }

    // Shader channel
    const tr: TileRenderer | null = i < mixerRenderers.length ? mixerRenderers[i] : null;
    if (!tr || !tr.program) continue;

    // Render the channel's shader to the WebGL canvas
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    try {
      tr.render(sharedState);
    } catch (err: unknown) {
      log.error(`Mixer channel ${i} render error:`, err);
      continue;
    }

    // Composite WebGL result onto 2D overlay with alpha
    ctx.globalAlpha = alpha;
    ctx.drawImage(canvas, 0, 0);
  }

  ctx.globalAlpha = 1.0;
  ctx.globalCompositeOperation = 'source-over';
  mixerOverlayCanvas.style.display = 'block';

  if (shaderRenderer!.isPlaying) {
    shaderRenderer!.frameCount++;
  }
}

function exitMixerMode(): void {
  mixerMode = false;
  mixerSelectedChannel = -1;
  mixerRenderers.forEach((r: TileRenderer | null) => { if (r) r.dispose(); });
  mixerRenderers = [];
  // Clean up asset sources
  mixerAssets.forEach((a: AssetEntry | null) => {
    if (a?.source instanceof HTMLVideoElement) {
      a.source.pause();
      a.source.removeAttribute('src');
      a.source.load();
    }
  });
  mixerAssets = [];
  if (mixerOverlayCanvas) {
    mixerOverlayCanvas.style.display = 'none';
  }
}

function initMixerModeIfNeeded(canvas: HTMLCanvasElement): void {
  mixerMode = true;

  if (!mixerOverlayCanvas) {
    mixerOverlayCanvas = document.createElement('canvas');
    mixerOverlayCanvas.id = 'mixer-overlay-canvas';
    mixerOverlayCanvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1';
    const parent = canvas.parentElement;
    if (parent) {
      parent.style.position = 'relative';
      parent.appendChild(mixerOverlayCanvas);
    }
  }

  mixerOverlayCanvas.width = canvas.width;
  mixerOverlayCanvas.height = canvas.height;
  mixerOverlayCtx = mixerOverlayCanvas.getContext('2d');
}

/**
 * Convert a file path to a proper file:// URL (handles Windows paths).
 */
function toFileUrl(filePath: string): string {
  if (filePath.startsWith('file://')) return filePath;
  if (filePath.startsWith('/')) return `file://${filePath}`;
  return `file:///${filePath.replace(/\\/g, '/')}`;
}

// =============================================================================
// Exported functions
// =============================================================================

/**
 * DOMContentLoaded logic — sets up canvas, renderer, refresh rate, resize, hints.
 */
export function initFullscreen(): void {
  document.addEventListener('DOMContentLoaded', async () => {
    const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement;

    // Set canvas to full window size
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Initialize shader renderer (always available)
    shaderRenderer = new ShaderRenderer(canvas);

    // Default to shader renderer (scene renderer created on demand)
    renderer = shaderRenderer;

    // Get display refresh rate and set frame interval limit
    try {
      const refreshRate: number = await window.electronAPI.getDisplayRefreshRate();
      if (refreshRate && refreshRate > 0) {
        targetRefreshRate = refreshRate;
        // Allow slightly faster than refresh rate to avoid frame drops
        minFrameInterval = (1000 / targetRefreshRate) * 0.95;
      }
    } catch (_err: unknown) {
      log.warn('Could not get display refresh rate, using 60Hz default');
      minFrameInterval = (1000 / 60) * 0.95;
    }

    // Handle window resize
    window.addEventListener('resize', () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      shaderRenderer!.setResolution(window.innerWidth, window.innerHeight);
      if (sceneRenderer) {
        sceneRenderer.setResolution(window.innerWidth, window.innerHeight);
      }
    });

    // Fade out the exit hint after 3 seconds
    setTimeout(() => {
      const hint = document.getElementById('exit-hint');
      if (hint) hint.classList.add('fade');
    }, 3000);

    // Show preset bar on mouse move
    document.addEventListener('mousemove', showPresetBar);

    // Keyboard shortcuts for presets (1-9 for global, Shift+1-9 for local)
    document.addEventListener('keydown', handlePresetKey);

    // Start render loop
    renderLoop();
  });
}

/**
 * Main render loop — called via requestAnimationFrame.
 */
export function renderLoop(currentTime?: number): void {
  animationId = requestAnimationFrame(renderLoop);

  // Frame rate limiting - skip frame if too soon
  if (currentTime !== undefined && minFrameInterval > 0 && currentTime - lastFrameTime < minFrameInterval) {
    return;
  }
  if (currentTime !== undefined) {
    lastFrameTime = currentTime;
  }

  // FPS calculation
  frameCount++;
  const elapsed: number = (currentTime ?? performance.now()) - lastFpsTime;
  if (elapsed >= 1000) {
    currentFps = Math.round((frameCount * 1000) / elapsed);
    frameCount = 0;
    lastFpsTime = currentTime ?? performance.now();

    // Send FPS to main window
    window.electronAPI.sendFullscreenFps(currentFps);
  }

  if (blackoutEnabled) {
    // Clear to black when blackout is enabled
    const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement;
    const gl: WebGL2RenderingContext | WebGLRenderingContext | null =
      canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (mixerOverlayCanvas) mixerOverlayCanvas.style.display = 'none';
  } else if (mixerMode) {
    renderMixerFrame();
  } else if (tiledMode) {
    renderTiledFrame();
  } else if (renderMode === 'asset' && standaloneAsset) {
    renderStandaloneAsset();
  } else {
    renderer!.render();
    if (mixerOverlayCanvas) mixerOverlayCanvas.style.display = 'none';
    if (standaloneOverlayCanvas) standaloneOverlayCanvas.style.display = 'none';
  }
}

/**
 * Register all IPC handlers for communication with the main window.
 */
export function registerIPCHandlers(): void {
  // Initialize with shader/scene state from main window
  window.electronAPI.onInitFullscreen(async (state: InitFullscreenState) => {
    // Switch renderer if mode specified
    if (state.renderMode) {
      renderMode = state.renderMode;
      if (renderMode === 'scene') {
        renderer = await ensureSceneRenderer();
      } else {
        renderer = shaderRenderer!;
      }
    }

    // Set resolution to native display resolution
    shaderRenderer!.setResolution(window.innerWidth, window.innerHeight);
    if (sceneRenderer) {
      sceneRenderer.setResolution(window.innerWidth, window.innerHeight);
    }

    // Compile the shader/scene
    if (state.shaderCode) {
      try {
        renderer!.compile(state.shaderCode);
        loadFileTexturesForRenderer(renderer!);
      } catch (err: unknown) {
        log.error('Compile error:', err);
      }
    }

    // Sync time
    if (state.time !== undefined) {
      renderer!.startTime = performance.now() - (state.time * 1000);
      renderer!.frameCount = state.frame || 0;
      renderer!.isPlaying = state.isPlaying !== false;
      if (!renderer!.isPlaying) {
        renderer!.pausedTime = state.time * 1000;
      }
    }

    // Load textures/videos/cameras
    if (state.channels) {
      state.channels.forEach((channel: ChannelInfo | null, index: number) => {
        if (channel) {
          loadChannel(index, channel);
        }
      });
    }

    // Set custom parameters
    if (state.params) {
      Object.keys(state.params).forEach((name: string) => {
        renderer!.setParam(name, state.params![name]);
      });
    }

    // Load presets
    if (state.localPresets) {
      localPresets = state.localPresets;
    }
    activeLocalPresetIndex = state.activeLocalPresetIndex ?? null;

    createPresetButtons();

    // Initialize tiled mode if configuration provided
    if (state.tiledConfig) {
      initTiledMode(state.tiledConfig);
    }

    // Initialize mixer mode if configuration provided
    if (state.mixerConfig) {
      initMixerMode(state.mixerConfig);
    }
  });

  // Handle shader/scene updates from main window
  window.electronAPI.onShaderUpdate(async (data: ShaderUpdateData) => {
    // Clear standalone asset when switching to shader/scene
    if (standaloneAsset) {
      clearStandaloneAsset();
    }
    // Exit mixer mode when switching to single shader/scene
    if (mixerMode) {
      exitMixerMode();
    }

    // Switch renderer if mode changed
    if (data.renderMode && data.renderMode !== renderMode) {
      renderMode = data.renderMode;
      if (renderMode === 'scene') {
        renderer = await ensureSceneRenderer();
      } else {
        renderer = shaderRenderer!;
        // Reinitialize GL state after Three.js has used the shared WebGL context
        shaderRenderer!.reinitialize();
      }
      renderer.setResolution(window.innerWidth, window.innerHeight);
    }

    if (data.shaderCode) {
      try {
        renderer!.compile(data.shaderCode);
        loadFileTexturesForRenderer(renderer!);
      } catch (err: unknown) {
        log.error('Compile error:', err);
      }
    }
  });

  // Handle time sync from main window
  window.electronAPI.onTimeSync((data: TimeSyncData) => {
    if (data.time !== undefined) {
      renderer!.startTime = performance.now() - (data.time * 1000);
      renderer!.frameCount = data.frame || 0;
      renderer!.isPlaying = data.isPlaying !== false;
      if (!renderer!.isPlaying) {
        renderer!.pausedTime = data.time * 1000;
      }
    }
  });

  // Handle param updates from main window
  window.electronAPI.onParamUpdate((data: ParamUpdateData) => {
    if (data.name && data.value !== undefined) {
      // Route to standalone asset when in asset mode
      if (renderMode === 'asset' && standaloneAsset) {
        standaloneAsset.params[data.name] = data.value as number;
        return;
      }
      renderer!.setParam(data.name, data.value);
      // Also route to the active mixer channel when in mixer mode
      if (mixerMode && mixerSelectedChannel >= 0 && mixerRenderers[mixerSelectedChannel]) {
        mixerRenderers[mixerSelectedChannel]!.setParam(data.name, data.value);
      }
    }
  });

  // Handle batched param updates from main window (more efficient)
  window.electronAPI.onBatchParamUpdate?.((params: Record<string, ParamValue | ParamArrayValue>) => {
    if (params && typeof params === 'object') {
      const mixerTarget: TileRenderer | null =
        (mixerMode && mixerSelectedChannel >= 0) ? mixerRenderers[mixerSelectedChannel] : null;
      Object.entries(params).forEach(([name, value]: [string, ParamValue | ParamArrayValue]) => {
        renderer!.setParam(name, value);
        if (mixerTarget) mixerTarget.setParam(name, value);
      });
    }
  });

  // Handle preset sync from main window
  window.electronAPI.onPresetSync((data: PresetSyncData) => {
    // Apply params directly from sync message
    if (data.params) {
      const mixerTarget: TileRenderer | null =
        (mixerMode && mixerSelectedChannel >= 0) ? mixerRenderers[mixerSelectedChannel] : null;
      Object.keys(data.params).forEach((name: string) => {
        renderer!.setParam(name, data.params[name]);
        if (mixerTarget) mixerTarget.setParam(name, data.params[name]);
      });
    }

    // Update highlighting
    if (data.type === 'local') {
      activeLocalPresetIndex = data.index;
    }
    updatePresetHighlights();
  });

  // Handle blackout from main window
  window.electronAPI.onBlackout((enabled: boolean) => {
    blackoutEnabled = enabled;
  });

  // IPC handler for standalone asset display
  window.electronAPI.onAssetUpdate?.((data: AssetUpdateData) => {
    const { assetType, dataUrl, filePath, params, clear } = data;

    if (clear) {
      clearStandaloneAsset();
      renderMode = 'shader';
      return;
    }

    const assetParams: Record<string, number> = params || {};

    if (assetType === 'asset-image' && dataUrl) {
      const img: HTMLImageElement = new Image();
      img.onload = (): void => {
        clearStandaloneAsset();
        standaloneAsset = { source: img, type: assetType, params: assetParams };
        renderMode = 'asset';
      };
      img.src = dataUrl;
    } else if (assetType === 'asset-video' && filePath) {
      const video: HTMLVideoElement = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.loop = true;
      const fileUrl: string = toFileUrl(filePath);
      video.onloadedmetadata = (): void => {
        clearStandaloneAsset();
        standaloneAsset = { source: video, type: assetType, params: assetParams };
        renderMode = 'asset';
        video.play().catch(() => { /* noop */ });
      };
      video.src = fileUrl;
    }
  });

  // =========================================================================
  // Mixer Mode IPC Handlers
  // =========================================================================

  window.electronAPI.onMixerParamUpdate?.((data: MixerParamData) => {
    const { channelIndex, paramName, value } = data;
    if (channelIndex < 0) return;

    // Check if this is an asset channel
    if (channelIndex < mixerAssets.length && mixerAssets[channelIndex]) {
      mixerAssets[channelIndex]!.params[paramName] = value as number;
      mixerSelectedChannel = channelIndex;
      return;
    }

    // Shader channel
    if (channelIndex < mixerRenderers.length && mixerRenderers[channelIndex]) {
      mixerRenderers[channelIndex]!.setParam(paramName, value);
      mixerSelectedChannel = channelIndex;
    }
  });

  window.electronAPI.onMixerAlphaUpdate?.((data: MixerAlphaData) => {
    const { channelIndex, alpha } = data;
    if (channelIndex >= 0) {
      // Grow array if needed
      while (mixerChannelAlphas.length <= channelIndex) mixerChannelAlphas.push(1);
      mixerChannelAlphas[channelIndex] = alpha;
    }
  });

  window.electronAPI.onMixerBlendMode?.((data: MixerBlendModeData) => {
    const { blendMode } = data;
    if (blendMode) {
      mixerBlendMode = blendMode;
    }
  });

  window.electronAPI.onMixerChannelUpdate?.((data: MixerChannelUpdateData) => {
    const { channelIndex, shaderCode, params, clear, assetType, dataUrl, filePath } = data;
    if (channelIndex < 0) return;

    const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement;

    if (clear) {
      // Clear this channel
      if (channelIndex < mixerRenderers.length && mixerRenderers[channelIndex]) {
        mixerRenderers[channelIndex]!.dispose();
        mixerRenderers[channelIndex] = null;
      }
      // Clear asset source
      while (mixerAssets.length <= channelIndex) mixerAssets.push(null);
      if (mixerAssets[channelIndex]) {
        if (mixerAssets[channelIndex]!.source instanceof HTMLVideoElement) {
          (mixerAssets[channelIndex]!.source as HTMLVideoElement).pause();
          (mixerAssets[channelIndex]!.source as HTMLVideoElement).removeAttribute('src');
          (mixerAssets[channelIndex]!.source as HTMLVideoElement).load();
        }
        mixerAssets[channelIndex] = null;
      }
      if (channelIndex < mixerChannelAlphas.length) {
        mixerChannelAlphas[channelIndex] = 1;
      }

      // Auto-select next active channel if cleared channel was selected
      if (mixerSelectedChannel === channelIndex) {
        mixerSelectedChannel = -1;
        for (let i = 0; i < mixerRenderers.length; i++) {
          if (i !== channelIndex && (mixerRenderers[i] || mixerAssets[i])) {
            mixerSelectedChannel = i;
            break;
          }
        }
      }

      // If no channels active, exit mixer mode
      const hasAny: boolean = mixerRenderers.some(Boolean) || mixerAssets.some(Boolean);
      if (!hasAny) {
        exitMixerMode();
      }
      return;
    }

    // Handle asset channels (images and videos)
    if (assetType) {
      while (mixerAssets.length <= channelIndex) mixerAssets.push(null);
      while (mixerChannelAlphas.length <= channelIndex) mixerChannelAlphas.push(1);

      // Clear any existing shader renderer for this channel
      if (channelIndex < mixerRenderers.length && mixerRenderers[channelIndex]) {
        mixerRenderers[channelIndex]!.dispose();
        mixerRenderers[channelIndex] = null;
      }

      // Clean up previous asset
      if (mixerAssets[channelIndex]?.source instanceof HTMLVideoElement) {
        (mixerAssets[channelIndex]!.source as HTMLVideoElement).pause();
      }

      const isVideo: boolean = assetType === 'asset-video';

      if (isVideo && filePath) {
        const video: HTMLVideoElement = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.loop = true;
        const fileUrl: string = toFileUrl(filePath);
        video.src = fileUrl;
        video.play().catch(() => { /* noop */ });
        mixerAssets[channelIndex] = {
          source: video,
          type: assetType,
          params: (params as Record<string, number>) || {},
        };
      } else if (dataUrl) {
        const img: HTMLImageElement = new Image();
        img.src = dataUrl;
        mixerAssets[channelIndex] = {
          source: img,
          type: assetType,
          params: (params as Record<string, number>) || {},
        };
      }

      mixerSelectedChannel = channelIndex;
      if (!mixerMode) initMixerModeIfNeeded(canvas);
      return;
    }

    if (!shaderCode) return;

    // Ensure shared GL is available
    if (!sharedGL) {
      sharedGL = shaderRenderer!.gl;
    }

    // Grow arrays as needed
    while (mixerRenderers.length <= channelIndex) mixerRenderers.push(null);
    while (mixerChannelAlphas.length <= channelIndex) mixerChannelAlphas.push(1);

    // Clear any asset for this channel
    while (mixerAssets.length <= channelIndex) mixerAssets.push(null);
    mixerAssets[channelIndex] = null;

    // Create or replace TileRenderer for this channel
    if (mixerRenderers[channelIndex]) {
      mixerRenderers[channelIndex]!.dispose();
    }

    const bounds: TileBounds = { tileIndex: channelIndex, x: 0, y: 0, width: canvas.width, height: canvas.height };
    const tr: TileRenderer = new TileRenderer(sharedGL, bounds);

    try {
      tr.compile(shaderCode);
      loadFileTexturesForRenderer(tr);
      if (params) {
        tr.setParams(params);
      }
    } catch (err: unknown) {
      log.error(`Failed to compile mixer channel ${channelIndex}:`, err);
    }

    mixerRenderers[channelIndex] = tr;
    mixerSelectedChannel = channelIndex;

    // Ensure mixer mode is active
    if (!mixerMode) {
      initMixerModeIfNeeded(canvas);
    }
  });

  // =========================================================================
  // Tiled Mode IPC Handlers
  // =========================================================================

  // Initialize tiled fullscreen mode
  window.electronAPI.onInitTiledFullscreen?.((config: TiledConfig) => {
    log.info('Received tiled fullscreen init:', config);
    initTiledMode(config);
  });

  // Update tile layout
  window.electronAPI.onTileLayoutUpdate?.((layout: TileLayout) => {
    updateTileLayout(layout);
  });

  // Assign shader to a tile
  window.electronAPI.onTileAssign?.((data: TileAssignData) => {
    const { tileIndex, shaderCode, params } = data;
    assignTileShader(tileIndex, shaderCode, params);
  });

  // Update tile parameter
  window.electronAPI.onTileParamUpdate?.((data: TileParamUpdateData) => {
    const { tileIndex, name, value } = data;
    updateTileParam(tileIndex, name, value);
  });

  // Exit tiled mode
  window.electronAPI.onExitTiledMode?.(() => {
    exitTiledMode();
  });
}
