// Tile Configuration Dialog Module
// Manages the tiled display configuration UI

import { state } from './state.js';
import { setStatus } from './utils.js';
import { tileState, setLayout, assignTile as assignTileToState } from './tile-state.js';

// Local tile configuration state
let tileConfig = {
  layout: { rows: 2, cols: 2, gaps: 4 },
  tiles: []
};

let selectedTileIndex = null;
let draggedSlotIndex = null;

// Initialize tile config dialog
export function initTileConfig() {
  const dialog = document.getElementById('tile-config-dialog');
  const closeBtn = document.getElementById('tile-config-close');
  const cancelBtn = document.getElementById('tile-config-cancel');
  const applyBtn = document.getElementById('tile-config-apply');
  const fullscreenBtn = document.getElementById('tile-config-fullscreen');
  const layoutPreset = document.getElementById('tile-layout-preset');
  const customInputs = document.getElementById('custom-layout-inputs');
  const rowsInput = document.getElementById('tile-rows');
  const colsInput = document.getElementById('tile-cols');
  const gapSlider = document.getElementById('tile-gap-size');
  const gapValue = document.getElementById('tile-gap-value');

  // Close dialog handlers
  closeBtn.addEventListener('click', closeDialog);
  cancelBtn.addEventListener('click', closeDialog);

  // Click outside to close
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) closeDialog();
  });

  // Layout preset change
  layoutPreset.addEventListener('change', () => {
    const value = layoutPreset.value;
    if (value === 'custom') {
      customInputs.classList.remove('hidden');
    } else {
      customInputs.classList.add('hidden');
      const [cols, rows] = value.split('x').map(Number);
      tileConfig.layout.rows = rows;
      tileConfig.layout.cols = cols;
      updatePreviewGrid();
    }
  });

  // Custom row/col inputs
  rowsInput.addEventListener('change', () => {
    tileConfig.layout.rows = Math.max(1, Math.min(8, parseInt(rowsInput.value) || 2));
    rowsInput.value = tileConfig.layout.rows;
    updatePreviewGrid();
  });

  colsInput.addEventListener('change', () => {
    tileConfig.layout.cols = Math.max(1, Math.min(8, parseInt(colsInput.value) || 2));
    colsInput.value = tileConfig.layout.cols;
    updatePreviewGrid();
  });

  // Gap size slider
  gapSlider.addEventListener('input', () => {
    tileConfig.layout.gaps = parseInt(gapSlider.value);
    gapValue.textContent = `${tileConfig.layout.gaps}px`;
  });

  // Apply button
  applyBtn.addEventListener('click', () => {
    saveTileState();
    setStatus('Tile configuration saved', 'success');
  });

  // Open fullscreen button
  fullscreenBtn.addEventListener('click', () => {
    openTiledFullscreen();
  });

  // Load saved state on startup
  loadTileState();
}

// Open the tile configuration dialog
export function openTileConfigDialog() {
  const dialog = document.getElementById('tile-config-dialog');
  dialog.classList.remove('hidden');

  // Reset UI to match current config
  updateLayoutPresetUI();
  updatePreviewGrid();
  populateShaderList();
}

// Close the dialog
function closeDialog() {
  const dialog = document.getElementById('tile-config-dialog');
  dialog.classList.add('hidden');
  selectedTileIndex = null;
}

// Update the layout preset dropdown to match current config
function updateLayoutPresetUI() {
  const layoutPreset = document.getElementById('tile-layout-preset');
  const customInputs = document.getElementById('custom-layout-inputs');
  const rowsInput = document.getElementById('tile-rows');
  const colsInput = document.getElementById('tile-cols');
  const gapSlider = document.getElementById('tile-gap-size');
  const gapValue = document.getElementById('tile-gap-value');

  const { rows, cols, gaps } = tileConfig.layout;

  // Find matching preset
  const presetValue = `${cols}x${rows}`;
  const matchingOption = Array.from(layoutPreset.options).find(
    opt => opt.value === presetValue
  );

  if (matchingOption) {
    layoutPreset.value = presetValue;
    customInputs.classList.add('hidden');
  } else {
    layoutPreset.value = 'custom';
    customInputs.classList.remove('hidden');
    rowsInput.value = rows;
    colsInput.value = cols;
  }

  gapSlider.value = gaps;
  gapValue.textContent = `${gaps}px`;
}

// Update the preview grid based on current layout
function updatePreviewGrid() {
  const grid = document.getElementById('tile-preview-grid');
  const { rows, cols, gaps } = tileConfig.layout;
  const tileCount = rows * cols;

  // Update grid template
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  grid.style.gap = `${gaps}px`;

  // Ensure tiles array is the right size
  while (tileConfig.tiles.length < tileCount) {
    tileConfig.tiles.push({ gridSlotIndex: null, params: null, visible: true });
  }
  tileConfig.tiles.length = tileCount;

  // Generate tile slots
  grid.innerHTML = '';
  for (let i = 0; i < tileCount; i++) {
    const slot = createTilePreviewSlot(i);
    grid.appendChild(slot);
  }
}

// Create a tile preview slot element
function createTilePreviewSlot(index) {
  const slot = document.createElement('div');
  slot.className = 'tile-preview-slot';
  slot.dataset.tileIndex = index;

  const tile = tileConfig.tiles[index];
  const hasShader = tile && tile.gridSlotIndex !== null;

  if (hasShader) {
    slot.classList.add('has-shader');
  }

  // Tile index indicator
  const indexLabel = document.createElement('span');
  indexLabel.className = 'tile-index';
  indexLabel.textContent = index + 1;
  slot.appendChild(indexLabel);

  // Shader name (if assigned)
  if (hasShader) {
    const shaderName = document.createElement('span');
    shaderName.className = 'tile-shader-name';
    const slotData = state.gridSlots[tile.gridSlotIndex];
    shaderName.textContent = slotData?.filePath
      ? slotData.filePath.split('/').pop().split('\\').pop()
      : `Slot ${tile.gridSlotIndex + 1}`;
    slot.appendChild(shaderName);

    // Clear button
    const clearBtn = document.createElement('button');
    clearBtn.className = 'tile-clear-btn';
    clearBtn.textContent = '\u00d7';
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearTile(index);
    });
    slot.appendChild(clearBtn);
  } else {
    const emptyLabel = document.createElement('span');
    emptyLabel.className = 'tile-shader-name';
    emptyLabel.textContent = 'Empty';
    emptyLabel.style.color = 'var(--text-secondary)';
    slot.appendChild(emptyLabel);
  }

  // Selection indicator
  if (selectedTileIndex === index) {
    slot.classList.add('selected');
  }

  // Click to select
  slot.addEventListener('click', () => {
    selectTile(index);
  });

  // Drag and drop handlers
  slot.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    slot.classList.add('drag-over');
  });

  slot.addEventListener('dragleave', () => {
    slot.classList.remove('drag-over');
  });

  slot.addEventListener('drop', (e) => {
    e.preventDefault();
    slot.classList.remove('drag-over');
    const slotIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!isNaN(slotIndex)) {
      assignShaderToTile(index, slotIndex);
    }
  });

  return slot;
}

// Select a tile
function selectTile(index) {
  selectedTileIndex = index;
  updatePreviewGrid();
}

// Assign a shader slot to a tile
function assignShaderToTile(tileIndex, gridSlotIndex) {
  if (tileIndex < 0 || tileIndex >= tileConfig.tiles.length) return;

  const slotData = state.gridSlots[gridSlotIndex];
  if (!slotData) {
    setStatus('No shader in selected slot', 'error');
    return;
  }

  tileConfig.tiles[tileIndex] = {
    gridSlotIndex,
    params: slotData.params ? { ...slotData.params } : null,
    visible: true
  };

  // Sync to shared tileState module
  assignTileToState(tileIndex, gridSlotIndex, slotData.params);

  updatePreviewGrid();
  setStatus(`Assigned slot ${gridSlotIndex + 1} to tile ${tileIndex + 1}`, 'success');
}

// Clear a tile
function clearTile(tileIndex) {
  if (tileIndex < 0 || tileIndex >= tileConfig.tiles.length) return;

  tileConfig.tiles[tileIndex] = {
    gridSlotIndex: null,
    params: null,
    visible: true
  };

  // Sync to shared tileState module
  tileState.tiles[tileIndex] = { gridSlotIndex: null, params: null, visible: true };

  updatePreviewGrid();
}

// Populate the shader list with available shaders
function populateShaderList() {
  const list = document.getElementById('tile-shader-list');
  list.innerHTML = '';

  state.gridSlots.forEach((slot, index) => {
    const item = document.createElement('div');
    item.className = 'tile-shader-item';
    item.draggable = true;
    item.dataset.slotIndex = index;

    if (slot) {
      item.classList.add('has-shader');

      // Create mini canvas for thumbnail
      const canvas = document.createElement('canvas');
      canvas.width = 80;
      canvas.height = 45;
      item.appendChild(canvas);

      // Copy thumbnail from main grid canvas
      const gridSlot = document.querySelector(`.grid-slot[data-slot="${index}"] canvas`);
      if (gridSlot) {
        const ctx = canvas.getContext('2d');
        try {
          ctx.drawImage(gridSlot, 0, 0, canvas.width, canvas.height);
        } catch (e) {
          // Canvas may be tainted
        }
      }
    }

    // Slot number label
    const numberLabel = document.createElement('span');
    numberLabel.className = 'shader-slot-number';
    numberLabel.textContent = index + 1;
    item.appendChild(numberLabel);

    // Drag handlers
    item.addEventListener('dragstart', (e) => {
      if (!slot) {
        e.preventDefault();
        return;
      }
      draggedSlotIndex = index;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', index.toString());
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedSlotIndex = null;
    });

    // Click to assign to selected tile
    item.addEventListener('click', () => {
      if (slot && selectedTileIndex !== null) {
        assignShaderToTile(selectedTileIndex, index);
      } else if (!slot) {
        setStatus('No shader in this slot', 'error');
      } else {
        setStatus('Select a tile first', 'error');
      }
    });

    list.appendChild(item);
  });
}

// Build the full configuration for fullscreen
function buildFullConfig() {
  const tilesWithShaders = tileConfig.tiles.map((tile, index) => {
    if (tile.gridSlotIndex === null) {
      return { gridSlotIndex: null, shaderCode: null, params: null, visible: tile.visible };
    }

    const slotData = state.gridSlots[tile.gridSlotIndex];
    if (!slotData) {
      return { gridSlotIndex: null, shaderCode: null, params: null, visible: tile.visible };
    }

    return {
      gridSlotIndex: tile.gridSlotIndex,
      shaderCode: slotData.shaderCode,
      params: tile.params || slotData.params,
      visible: tile.visible
    };
  });

  return {
    layout: { ...tileConfig.layout },
    tiles: tilesWithShaders
  };
}

// Open tiled fullscreen display
function openTiledFullscreen() {
  const config = buildFullConfig();

  // Check if at least one tile has a shader
  const hasAnyShader = config.tiles.some(t => t.shaderCode !== null);
  if (!hasAnyShader) {
    setStatus('Assign at least one shader to a tile', 'error');
    return;
  }

  // Save state before opening
  saveTileState();

  // Close dialog
  closeDialog();

  // Send to main process to open fullscreen
  window.electronAPI.openTiledFullscreen(config);

  setStatus('Opening tiled fullscreen display', 'success');
}

// Save tile state to file
async function saveTileState() {
  const saveData = {
    layout: { ...tileConfig.layout },
    tiles: tileConfig.tiles.map(t => ({
      gridSlotIndex: t.gridSlotIndex,
      visible: t.visible
    }))
  };

  window.electronAPI.saveTileState(saveData);
}

// Load tile state from file
async function loadTileState() {
  try {
    const data = await window.electronAPI.loadTileState();
    if (data) {
      tileConfig.layout = data.layout || { rows: 2, cols: 2, gaps: 4 };
      tileConfig.tiles = (data.tiles || []).map(t => ({
        gridSlotIndex: t.gridSlotIndex ?? null,
        params: null, // Params will be loaded from grid slots
        visible: t.visible !== false
      }));

      // Ensure correct number of tiles
      const count = tileConfig.layout.rows * tileConfig.layout.cols;
      while (tileConfig.tiles.length < count) {
        tileConfig.tiles.push({ gridSlotIndex: null, params: null, visible: true });
      }
      tileConfig.tiles.length = count;

      // Sync to shared tileState module
      syncToTileState();
    }
  } catch (err) {
    console.error('Failed to load tile state:', err);
  }
}

// Sync local tileConfig to shared tileState module
function syncToTileState() {
  setLayout(tileConfig.layout.rows, tileConfig.layout.cols, tileConfig.layout.gaps);
  tileConfig.tiles.forEach((tile, index) => {
    if (tile.gridSlotIndex !== null) {
      assignTileToState(index, tile.gridSlotIndex, tile.params);
    }
  });
}

// Export for use from menu
export function showTileConfigDialog() {
  openTileConfigDialog();
}
