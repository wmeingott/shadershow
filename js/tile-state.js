// Tile State module - manages tiled display configuration
// Each tile can independently render a shader from a grid slot

export const tileState = {
  // Layout configuration
  layout: {
    rows: 2,
    cols: 2,
    gaps: 4  // Gap between tiles in pixels
  },

  // Tile assignments - array of tile configurations
  // Each tile maps to a grid slot and can have its own params
  // Initialize with 4 empty tiles for default 2x2 layout
  tiles: [
    { gridSlotIndex: null, params: null, visible: true },
    { gridSlotIndex: null, params: null, visible: true },
    { gridSlotIndex: null, params: null, visible: true },
    { gridSlotIndex: null, params: null, visible: true }
  ],

  // Runtime state (not persisted)
  renderers: [],      // TileRenderer instances (fullscreen window only)
  isInitialized: false
};

// Layout presets for quick selection
export const layoutPresets = [
  { label: '1x1 (Single)', rows: 1, cols: 1 },
  { label: '2x1 (Dual)', rows: 1, cols: 2 },
  { label: '1x2 (Stack)', rows: 2, cols: 1 },
  { label: '2x2 (Quad)', rows: 2, cols: 2 },
  { label: '3x2', rows: 2, cols: 3 },
  { label: '2x3', rows: 3, cols: 2 },
  { label: '3x3 (Nine)', rows: 3, cols: 3 },
  { label: '4x4 (Sixteen)', rows: 4, cols: 4 }
];

// Initialize tiles array based on layout
export function initTiles(rows, cols) {
  const count = rows * cols;
  tileState.tiles = [];

  for (let i = 0; i < count; i++) {
    tileState.tiles.push({
      gridSlotIndex: null,  // Index into grid slots (0-31), null = empty
      params: null,         // Per-tile parameter overrides (null = use slot defaults)
      visible: true         // Whether to render this tile
    });
  }

  tileState.layout.rows = rows;
  tileState.layout.cols = cols;
}

// Set layout with optional tile preservation
export function setLayout(rows, cols, gaps = 4, preserveTiles = false) {
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
        tileState.tiles.push({
          gridSlotIndex: null,
          params: null,
          visible: true
        });
      }
    } else {
      tileState.tiles.push({
        gridSlotIndex: null,
        params: null,
        visible: true
      });
    }
  }
}

// Assign a grid slot to a tile
export function assignTile(tileIndex, gridSlotIndex, params = null) {
  if (tileIndex >= 0 && tileIndex < tileState.tiles.length) {
    tileState.tiles[tileIndex] = {
      gridSlotIndex,
      params,
      visible: true
    };
  }
}

// Clear a tile
export function clearTile(tileIndex) {
  if (tileIndex >= 0 && tileIndex < tileState.tiles.length) {
    tileState.tiles[tileIndex] = {
      gridSlotIndex: null,
      params: null,
      visible: true
    };
  }
}

// Toggle tile visibility
export function setTileVisibility(tileIndex, visible) {
  if (tileIndex >= 0 && tileIndex < tileState.tiles.length) {
    tileState.tiles[tileIndex].visible = visible;
  }
}

// Get tile bounds for rendering (pixel coordinates within canvas)
export function calculateTileBounds(canvasWidth, canvasHeight) {
  const { rows, cols, gaps } = tileState.layout;
  const bounds = [];

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

// Serialize tile state for persistence
export function serializeTileState() {
  return {
    layout: { ...tileState.layout },
    tiles: tileState.tiles.map(t => ({
      gridSlotIndex: t.gridSlotIndex,
      params: t.params ? { ...t.params } : null,
      visible: t.visible
    }))
  };
}

// Deserialize tile state from saved data
export function deserializeTileState(data) {
  if (!data) return;

  if (data.layout) {
    tileState.layout.rows = data.layout.rows || 2;
    tileState.layout.cols = data.layout.cols || 2;
    tileState.layout.gaps = data.layout.gaps ?? 4;
  }

  if (data.tiles && Array.isArray(data.tiles)) {
    tileState.tiles = data.tiles.map(t => ({
      gridSlotIndex: t.gridSlotIndex ?? null,
      params: t.params ? { ...t.params } : null,
      visible: t.visible !== false
    }));
  }

  // Ensure we have the right number of tiles
  const expectedCount = tileState.layout.rows * tileState.layout.cols;
  while (tileState.tiles.length < expectedCount) {
    tileState.tiles.push({
      gridSlotIndex: null,
      params: null,
      visible: true
    });
  }
  if (tileState.tiles.length > expectedCount) {
    tileState.tiles.length = expectedCount;
  }
}
