// AppState — Global state shared across all renderer modules.
// Typed version of js/state.js.

import type { ParamValue } from '@shared/types/params.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RenderMode = 'shader' | 'scene' | 'asset';
export type BlendMode = 'lighter' | 'source-over' | 'screen' | 'multiply' | 'overlay';

export interface ActiveAsset {
  renderer: unknown;
  type: 'image' | 'video';
  mediaPath: string | null;
  dataUrl: string | null;
}

export interface ChannelState {
  type: string;
  source?: string;
  filePath?: string;
  dataUrl?: string;
  [key: string]: unknown;
}

export interface MixerChannel {
  slotIndex: number | null;
  alpha: number;
  params: Record<string, ParamValue>;
  customParams: Record<string, ParamValue>;
  renderer: unknown | null;
  shaderCode: string | null;
}

export interface ShaderTab {
  name: string;
  slots: unknown[];
}

// ---------------------------------------------------------------------------
// Debounced remote state notification
// ---------------------------------------------------------------------------

let _remoteNotifyTimeout: ReturnType<typeof setTimeout> | null = null;

export function notifyRemoteStateChanged(): void {
  if (_remoteNotifyTimeout) return;
  _remoteNotifyTimeout = setTimeout(() => {
    _remoteNotifyTimeout = null;
    window.dispatchEvent(new Event('remote-state-changed'));
  }, 50);
}

// ---------------------------------------------------------------------------
// Global state singleton
// ---------------------------------------------------------------------------

export const state = {
  editor: null as unknown,
  renderer: null as unknown,
  shaderRenderer: null as unknown,
  sceneRenderer: null as unknown,
  renderMode: 'shader' as RenderMode,
  activeAsset: null as ActiveAsset | null,
  compileTimeout: null as ReturnType<typeof setTimeout> | null,
  animationId: null as number | null,
  previewEnabled: true,
  gridEnabled: false,
  editorEnabled: true,
  paramsEnabled: true,
  ndiEnabled: false,
  ndiFrameCounter: 0,
  ndiFrameSkip: 4,
  syphonEnabled: false,
  syphonFrameCounter: 0,
  syphonFrameSkip: 4,
  recordingEnabled: false,
  recordingFrameCounter: 0,
  recordingFrameSkip: 1,
  blackoutEnabled: false,

  // Fullscreen tracking
  fullscreenActive: false,
  fullscreenFps: 0,
  fullscreenTargetFps: 60,
  previewFrameInterval: 0,

  // Channel state for fullscreen sync
  channelState: [null, null, null, null] as (ChannelState | null)[],

  // Shader grid state
  gridSlots: [] as unknown[],
  gridAnimationId: null as number | null,
  activeGridSlot: null as number | null,

  // Tabbed shader grid
  shaderTabs: [{ name: 'My Shaders', slots: [] }] as ShaderTab[],
  activeShaderTab: 0,

  // Presets
  activeLocalPresetIndex: null as number | null,

  // Mixer
  mixerChannels: [
    { slotIndex: null, alpha: 1.0, params: {}, customParams: {}, renderer: null, shaderCode: null },
  ] as MixerChannel[],
  mixerEnabled: false,
  mixerArmedChannel: null as number | null,
  mixerSelectedChannel: null as number | null,
  mixerBlendMode: 'lighter' as BlendMode,

  // Visual presets
  visualPresets: [] as unknown[],
  visualPresetsEnabled: false,

  // Tiled preview
  tiledPreviewEnabled: false,
  tileRenderers: [] as unknown[],
  selectedTileIndex: 0,
};
