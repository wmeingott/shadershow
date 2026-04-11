// Tile State module - manages tiled display configuration
// Each tile can independently render a shader from a grid slot

import type { ParamValues } from '@shared/types/params.js';

// ---------------------------------------------------------------------------
// Local interfaces (runtime shape — note: uses `gaps` not `gap`)
// ---------------------------------------------------------------------------

export interface TileLayoutConfig {
  rows: number;
  cols: number;
  gaps: number;
}

export interface TileConfig {
  gridSlotIndex: number | null;
  params: ParamValues | null;
  customParams: ParamValues | null;
  visible: boolean;
}

interface TilePresetTile extends TileConfig {
  shaderCode: string | null;
}

export interface TilePreset {
  name: string;
  savedAt: number;
  layout: TileLayoutConfig;
  tiles: TilePresetTile[];
}

interface TilePresets {
  presets: (TilePreset | null)[];
  activeIndex: number | null;
}

interface TileBounds {
  tileIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TileState {
  layout: TileLayoutConfig;
  tiles: TileConfig[];
  renderers: unknown[];
  isInitialized: boolean;
}

interface SerializedTilePresets {
  presets: (TilePreset | null)[];
  activeIndex: number | null;
}

/** Type for grid slot data passed into saveTilePreset */
type GridSlotInput = Array<{
  shaderCode?: string | null;
  params?: ParamValues | null;
  customParams?: ParamValues | null;
} | null>;

// ---------------------------------------------------------------------------
// State singletons
// ---------------------------------------------------------------------------

// Tile presets - full snapshots of tiled display state
// Each preset stores layout + all tile assignments with their shader code and params
export const tilePresets: TilePresets = {
  presets: [], // Array of up to 8 presets
  activeIndex: null
};

export const tileState: TileState = {
  // Layout configuration
  layout: {
    rows: 2,
    cols: 2,
    gaps: 4  // Gap between tiles in pixels
  },

  // Tile assignments - array of tile configurations
  // Each tile maps to a grid slot and can have its own independent params
  // Tiles share the slot's renderer but have their own param copies
  // Initialize with 4 empty tiles for default 2x2 layout
  tiles: [
    { gridSlotIndex: null, params: null, customParams: null, visible: true },
    { gridSlotIndex: null, params: null, customParams: null, visible: true },
    { gridSlotIndex: null, params: null, customParams: null, visible: true },
    { gridSlotIndex: null, params: null, customParams: null, visible: true }
  ],

  // Runtime state (not persisted)
  renderers: [],      // TileRenderer instances (fullscreen window only)
  isInitialized: false
};

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

function createEmptyTile(): TileConfig {
  return {
    gridSlotIndex: null,
    params: null,
    customParams: null,
    visible: true
  };
}

// Set layout with optional tile preservation
export function setLayout(
  rows: number,
  cols: number,
  gaps: number = 4,
  preserveTiles: boolean = false
): void {
  const oldTiles = [...tileState.tiles];
  const oldCols = tileState.layout.cols;

  tileState.layout.rows = rows;
  tileState.layout.cols = cols;
  tileState.layout.gaps = gaps;

  const count = rows * cols;
  tileState.tiles = [];

  for (let i = 0; i < count; i++) {
    if (preserveTiles && i < oldTiles.length) {
      // Try to preserve tile in same position or remap
      const oldRow = Math.floor(i / oldCols);
      const oldCol = i % oldCols;
      const oldIndex = oldRow * oldCols + oldCol;

      if (oldIndex < oldTiles.length) {
        tileState.tiles.push({ ...oldTiles[oldIndex] });
      } else {
        tileState.tiles.push(createEmptyTile());
      }
    } else {
      tileState.tiles.push(createEmptyTile());
    }
  }
}

// Assign a grid slot to a tile
export function assignTile(
  tileIndex: number,
  gridSlotIndex: number,
  params: ParamValues | null = null,
  customParams: ParamValues | null = null
): void {
  if (tileIndex >= 0 && tileIndex < tileState.tiles.length) {
    tileState.tiles[tileIndex] = {
      gridSlotIndex,
      params: params ? { ...params } : null,
      customParams: customParams ? { ...customParams } : null,
      visible: true
    };
  }
}

// Get tile bounds for rendering (pixel coordinates within canvas)
export function calculateTileBounds(
  canvasWidth: number,
  canvasHeight: number
): TileBounds[] {
  const { rows, cols, gaps } = tileState.layout;
  const bounds: TileBounds[] = [];

  // Calculate available space after gaps
  const totalGapX = gaps * (cols - 1);
  const totalGapY = gaps * (rows - 1);
  const tileWidth = Math.floor((canvasWidth - totalGapX) / cols);
  const tileHeight = Math.floor((canvasHeight - totalGapY) / rows);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tileIndex = row * cols + col;
      const x = col * (tileWidth + gaps);
      // WebGL has Y=0 at bottom, so flip the row order
      const y = (rows - 1 - row) * (tileHeight + gaps);

      bounds.push({
        tileIndex,
        x,
        y,
        width: tileWidth,
        height: tileHeight
      });
    }
  }

  return bounds;
}

// =============================================================================
// Tile Preset Functions
// =============================================================================

// Save current tiled state as a preset
export function saveTilePreset(
  index: number,
  name: string,
  gridSlots: GridSlotInput
): TilePreset | undefined {
  if (index < 0 || index > 7) return;

  // Build full preset with shader code embedded
  const preset: TilePreset = {
    name: name || `Preset ${index + 1}`,
    savedAt: Date.now(),
    layout: { ...tileState.layout },
    tiles: tileState.tiles.map(tile => {
      if (tile.gridSlotIndex === null) {
        return { gridSlotIndex: null, shaderCode: null, params: null, customParams: null, visible: true };
      }
      const slotData = gridSlots[tile.gridSlotIndex];
      return {
        gridSlotIndex: tile.gridSlotIndex,
        shaderCode: slotData?.shaderCode || null,
        params: tile.params ? { ...tile.params } : (slotData?.params ? { ...slotData.params } : null),
        customParams: tile.customParams ? { ...tile.customParams } : (slotData?.customParams ? { ...slotData.customParams } : null),
        visible: tile.visible !== false
      };
    })
  };

  // Ensure presets array is large enough
  while (tilePresets.presets.length <= index) {
    tilePresets.presets.push(null);
  }
  tilePresets.presets[index] = preset;
  tilePresets.activeIndex = index;

  return preset;
}

// Recall a tile preset
export function recallTilePreset(index: number): TilePreset | null {
  if (index < 0 || index >= tilePresets.presets.length) return null;

  const preset = tilePresets.presets[index];
  if (!preset) return null;

  // Apply layout
  tileState.layout = { ...preset.layout };

  // Apply tiles (just the grid slot indices and params, shader code is for fullscreen)
  tileState.tiles = preset.tiles.map(t => ({
    gridSlotIndex: t.gridSlotIndex,
    params: t.params ? { ...t.params } : null,
    customParams: t.customParams ? { ...t.customParams } : null,
    visible: t.visible !== false
  }));

  tilePresets.activeIndex = index;
  return preset;
}

// Get preset info for display
export function getTilePresetInfo(
  index: number
): { name: string; layout: TileLayoutConfig; tileCount: number } | null {
  if (index < 0 || index >= tilePresets.presets.length) return null;
  const preset = tilePresets.presets[index];
  if (!preset) return null;
  return {
    name: preset.name,
    layout: preset.layout,
    tileCount: preset.tiles.filter(t => t.gridSlotIndex !== null).length
  };
}

// Serialize presets for persistence (deep copy)
export function serializeTilePresets(): SerializedTilePresets {
  return {
    presets: tilePresets.presets.map(p => {
      if (!p) return null;
      return {
        name: p.name,
        savedAt: p.savedAt,
        layout: { ...p.layout },
        tiles: p.tiles.map(t => ({
          gridSlotIndex: t.gridSlotIndex,
          shaderCode: t.shaderCode,
          params: t.params ? { ...t.params } : null,
          customParams: t.customParams ? { ...t.customParams } : null,
          visible: t.visible
        }))
      };
    }),
    activeIndex: tilePresets.activeIndex
  };
}

// Deserialize presets from saved data (deep copy)
export function deserializeTilePresets(data: Partial<SerializedTilePresets> | null | undefined): void {
  if (!data) return;
  if (Array.isArray(data.presets)) {
    tilePresets.presets = data.presets.map(p => {
      if (!p) return null;
      return {
        name: p.name,
        savedAt: p.savedAt,
        layout: { ...p.layout },
        tiles: p.tiles.map(t => ({
          gridSlotIndex: t.gridSlotIndex,
          shaderCode: t.shaderCode,
          params: t.params ? { ...t.params } : null,
          customParams: t.customParams ? { ...t.customParams } : null,
          visible: t.visible
        }))
      };
    });
  }
  tilePresets.activeIndex = data.activeIndex ?? null;
}
