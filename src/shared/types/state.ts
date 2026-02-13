// Application state types

import type { ParamValues } from './params.js';
import type { IRenderer } from './renderer.js';

/** Render mode of the main renderer */
export type RenderMode = 'shader' | 'scene' | 'asset';

/** Slot type in the shader grid */
export type SlotType = 'shader' | 'scene' | 'asset-image' | 'asset-video' | 'empty';

/** Blend mode for mixer compositing (maps to canvas globalCompositeOperation) */
export type BlendMode =
  | 'lighter' | 'screen' | 'source-over' | 'multiply'
  | 'overlay' | 'hard-light' | 'soft-light' | 'difference'
  | 'exclusion' | 'color-dodge' | 'color-burn';

/** Channel state for texture inputs (iChannel0-3) */
export interface ChannelState {
  type: ChannelType;
  /** Data URL for images, file path for videos, source name for NDI */
  source?: string;
  /** FFT size for audio channels */
  fftSize?: number;
}

import type { ChannelType } from './renderer.js';

/** A preset stored for a shader slot */
export interface PresetData {
  params: ParamValues;
  name: string | null;
}

/** Data for a single grid slot */
export interface GridSlotData {
  /** Slot type */
  type: SlotType;
  /** Shader/scene source code (stored separately in files, null in grid state) */
  code?: string | null;
  /** File path for the shader (e.g. "button5.glsl") */
  file?: string;
  /** Display name */
  name?: string;
  /** Current parameter values */
  params?: ParamValues;
  /** Custom @param values */
  customParams?: ParamValues;
  /** Channel states (iChannel0-3 texture assignments) */
  channels?: (ChannelState | null)[];
  /** Local presets for this slot */
  presets?: PresetData[];
  /** Thumbnail data URL */
  thumbnail?: string;
  /** Media file path (for asset slots) */
  mediaPath?: string;
  /** Reference to the active mini renderer (transient, not persisted) */
  renderer?: IRenderer | null;
}

/** A tab in the shader grid */
export interface ShaderTabData {
  name: string;
  slots: GridSlotData[];
  /** Tab section type: 'shaders' (default) or 'assets' */
  section?: 'shaders' | 'assets';
}

/** Mixer channel data */
export interface MixerChannelData {
  /** Index of the grid slot assigned to this channel, or null */
  slotIndex: number | null;
  /** Alpha/opacity (0-1) */
  alpha: number;
  /** Built-in parameter values */
  params: ParamValues;
  /** Custom @param values */
  customParams: ParamValues;
  /** Reference to the channel's renderer (transient) */
  renderer?: IRenderer | null;
  /** Cached shader code (transient) */
  shaderCode?: string | null;
}

/** Tile data for tiled display mode */
export interface TileData {
  /** Grid slot index assigned to this tile, or null */
  gridSlotIndex: number | null;
  /** Tab index for the assigned slot */
  tabIndex?: number;
  /** Parameter values for this tile */
  params?: ParamValues;
  /** Custom param values for this tile */
  customParams?: ParamValues;
  /** Shader code cache (transient) */
  shaderCode?: string | null;
}

/** Tile layout configuration */
export interface TileLayout {
  rows: number;
  cols: number;
  gap: number;
}

/** Visual preset (full-state snapshot) */
export interface VisualPreset {
  name: string;
  /** Slot data snapshots */
  slots: Partial<GridSlotData>[];
  /** Mixer state snapshot */
  mixer?: {
    channels: Partial<MixerChannelData>[];
    blendMode: BlendMode;
    enabled: boolean;
  };
  /** Tile state snapshot */
  tiles?: TileData[];
  /** Thumbnail data URL */
  thumbnail?: string;
}

/** Mix preset (mixer-only state snapshot) */
export interface MixPreset {
  name: string;
  channels: Partial<MixerChannelData>[];
  blendMode: BlendMode;
  enabled: boolean;
}

/** Editor tab state */
export interface EditorTab {
  id: string;
  name: string;
  mode: 'glsl' | 'javascript' | 'jsx';
  content: string;
  /** Grid slot index this tab is editing, or null for unsaved */
  slotIndex: number | null;
}

/** Full application state (renderer process) */
export interface AppState {
  editor: unknown; // Ace editor instance
  renderer: IRenderer | null;
  shaderRenderer: IRenderer | null;
  sceneRenderer: IRenderer | null;
  renderMode: RenderMode;
  activeAsset: { renderer: IRenderer; type: string; mediaPath: string; dataUrl: string } | null;
  compileTimeout: ReturnType<typeof setTimeout> | null;
  animationId: number | null;
  previewEnabled: boolean;
  gridEnabled: boolean;
  editorEnabled: boolean;
  paramsEnabled: boolean;
  ndiEnabled: boolean;
  ndiFrameCounter: number;
  ndiFrameSkip: number;
  syphonEnabled: boolean;
  syphonFrameCounter: number;
  syphonFrameSkip: number;
  recordingEnabled: boolean;
  recordingFrameCounter: number;
  recordingFrameSkip: number;
  blackoutEnabled: boolean;
  fullscreenActive: boolean;
  fullscreenFps: number;
  fullscreenTargetFps: number;
  previewFrameInterval: number;
  channelState: (ChannelState | null)[];
  gridSlots: GridSlotData[];
  gridAnimationId: number | null;
  activeGridSlot: number | null;
  shaderTabs: ShaderTabData[];
  activeShaderTab: number;
  activeLocalPresetIndex: number | null;
  mixerChannels: MixerChannelData[];
  mixerEnabled: boolean;
  mixerArmedChannel: number | null;
  mixerSelectedChannel: number | null;
  mixerBlendMode: BlendMode;
  visualPresets: VisualPreset[];
  visualPresetsEnabled: boolean;
  tiledPreviewEnabled: boolean;
  tileRenderers: IRenderer[];
  selectedTileIndex: number;
}
