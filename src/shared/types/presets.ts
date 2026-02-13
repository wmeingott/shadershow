// Preset data types (for persistence)

import type { ParamValues } from './params.js';

/** A local preset stored per-shader-slot */
export interface LocalPreset {
  params: ParamValues;
  name: string | null;
}

/** Global parameter presets (data/presets.json) */
export interface GlobalPresets {
  [name: string]: ParamValues;
}

/** Tile preset — full snapshot of a tiled display configuration */
export interface TilePreset {
  name?: string;
  layout: {
    rows: number;
    cols: number;
    gap: number;
  };
  tiles: TilePresetEntry[];
}

/** Entry in a tile preset */
export interface TilePresetEntry {
  gridSlotIndex: number | null;
  tabIndex?: number;
  shaderCode?: string;
  params?: ParamValues;
  customParams?: ParamValues;
}

/** State preset — full snapshot of grid slot + mixer + tile state */
export interface StatePreset {
  /** Active grid slot index */
  activeSlot: number | null;
  /** Parameter values for the active slot */
  params: ParamValues;
  /** Mixer state */
  mixer?: {
    channels: MixerPresetChannel[];
    blendMode: string;
    enabled: boolean;
  };
}

/** Mixer channel in a state preset */
export interface MixerPresetChannel {
  slotIndex: number | null;
  alpha: number;
  params: ParamValues;
  customParams: ParamValues;
}
