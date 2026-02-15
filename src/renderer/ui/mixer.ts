// Shader Mixer — dynamic channel compositor with per-channel parameters.
// Typed version of js/mixer.js.

import { state, notifyRemoteStateChanged } from '../core/state.js';
import type { ParamValue } from '@shared/types/params.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal electronAPI surface used by this module */
declare const window: Window & {
  electronAPI: {
    sendMixerAlphaUpdate(data: { channelIndex: number; alpha: number }): void;
    sendMixerBlendMode(data: { blendMode: string }): void;
    sendMixerChannelUpdate(data: Record<string, unknown>): void;
    sendMixerParamUpdate(data: { channelIndex: number; paramName: string; value: ParamValue }): void;
    sendParamUpdate(data: { name: string; value: unknown }): void;
    getMediaAbsolutePath(mediaPath: string): Promise<string>;
    loadMediaDataUrl(mediaPath: string): Promise<{ success: boolean; dataUrl?: string }>;
  };
};

/** Minimal MiniShaderRenderer surface */
interface MiniRendererLike {
  compile(source: string): unknown;
  customParams?: Array<{ name: string; default: ParamValue }>;
  customParamValues: Record<string, ParamValue>;
  setSpeed(speed: number): void;
  renderDirect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void;
  setParam?(name: string, value: ParamValue): void;
  dispose?(): void;
}

/** AssetRenderer-like */
interface AssetRendererLike {
  mediaPath: string;
  assetType?: string;
  image?: { src: string };
  setParams(params: Record<string, ParamValue>): void;
  loadVideo(absPath: string): Promise<void>;
  loadImage(dataUrl: string): Promise<void>;
  renderDirect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void;
  dispose?(): void;
}

/** Runtime shape of a mixer channel (extends the typed MixerChannel) */
interface MixerChannelRuntime {
  slotIndex: number | null;
  tabIndex?: number | null;
  alpha: number;
  params: Record<string, ParamValue>;
  customParams: Record<string, ParamValue>;
  renderer: MiniRendererLike | AssetRendererLike | null;
  shaderCode: string | null;
  assetType?: string | null;
  mediaPath?: string;
  _ownsRenderer?: boolean;
}

/** Grid slot data (runtime shape) */
interface GridSlotLike {
  shaderCode?: string | null;
  filePath?: string | null;
  params?: Record<string, ParamValue> | null;
  customParams?: Record<string, ParamValue> | null;
  renderer?: MiniRendererLike | null;
  type?: string;
  label?: string;
  mediaPath?: string;
}

/** Shader tab with slots */
interface ShaderTabLike {
  name: string;
  slots?: Array<GridSlotLike | null>;
}

/** Mix preset (from presets module) */
export interface MixPreset {
  name: string;
  blendMode?: string;
  channels?: MixPresetChannel[];
}

interface MixPresetChannel {
  alpha?: number;
  params?: Record<string, ParamValue>;
  customParams?: Record<string, ParamValue>;
  shaderCode?: string | null;
  assetType?: string | null;
  mediaPath?: string;
}

import { loadParamsToSliders, generateCustomParamUI } from './params.js';
import { updateLocalPresetsUI } from './presets.js';
import { setStatus } from './utils.js';
import { MiniShaderRenderer } from '../renderers/mini-shader-renderer.js';
import { AssetRenderer } from '../renderers/asset-renderer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MIXER_CHANNELS = 8;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let mixerOverlayCanvas: HTMLCanvasElement | null = null;
let mixerOverlayCtx: CanvasRenderingContext2D | null = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function channels(): MixerChannelRuntime[] {
  return state.mixerChannels as MixerChannelRuntime[];
}

function tabs(): ShaderTabLike[] {
  return state.shaderTabs as ShaderTabLike[];
}

function slots(): Array<GridSlotLike | null> {
  return state.gridSlots as Array<GridSlotLike | null>;
}

function mainRenderer(): MiniRendererLike {
  return state.renderer as MiniRendererLike;
}

// Create a mixer channel DOM element and attach event handlers
function createChannelElement(index: number): HTMLDivElement {
  const channelEl = document.createElement('div');
  channelEl.className = 'mixer-channel';
  channelEl.dataset.channel = String(index);

  const btn = document.createElement('button');
  btn.className = 'mixer-btn';
  btn.title = 'Click to arm, then click a grid shader to assign. Right-click to clear.';
  btn.textContent = '\u2014';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'mixer-slider';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.01';
  slider.value = '1';

  channelEl.appendChild(btn);
  channelEl.appendChild(slider);

  // Left click: if assigned, select for param editing; if not, arm/disarm
  btn.addEventListener('click', () => {
    const ch = channels()[index];
    if (state.mixerArmedChannel === index) {
      state.mixerArmedChannel = null;
      btn.classList.remove('armed');
      setStatus('Mixer channel disarmed', 'success');
    } else if ((ch.slotIndex !== null && ch.tabIndex != null) || ch.renderer) {
      disarmAll();
      selectMixerChannel(index);
    } else {
      disarmAll();
      state.mixerArmedChannel = index;
      btn.classList.add('armed');
      setStatus(`Mixer channel ${index + 1} armed \u2014 click a grid shader to assign`, 'success');
    }
  });

  btn.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    clearMixerChannel(index);
  });

  slider.addEventListener('input', () => {
    const alpha = parseFloat(slider.value);
    channels()[index].alpha = alpha;
    window.electronAPI.sendMixerAlphaUpdate({ channelIndex: index, alpha });
  });

  return channelEl;
}

function updateAddButtonVisibility(): void {
  const addBtn = document.getElementById('mixer-add-btn');
  if (addBtn) {
    addBtn.classList.toggle('hidden', state.mixerChannels.length >= MAX_MIXER_CHANNELS);
  }
}

// Rebuild all channel DOM elements from state (used after splice)
function rebuildChannelElements(): void {
  const container = document.getElementById('mixer-channels');
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < channels().length; i++) {
    const ch = channels()[i];
    const el = createChannelElement(i);
    const btn = el.querySelector('.mixer-btn') as HTMLButtonElement;
    const slider = el.querySelector('.mixer-slider') as HTMLInputElement;

    if ((ch.slotIndex !== null && ch.tabIndex != null) || ch.renderer) {
      if (ch.assetType) {
        btn.textContent = ch.slotIndex !== null ? 'A' + String(ch.slotIndex + 1) : 'A';
      } else {
        btn.textContent = ch.renderer && ch.slotIndex === null ? 'M' : String((ch.slotIndex ?? 0) + 1);
      }
      btn.classList.add('assigned');
    }
    if (state.mixerSelectedChannel === i) {
      btn.classList.add('selected');
    }
    if (state.mixerArmedChannel === i) {
      btn.classList.add('armed');
    }
    slider.value = String(ch.alpha);

    container.appendChild(el);
  }
  updateAddButtonVisibility();
}

function syncToggleButton(): void {
  const btn = document.getElementById('mixer-toggle-btn');
  if (btn) btn.classList.toggle('active', state.mixerEnabled);
}

function disarmAll(): void {
  state.mixerArmedChannel = null;
  const btns = document.querySelectorAll('#mixer-channels .mixer-btn');
  btns.forEach(b => b.classList.remove('armed'));
}

// Select a mixer channel for parameter editing
function selectMixerChannel(channelIndex: number): void {
  const ch = channels()[channelIndex];
  if (ch.slotIndex === null && ch.tabIndex === null && !ch.renderer) return;

  const btns = document.querySelectorAll('#mixer-channels .mixer-btn');
  btns.forEach(b => b.classList.remove('selected'));
  btns[channelIndex]?.classList.add('selected');

  state.mixerSelectedChannel = channelIndex;

  // For grid-assigned channels, look up from the correct tab
  let slotData: GridSlotLike | null = null;
  if (ch.slotIndex !== null && ch.tabIndex != null) {
    const tab = tabs()[ch.tabIndex];
    slotData = tab?.slots?.[ch.slotIndex] || null;
  }
  const shaderCode = slotData?.shaderCode || ch.shaderCode;

  if (slotData) {
    if (state.activeGridSlot !== null) {
      const prevSlot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
      if (prevSlot) prevSlot.classList.remove('active');
    }
    state.activeGridSlot = ch.slotIndex;
    const slot = document.querySelector(`.grid-slot[data-slot="${ch.slotIndex}"]`);
    if (slot) slot.classList.add('active');
  }

  const isAsset = ch.assetType || slotData?.type?.startsWith('asset-');

  if (!isAsset) {
    if (shaderCode) {
      try {
        mainRenderer().compile(shaderCode);
      } catch (err: unknown) {
        console.warn('Mixer: Failed to compile shader for param UI:', (err as Error).message);
      }
    }
    const allParams = { ...ch.params, ...ch.customParams };
    loadParamsToSliders(allParams, { skipMixerSync: true });
  }

  generateCustomParamUI();
  updateLocalPresetsUI();

  const name = isAsset
    ? (slotData?.label || slotData?.mediaPath || `Asset ${(ch.slotIndex ?? 0) + 1}`)
    : (slotData?.filePath?.split('/').pop()?.split('\\').pop() || (ch.shaderCode ? 'Mix Preset' : `Slot ${(ch.slotIndex ?? 0) + 1}`));
  setStatus(`Mixer ${channelIndex + 1}: ${name}`, 'success');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function addMixerChannel(): number | null {
  if (state.mixerChannels.length >= MAX_MIXER_CHANNELS) return null;

  const newIndex = state.mixerChannels.length;
  (state.mixerChannels as MixerChannelRuntime[]).push({
    slotIndex: null, alpha: 1.0, params: {}, customParams: {}, renderer: null, shaderCode: null
  });

  const container = document.getElementById('mixer-channels');
  if (container) {
    container.appendChild(createChannelElement(newIndex));
  }

  updateAddButtonVisibility();
  console.info('[Mixer] Channel added, total:', state.mixerChannels.length);
  notifyRemoteStateChanged();
  return newIndex;
}

export function initMixer(): void {
  const panel = document.getElementById('mixer-panel');
  if (!panel) return;

  rebuildChannelElements();

  const blendSelect = document.getElementById('mixer-blend-mode') as HTMLSelectElement | null;
  if (blendSelect) {
    blendSelect.value = state.mixerBlendMode;
    blendSelect.addEventListener('change', () => {
      state.mixerBlendMode = blendSelect.value as typeof state.mixerBlendMode;
      window.electronAPI.sendMixerBlendMode({ blendMode: blendSelect.value });
    });
  }

  const resetBtn = document.getElementById('mixer-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => resetMixer());
  }

  const toggleBtn = document.getElementById('mixer-toggle-btn');
  if (toggleBtn) {
    if (state.mixerEnabled) toggleBtn.classList.add('active');
    toggleBtn.addEventListener('click', () => {
      state.mixerEnabled = !state.mixerEnabled;
      toggleBtn.classList.toggle('active', state.mixerEnabled);
      if (!state.mixerEnabled) hideMixerOverlay();
      generateCustomParamUI();
      setStatus(state.mixerEnabled ? 'Mixer enabled' : 'Mixer disabled', 'success');
    });
  }

  const addBtn = document.getElementById('mixer-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const newIndex = addMixerChannel();
      if (newIndex !== null) {
        disarmAll();
        state.mixerArmedChannel = newIndex;
        const btns = document.querySelectorAll('#mixer-channels .mixer-btn');
        btns[newIndex]?.classList.add('armed');
        setStatus(`Mixer channel ${newIndex + 1} added and armed`, 'success');
      }
    });
    updateAddButtonVisibility();
  }
}

export function assignShaderToMixer(channelIndex: number, slotIndex: number): void {
  const ch = channels()[channelIndex];

  if (ch.renderer && ch._ownsRenderer && (ch.renderer as MiniRendererLike).dispose) {
    (ch.renderer as MiniRendererLike).dispose!();
  }
  ch.renderer = null;
  ch.shaderCode = null;
  ch._ownsRenderer = false;

  ch.slotIndex = slotIndex;
  ch.tabIndex = state.activeShaderTab;

  const slotData = slots()[slotIndex];

  ch.shaderCode = slotData?.shaderCode || null;
  ch.params = { ...(slotData?.params || {}) };
  ch.customParams = {};

  const miniRenderer = slotData?.renderer as MiniRendererLike | null;
  if (miniRenderer?.customParams) {
    for (const param of miniRenderer.customParams) {
      const slotVal = slotData?.customParams?.[param.name];
      if (slotVal !== undefined) {
        ch.customParams[param.name] = Array.isArray(slotVal) ? [...slotVal] : slotVal;
      } else {
        ch.customParams[param.name] = Array.isArray(param.default) ? [...(param.default as number[])] : param.default;
      }
    }
  }

  const btn = document.querySelectorAll('#mixer-channels .mixer-btn')[channelIndex];
  if (btn) {
    btn.textContent = String(slotIndex + 1);
    btn.classList.add('assigned');
    btn.classList.remove('armed');
  }

  state.mixerArmedChannel = null;
  state.mixerEnabled = true;
  syncToggleButton();
  selectMixerChannel(channelIndex);

  window.electronAPI.sendMixerChannelUpdate({
    channelIndex,
    shaderCode: slotData?.shaderCode,
    params: { speed: ch.params.speed ?? 1, ...ch.customParams }
  });

  const name = slotData?.filePath?.split('/').pop()?.split('\\').pop() || `Slot ${slotIndex + 1}`;
  setStatus(`Mixer ${channelIndex + 1} \u2190 ${name}`, 'success');
  notifyRemoteStateChanged();
}

export function assignAssetToMixer(channelIndex: number, slotIndex: number): void {
  const ch = channels()[channelIndex];

  if (ch.renderer && ch._ownsRenderer && (ch.renderer as MiniRendererLike).dispose) {
    (ch.renderer as MiniRendererLike).dispose!();
  }
  ch.renderer = null;
  ch.shaderCode = null;
  ch._ownsRenderer = false;

  ch.slotIndex = slotIndex;
  ch.tabIndex = state.activeShaderTab;

  const slotData = slots()[slotIndex];
  ch.assetType = slotData?.type || null;
  ch.params = {};
  ch.customParams = { ...(slotData?.customParams || {}) };

  const btn = document.querySelectorAll('#mixer-channels .mixer-btn')[channelIndex];
  if (btn) {
    btn.textContent = 'A' + String(slotIndex + 1);
    btn.classList.add('assigned');
    btn.classList.remove('armed');
  }

  state.mixerArmedChannel = null;
  state.mixerEnabled = true;
  syncToggleButton();
  selectMixerChannel(channelIndex);

  const assetRenderer = slotData?.renderer as unknown as AssetRendererLike | null;
  const updateData: Record<string, unknown> = {
    channelIndex,
    assetType: slotData?.type,
    mediaPath: slotData?.mediaPath,
    params: { ...ch.customParams }
  };

  if (assetRenderer?.assetType === 'image' && assetRenderer?.image?.src) {
    updateData.dataUrl = assetRenderer.image.src;
  }
  if (assetRenderer?.assetType === 'video') {
    window.electronAPI.getMediaAbsolutePath(slotData!.mediaPath!).then(absPath => {
      updateData.filePath = absPath;
      window.electronAPI.sendMixerChannelUpdate(updateData);
    });
  } else {
    window.electronAPI.sendMixerChannelUpdate(updateData);
  }

  const name = slotData?.label || slotData?.mediaPath || `Asset ${slotIndex + 1}`;
  setStatus(`Mixer ${channelIndex + 1} \u2190 ${name}`, 'success');
  notifyRemoteStateChanged();
}

export function clearMixerChannel(channelIndex: number): void {
  const ch = channels()[channelIndex];

  if (ch.renderer && ch._ownsRenderer && (ch.renderer as MiniRendererLike).dispose) {
    (ch.renderer as MiniRendererLike).dispose!();
  }

  if (state.mixerChannels.length > 1) {
    (state.mixerChannels as MixerChannelRuntime[]).splice(channelIndex, 1);

    if (state.mixerArmedChannel === channelIndex) {
      state.mixerArmedChannel = null;
    } else if (state.mixerArmedChannel !== null && state.mixerArmedChannel > channelIndex) {
      state.mixerArmedChannel--;
    }

    if (state.mixerSelectedChannel === channelIndex) {
      state.mixerSelectedChannel = null;
      for (let i = 0; i < channels().length; i++) {
        const other = channels()[i];
        if ((other.slotIndex !== null && other.tabIndex !== null) || other.renderer) {
          state.mixerSelectedChannel = i;
          break;
        }
      }
    } else if (state.mixerSelectedChannel !== null && state.mixerSelectedChannel > channelIndex) {
      state.mixerSelectedChannel--;
    }

    rebuildChannelElements();
    window.electronAPI.sendMixerChannelUpdate({ channelIndex, clear: true });

    if (!isMixerActive()) hideMixerOverlay();
    generateCustomParamUI();

    setStatus(`Mixer channel ${channelIndex + 1} removed`, 'success');
    notifyRemoteStateChanged();
    return;
  }

  // Single channel — just reset it
  ch.renderer = null;
  ch.shaderCode = null;
  ch.assetType = null;
  ch._ownsRenderer = false;
  ch.slotIndex = null;
  ch.tabIndex = null;
  ch.alpha = 1.0;
  ch.params = {};
  ch.customParams = {};

  const btn = document.querySelectorAll('#mixer-channels .mixer-btn')[channelIndex];
  if (btn) {
    btn.textContent = '\u2014';
    btn.classList.remove('assigned', 'armed', 'selected');
  }

  const slider = document.querySelectorAll('#mixer-channels .mixer-slider')[channelIndex] as HTMLInputElement | undefined;
  if (slider) slider.value = '1';

  if (state.mixerArmedChannel === channelIndex) state.mixerArmedChannel = null;
  if (state.mixerSelectedChannel === channelIndex) state.mixerSelectedChannel = null;

  if (!isMixerActive()) hideMixerOverlay();
  window.electronAPI.sendMixerChannelUpdate({ channelIndex, clear: true });
  generateCustomParamUI();

  setStatus(`Mixer channel ${channelIndex + 1} cleared`, 'success');
  notifyRemoteStateChanged();
}

export function isMixerActive(): boolean {
  if (!state.mixerEnabled) return false;
  return channels().some(ch => {
    if (ch.renderer) return true;
    if (ch.slotIndex !== null && ch.tabIndex != null) {
      const tab = tabs()[ch.tabIndex];
      return !!(tab?.slots?.[ch.slotIndex]?.renderer);
    }
    return false;
  });
}

export function resetMixer(): void {
  console.info('[Mixer] Resetting mixer, disposing', state.mixerChannels.length, 'channels');
  for (const ch of channels()) {
    if (ch.renderer && ch._ownsRenderer && (ch.renderer as MiniRendererLike).dispose) {
      (ch.renderer as MiniRendererLike).dispose!();
    }
  }

  for (let i = 0; i < state.mixerChannels.length; i++) {
    window.electronAPI.sendMixerChannelUpdate({ channelIndex: i, clear: true });
  }

  state.mixerChannels.length = 0;
  (state.mixerChannels as MixerChannelRuntime[]).push({
    slotIndex: null, alpha: 1.0, params: {}, customParams: {}, renderer: null, shaderCode: null
  });
  state.mixerArmedChannel = null;
  state.mixerSelectedChannel = null;
  state.mixerEnabled = false;
  syncToggleButton();
  rebuildChannelElements();
  hideMixerOverlay();
  generateCustomParamUI();
  setStatus('Mixer reset', 'success');
  notifyRemoteStateChanged();
}

export function updateMixerChannelParam(paramName: string, value: ParamValue): void {
  const chIdx = state.mixerSelectedChannel;
  if (chIdx === null) return;
  const ch = channels()[chIdx];
  if (!ch || (ch.slotIndex === null && ch.tabIndex === null && !ch.renderer)) return;

  if (paramName === 'speed') {
    ch.params.speed = value;
  } else {
    ch.customParams[paramName] = value;
  }

  window.electronAPI.sendMixerParamUpdate({ channelIndex: chIdx, paramName, value });
}

export function renderMixerComposite(): { time: number; frame: number; fps: number } {
  const mainCanvas = document.getElementById('shader-canvas') as HTMLCanvasElement;
  const canvasWidth = mainCanvas.width;
  const canvasHeight = mainCanvas.height;

  if (!mixerOverlayCanvas) {
    mixerOverlayCanvas = document.createElement('canvas');
    mixerOverlayCanvas.id = 'mixer-overlay-canvas';
    mixerOverlayCanvas.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);max-width:100%;max-height:100%;pointer-events:none';
    mainCanvas.parentElement!.style.position = 'relative';
    mainCanvas.parentElement!.appendChild(mixerOverlayCanvas);
  }

  if (mixerOverlayCanvas.width !== canvasWidth || mixerOverlayCanvas.height !== canvasHeight) {
    mixerOverlayCanvas.width = canvasWidth;
    mixerOverlayCanvas.height = canvasHeight;
    mixerOverlayCtx = null;
  }

  if (!mixerOverlayCtx) {
    mixerOverlayCtx = mixerOverlayCanvas.getContext('2d');
  }

  const ctx = mixerOverlayCtx!;

  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  ctx.globalCompositeOperation = state.mixerBlendMode;

  MiniShaderRenderer.ensureSharedCanvasSize?.(canvasWidth, canvasHeight);

  const mainStats = (mainRenderer() as { getStats?: () => { time: number; frame: number; fps: number } })
    .getStats?.() || { time: 0, frame: 0, fps: 60 };

  for (const ch of channels()) {
    if (ch.alpha <= 0) continue;

    let chRenderer: MiniRendererLike | AssetRendererLike | null = null;
    if (ch.slotIndex !== null && ch.tabIndex != null) {
      const tab = tabs()[ch.tabIndex];
      chRenderer = (tab?.slots?.[ch.slotIndex]?.renderer as MiniRendererLike | null) || null;
    }
    if (!chRenderer) chRenderer = ch.renderer;
    if (!chRenderer) continue;

    (chRenderer as MiniRendererLike).setSpeed?.(ch.params.speed as number ?? 1);

    (chRenderer as MiniRendererLike).customParamValues = {};
    if (ch.customParams) {
      for (const [name, value] of Object.entries(ch.customParams)) {
        (chRenderer as MiniRendererLike).customParamValues[name] = value;
      }
    }

    ctx.globalAlpha = ch.alpha;
    try {
      (chRenderer as MiniRendererLike).renderDirect(ctx, 0, 0, canvasWidth, canvasHeight);
    } catch (err) {
      console.error('[Mixer] Render error for slot', ch.slotIndex, err);
    }
  }

  ctx.globalAlpha = 1.0;
  ctx.globalCompositeOperation = 'source-over';
  mixerOverlayCanvas.style.display = 'block';

  return mainStats;
}

export function hideMixerOverlay(): void {
  if (mixerOverlayCanvas) {
    mixerOverlayCanvas.style.display = 'none';
  }
}

export function captureMixerThumbnail(): string | null {
  if (!mixerOverlayCanvas || mixerOverlayCanvas.width === 0) return null;
  const thumbW = 240;
  const thumbH = Math.round(thumbW * mixerOverlayCanvas.height / mixerOverlayCanvas.width) || 135;
  const tmp = document.createElement('canvas');
  tmp.width = thumbW;
  tmp.height = thumbH;
  const ctx = tmp.getContext('2d')!;
  ctx.drawImage(mixerOverlayCanvas, 0, 0, thumbW, thumbH);
  return tmp.toDataURL('image/jpeg', 0.7);
}

export function recallMixState(preset: MixPreset): void {
  console.info('[Mixer] Recalling mix preset:', preset.name, 'channels:', (preset.channels || []).length);
  for (const ch of channels()) {
    if (ch.renderer && ch._ownsRenderer && (ch.renderer as MiniRendererLike).dispose) {
      (ch.renderer as MiniRendererLike).dispose!();
    }
  }

  for (let i = 0; i < state.mixerChannels.length; i++) {
    window.electronAPI.sendMixerChannelUpdate({ channelIndex: i, clear: true });
  }

  const presetChannelCount = (preset.channels || []).length;
  const targetCount = Math.max(1, Math.min(presetChannelCount, MAX_MIXER_CHANNELS));

  state.mixerChannels.length = 0;
  for (let i = 0; i < targetCount; i++) {
    (state.mixerChannels as MixerChannelRuntime[]).push({
      slotIndex: null, alpha: 1.0, params: {}, customParams: {}, renderer: null, shaderCode: null
    });
  }

  state.mixerArmedChannel = null;
  state.mixerSelectedChannel = null;

  state.mixerBlendMode = (preset.blendMode || 'lighter') as typeof state.mixerBlendMode;
  const blendSelect = document.getElementById('mixer-blend-mode') as HTMLSelectElement | null;
  if (blendSelect) blendSelect.value = state.mixerBlendMode;
  window.electronAPI.sendMixerBlendMode({ blendMode: state.mixerBlendMode });

  for (let i = 0; i < targetCount; i++) {
    const presetCh = preset.channels![i];
    if (!presetCh) continue;

    const ch = channels()[i];
    ch.alpha = presetCh.alpha ?? 1.0;
    ch.params = { ...(presetCh.params || {}) };
    ch.customParams = { ...(presetCh.customParams || {}) };
    ch.slotIndex = null;

    // Handle asset channels
    if (presetCh.assetType && presetCh.mediaPath) {
      ch.assetType = presetCh.assetType;
      ch.mediaPath = presetCh.mediaPath;
      ch.shaderCode = null;

      const isVideo = presetCh.assetType === 'asset-video';
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = 160;
      tempCanvas.height = 90;

      const assetRenderer = new AssetRenderer(tempCanvas) as unknown as AssetRendererLike;
      assetRenderer.mediaPath = presetCh.mediaPath;
      if (presetCh.customParams) assetRenderer.setParams(presetCh.customParams);

      ch.renderer = assetRenderer;
      ch._ownsRenderer = true;

      (async () => {
        try {
          if (isVideo) {
            const absPath = await window.electronAPI.getMediaAbsolutePath(presetCh.mediaPath!);
            await assetRenderer.loadVideo(absPath);
            window.electronAPI.sendMixerChannelUpdate({
              channelIndex: i, assetType: presetCh.assetType, mediaPath: presetCh.mediaPath,
              filePath: absPath, params: { ...ch.customParams }
            });
          } else {
            const loaded = await window.electronAPI.loadMediaDataUrl(presetCh.mediaPath!);
            if (loaded.success) {
              await assetRenderer.loadImage(loaded.dataUrl!);
              window.electronAPI.sendMixerChannelUpdate({
                channelIndex: i, assetType: presetCh.assetType, mediaPath: presetCh.mediaPath,
                dataUrl: loaded.dataUrl, params: { ...ch.customParams }
              });
            }
          }
        } catch (err: unknown) {
          console.error(`[Mixer] Failed to load asset for mix preset channel ${i + 1}:`, (err as Error).message);
        }
      })();

      window.electronAPI.sendMixerAlphaUpdate({ channelIndex: i, alpha: ch.alpha });
      continue;
    }

    // Shader channel
    if (!presetCh.shaderCode) continue;

    ch.shaderCode = presetCh.shaderCode;
    ch.assetType = null;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = 160;
    tempCanvas.height = 90;
    try {
      const miniRenderer = new MiniShaderRenderer(tempCanvas) as unknown as MiniRendererLike;
      miniRenderer.compile(presetCh.shaderCode);

      if (presetCh.customParams) {
        miniRenderer.customParamValues = { ...(presetCh.customParams) };
      }
      miniRenderer.setSpeed((presetCh.params?.speed as number) ?? 1);

      ch.renderer = miniRenderer;
      ch._ownsRenderer = true;
    } catch (err: unknown) {
      console.error(`[Mixer] Failed to compile mix preset channel ${i + 1}:`, (err as Error).message);
      continue;
    }

    window.electronAPI.sendMixerChannelUpdate({
      channelIndex: i, shaderCode: presetCh.shaderCode,
      params: { speed: ch.params.speed ?? 1, ...ch.customParams }
    });
    window.electronAPI.sendMixerAlphaUpdate({ channelIndex: i, alpha: ch.alpha });
  }

  rebuildChannelElements();

  state.mixerEnabled = true;
  syncToggleButton();
  if (isMixerActive()) {
    if (mixerOverlayCanvas) mixerOverlayCanvas.style.display = 'block';
  }

  for (let i = 0; i < channels().length; i++) {
    const ch2 = channels()[i];
    if (ch2.renderer || ch2.shaderCode || ch2.assetType) {
      selectMixerChannel(i);
      break;
    }
  }

  setStatus(`Recalled mix preset: ${preset.name}`, 'success');
  notifyRemoteStateChanged();
}
