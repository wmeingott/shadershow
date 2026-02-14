// IPC Handlers — typed version of js/ipc.js
// Registers all main→renderer IPC listeners and manages remote control state.

import { state, notifyRemoteStateChanged } from '../core/state.js';
import type { ChannelState, MixerChannel, ShaderTab, RenderMode, BlendMode } from '../core/state.js';
import type {
  IPCOnChannels,
  OnPayload,
  ParamValue,
  ParamValues,
  ParamDef,
} from '@shared/types/index.js';
import type { SettingsDialogData } from '@shared/types/settings.js';
import type { TileLayout } from '@shared/types/state.js';
import { createTaggedLogger } from '@shared/logger.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createTaggedLogger();

// ---------------------------------------------------------------------------
// Type declarations for externally provided functions & objects
// ---------------------------------------------------------------------------

// Ace editor minimal interface (used via state.editor)
interface AceEditor {
  getValue(): string;
}

// Renderer interface as used in this file
interface ShaderRendererLike {
  loadTexture(channel: number, dataUrl: string): Promise<{ width: number; height: number }>;
  loadVideo(channel: number, filePath: string): Promise<{ width: number; height: number }>;
  loadCamera(channel: number): Promise<{ width: number; height: number }>;
  loadAudio(channel: number): Promise<{ width: number; height: number }>;
  clearChannel(channel: number): void;
  getStats(): { time: number; frame: number; isPlaying: boolean };
  getParams(): ParamValues;
  initNDIChannel(channel: number, source: string): void;
  setNDIFrame(channel: number, width: number, height: number, data: Uint8Array): void;
  setParam(name: string, value: ParamValue): void;
  getCustomParamValues?(): ParamValues;
  getCustomParamDefs?(): ParamDef[];
}

// Grid slot data as used by ipc.js runtime
interface GridSlot {
  shaderCode: string | null;
  filePath: string | null;
  params: ParamValues | null;
  customParams: ParamValues | null;
  presets: Array<{ name: string | null; params?: ParamValues }>;
  label?: string;
  renderer?: { canvas: HTMLCanvasElement } | null;
}

// ShaderTab extended with runtime fields used in this file
interface ShaderTabRuntime {
  name: string;
  type?: string;
  slots?: Array<GridSlot | null>;
  mixPresets?: Array<{ name: string }>;
}

// Tile state object (from js/tile-state.js)
interface TileStateObj {
  layout: TileLayout;
  tiles: Array<{
    gridSlotIndex: number | null;
    params?: ParamValues;
    customParams?: ParamValues;
    visible?: boolean;
  } | null>;
}

// Tab returned by getActiveTab()
interface EditorTabInfo {
  id: string;
  content?: string;
  filePath?: string;
  type?: string;
}

import { setStatus, updateChannelSlot } from '../ui/utils.js';
import { compileShader, setEditorMode } from '../ui/editor.js';
import { togglePlayback, resetTime, resetFullscreenSelect } from '../ui/controls.js';
import { loadGridPresetsFromData, saveGridState } from '../grid/grid-persistence.js';
import { selectGridSlot } from '../grid/shader-grid.js';
import { switchShaderTab } from '../grid/grid-tabs.js';
import { recallLocalPreset, updateLocalPresetsUI } from '../ui/presets.js';
import { loadParamsToSliders, generateCustomParamUI } from '../ui/params.js';
import { updatePreviewFrameLimit } from '../core/render-loop.js';
import { setRenderMode, detectRenderMode, restartRender } from '../core/renderer-manager.js';
import { createTab, openInTab, activeTabHasChanges, markTabSaved, getActiveTab } from '../ui/tabs.js';
import { isMixerActive, assignShaderToMixer, clearMixerChannel, resetMixer, recallMixState } from '../ui/mixer.js';
import { recallVisualPreset, rebuildVisualPresetsDOM } from '../grid/visual-presets.js';
import { tileState } from '../tiles/tile-state.js';

/** Benchmark not yet ported to TS — no-op stub */
function runBenchmark(): void { /* no-op */ }

// ---------------------------------------------------------------------------
// ElectronAPI type — shape of window.electronAPI used in this file
// ---------------------------------------------------------------------------

interface ElectronAPI {
  // Invoke (request/response)
  getSettings(): Promise<SettingsDialogData>;
  getDefaultShader(): Promise<string>;
  getDefaultScene(): Promise<string>;

  // Send (fire-and-forget, renderer → main)
  saveContent(content: string): void;
  sendEditorHasChanges(hasChanges: boolean): void;
  sendFullscreenState(data: unknown): void;
  saveGridPresetsToFile(gridState: unknown): void;
  sendPreviewResolution(data: { width: number; height: number }): void;
  sendPreviewResolutionForRecording(data: { width: number; height: number }): void;
  sendParamUpdate(data: { name: string; value: unknown }): void;
  sendMixerAlphaUpdate(data: { channelIndex: number; alpha: number }): void;
  sendMixerBlendMode(data: { blendMode: string }): void;
  sendRemoteStateChanged(data: unknown): void;
  sendRemoteGetStateResponse(data: unknown): void;
  sendRemoteGetThumbnailResponse(data: { tabIndex: number; slotIndex: number; dataUrl: string | null; _queryId?: number }): void;
  sendBlackout(enabled: boolean): void;

  // On listeners (main → renderer)
  onFileOpened(cb: (data: { content: string; filePath: string }) => void): void;
  onNewFile(cb: (data: { fileType?: string } | null) => void): void;
  onRequestContentForSave(cb: () => void): void;
  onCheckEditorChanges(cb: () => void): void;
  onTextureLoaded(cb: (data: { channel: number; dataUrl: string; filePath: string }) => void): void;
  onVideoLoaded(cb: (data: { channel: number; filePath: string }) => void): void;
  onCameraRequested(cb: (data: { channel: number }) => void): void;
  onAudioRequested(cb: (data: { channel: number }) => void): void;
  onChannelCleared(cb: (data: { channel: number }) => void): void;
  onCompileShader(cb: () => void): void;
  onTogglePlayback(cb: () => void): void;
  onResetTime(cb: () => void): void;
  onRunBenchmark(cb: () => void): void;
  onRestartRender(cb: () => void): void;
  onRequestFullscreenState(cb: () => void): void;
  onRequestGridStateForSave(cb: () => void): void;
  onGridPresetsSaved(cb: (data: { filePath: string }) => void): void;
  onLoadGridPresets(cb: (data: { gridState: unknown; filePath: string }) => void): void;
  onNDIStatus(cb: (data: { enabled: boolean; width?: number; height?: number }) => void): void;
  onNDIFrameSkipChanged?(cb: (frameSkip: number) => void): void;
  onRecordingStatus(cb: (data: { enabled: boolean; filePath?: string; exitCode?: number; error?: string }) => void): void;
  onRequestPreviewResolutionForRecording?(cb: () => void): void;
  onSyphonStatus(cb: (data: { enabled: boolean; error?: string }) => void): void;
  onPresetSync(cb: (data: { type: string; index: number; params: ParamValues }) => void): void;
  onRequestPreviewResolution(cb: () => void): void;
  onNDISourceSet(cb: (data: { channel: number; source: string; width?: number; height?: number }) => void): void;
  onNDIInputFrame(cb: (data: { channel: number; width: number; height: number; data: Uint8Array | ArrayBuffer }) => void): void;
  onFullscreenFps(cb: (fps: number) => void): void;
  onFullscreenClosed(cb: () => void): void;
  onFullscreenOpened(cb: (displayId: number) => void): void;

  // Remote control listeners
  onRemoteGetState(cb: (data: unknown) => void): void;
  onRemoteGetThumbnail(cb: (data: { tabIndex: number; slotIndex: number }) => void): void;
  onRemoteSelectTab(cb: (data: { tabIndex: number }) => void): void;
  onRemoteSelectSlot(cb: (data: { slotIndex: number }) => void): void;
  onRemoteSetParam(cb: (data: { name: string; value: ParamValue }) => void): void;
  onRemoteRecallPreset(cb: (data: { presetIndex: number }) => void): void;
  onRemoteMixerAssign(cb: (data: { channelIndex: number; slotIndex: number }) => void): void;
  onRemoteMixerClear(cb: (data: { channelIndex: number }) => void): void;
  onRemoteMixerAlpha(cb: (data: { channelIndex: number; value: number }) => void): void;
  onRemoteMixerSelect(cb: (data: { channelIndex: number }) => void): void;
  onRemoteMixerBlend(cb: (data: { mode: string }) => void): void;
  onRemoteMixerReset(cb: (data: unknown) => void): void;
  onRemoteMixerToggle(cb: (data: unknown) => void): void;
  onRemoteRecallMixPreset(cb: (data: { tabIndex: number; presetIndex: number }) => void): void;
  onRemoteTogglePlayback(cb: (data: unknown) => void): void;
  onRemoteResetTime(cb: (data: unknown) => void): void;
  onRemoteBlackout(cb: (data: { enabled: boolean }) => void): void;
  onRemoteRecallVisualPreset(cb: (data: { vpTabIndex: number; presetIndex: number }) => void): void;
  onRemoteReorderVisualPreset(cb: (data: { vpTabIndex: number; fromIndex: number; toIndex: number }) => void): void;
  onRemoteGetPreviewFrame(cb: (data: unknown) => void): void;
  sendRemoteGetPreviewFrameResponse(data: unknown): void;
}

declare const window: Window & { electronAPI: ElectronAPI };

// ---------------------------------------------------------------------------
// Remote state snapshot types
// ---------------------------------------------------------------------------

interface RemoteSlotInfo {
  index: number;
  label: string;
  hasShader: boolean;
  presetCount: number;
  presetNames: string[];
}

interface RemoteTabInfo {
  name: string;
  type: string;
  slots?: RemoteSlotInfo[];
  mixPresets?: Array<{ index: number; name: string }>;
}

interface RemoteMixerChannelInfo {
  slotIndex: number | null;
  tabIndex?: number | null;
  alpha: number;
  hasShader: boolean;
  label: string | null;
}

interface RemoteVpTab {
  name: string;
  presets: Array<{ name: string; thumbnail: string | null }>;
}

interface RemoteStateSnapshot {
  tabs: RemoteTabInfo[];
  activeTab: number;
  activeSlot: number | null;
  mixer: {
    enabled: boolean;
    blendMode: string;
    selectedChannel: number | null;
    channels: RemoteMixerChannelInfo[];
  };
  params: ParamValues;
  customParamDefs: RemoteParamDef[];
  presets: string[];
  vpTabs: RemoteVpTab[];
  activeVpTab: number;
  playback: {
    isPlaying: boolean;
    time: number;
  };
  blackout: boolean;
}

interface RemoteParamDef {
  name: string;
  type: string;
  min: number | null;
  max: number | null;
  default: ParamValue | ParamValue[];
  description: string;
  isArray: boolean;
  arraySize: number;
}

// ---------------------------------------------------------------------------
// Fullscreen state types
// ---------------------------------------------------------------------------

interface TiledTileConfig {
  gridSlotIndex: number | null;
  shaderCode: string | null;
  params: ParamValues | null;
  visible: boolean;
}

interface TiledConfig {
  layout: TileLayout;
  tiles: TiledTileConfig[];
  previewResolution: { width: number; height: number };
}

interface MixerChannelConfig {
  shaderCode: string;
  alpha: number;
  params: ParamValues;
}

interface MixerConfig {
  blendMode: string;
  channels: (MixerChannelConfig | null)[];
  previewResolution: { width: number; height: number };
}

interface FullscreenState {
  shaderCode: string;
  renderMode: RenderMode;
  time: number;
  frame: number;
  isPlaying: boolean;
  channels: (ChannelState | null)[];
  params: ParamValues;
  localPresets: Array<{ name: string | null; params?: ParamValues }>;
  activeLocalPresetIndex: number | null;
  tiledConfig: TiledConfig | null;
  mixerConfig: MixerConfig | null;
}

// ===========================================================================
// initIPC — main entry point
// ===========================================================================

export async function initIPC(): Promise<void> {
  // Load initial settings (including ndiFrameSkip)
  try {
    const settings: SettingsDialogData = await window.electronAPI.getSettings();
    if (settings.ndiFrameSkip) {
      state.ndiFrameSkip = settings.ndiFrameSkip;
    }
  } catch (err: unknown) {
    log.error('IPC', 'Failed to load initial settings:', err);
  }

  // ---------- File operations ----------

  window.electronAPI.onFileOpened(({ content, filePath }: { content: string; filePath: string }) => {
    // Detect render mode from file extension/content
    const mode: RenderMode = detectRenderMode(filePath, content);

    // Open in a new tab (or activate existing if already open)
    openInTab({
      content,
      filePath,
      type: mode,
      activate: true,
    });
  });

  window.electronAPI.onNewFile(async (data: { fileType?: string } | null) => {
    const fileType: string = data?.fileType || 'shader';

    if (fileType === 'scene') {
      const defaultScene: string = await window.electronAPI.getDefaultScene();
      createTab({
        content: defaultScene,
        type: 'scene',
        title: 'Untitled Scene',
        activate: true,
      });
    } else {
      const defaultShader: string = await window.electronAPI.getDefaultShader();
      createTab({
        content: defaultShader,
        type: 'shader',
        title: 'Untitled Shader',
        activate: true,
      });
    }
  });

  window.electronAPI.onRequestContentForSave(() => {
    const editor = state.editor as AceEditor;
    const content: string = editor.getValue();
    window.electronAPI.saveContent(content);
    // Mark current tab as saved
    const activeTab: EditorTabInfo | null = getActiveTab();
    if (activeTab) {
      markTabSaved(activeTab.id);
    }
  });

  // Check if editor has unsaved changes
  window.electronAPI.onCheckEditorChanges(() => {
    const hasChanges: boolean = activeTabHasChanges();
    window.electronAPI.sendEditorHasChanges(hasChanges);
  });

  // ---------- Texture loading ----------

  window.electronAPI.onTextureLoaded(async ({ channel, dataUrl, filePath }: { channel: number; dataUrl: string; filePath: string }) => {
    try {
      const renderer = state.renderer as ShaderRendererLike;
      const result = await renderer.loadTexture(channel, dataUrl);
      state.channelState[channel] = { type: 'image', dataUrl, filePath } as ChannelState;
      updateChannelSlot(channel, 'image', filePath, result.width, result.height, dataUrl);
      log.debug('IPC', 'Texture loaded to iChannel' + channel, filePath);
      setStatus(`Loaded texture to iChannel${channel}`, 'success');
    } catch (err: unknown) {
      const message = (err as Error).message;
      log.error('IPC', 'Failed to load texture:', message);
      setStatus(`Failed to load texture: ${message}`, 'error');
    }
  });

  // ---------- Video loading ----------

  window.electronAPI.onVideoLoaded(async ({ channel, filePath }: { channel: number; filePath: string }) => {
    try {
      const renderer = state.renderer as ShaderRendererLike;
      const result = await renderer.loadVideo(channel, filePath);
      state.channelState[channel] = { type: 'video', filePath } as ChannelState;
      updateChannelSlot(channel, 'video', filePath, result.width, result.height);
      log.debug('IPC', 'Video loaded to iChannel' + channel, filePath);
      setStatus(`Loaded video to iChannel${channel}`, 'success');
    } catch (err: unknown) {
      const message = (err as Error).message;
      log.error('IPC', 'Failed to load video:', message);
      setStatus(`Failed to load video: ${message}`, 'error');
    }
  });

  // ---------- Camera loading ----------

  window.electronAPI.onCameraRequested(async ({ channel }: { channel: number }) => {
    try {
      const renderer = state.renderer as ShaderRendererLike;
      const result = await renderer.loadCamera(channel);
      state.channelState[channel] = { type: 'camera' } as ChannelState;
      updateChannelSlot(channel, 'camera', 'Camera', result.width, result.height);
      log.debug('IPC', 'Camera connected to iChannel' + channel);
      setStatus(`Camera connected to iChannel${channel}`, 'success');
    } catch (err: unknown) {
      const message = (err as Error).message;
      log.error('IPC', 'Failed to access camera:', message);
      setStatus(`Failed to access camera: ${message}`, 'error');
    }
  });

  // ---------- Audio loading ----------

  window.electronAPI.onAudioRequested(async ({ channel }: { channel: number }) => {
    try {
      const renderer = state.renderer as ShaderRendererLike;
      const result = await renderer.loadAudio(channel);
      state.channelState[channel] = { type: 'audio' } as ChannelState;
      updateChannelSlot(channel, 'audio', 'Audio FFT', result.width, result.height);
      log.debug('IPC', 'Audio connected to iChannel' + channel);
      setStatus(`Audio input connected to iChannel${channel}`, 'success');
    } catch (err: unknown) {
      const message = (err as Error).message;
      log.error('IPC', 'Failed to access audio:', message);
      setStatus(`Failed to access audio: ${message}`, 'error');
    }
  });

  // ---------- Channel clear ----------

  window.electronAPI.onChannelCleared(({ channel }: { channel: number }) => {
    const renderer = state.renderer as ShaderRendererLike;
    renderer.clearChannel(channel);
    state.channelState[channel] = null;
    updateChannelSlot(channel, 'empty');
    setStatus(`Cleared iChannel${channel}`, 'success');
  });

  // ---------- Shader controls from menu ----------

  window.electronAPI.onCompileShader(compileShader);
  window.electronAPI.onTogglePlayback(() => {
    // Ignore Space-triggered toggle when editor or any text input is focused
    const active: Element | null = document.activeElement;
    if (
      active &&
      (active.closest('#editor') ||
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT')
    ) {
      return;
    }
    togglePlayback();
  });
  window.electronAPI.onResetTime(resetTime);
  window.electronAPI.onRunBenchmark(runBenchmark);
  window.electronAPI.onRestartRender(restartRender);

  // ---------- Fullscreen state request ----------

  window.electronAPI.onRequestFullscreenState(() => {
    const renderer = state.renderer as ShaderRendererLike;
    const stats = renderer.getStats();

    // Get shader code from active grid slot if selected, otherwise from editor
    const editor = state.editor as AceEditor;
    let shaderCode: string = editor.getValue();
    let localPresets: Array<{ name: string | null; params?: ParamValues }> = [];
    const gridSlots = state.gridSlots as GridSlot[];
    if (state.activeGridSlot !== null && gridSlots[state.activeGridSlot]) {
      shaderCode = gridSlots[state.activeGridSlot].shaderCode || shaderCode;
      localPresets = gridSlots[state.activeGridSlot].presets || [];
    }

    // Build tiled mode configuration if enabled
    let tiledConfig: TiledConfig | null = null;
    log.debug('IPC', 'Building fullscreen state, tiledPreviewEnabled:', state.tiledPreviewEnabled);
    if (state.tiledPreviewEnabled) {
      const tiles: TiledTileConfig[] = tileState.tiles.map((tile) => {
        if (!tile || tile.gridSlotIndex === null) {
          return { gridSlotIndex: null, shaderCode: null, params: null, visible: true };
        }
        const slotData = gridSlots[tile.gridSlotIndex];
        if (!slotData) {
          return { gridSlotIndex: tile.gridSlotIndex, shaderCode: null, params: null, visible: tile.visible !== false };
        }
        const params: ParamValues = {
          speed: tile.params?.speed ?? slotData.params?.speed ?? 1,
          ...(slotData.customParams || {}),
          ...(tile.customParams || {}),
        };
        return {
          gridSlotIndex: tile.gridSlotIndex,
          shaderCode: slotData.shaderCode,
          params,
          visible: tile.visible !== false,
        };
      });
      // Include preview resolution so fullscreen can match aspect ratio
      const previewCanvas = document.getElementById('shader-canvas') as HTMLCanvasElement;
      tiledConfig = {
        layout: { ...tileState.layout },
        tiles,
        previewResolution: {
          width: previewCanvas.width,
          height: previewCanvas.height,
        },
      };
      log.debug('IPC', 'Built tiledConfig with', tiledConfig.tiles.length, 'tiles');
    }

    // Build mixer configuration if mixer is active
    let mixerConfig: MixerConfig | null = null;
    if (isMixerActive()) {
      const previewCanvas = document.getElementById('shader-canvas') as HTMLCanvasElement;
      const mixerChannels = state.mixerChannels as Array<MixerChannel & { tabIndex?: number | null }>;
      const shaderTabs = state.shaderTabs as ShaderTabRuntime[];
      mixerConfig = {
        blendMode: state.mixerBlendMode,
        channels: mixerChannels.map((ch) => {
          // Grid-assigned channel: use tab-aware lookup
          if (ch.slotIndex !== null && ch.tabIndex !== null && ch.tabIndex !== undefined) {
            const tab = shaderTabs[ch.tabIndex];
            const slotData = tab?.slots?.[ch.slotIndex];
            if (!slotData) return null;
            return {
              shaderCode: slotData.shaderCode!,
              alpha: ch.alpha,
              params: { speed: ch.params.speed ?? slotData.params?.speed ?? 1, ...ch.customParams },
            };
          }
          // Recalled mix preset: use stored shaderCode
          if (ch.shaderCode) {
            return {
              shaderCode: ch.shaderCode,
              alpha: ch.alpha,
              params: { speed: ch.params.speed ?? 1, ...ch.customParams },
            };
          }
          return null;
        }),
        previewResolution: { width: previewCanvas.width, height: previewCanvas.height },
      };
    }

    log.debug('IPC', 'Sending fullscreen state, tiled:', tiledConfig ? 'yes' : 'no', 'mixer:', mixerConfig ? 'yes' : 'no');
    const fullscreenState: FullscreenState = {
      shaderCode,
      renderMode: state.renderMode,
      time: stats.time,
      frame: stats.frame,
      isPlaying: stats.isPlaying,
      channels: state.channelState,
      params: renderer.getParams(),
      localPresets,
      activeLocalPresetIndex: state.activeLocalPresetIndex,
      tiledConfig,
      mixerConfig,
    };
    window.electronAPI.sendFullscreenState(fullscreenState);
  });

  // ---------- Grid presets save/load ----------

  window.electronAPI.onRequestGridStateForSave(() => {
    const gridSlots = state.gridSlots as GridSlot[];
    const gridState = gridSlots.map((slot: GridSlot | null) => {
      if (!slot) return null;
      return {
        shaderCode: slot.shaderCode,
        filePath: slot.filePath,
      };
    });
    window.electronAPI.saveGridPresetsToFile(gridState);
  });

  window.electronAPI.onGridPresetsSaved(({ filePath }: { filePath: string }) => {
    const fileName: string = filePath.split('/').pop()!.split('\\').pop()!;
    setStatus(`Grid presets saved to ${fileName}`, 'success');
  });

  window.electronAPI.onLoadGridPresets(({ gridState, filePath }: { gridState: unknown; filePath: string }) => {
    loadGridPresetsFromData(gridState, filePath);
  });

  // ---------- NDI status ----------

  window.electronAPI.onNDIStatus(({ enabled, width, height }: { enabled: boolean; width?: number; height?: number }) => {
    state.ndiEnabled = enabled;
    const btnNdi = document.getElementById('btn-ndi') as HTMLElement | null;
    if (enabled) {
      btnNdi?.classList.add('active');
      if (btnNdi) btnNdi.title = `NDI Output Active (${width}x${height})`;
      log.info('IPC', 'NDI output started at', width + 'x' + height);
      setStatus(`NDI output started at ${width}x${height}`, 'success');
    } else {
      btnNdi?.classList.remove('active');
      if (btnNdi) btnNdi.title = 'Toggle NDI Output';
      log.info('IPC', 'NDI output stopped');
      setStatus('NDI output stopped', 'success');
    }
  });

  // NDI frame skip changed
  window.electronAPI.onNDIFrameSkipChanged?.((frameSkip: number) => {
    state.ndiFrameSkip = frameSkip;
    const fpsMap: Record<number, number> = { 1: 60, 2: 30, 3: 20, 4: 15, 6: 10 };
    const fps: number = fpsMap[frameSkip] || Math.round(60 / frameSkip);
    setStatus(`NDI frame rate set to ${fps} fps`, 'success');
  });

  // ---------- Recording status ----------

  window.electronAPI.onRecordingStatus(({ enabled, filePath, exitCode, error }: {
    enabled: boolean;
    filePath?: string;
    exitCode?: number;
    error?: string;
  }) => {
    if (!enabled) {
      state.recordingEnabled = false;
      const btnRecord = document.getElementById('btn-record') as HTMLElement | null;
      if (btnRecord) {
        btnRecord.classList.remove('active');
        btnRecord.title = 'Start Recording (Cmd+Shift+R)';
      }
      if (error) {
        log.error('IPC', 'Recording error:', error);
        setStatus(`Recording error: ${error}`, 'error');
      } else if (filePath && exitCode === 0) {
        const fileName: string = filePath.split('/').pop()!.split('\\').pop()!;
        log.debug('IPC', 'Recording saved:', fileName);
        setStatus(`Recording saved: ${fileName}`, 'success');
      } else if (exitCode !== 0 && exitCode !== undefined) {
        log.error('IPC', 'Recording finished with errors, exit code:', exitCode);
        setStatus(`Recording finished with errors (exit code ${exitCode})`, 'error');
      }
    }
  });

  // Preview resolution request for recording "Match Preview" option
  window.electronAPI.onRequestPreviewResolutionForRecording?.(() => {
    const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement;
    window.electronAPI.sendPreviewResolutionForRecording({
      width: canvas.width,
      height: canvas.height,
    });
  });

  // ---------- Syphon status (macOS only) ----------

  window.electronAPI.onSyphonStatus(({ enabled, error }: { enabled: boolean; error?: string }) => {
    state.syphonEnabled = enabled;
    if (enabled) {
      log.info('IPC', 'Syphon output started');
      setStatus('Syphon output started', 'success');
    } else if (error) {
      log.error('IPC', 'Syphon error:', error);
      setStatus(`Syphon error: ${error}`, 'error');
    } else {
      log.info('IPC', 'Syphon output stopped');
      setStatus('Syphon output stopped', 'success');
    }
  });

  // ---------- Preset sync from fullscreen window ----------

  window.electronAPI.onPresetSync((data: { type: string; index: number; params: ParamValues }) => {
    // Apply params directly from sync message to renderer and sliders
    if (data.params) {
      loadParamsToSliders(data.params);
    }

    // Update highlighting without triggering another sync
    if (data.type === 'local') {
      state.activeLocalPresetIndex = data.index;
      document.querySelectorAll('.preset-btn.local-preset').forEach((btn: Element, i: number) => {
        btn.classList.toggle('active', i === data.index);
      });
    }
  });

  // Preview resolution request for NDI "Match Preview" option
  window.electronAPI.onRequestPreviewResolution(() => {
    const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement;
    window.electronAPI.sendPreviewResolution({
      width: canvas.width,
      height: canvas.height,
    });
  });

  // ---------- NDI input source set ----------

  window.electronAPI.onNDISourceSet(({ channel, source, width, height }: {
    channel: number;
    source: string;
    width?: number;
    height?: number;
  }) => {
    const renderer = state.renderer as ShaderRendererLike;
    renderer.initNDIChannel(channel, source);
    state.channelState[channel] = { type: 'ndi', source } as ChannelState;
    updateChannelSlot(channel, 'ndi', source, width || 0, height || 0);
    log.info('IPC', 'NDI source connected to iChannel' + channel + ':', source);
    setStatus(`NDI source "${source}" connected to iChannel${channel}`, 'success');
  });

  // NDI input frame received (binary data via structured clone)
  window.electronAPI.onNDIInputFrame(({ channel, width, height, data }: {
    channel: number;
    width: number;
    height: number;
    data: Uint8Array | ArrayBuffer;
  }) => {
    if (state.channelState[channel]?.type === 'ndi') {
      // data is already a Uint8Array (sent as binary from main process)
      const bytes: Uint8Array = data instanceof Uint8Array ? data : new Uint8Array(data);
      const renderer = state.renderer as ShaderRendererLike;
      renderer.setNDIFrame(channel, width, height, bytes);
    }
  });

  // ---------- Fullscreen FPS display and adaptive preview framerate ----------

  window.electronAPI.onFullscreenFps((fps: number) => {
    // Update state for adaptive preview framerate
    state.fullscreenFps = fps;
    state.fullscreenActive = true;
    updatePreviewFrameLimit();

    // Update UI display
    const fpsDisplay = document.getElementById('fullscreen-fps') as HTMLElement | null;
    if (fpsDisplay) {
      fpsDisplay.textContent = `${fps} fps`;
      fpsDisplay.classList.remove('active', 'low', 'very-low');
      if (fps >= 50) {
        fpsDisplay.classList.add('active');
      } else if (fps >= 30) {
        fpsDisplay.classList.add('low');
      } else {
        fpsDisplay.classList.add('very-low');
      }
    }
  });

  // Track fullscreen window closed
  window.electronAPI.onFullscreenClosed(() => {
    state.fullscreenActive = false;
    state.fullscreenFps = 0;
    state.previewFrameInterval = 0; // Remove frame limiting

    // Reset FPS display
    const fpsDisplay = document.getElementById('fullscreen-fps') as HTMLElement | null;
    if (fpsDisplay) {
      fpsDisplay.textContent = '-- fps';
      fpsDisplay.classList.remove('active', 'low', 'very-low');
    }

    // Reset fullscreen select to "No Fullscreen"
    resetFullscreenSelect();
  });

  // Sync fullscreen select when opened via menu (Cmd+F)
  window.electronAPI.onFullscreenOpened((displayId: number) => {
    const select = document.getElementById('fullscreen-select') as HTMLSelectElement | null;
    if (select) select.value = String(displayId);
  });

  // =========================================================================
  // Remote Control Handlers
  // =========================================================================
  initRemoteHandlers();

  // Listen for remote state change notifications from other modules
  window.addEventListener('remote-state-changed', () => {
    sendRemoteStateUpdate();
  });
}

// =============================================================================
// Remote Control — State Snapshot Builders & Action Handlers
// =============================================================================

function buildRemoteStateSnapshot(): RemoteStateSnapshot {
  const filename = (fp: string | null): string | null =>
    fp ? fp.split('/').pop()!.split('\\').pop()! : null;

  const shaderTabs = state.shaderTabs as ShaderTabRuntime[];
  const gridSlots = state.gridSlots as GridSlot[];
  const mixerChannels = state.mixerChannels as Array<MixerChannel & { tabIndex?: number | null }>;

  return {
    tabs: shaderTabs.map((tab: ShaderTabRuntime) => ({
      name: tab.name,
      type: tab.type || 'shaders',
      slots:
        tab.type !== 'mix'
          ? (tab.slots || [])
              .map((s: GridSlot | null, j: number): RemoteSlotInfo | null =>
                s
                  ? {
                      index: j,
                      label: s.label || filename(s.filePath) || `Slot ${j + 1}`,
                      hasShader: !!s.shaderCode,
                      presetCount: (s.presets || []).length,
                      presetNames: (s.presets || []).map(
                        (p, idx) => p.name || `Preset ${idx + 1}`,
                      ),
                    }
                  : null,
              )
              .filter((x): x is RemoteSlotInfo => x !== null)
          : undefined,
      mixPresets:
        tab.type === 'mix'
          ? (tab.mixPresets || []).map((p: { name: string }, j: number) => ({
              index: j,
              name: p.name,
            }))
          : undefined,
    })),
    activeTab: state.activeShaderTab,
    activeSlot: state.activeGridSlot,
    mixer: {
      enabled: state.mixerEnabled,
      blendMode: state.mixerBlendMode,
      selectedChannel: state.mixerSelectedChannel,
      channels: mixerChannels.map((ch) => ({
        slotIndex: ch.slotIndex,
        tabIndex: (ch as { tabIndex?: number | null }).tabIndex ?? null,
        alpha: ch.alpha,
        hasShader: ch.slotIndex !== null || !!ch.renderer,
        label: ch.slotIndex !== null ? `Slot ${ch.slotIndex + 1}` : ch.renderer ? 'Mix' : null,
      })),
    },
    params: buildCurrentParams(),
    customParamDefs: getCustomParamDefs(),
    presets: getCurrentSlotPresetNames(),
    vpTabs: (state.vpTabs as Array<{ name: string; presets: Array<{ name: string; thumbnail: string | null }> }>).map(t => ({
      name: t.name,
      presets: (t.presets || []).map(p => ({ name: p.name, thumbnail: p.thumbnail })),
    })),
    activeVpTab: state.activeVpTab as number,
    playback: {
      isPlaying: (state.renderer as ShaderRendererLike | null)?.getStats?.()?.isPlaying ?? true,
      time: (state.renderer as ShaderRendererLike | null)?.getStats?.()?.time || 0,
    },
    blackout: state.blackoutEnabled,
  };
}

function buildCurrentParams(): ParamValues {
  const params: ParamValues = {};
  if (state.renderer) {
    const renderer = state.renderer as ShaderRendererLike;
    // Speed
    const speedSlider = document.getElementById('param-speed') as HTMLInputElement | null;
    if (speedSlider) params.speed = parseFloat(speedSlider.value);

    // Custom params
    const customValues: ParamValues | undefined = renderer.getCustomParamValues?.();
    if (customValues) {
      Object.assign(params, customValues);
    }
  }
  return params;
}

function getCustomParamDefs(): RemoteParamDef[] {
  const renderer = state.renderer as ShaderRendererLike | null;
  if (!renderer?.getCustomParamDefs) return [];
  return renderer.getCustomParamDefs().map((p: ParamDef) => ({
    name: p.name,
    type: p.type,
    min: p.min,
    max: p.max,
    default: p.default,
    description: p.description,
    isArray: p.isArray || false,
    arraySize: p.arraySize || 0,
  }));
}

function getCurrentSlotPresetNames(): string[] {
  const gridSlots = state.gridSlots as GridSlot[];
  if (state.activeGridSlot === null || !gridSlots[state.activeGridSlot]) return [];
  const presets = gridSlots[state.activeGridSlot].presets || [];
  return presets.map((p, i) => p.name || `Preset ${i + 1}`);
}

// Send full state update to remote clients
export function sendRemoteStateUpdate(): void {
  window.electronAPI.sendRemoteStateChanged({
    type: 'state-update',
    data: buildRemoteStateSnapshot(),
  });
}

function initRemoteHandlers(): void {
  // ---- State queries (request -> response) ----

  window.electronAPI.onRemoteGetState((req: { _queryId?: number } | null) => {
    const snapshot: RemoteStateSnapshot = buildRemoteStateSnapshot();
    const response = { ...snapshot, _queryId: req?._queryId } as unknown;
    window.electronAPI.sendRemoteGetStateResponse(response);
  });

  window.electronAPI.onRemoteGetThumbnail((req: { tabIndex: number; slotIndex: number; _queryId?: number }) => {
    const { tabIndex, slotIndex, _queryId } = req || {};
    let dataUrl: string | null = null;

    try {
      const shaderTabs = state.shaderTabs as ShaderTabRuntime[];
      const tab = shaderTabs[tabIndex];
      if (tab && tab.type !== 'mix') {
        const slot = tab.slots?.[slotIndex];
        if (slot && slot.renderer) {
          // Render a fresh frame before capturing to ensure canvas is up-to-date
          if (slot.renderer.setSpeed) slot.renderer.setSpeed(slot.params?.speed ?? 1);
          if (slot.renderer.render) slot.renderer.render();
          const canvas: HTMLCanvasElement = slot.renderer.canvas;
          if (canvas && canvas.width > 0) {
            dataUrl = canvas.toDataURL('image/jpeg', 0.6);
          }
        }
      }
    } catch (err: unknown) {
      log.error('IPC', 'Remote thumbnail error:', err);
    }

    window.electronAPI.sendRemoteGetThumbnailResponse({
      tabIndex,
      slotIndex,
      dataUrl,
      _queryId,
    });
  });

  // ---- Action dispatch (fire-and-forget) ----

  window.electronAPI.onRemoteSelectTab(({ tabIndex }: { tabIndex: number }) => {
    if (typeof tabIndex === 'number') {
      switchShaderTab(tabIndex);
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteSelectSlot(({ slotIndex }: { slotIndex: number }) => {
    if (typeof slotIndex === 'number') {
      selectGridSlot(slotIndex);
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteSetParam(({ name, value }: { name: string; value: ParamValue }) => {
    if (!name || !state.renderer) return;
    const renderer = state.renderer as ShaderRendererLike;

    if (name === 'speed') {
      const speedSlider = document.getElementById('param-speed') as HTMLInputElement | null;
      const speedValue = document.getElementById('param-speed-value') as HTMLElement | null;
      if (speedSlider) {
        speedSlider.value = String(value);
        if (speedValue) speedValue.textContent = (typeof value === 'number' ? value : parseFloat(String(value))).toFixed(2);
      }
      renderer.setParam('speed', value);
      window.electronAPI.sendParamUpdate({ name: 'speed', value });
    } else {
      renderer.setParam(name, value);
      window.electronAPI.sendParamUpdate({ name, value });
    }

    // Store to active grid slot
    const gridSlots = state.gridSlots as GridSlot[];
    if (state.activeGridSlot !== null && gridSlots[state.activeGridSlot]) {
      const slot = gridSlots[state.activeGridSlot];
      if (name === 'speed') {
        if (!slot.params) slot.params = {};
        slot.params.speed = value;
      } else {
        if (!slot.customParams) slot.customParams = {};
        slot.customParams[name] = value;
      }
    }
  });

  window.electronAPI.onRemoteRecallPreset(({ presetIndex }: { presetIndex: number }) => {
    if (typeof presetIndex === 'number') {
      recallLocalPreset(presetIndex);
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteMixerAssign(({ channelIndex, slotIndex }: { channelIndex: number; slotIndex: number }) => {
    if (typeof channelIndex === 'number' && typeof slotIndex === 'number') {
      assignShaderToMixer(channelIndex, slotIndex);
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteMixerClear(({ channelIndex }: { channelIndex: number }) => {
    if (typeof channelIndex === 'number') {
      clearMixerChannel(channelIndex);
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteMixerAlpha(({ channelIndex, value }: { channelIndex: number; value: number }) => {
    if (typeof channelIndex !== 'number') return;
    const ch: MixerChannel | undefined = state.mixerChannels[channelIndex];
    if (ch) {
      ch.alpha = value;
      const slider = document.querySelectorAll('#mixer-channels .mixer-slider')[channelIndex] as HTMLInputElement | undefined;
      if (slider) slider.value = String(value);
      window.electronAPI.sendMixerAlphaUpdate({ channelIndex, alpha: value });
    }
  });

  window.electronAPI.onRemoteMixerSelect(({ channelIndex }: { channelIndex: number }) => {
    if (typeof channelIndex === 'number') {
      // Simulate selecting the mixer channel
      const btns: NodeListOf<Element> = document.querySelectorAll('#mixer-channels .mixer-btn');
      btns.forEach((b: Element) => b.classList.remove('selected'));
      btns[channelIndex]?.classList.add('selected');
      state.mixerSelectedChannel = channelIndex;
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteMixerBlend(({ mode }: { mode: string }) => {
    if (mode) {
      state.mixerBlendMode = mode as BlendMode;
      const select = document.getElementById('mixer-blend-mode') as HTMLSelectElement | null;
      if (select) select.value = mode;
      window.electronAPI.sendMixerBlendMode({ blendMode: mode });
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteMixerReset(() => {
    resetMixer();
    sendRemoteStateUpdate();
  });

  window.electronAPI.onRemoteMixerToggle(() => {
    state.mixerEnabled = !state.mixerEnabled;
    const btn = document.getElementById('mixer-toggle-btn') as HTMLElement | null;
    if (btn) btn.classList.toggle('active', state.mixerEnabled);
    sendRemoteStateUpdate();
  });

  window.electronAPI.onRemoteRecallMixPreset(({ tabIndex, presetIndex }: { tabIndex: number; presetIndex: number }) => {
    if (typeof tabIndex !== 'number' || typeof presetIndex !== 'number') return;
    const shaderTabs = state.shaderTabs as ShaderTabRuntime[];
    const tab = shaderTabs[tabIndex];
    if (tab?.type === 'mix' && tab.mixPresets?.[presetIndex]) {
      recallMixState(tab.mixPresets[presetIndex]);
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteTogglePlayback(() => {
    togglePlayback();
    sendRemoteStateUpdate();
  });

  window.electronAPI.onRemoteResetTime(() => {
    resetTime();
    sendRemoteStateUpdate();
  });

  window.electronAPI.onRemoteBlackout(({ enabled }: { enabled: boolean }) => {
    state.blackoutEnabled = !!enabled;
    window.electronAPI.sendBlackout(state.blackoutEnabled);

    const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement | null;
    if (canvas) canvas.style.opacity = state.blackoutEnabled ? '0' : '1';

    sendRemoteStateUpdate();
  });

  window.electronAPI.onRemoteRecallVisualPreset(({ vpTabIndex, presetIndex }: { vpTabIndex: number; presetIndex: number }) => {
    if (typeof vpTabIndex === 'number' && typeof presetIndex === 'number') {
      // Switch to the requested VP tab before recalling
      const vpTabs = state.vpTabs as Array<{ name: string; presets: unknown[] }>;
      if (vpTabIndex >= 0 && vpTabIndex < vpTabs.length) {
        state.activeVpTab = vpTabIndex;
      }
      recallVisualPreset(presetIndex).then(() => {
        sendRemoteStateUpdate();
      });
    }
  });

  // ---- Reorder visual presets ----

  window.electronAPI.onRemoteReorderVisualPreset(({ vpTabIndex, fromIndex, toIndex }: { vpTabIndex: number; fromIndex: number; toIndex: number }) => {
    if (typeof vpTabIndex !== 'number' || typeof fromIndex !== 'number' || typeof toIndex !== 'number') return;
    const vpTabs = state.vpTabs as Array<{ name: string; presets: unknown[] }>;
    const tab = vpTabs[vpTabIndex];
    if (!tab || !tab.presets) return;
    if (fromIndex < 0 || fromIndex >= tab.presets.length || toIndex < 0 || toIndex >= tab.presets.length) return;
    if (fromIndex === toIndex) return;

    // Move the preset from fromIndex to toIndex
    const [item] = tab.presets.splice(fromIndex, 1);
    tab.presets.splice(toIndex, 0, item);

    // If this is the active VP tab, rebuild the DOM
    if (vpTabIndex === (state.activeVpTab as number)) {
      rebuildVisualPresetsDOM();
    }
    saveGridState();
    sendRemoteStateUpdate();
  });

  // ---- Preview frame capture for MJPEG stream ----

  window.electronAPI.onRemoteGetPreviewFrame((req: unknown) => {
    const _queryId = (req as { _queryId?: number } | null)?._queryId;
    try {
      const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement | null;
      if (!canvas || canvas.width === 0) {
        window.electronAPI.sendRemoteGetPreviewFrameResponse({ _queryId });
        return;
      }

      // Downscale to max 640px width for bandwidth efficiency
      const maxW = 640;
      let w = canvas.width;
      let h = canvas.height;
      if (w > maxW) {
        const scale = maxW / w;
        w = maxW;
        h = Math.round(h * scale);
      }

      const offscreen = document.createElement('canvas');
      offscreen.width = w;
      offscreen.height = h;
      const ctx = offscreen.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0, w, h);
      const dataUrl = offscreen.toDataURL('image/jpeg', 0.5);
      window.electronAPI.sendRemoteGetPreviewFrameResponse({ dataUrl, _queryId });
    } catch (err: unknown) {
      log.error('IPC', 'Preview frame capture error:', err);
      window.electronAPI.sendRemoteGetPreviewFrameResponse({ _queryId });
    }
  });
}
