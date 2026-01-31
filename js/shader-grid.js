// Shader Grid module
import { state } from './state.js';
import { setStatus } from './utils.js';
import { loadParamsToSliders, generateCustomParamUI } from './params.js';
import { updateLocalPresetsUI } from './presets.js';
import { setRenderMode, ensureSceneRenderer } from './renderer.js';
import { setEditorMode } from './editor.js';
import { parseShaderParams, generateUniformDeclarations } from './param-parser.js';
import { openInTab } from './tabs.js';
import { tileState, assignTile } from './tile-state.js';
import { updateTileRenderer, refreshTileRenderers } from './controls.js';

// Track drag state
let dragSourceIndex = null;

// Store event listeners for cleanup (to prevent memory leaks)
const slotEventListeners = new Map();
let documentClickHandler = null;

// Cleanup function for grid event listeners
export function cleanupShaderGrid() {
  // Remove slot event listeners
  slotEventListeners.forEach((listeners, slot) => {
    listeners.forEach(({ event, handler }) => {
      slot.removeEventListener(event, handler);
    });
  });
  slotEventListeners.clear();

  // Remove document click handler
  if (documentClickHandler) {
    document.removeEventListener('click', documentClickHandler);
    documentClickHandler = null;
  }

  // Disconnect intersection observer
  cleanupGridVisibilityObserver();

  // Stop grid animation
  stopGridAnimation();
}

// Create a grid slot DOM element and wire up event listeners
function createGridSlotElement(index) {
  const slot = document.createElement('div');
  slot.className = 'grid-slot';
  slot.dataset.slot = index;
  slot.setAttribute('draggable', 'true');

  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  slot.appendChild(canvas);

  const numberSpan = document.createElement('span');
  numberSpan.className = 'slot-number';
  numberSpan.textContent = index + 1;
  slot.appendChild(numberSpan);

  // Store listeners for this slot
  const listeners = [];

  // Drag start - store source index
  const dragstartHandler = (e) => {
    dragSourceIndex = index;
    slot.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
  };
  slot.addEventListener('dragstart', dragstartHandler);
  listeners.push({ event: 'dragstart', handler: dragstartHandler });

  // Drag end - cleanup
  const dragendHandler = () => {
    slot.classList.remove('dragging');
    dragSourceIndex = null;
    document.querySelectorAll('.grid-slot.drag-over').forEach(s => {
      s.classList.remove('drag-over');
    });
  };
  slot.addEventListener('dragend', dragendHandler);
  listeners.push({ event: 'dragend', handler: dragendHandler });

  // Drag over - allow drop
  const dragoverHandler = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  slot.addEventListener('dragover', dragoverHandler);
  listeners.push({ event: 'dragover', handler: dragoverHandler });

  // Drag enter - visual feedback
  const dragenterHandler = (e) => {
    e.preventDefault();
    if (dragSourceIndex !== null && dragSourceIndex !== index) {
      slot.classList.add('drag-over');
    }
  };
  slot.addEventListener('dragenter', dragenterHandler);
  listeners.push({ event: 'dragenter', handler: dragenterHandler });

  // Drag leave - remove visual feedback
  const dragleaveHandler = (e) => {
    if (!slot.contains(e.relatedTarget)) {
      slot.classList.remove('drag-over');
    }
  };
  slot.addEventListener('dragleave', dragleaveHandler);
  listeners.push({ event: 'dragleave', handler: dragleaveHandler });

  // Drop - swap slots
  const dropHandler = (e) => {
    e.preventDefault();
    slot.classList.remove('drag-over');
    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!isNaN(fromIndex) && fromIndex !== index) {
      swapGridSlots(fromIndex, index);
    }
  };
  slot.addEventListener('drop', dropHandler);
  listeners.push({ event: 'drop', handler: dropHandler });

  // Left click - select slot and load parameters
  const clickHandler = () => {
    if (state.gridSlots[index]) {
      selectGridSlot(index);
    }
  };
  slot.addEventListener('click', clickHandler);
  listeners.push({ event: 'click', handler: clickHandler });

  // Double click - open shader in editor tab
  const dblclickHandler = () => {
    if (state.gridSlots[index]) {
      loadGridShaderToEditor(index);
    }
  };
  slot.addEventListener('dblclick', dblclickHandler);
  listeners.push({ event: 'dblclick', handler: dblclickHandler });

  // Right click - context menu
  const contextmenuHandler = (e) => {
    e.preventDefault();
    showGridContextMenu(e.clientX, e.clientY, index);
  };
  slot.addEventListener('contextmenu', contextmenuHandler);
  listeners.push({ event: 'contextmenu', handler: contextmenuHandler });

  slotEventListeners.set(slot, listeners);

  return slot;
}

// Create the "Add Shader" button element
function createAddButton() {
  const btn = document.createElement('div');
  btn.className = 'grid-slot grid-add-btn';
  btn.title = 'Add shader to grid';

  const plusSign = document.createElement('span');
  plusSign.className = 'grid-add-plus';
  plusSign.textContent = '+';
  btn.appendChild(plusSign);

  btn.addEventListener('click', async () => {
    await addNewGridSlot();
  });

  return btn;
}

// Add a new empty slot and immediately prompt to load a shader
async function addNewGridSlot() {
  const newIndex = state.gridSlots.length;
  state.gridSlots.push(null);

  const container = document.getElementById('shader-grid-container');
  const addBtn = container.querySelector('.grid-add-btn');

  const slotEl = createGridSlotElement(newIndex);
  container.insertBefore(slotEl, addBtn);

  // Observe new slot for visibility
  if (gridIntersectionObserver) {
    gridIntersectionObserver.observe(slotEl);
  }

  // Prompt to load a shader
  await loadShaderToSlot(newIndex);

  // If user canceled, remove the empty slot
  if (!state.gridSlots[newIndex]) {
    removeGridSlotElement(newIndex);
  }
}

// Remove a grid slot DOM element and compact state
function removeGridSlotElement(index) {
  // Dispose renderer
  if (state.gridSlots[index] && state.gridSlots[index].renderer) {
    if (state.gridSlots[index].renderer.dispose) {
      state.gridSlots[index].renderer.dispose();
    }
  }

  // Remove from state
  state.gridSlots.splice(index, 1);

  // Fix activeGridSlot reference
  if (state.activeGridSlot === index) {
    state.activeGridSlot = null;
  } else if (state.activeGridSlot !== null && state.activeGridSlot > index) {
    state.activeGridSlot--;
  }

  // Rebuild DOM (simpler than re-indexing all elements + listeners)
  rebuildGridDOM();
}

// Rebuild all grid slot DOM elements from state
function rebuildGridDOM() {
  const container = document.getElementById('shader-grid-container');

  // Cleanup existing listeners
  slotEventListeners.forEach((listeners, slot) => {
    listeners.forEach(({ event, handler }) => {
      slot.removeEventListener(event, handler);
    });
  });
  slotEventListeners.clear();
  cleanupGridVisibilityObserver();

  // Clear container
  container.innerHTML = '';

  // Recreate slot elements for each state entry
  for (let i = 0; i < state.gridSlots.length; i++) {
    const slotEl = createGridSlotElement(i);
    container.appendChild(slotEl);

    const data = state.gridSlots[i];
    if (data) {
      slotEl.classList.add('has-shader');
      if (data.hasError) slotEl.classList.add('has-error');
      if (state.activeGridSlot === i) slotEl.classList.add('active');

      const fileName = data.filePath ? data.filePath.split('/').pop().split('\\').pop() : `Slot ${i + 1}`;
      const typeLabel = data.type === 'scene' ? ' (scene)' : '';
      slotEl.title = `Slot ${i + 1}: ${fileName}${typeLabel}`;

      // Update renderer's canvas reference to the new DOM element
      if (data.renderer) {
        const newCanvas = slotEl.querySelector('canvas');
        data.renderer.canvas = newCanvas;
        data.renderer.ctx2d = newCanvas.getContext('2d');
      }
    }
  }

  // Add the "+" button at the end
  container.appendChild(createAddButton());

  // Reinitialize visibility observer
  initGridVisibilityObserver();
}

export async function initShaderGrid() {
  // Cleanup any existing listeners first
  cleanupShaderGrid();

  // Close context menu when clicking elsewhere
  documentClickHandler = hideContextMenu;
  document.addEventListener('click', documentClickHandler);

  // Load saved grid state (this will create DOM slots dynamically)
  await loadGridState();

  // If no slots were loaded, rebuild DOM with just the add button
  if (state.gridSlots.length === 0) {
    rebuildGridDOM();
  }
}

function showGridContextMenu(x, y, slotIndex) {
  hideContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'grid-context-menu';

  const hasShader = state.gridSlots[slotIndex] !== null;

  // Load shader option
  const loadItem = document.createElement('div');
  loadItem.className = 'context-menu-item';
  loadItem.textContent = 'Load Shader...';
  loadItem.addEventListener('click', async () => {
    hideContextMenu();
    await loadShaderToSlot(slotIndex);
  });
  menu.appendChild(loadItem);

  // Assign current shader option
  const assignItem = document.createElement('div');
  assignItem.className = 'context-menu-item';
  assignItem.textContent = 'Assign Current Shader';
  assignItem.addEventListener('click', () => {
    hideContextMenu();
    assignCurrentShaderToSlot(slotIndex);
  });
  menu.appendChild(assignItem);

  // Set current params as default option (only if has shader)
  const setParamsItem = document.createElement('div');
  setParamsItem.className = `context-menu-item${hasShader ? '' : ' disabled'}`;
  setParamsItem.textContent = 'Set Current Params as Default';
  if (hasShader) {
    setParamsItem.addEventListener('click', () => {
      hideContextMenu();
      setCurrentParamsAsDefault(slotIndex);
    });
  }
  menu.appendChild(setParamsItem);

  // Clear option (only if has shader)
  const clearItem = document.createElement('div');
  clearItem.className = `context-menu-item${hasShader ? '' : ' disabled'}`;
  clearItem.textContent = 'Clear Slot';
  if (hasShader) {
    clearItem.addEventListener('click', () => {
      hideContextMenu();
      clearGridSlot(slotIndex);
    });
  }
  menu.appendChild(clearItem);

  // Remove slot option
  const removeItem = document.createElement('div');
  removeItem.className = 'context-menu-item';
  removeItem.textContent = 'Remove Slot';
  removeItem.addEventListener('click', async () => {
    hideContextMenu();
    // Delete the shader file first
    await window.electronAPI.deleteShaderFromSlot(slotIndex);
    removeGridSlotElement(slotIndex);
    saveGridState();
    // Re-save all shader files with updated indices
    await resaveAllShaderFiles();
    setStatus(`Removed slot ${slotIndex + 1}`, 'success');
  });
  menu.appendChild(removeItem);

  // Send to Tile submenu (only if has shader and tiles are configured)
  if (hasShader && tileState.tiles.length > 0) {
    const separator = document.createElement('div');
    separator.className = 'context-menu-separator';
    menu.appendChild(separator);

    const { rows, cols } = tileState.layout;
    const tileCount = rows * cols;

    // Create "Send to Tile" submenu container
    const tileSubmenu = document.createElement('div');
    tileSubmenu.className = 'context-menu-item has-submenu';
    tileSubmenu.textContent = 'Send to Tile';

    const submenuArrow = document.createElement('span');
    submenuArrow.className = 'submenu-arrow';
    submenuArrow.textContent = '\u25b6';
    tileSubmenu.appendChild(submenuArrow);

    const submenuContent = document.createElement('div');
    submenuContent.className = 'context-submenu';

    for (let i = 0; i < tileCount; i++) {
      const tileItem = document.createElement('div');
      tileItem.className = 'context-menu-item';
      const currentSlot = tileState.tiles[i]?.gridSlotIndex;
      const tileLabel = currentSlot !== null ? `Tile ${i + 1} (Slot ${currentSlot + 1})` : `Tile ${i + 1} (Empty)`;
      tileItem.textContent = tileLabel;

      tileItem.addEventListener('click', () => {
        hideContextMenu();
        assignShaderToTile(slotIndex, i);
      });

      submenuContent.appendChild(tileItem);
    }

    tileSubmenu.appendChild(submenuContent);
    menu.appendChild(tileSubmenu);
  }

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Adjust position if menu goes off screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${window.innerWidth - rect.width - 5}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${window.innerHeight - rect.height - 5}px`;
  }
}

function hideContextMenu() {
  const menu = document.getElementById('grid-context-menu');
  if (menu) {
    menu.remove();
  }
}

// Assign a shader slot to a tile
function assignShaderToTile(slotIndex, tileIndex) {
  const slotData = state.gridSlots[slotIndex];
  if (!slotData) {
    setStatus('No shader in slot', 'error');
    return;
  }

  // Update tile state with copies of slot's params
  // Tiles share the slot's renderer but have their own param copies
  assignTile(tileIndex, slotIndex, slotData.params, slotData.customParams);

  // Update tile renderer reference (points to slot's renderer)
  updateTileRenderer(tileIndex);

  // Sync to fullscreen if tiled mode is active
  if (state.tiledPreviewEnabled && slotData.shaderCode) {
    const allParams = {
      speed: slotData.params?.speed ?? 1,
      ...(slotData.customParams || {})
    };
    window.electronAPI.assignTileShader?.(tileIndex, slotData.shaderCode, allParams);
  }

  // Save tile state
  saveTileState();

  setStatus(`Assigned slot ${slotIndex + 1} to tile ${tileIndex + 1}`, 'success');
}

// Save tile state to file
function saveTileState() {
  const saveData = {
    layout: { ...tileState.layout },
    tiles: tileState.tiles.map(t => ({
      gridSlotIndex: t.gridSlotIndex,
      params: t.params ? { ...t.params } : null,
      customParams: t.customParams ? { ...t.customParams } : null,
      visible: t.visible
    }))
  };
  window.electronAPI.saveTileState?.(saveData);
}

// Set current parameters as default for a shader slot
function setCurrentParamsAsDefault(slotIndex) {
  const slotData = state.gridSlots[slotIndex];
  if (!slotData) return;

  // Get current params from the main renderer
  const currentParams = state.renderer.getParams();

  // Update the slot's params
  slotData.params = { ...currentParams };

  // Save grid state
  saveGridState();

  setStatus(`Saved current params as default for slot ${slotIndex + 1}`, 'success');
}

// Swap two grid slots
async function swapGridSlots(fromIndex, toIndex) {
  const fromSlot = document.querySelector(`.grid-slot[data-slot="${fromIndex}"]`);
  const toSlot = document.querySelector(`.grid-slot[data-slot="${toIndex}"]`);
  const fromCanvas = fromSlot.querySelector('canvas');
  const toCanvas = toSlot.querySelector('canvas');

  // Swap data in state
  const fromData = state.gridSlots[fromIndex];
  const toData = state.gridSlots[toIndex];
  state.gridSlots[fromIndex] = toData;
  state.gridSlots[toIndex] = fromData;

  // Update active slot reference if needed
  if (state.activeGridSlot === fromIndex) {
    state.activeGridSlot = toIndex;
  } else if (state.activeGridSlot === toIndex) {
    state.activeGridSlot = fromIndex;
  }

  // Recreate renderers for swapped slots (they need new canvas references)
  if (state.gridSlots[fromIndex]) {
    const data = state.gridSlots[fromIndex];
    if (data.type === 'scene') {
      // Re-render scene snapshot to new canvas position
      try {
        const sceneRenderer = ensureSceneRenderer();
        if (sceneRenderer) {
          sceneRenderer.compile(data.shaderCode);
          sceneRenderer.resetTime();
          sceneRenderer.render();
          const mainCanvas = document.getElementById('shader-canvas');
          const ctx = fromCanvas.getContext('2d');
          ctx.drawImage(mainCanvas, 0, 0, mainCanvas.width, mainCanvas.height, 0, 0, fromCanvas.width, fromCanvas.height);
        }
      } catch (err) {
        console.warn(`Failed to re-render scene for slot ${fromIndex + 1}:`, err);
      }
    } else {
      // Dispose old renderer before creating new one
      if (data.renderer && data.renderer.dispose) {
        data.renderer.dispose();
      }
      const newRenderer = new MiniShaderRenderer(fromCanvas);
      try {
        newRenderer.compile(data.shaderCode);
        data.renderer = newRenderer;
      } catch (err) {
        console.warn(`Failed to recompile shader for slot ${fromIndex + 1}:`, err);
      }
    }
  }

  if (state.gridSlots[toIndex]) {
    const data = state.gridSlots[toIndex];
    if (data.type === 'scene') {
      // Re-render scene snapshot to new canvas position
      try {
        const sceneRenderer = ensureSceneRenderer();
        if (sceneRenderer) {
          sceneRenderer.compile(data.shaderCode);
          sceneRenderer.resetTime();
          sceneRenderer.render();
          const mainCanvas = document.getElementById('shader-canvas');
          const ctx = toCanvas.getContext('2d');
          ctx.drawImage(mainCanvas, 0, 0, mainCanvas.width, mainCanvas.height, 0, 0, toCanvas.width, toCanvas.height);
        }
      } catch (err) {
        console.warn(`Failed to re-render scene for slot ${toIndex + 1}:`, err);
      }
    } else {
      // Dispose old renderer before creating new one
      if (data.renderer && data.renderer.dispose) {
        data.renderer.dispose();
      }
      const newRenderer = new MiniShaderRenderer(toCanvas);
      try {
        newRenderer.compile(data.shaderCode);
        data.renderer = newRenderer;
      } catch (err) {
        console.warn(`Failed to recompile shader for slot ${toIndex + 1}:`, err);
      }
    }
  }

  // Update visual state for fromSlot
  updateSlotVisualState(fromIndex, fromSlot);

  // Update visual state for toSlot
  updateSlotVisualState(toIndex, toSlot);

  // Clear canvases for empty slots
  if (!state.gridSlots[fromIndex]) {
    const ctx = fromCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, fromCanvas.width, fromCanvas.height);
  }
  if (!state.gridSlots[toIndex]) {
    const ctx = toCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, toCanvas.width, toCanvas.height);
  }

  // Save shader files to new locations
  if (state.gridSlots[fromIndex]) {
    await window.electronAPI.saveShaderToSlot(fromIndex, state.gridSlots[fromIndex].shaderCode);
  } else {
    await window.electronAPI.deleteShaderFromSlot(fromIndex);
  }

  if (state.gridSlots[toIndex]) {
    await window.electronAPI.saveShaderToSlot(toIndex, state.gridSlots[toIndex].shaderCode);
  } else {
    await window.electronAPI.deleteShaderFromSlot(toIndex);
  }

  // Save grid state
  saveGridState();

  setStatus(`Swapped slot ${fromIndex + 1} with slot ${toIndex + 1}`, 'success');
}

// Update visual state of a slot based on its data
function updateSlotVisualState(index, slot) {
  const data = state.gridSlots[index];

  if (data) {
    slot.classList.add('has-shader');
    const typeLabel = data.type === 'scene' ? ' (scene)' : '';
    slot.title = data.filePath
      ? `Slot ${index + 1}: ${data.filePath.split('/').pop().split('\\').pop()}${typeLabel}`
      : `Slot ${index + 1}: Current ${data.type === 'scene' ? 'scene' : 'shader'}`;
  } else {
    slot.classList.remove('has-shader');
    slot.title = `Slot ${index + 1} - Right-click for options`;
  }

  // Update active state
  if (state.activeGridSlot === index) {
    slot.classList.add('active');
  } else {
    slot.classList.remove('active');
  }
}

async function loadShaderToSlot(slotIndex) {
  const result = await window.electronAPI.loadShaderForGrid();
  if (result && result.content) {
    // Check if this is a Three.js scene file
    const isScene = result.filePath &&
      (result.filePath.endsWith('.jsx') || result.filePath.includes('.scene.js')) ||
      isSceneCode(result.content);

    if (isScene) {
      assignSceneToSlot(slotIndex, result.content, result.filePath);
    } else {
      assignShaderToSlot(slotIndex, result.content, result.filePath);
    }
  } else if (result && result.error) {
    setStatus(`Failed to load shader: ${result.error}`, 'error');
  }
}

function assignCurrentShaderToSlot(slotIndex) {
  const code = state.editor.getValue();
  const isScene = state.renderMode === 'scene' || isSceneCode(code);

  if (isScene) {
    assignSceneToSlot(slotIndex, code, null);
  } else {
    assignShaderToSlot(slotIndex, code, null);
  }
}

// Detect if code is a Three.js scene
function isSceneCode(code) {
  return code.includes('function setup') && (code.includes('THREE') || code.includes('scene'));
}

export async function assignShaderToSlot(slotIndex, shaderCode, filePath, skipSave = false, params = null, presets = null, customParams = null) {
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  const canvas = slot.querySelector('canvas');

  // Clean up existing renderer to prevent memory leaks
  if (state.gridSlots[slotIndex] && state.gridSlots[slotIndex].renderer) {
    if (state.gridSlots[slotIndex].renderer.dispose) {
      state.gridSlots[slotIndex].renderer.dispose();
    }
  }

  // Create mini renderer for this slot
  const miniRenderer = new MiniShaderRenderer(canvas);

  // Use provided params or capture current params for speed
  const slotParams = params || { speed: 1 };

  try {
    miniRenderer.compile(shaderCode);

    // Get custom params: start with defaults from the shader, then overlay any saved values
    // This ensures all params have values even if saved state is incomplete
    let slotCustomParams = {};

    // First, populate with defaults from shader's @param definitions
    for (const param of miniRenderer.customParams || []) {
      slotCustomParams[param.name] = Array.isArray(param.default)
        ? [...param.default]
        : param.default;
    }

    // Then overlay any provided/saved custom params
    if (customParams && Object.keys(customParams).length > 0) {
      Object.assign(slotCustomParams, customParams);
    }

    state.gridSlots[slotIndex] = {
      shaderCode,
      filePath,
      renderer: miniRenderer,
      params: { ...slotParams },
      customParams: slotCustomParams,
      presets: presets || []
    };
    slot.classList.add('has-shader');
    slot.classList.remove('has-error');  // Clear any previous error state
    slot.title = filePath ? `Slot ${slotIndex + 1}: ${filePath.split('/').pop().split('\\').pop()}` : `Slot ${slotIndex + 1}: Current shader`;

    if (!skipSave) {
      // Save shader code to individual file
      await window.electronAPI.saveShaderToSlot(slotIndex, shaderCode);
      setStatus(`Shader assigned to slot ${slotIndex + 1}`, 'success');
      saveGridState();
    }
  } catch (err) {
    if (!skipSave) {
      setStatus(`Failed to compile shader for slot ${slotIndex + 1}: ${err.message}`, 'error');
    }
    throw err;
  }
}

// Draw a static scene placeholder on a mini canvas
function drawScenePlaceholder(ctx, width, height) {
  ctx.fillStyle = '#0a0a1a';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#6688cc';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Scene', width / 2, height / 2);
}

// Assign a Three.js scene to a grid slot with a static snapshot
async function assignSceneToSlot(slotIndex, sceneCode, filePath, skipSave = false, params = null, presets = null) {
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  const canvas = slot.querySelector('canvas');
  const ctx = canvas.getContext('2d');

  // Clean up existing slot data
  if (state.gridSlots[slotIndex]) {
    state.gridSlots[slotIndex] = null;
  }

  // Use provided params or capture current params
  const slotParams = params || { speed: 1 };

  if (skipSave) {
    // During initial load, don't render snapshots on the main canvas —
    // it would create a competing WebGL context and break ShaderRenderer
    drawScenePlaceholder(ctx, canvas.width, canvas.height);
  } else {
    // Interactive assignment: try to render a snapshot
    const sceneRenderer = ensureSceneRenderer();
    if (sceneRenderer) {
      try {
        sceneRenderer.compile(sceneCode);
        sceneRenderer.resetTime();
        sceneRenderer.render();

        const mainCanvas = document.getElementById('shader-canvas');
        ctx.drawImage(mainCanvas, 0, 0, mainCanvas.width, mainCanvas.height, 0, 0, canvas.width, canvas.height);
      } catch (err) {
        console.warn(`Scene snapshot failed for slot ${slotIndex + 1}:`, err.message);
        drawScenePlaceholder(ctx, canvas.width, canvas.height);
      }
    } else {
      drawScenePlaceholder(ctx, canvas.width, canvas.height);
    }
  }

  // Store scene data (no mini renderer for scenes)
  state.gridSlots[slotIndex] = {
    shaderCode: sceneCode,
    filePath,
    renderer: null,
    type: 'scene',
    params: { ...slotParams },
    presets: presets || []
  };

  slot.classList.add('has-shader');
  slot.classList.remove('has-error');
  slot.title = filePath
    ? `Slot ${slotIndex + 1}: ${filePath.split('/').pop().split('\\').pop()} (scene)`
    : `Slot ${slotIndex + 1}: Current scene`;

  if (!skipSave) {
    await window.electronAPI.saveShaderToSlot(slotIndex, sceneCode);
    setStatus(`Scene assigned to slot ${slotIndex + 1}`, 'success');
    saveGridState();
  }
}

// Store a shader that failed to compile so user can still edit it
function assignFailedShaderToSlot(slotIndex, shaderCode, filePath, savedData = {}) {
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  const canvas = slot.querySelector('canvas');
  const ctx = canvas.getContext('2d');

  // Draw error indicator on canvas
  ctx.fillStyle = '#331111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ff4444';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ERROR', canvas.width / 2, canvas.height / 2 - 8);
  ctx.font = '10px sans-serif';
  ctx.fillText('Click to fix', canvas.width / 2, canvas.height / 2 + 8);

  // Store shader data (without renderer) so it can be edited
  state.gridSlots[slotIndex] = {
    shaderCode,
    filePath,
    renderer: null,  // No renderer - compilation failed
    type: savedData.type || 'shader',
    params: savedData.params || {},
    customParams: savedData.customParams || {},
    presets: savedData.presets || [],
    hasError: true  // Flag to indicate this slot has an error
  };

  slot.classList.add('has-shader');
  slot.classList.add('has-error');
  const fileName = filePath ? filePath.split('/').pop().split('\\').pop() : 'shader';
  slot.title = `Slot ${slotIndex + 1}: ${fileName} (ERROR - click to edit)`;
}

async function clearGridSlot(slotIndex) {
  // Dispose renderer
  if (state.gridSlots[slotIndex] && state.gridSlots[slotIndex].renderer) {
    if (state.gridSlots[slotIndex].renderer.dispose) {
      state.gridSlots[slotIndex].renderer.dispose();
    }
  }

  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  state.gridSlots[slotIndex] = null;
  if (slot) {
    slot.classList.remove('has-shader');
    slot.classList.remove('has-error');
    slot.title = `Slot ${slotIndex + 1} - Right-click to assign shader`;

    // Clear canvas
    const canvas = slot.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  // Delete shader file
  await window.electronAPI.deleteShaderFromSlot(slotIndex);

  // Clear active slot if this was it
  if (state.activeGridSlot === slotIndex) {
    state.activeGridSlot = null;
    updateLocalPresetsUI();
    updateSaveButtonState();
  }

  setStatus(`Cleared slot ${slotIndex + 1}`, 'success');

  // Save grid state
  saveGridState();
}

export async function saveActiveSlotShader() {
  if (state.activeGridSlot === null) {
    setStatus('No slot selected', 'error');
    return;
  }

  const slotData = state.gridSlots[state.activeGridSlot];
  if (!slotData) {
    setStatus('No content in active slot', 'error');
    return;
  }

  const code = state.editor.getValue();
  const isScene = slotData.type === 'scene';

  // Update the slot's code
  slotData.shaderCode = code;

  // Also update the renderer/snapshot in the slot
  try {
    if (isScene) {
      // For scenes, re-render the snapshot
      const sceneRenderer = ensureSceneRenderer();
      if (sceneRenderer) {
        sceneRenderer.compile(code);
        sceneRenderer.resetTime();
        sceneRenderer.render();

        // Update the slot canvas with new snapshot
        const slot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
        const canvas = slot.querySelector('canvas');
        const mainCanvas = document.getElementById('shader-canvas');
        const ctx = canvas.getContext('2d');
        ctx.drawImage(mainCanvas, 0, 0, mainCanvas.width, mainCanvas.height, 0, 0, canvas.width, canvas.height);
      }
    } else {
      // For shaders, recompile the mini renderer
      if (slotData.renderer) {
        slotData.renderer.compile(code);
      }
    }
  } catch (err) {
    // Don't fail the save if compilation fails
    console.warn(`${isScene ? 'Scene' : 'Shader'} compilation warning:`, err.message);
  }

  // Save to file
  const result = await window.electronAPI.saveShaderToSlot(state.activeGridSlot, code);
  const typeLabel = isScene ? 'Scene' : 'Shader';
  if (result.success) {
    setStatus(`${typeLabel} saved to slot ${state.activeGridSlot + 1}`, 'success');
  } else {
    setStatus(`Failed to save ${typeLabel.toLowerCase()}: ${result.error}`, 'error');
  }
}

export function updateSaveButtonState() {
  const btnSaveShader = document.getElementById('btn-save-shader');
  if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
    btnSaveShader.disabled = false;
    btnSaveShader.title = `Save Shader to Slot ${state.activeGridSlot + 1} (Ctrl+S)`;
  } else {
    btnSaveShader.disabled = true;
    btnSaveShader.title = 'Save Shader to Active Slot (select a slot first)';
  }
}

export function saveGridState() {
  const gridState = state.gridSlots.map(slot => {
    if (!slot) return null;
    // Don't include shaderCode - it's saved to individual files
    return {
      filePath: slot.filePath,
      params: slot.params,
      customParams: slot.customParams || {},  // Custom shader parameters
      presets: slot.presets || [],
      type: slot.type || 'shader'  // 'shader' or 'scene'
    };
  });
  window.electronAPI.saveGridState(gridState);
}

export async function loadGridState() {
  const gridState = await window.electronAPI.loadGridState();
  if (!gridState || !Array.isArray(gridState)) {
    rebuildGridDOM();
    return;
  }

  // Only load slots that have actual shader data (compact the array)
  const compactState = [];
  for (let i = 0; i < gridState.length; i++) {
    if (gridState[i] && gridState[i].shaderCode) {
      compactState.push(gridState[i]);
    }
  }

  // Initialize state array with null entries for each slot we'll create
  state.gridSlots = new Array(compactState.length).fill(null);

  // Build DOM first so assignShaderToSlot can find the elements
  rebuildGridDOM();

  let loadedCount = 0;
  const failedSlots = [];

  for (let i = 0; i < compactState.length; i++) {
    const slotData = compactState[i];
    try {
      const isScene = slotData.type === 'scene';
      if (isScene) {
        await assignSceneToSlot(i, slotData.shaderCode, slotData.filePath, true, slotData.params, slotData.presets);
      } else {
        await assignShaderToSlot(i, slotData.shaderCode, slotData.filePath, true, slotData.params, slotData.presets, slotData.customParams);
      }
      loadedCount++;
    } catch (err) {
      // Store the shader anyway so user can edit it
      assignFailedShaderToSlot(i, slotData.shaderCode, slotData.filePath, slotData);
      failedSlots.push(i + 1);
      console.warn(`Failed to compile slot ${i + 1}:`, err.message);
    }
  }

  // Re-save shader files with compacted indices if we compacted
  if (compactState.length !== gridState.length) {
    await resaveAllShaderFiles();
    saveGridState();
  }

  if (failedSlots.length > 0) {
    setStatus(`Restored ${loadedCount} items, ${failedSlots.length} failed to compile (slots: ${failedSlots.join(', ')})`, 'error');
  } else if (loadedCount > 0) {
    setStatus(`Restored ${loadedCount} item${loadedCount > 1 ? 's' : ''} from saved state`, 'success');
  }
}

export async function loadGridPresetsFromData(gridState, filePath) {
  if (!gridState || !Array.isArray(gridState)) {
    setStatus('Invalid grid presets file', 'error');
    return;
  }

  // Dispose all existing renderers
  for (let i = 0; i < state.gridSlots.length; i++) {
    if (state.gridSlots[i] && state.gridSlots[i].renderer) {
      if (state.gridSlots[i].renderer.dispose) {
        state.gridSlots[i].renderer.dispose();
      }
    }
  }

  // Compact: only keep entries with shader data
  const compactState = gridState.filter(s => s && s.shaderCode);

  // Reset state
  state.gridSlots = new Array(compactState.length).fill(null);
  state.activeGridSlot = null;
  rebuildGridDOM();

  // Load new presets
  let loadedCount = 0;
  for (let i = 0; i < compactState.length; i++) {
    const slotData = compactState[i];
    try {
      const isScene = slotData.type === 'scene';
      if (isScene) {
        await assignSceneToSlot(i, slotData.shaderCode, slotData.filePath, true, slotData.params, slotData.presets);
      } else {
        await assignShaderToSlot(i, slotData.shaderCode, slotData.filePath, true, slotData.params, slotData.presets, slotData.customParams);
      }
      loadedCount++;
    } catch (err) {
      console.warn(`Failed to load ${slotData.type || 'shader'} in slot ${i + 1}:`, err);
    }
  }

  const fileName = filePath.split('/').pop().split('\\').pop();
  if (loadedCount > 0) {
    setStatus(`Loaded ${loadedCount} shader${loadedCount > 1 ? 's' : ''} from ${fileName}`, 'success');
    // Save as current state
    await resaveAllShaderFiles();
    saveGridState();
  } else {
    setStatus(`No valid shaders found in ${fileName}`, 'error');
  }
}

export function loadGridShaderToEditor(slotIndex) {
  const slotData = state.gridSlots[slotIndex];
  if (!slotData) return;

  // Clear previous active slot highlight
  if (state.activeGridSlot !== null) {
    const prevSlot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
    if (prevSlot) prevSlot.classList.remove('active');
  }

  // Set new active slot
  state.activeGridSlot = slotIndex;
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  slot.classList.add('active');

  // Determine type and title
  const isScene = slotData.type === 'scene';
  const slotName = slotData.filePath ? slotData.filePath.split('/').pop().split('\\').pop() : `Slot ${slotIndex + 1}`;
  const typeLabel = isScene ? 'scene' : 'shader';

  // Open in a new tab (or activate existing tab for this slot)
  openInTab({
    content: slotData.shaderCode,
    filePath: slotData.filePath,
    type: isScene ? 'scene' : 'shader',
    title: slotName,
    slotIndex: slotIndex,
    activate: true
  });

  // Load saved custom param values if available (after tab is activated and compiled)
  setTimeout(() => {
    if (slotData.customParams && !isScene) {
      state.renderer.setCustomParamValues(slotData.customParams);
      generateCustomParamUI(); // Regenerate UI to reflect loaded values
    }
  }, 100);

  // Load speed to slider if present
  if (slotData.params) {
    loadParamsToSliders(slotData.params);
  }

  // Update local presets UI for this shader
  updateLocalPresetsUI();

  // Update save button state
  updateSaveButtonState();

  setStatus(`Editing ${slotName} (${typeLabel} slot ${slotIndex + 1})`, 'success');
}

// Select a grid slot: load shader into preview and show its parameters (single click behavior)
export function selectGridSlot(slotIndex) {
  const slotData = state.gridSlots[slotIndex];
  if (!slotData) return;

  // Clear previous active slot highlight
  if (state.activeGridSlot !== null) {
    const prevSlot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
    if (prevSlot) prevSlot.classList.remove('active');
  }

  // Set active slot
  state.activeGridSlot = slotIndex;
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  if (slot) slot.classList.add('active');

  const isScene = slotData.type === 'scene';
  const slotName = slotData.filePath ? slotData.filePath.split('/').pop().split('\\').pop() : `Slot ${slotIndex + 1}`;

  // Switch render mode if needed
  if (isScene) {
    setRenderMode('scene');
  } else {
    setRenderMode('shader');
  }

  // Always compile the shader to state.renderer so we can read @param definitions
  // and generate the correct parameter UI
  try {
    state.renderer.compile(slotData.shaderCode);
  } catch (err) {
    console.warn(`Failed to compile for preview:`, err.message);
  }

  // If tiled preview is enabled, also assign shader to selected tile
  if (state.tiledPreviewEnabled) {
    assignShaderToTile(slotIndex, state.selectedTileIndex);
  }

  // Load params to sliders (works for both tiled and non-tiled mode)
  if (slotData.params) {
    loadParamsToSliders(slotData.params);
  }

  // Load custom params if available
  if (slotData.customParams && !isScene) {
    // Load to main renderer
    if (state.renderer?.setCustomParamValues) {
      state.renderer.setCustomParamValues(slotData.customParams);
    }
    // Also load to MiniShaderRenderer for tiled preview
    if (slotData.renderer?.setParams) {
      slotData.renderer.setParams(slotData.customParams);
    }
  }

  // Regenerate custom param UI based on the shader's @param definitions
  generateCustomParamUI();

  // Update local presets UI for this shader
  updateLocalPresetsUI();

  // Update save button state
  updateSaveButtonState();

  // Sync to fullscreen window if open
  const allParams = {
    ...(slotData.params || {}),
    ...(slotData.customParams || state.renderer.getCustomParamValues?.() || {})
  };

  if (state.tiledPreviewEnabled) {
    // In tiled mode, update the specific tile
    if (window.electronAPI.assignTileShader) {
      window.electronAPI.assignTileShader(state.selectedTileIndex, slotIndex, slotData.shaderCode, allParams);
    }
  } else {
    // In normal mode, update the main fullscreen
    window.electronAPI.sendShaderUpdate({
      shaderCode: slotData.shaderCode,
      renderMode: isScene ? 'scene' : 'shader',
      params: allParams
    });

    if (window.electronAPI.sendBatchParamUpdate) {
      window.electronAPI.sendBatchParamUpdate(allParams);
    }
  }

  const tileInfo = state.tiledPreviewEnabled ? ` -> tile ${state.selectedTileIndex + 1}` : '';
  setStatus(`Playing ${slotName} (slot ${slotIndex + 1}${tileInfo})`, 'success');
}

export function playGridShader(slotIndex) {
  const slotData = state.gridSlots[slotIndex];
  if (!slotData) return;

  // If tiled preview is enabled, assign to selected tile instead
  if (state.tiledPreviewEnabled) {
    assignShaderToTile(slotIndex, state.selectedTileIndex);
    return;
  }

  // Clear previous active slot highlight
  if (state.activeGridSlot !== null) {
    const prevSlot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
    if (prevSlot) prevSlot.classList.remove('active');
  }

  // Set active slot
  state.activeGridSlot = slotIndex;
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  if (slot) slot.classList.add('active');

  // Check if this is a scene
  const isScene = slotData.type === 'scene';
  const slotName = slotData.filePath ? slotData.filePath.split('/').pop().split('\\').pop() : `Slot ${slotIndex + 1}`;

  // Open in a new tab (or activate existing tab for this slot)
  openInTab({
    content: slotData.shaderCode,
    filePath: slotData.filePath,
    type: isScene ? 'scene' : 'shader',
    title: slotName,
    slotIndex: slotIndex,
    activate: true
  });

  // Load speed to slider if present
  if (slotData.params) {
    loadParamsToSliders(slotData.params);
  }

  // Update local presets UI for this shader
  updateLocalPresetsUI();

  // Update save button state
  updateSaveButtonState();

  // Load saved custom param values if available (after tab is activated)
  setTimeout(() => {
    if (slotData.customParams && !isScene) {
      state.renderer.setCustomParamValues(slotData.customParams);
      generateCustomParamUI(); // Regenerate to reflect loaded values
    }
  }, 100);

  // Batch all params for fullscreen to reduce IPC overhead
  const allParams = {
    ...(slotData.params || {}),
    ...(slotData.customParams || state.renderer.getCustomParamValues())
  };

  // Send to fullscreen window (if open) with all params included
  const fullscreenState = {
    shaderCode: slotData.shaderCode,
    time: 0,
    frame: 0,
    isPlaying: true,
    channels: state.channelState,
    params: allParams,
    renderMode: isScene ? 'scene' : 'shader'
  };
  window.electronAPI.sendShaderUpdate(fullscreenState);
  window.electronAPI.sendTimeSync({ time: 0, frame: 0, isPlaying: true });

  // Send batched params in single IPC call (fullscreen will apply them from the state above,
  // but we also send individually for any param listeners that expect per-param updates)
  // Use a single batch call if available, otherwise fall back to individual calls
  if (window.electronAPI.sendBatchParamUpdate) {
    window.electronAPI.sendBatchParamUpdate(allParams);
  } else {
    // Fall back to individual calls for backwards compatibility
    Object.entries(allParams).forEach(([name, value]) => {
      window.electronAPI.sendParamUpdate({ name, value });
    });
  }

  const typeLabel = isScene ? 'scene' : 'shader';
  setStatus(`Playing ${typeLabel}: ${slotName}`, 'success');
}

// Re-save all shader files with current indices (after removing/compacting slots)
async function resaveAllShaderFiles() {
  // Delete files at all indices up to a generous upper bound
  // (covers previous larger grids being compacted)
  const maxIndex = Math.max(state.gridSlots.length + 50, 100);
  for (let i = 0; i < maxIndex; i++) {
    await window.electronAPI.deleteShaderFromSlot(i);
  }
  // Save current files
  for (let i = 0; i < state.gridSlots.length; i++) {
    if (state.gridSlots[i] && state.gridSlots[i].shaderCode) {
      await window.electronAPI.saveShaderToSlot(i, state.gridSlots[i].shaderCode);
    }
  }
}

// Grid animation frame rate limiting (10fps = 100ms interval)
const GRID_FRAME_INTERVAL = 100;

// Track which slots are visible using IntersectionObserver
const visibleSlots = new Set();
let gridIntersectionObserver = null;

// Cleanup IntersectionObserver
function cleanupGridVisibilityObserver() {
  if (gridIntersectionObserver) {
    gridIntersectionObserver.disconnect();
    gridIntersectionObserver = null;
  }
  visibleSlots.clear();
}

function initGridVisibilityObserver() {
  // Cleanup existing observer first
  cleanupGridVisibilityObserver();

  gridIntersectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const slotIndex = parseInt(entry.target.dataset.slot, 10);
      if (entry.isIntersecting) {
        visibleSlots.add(slotIndex);
      } else {
        visibleSlots.delete(slotIndex);
      }
    });
  }, {
    root: document.getElementById('grid-panel'),
    threshold: 0.1 // Consider visible if at least 10% is showing
  });

  // Observe all grid slots (exclude the add button)
  document.querySelectorAll('.grid-slot:not(.grid-add-btn)').forEach(slot => {
    gridIntersectionObserver.observe(slot);
  });
}

export function startGridAnimation() {
  if (state.gridAnimationId) return;

  // Initialize visibility observer if not already done
  initGridVisibilityObserver();

  // Use setTimeout instead of RAF for 10fps - more efficient since we don't need 60fps callbacks
  function animateGrid() {
    // Skip rendering if grid panel is not visible (hidden via UI toggle)
    // This prevents wasted GPU work when grid is collapsed
    if (!state.gridEnabled) {
      // Keep the timer running but don't render - will resume when grid shown
      state.gridAnimationId = setTimeout(animateGrid, GRID_FRAME_INTERVAL);
      return;
    }

    // Only render slots that are currently visible (via IntersectionObserver)
    for (const slotIndex of visibleSlots) {
      const slot = state.gridSlots[slotIndex];
      if (slot && slot.renderer) {
        slot.renderer.setSpeed(slot.params?.speed ?? 1);
        slot.renderer.render();
      }
    }

    // Schedule next frame at 10fps interval
    state.gridAnimationId = setTimeout(animateGrid, GRID_FRAME_INTERVAL);
  }

  // Start the animation loop
  animateGrid();
}

export function stopGridAnimation() {
  if (state.gridAnimationId) {
    clearTimeout(state.gridAnimationId);
    state.gridAnimationId = null;
  }
}

// Shared WebGL context for all MiniShaderRenderers
// This avoids the "too many WebGL contexts" browser limit
let sharedGLCanvas = null;
let sharedGL = null;
let sharedVAO = null;

function getSharedGL() {
  if (!sharedGL) {
    sharedGLCanvas = document.createElement('canvas');
    sharedGLCanvas.width = 160;
    sharedGLCanvas.height = 90;
    sharedGL = sharedGLCanvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true
    });

    if (!sharedGL) {
      console.error('Failed to create shared WebGL2 context');
      return null;
    }

    // Setup shared geometry (full-screen quad)
    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const vbo = sharedGL.createBuffer();
    sharedGL.bindBuffer(sharedGL.ARRAY_BUFFER, vbo);
    sharedGL.bufferData(sharedGL.ARRAY_BUFFER, vertices, sharedGL.STATIC_DRAW);

    sharedVAO = sharedGL.createVertexArray();
    sharedGL.bindVertexArray(sharedVAO);
    sharedGL.enableVertexAttribArray(0);
    sharedGL.vertexAttribPointer(0, 2, sharedGL.FLOAT, false, 0, 0);

    // Handle context loss on shared canvas
    sharedGLCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('Shared WebGL context lost');
    });

    sharedGLCanvas.addEventListener('webglcontextrestored', () => {
      console.log('Shared WebGL context restored');
      // Reinitialize geometry
      const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
      const vbo = sharedGL.createBuffer();
      sharedGL.bindBuffer(sharedGL.ARRAY_BUFFER, vbo);
      sharedGL.bufferData(sharedGL.ARRAY_BUFFER, vertices, sharedGL.STATIC_DRAW);
      sharedVAO = sharedGL.createVertexArray();
      sharedGL.bindVertexArray(sharedVAO);
      sharedGL.enableVertexAttribArray(0);
      sharedGL.vertexAttribPointer(0, 2, sharedGL.FLOAT, false, 0, 0);
    });
  }
  return sharedGL;
}

// Mini shader renderer for grid previews - uses shared WebGL context
export class MiniShaderRenderer {
  constructor(canvas) {
    this.canvas = canvas;  // Display canvas (will use 2D context to copy from shared)
    this.ctx2d = canvas.getContext('2d');  // 2D context for copying rendered result
    this.gl = getSharedGL();  // Use shared WebGL context
    this.contextValid = !!this.gl;

    if (!this.gl) {
      console.warn('Shared WebGL context not available');
      return;
    }

    this.program = null;
    this.startTime = performance.now();
    this.uniforms = {};
    this.speed = 1.0;

    // Pre-allocated buffers with default values (for backward compatibility)
    this._colorArray = new Float32Array(30).fill(1.0);  // 10 colors * 3 components, all white
    this._paramsArray = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5]);  // 5 params at 0.5

    // Custom param values storage
    this.customParamValues = {};
  }

  setSpeed(speed) {
    this.speed = speed;
  }

  // Set resolution (resize display canvas)
  setResolution(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      // Update 2D context after resize
      this.ctx2d = this.canvas.getContext('2d');
    }
  }

  // Get current resolution
  getResolution() {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  // Resize shared canvas to match target resolution for rendering
  _resizeSharedCanvas(width, height) {
    if (sharedGLCanvas && (sharedGLCanvas.width !== width || sharedGLCanvas.height !== height)) {
      sharedGLCanvas.width = width;
      sharedGLCanvas.height = height;
    }
  }

  // Ensure shared canvas is at least the given size (for tiled preview batching)
  static ensureSharedCanvasSize(width, height) {
    if (!sharedGLCanvas) {
      getSharedGL();  // Initialize if needed
    }
    if (sharedGLCanvas) {
      // Only resize if current size is smaller (avoid thrashing)
      if (sharedGLCanvas.width < width || sharedGLCanvas.height < height) {
        sharedGLCanvas.width = Math.max(sharedGLCanvas.width, width);
        sharedGLCanvas.height = Math.max(sharedGLCanvas.height, height);
      }
    }
  }

  // Get the shared canvas for direct access
  static getSharedCanvas() {
    if (!sharedGLCanvas) {
      getSharedGL();
    }
    return sharedGLCanvas;
  }

  // Set a custom parameter value
  setParam(name, value) {
    if (name === 'speed') {
      this.setSpeed(value);
    } else {
      this.customParamValues[name] = value;
    }
  }

  // Set multiple parameters at once
  setParams(params) {
    if (!params) return;
    Object.entries(params).forEach(([name, value]) => {
      this.setParam(name, value);
    });
  }

  // Reset custom params to shader defaults (call before applying tile-specific params)
  resetCustomParams() {
    this.customParamValues = {};
  }

  compile(fragmentSource) {
    // Check if context is valid
    if (!this.contextValid || !this.gl) {
      throw new Error('WebGL context not available');
    }

    const gl = this.gl;

    // Parse custom @param comments and generate uniform declarations
    const customParams = parseShaderParams(fragmentSource);
    const customUniformDecls = generateUniformDeclarations(customParams);

    const vertexSource = `#version 300 es
      layout(location = 0) in vec2 position;
      void main() { gl_Position = vec4(position, 0.0, 1.0); }
    `;

    const wrappedFragment = `#version 300 es
      precision highp float;
      uniform vec3 iResolution;
      uniform float iTime;
      uniform vec4 iMouse;
      uniform sampler2D iChannel0, iChannel1, iChannel2, iChannel3;
      uniform vec3 iChannelResolution[4];
      uniform float iTimeDelta;
      uniform int iFrame;
      uniform vec4 iDate;
      uniform vec3 iColorRGB[10];
      uniform float iParams[5];
      uniform float iSpeed;
      ${customUniformDecls}
      out vec4 outColor;
      ${fragmentSource}
      void main() { mainImage(outColor, gl_FragCoord.xy); }
    `;

    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    if (!vertexShader) {
      throw new Error('Failed to create vertex shader - WebGL context may be lost');
    }
    gl.shaderSource(vertexShader, vertexSource);
    gl.compileShader(vertexShader);

    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(vertexShader);
      gl.deleteShader(vertexShader);
      throw new Error(error);
    }

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    if (!fragmentShader) {
      gl.deleteShader(vertexShader);
      throw new Error('Failed to create fragment shader - WebGL context may be lost');
    }
    gl.shaderSource(fragmentShader, wrappedFragment);
    gl.compileShader(fragmentShader);

    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(fragmentShader);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      throw new Error(error);
    }

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }

    if (this.program) gl.deleteProgram(this.program);
    this.program = program;

    this.uniforms = {
      iResolution: gl.getUniformLocation(program, 'iResolution'),
      iTime: gl.getUniformLocation(program, 'iTime'),
      iColorRGB: gl.getUniformLocation(program, 'iColorRGB'),
      iParams: gl.getUniformLocation(program, 'iParams'),
      iSpeed: gl.getUniformLocation(program, 'iSpeed')
    };

    // Store custom params and their uniform locations
    this.customParams = customParams;
    this.customUniformLocations = {};
    for (const param of customParams) {
      this.customUniformLocations[param.name] = gl.getUniformLocation(program, param.name);
    }

    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
  }

  render() {
    if (!this.program || !this.contextValid || !this.gl || !sharedGLCanvas) return;

    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;

    // Resize shared canvas to match display canvas
    this._resizeSharedCanvas(width, height);

    // Render using internal method
    this._renderInternal(gl, width, height);

    // Copy rendered result from shared canvas to display canvas
    if (this.ctx2d) {
      this.ctx2d.drawImage(sharedGLCanvas, 0, 0, width, height);
    }
  }

  // Render directly to a target 2D context at specified position
  // This avoids canvas resizing and reduces GPU->CPU syncs for tiled preview
  renderDirect(targetCtx, destX, destY, destWidth, destHeight) {
    if (!this.program || !this.contextValid || !this.gl || !sharedGLCanvas) return;

    const gl = this.gl;

    // Use viewport to render at destination size without resizing shared canvas
    // The shared canvas should already be sized large enough
    gl.viewport(0, 0, destWidth, destHeight);

    // Render using internal method
    this._renderInternal(gl, destWidth, destHeight);

    // Copy from shared canvas to target context at destination position
    // Source rect is bottom-left of shared canvas at destWidth x destHeight
    targetCtx.drawImage(
      sharedGLCanvas,
      0, sharedGLCanvas.height - destHeight, destWidth, destHeight,  // Source rect
      destX, destY, destWidth, destHeight  // Dest rect
    );
  }

  // Internal render method - sets uniforms and draws
  _renderInternal(gl, width, height) {
    const time = (performance.now() - this.startTime) / 1000 * this.speed;

    gl.useProgram(this.program);

    gl.uniform3f(this.uniforms.iResolution, width, height, 1);
    gl.uniform1f(this.uniforms.iTime, time);

    // Use pre-allocated arrays with default values (for backward compatibility)
    gl.uniform3fv(this.uniforms.iColorRGB, this._colorArray);
    gl.uniform1fv(this.uniforms.iParams, this._paramsArray);
    gl.uniform1f(this.uniforms.iSpeed, this.speed);

    // Set custom param uniforms (use stored value or default)
    for (const param of this.customParams || []) {
      const loc = this.customUniformLocations[param.name];
      if (loc === null) continue;

      // Use stored value if available, otherwise use default
      const value = this.customParamValues[param.name] !== undefined
        ? this.customParamValues[param.name]
        : param.default;

      switch (param.glslBaseType) {
        case 'float':
          gl.uniform1f(loc, value);
          break;
        case 'int':
          gl.uniform1i(loc, value);
          break;
        case 'vec2':
          gl.uniform2fv(loc, Array.isArray(value) ? value : [value, value]);
          break;
        case 'vec3':
          gl.uniform3fv(loc, Array.isArray(value) ? value : [value, value, value]);
          break;
        case 'vec4':
          gl.uniform4fv(loc, Array.isArray(value) ? value : [value, value, value, value]);
          break;
      }
    }

    // Use shared VAO and draw
    gl.bindVertexArray(sharedVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Dispose WebGL resources to prevent memory leaks
  dispose() {
    const gl = this.gl;
    if (!gl) return;

    // Only delete the program, not the shared VAO
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }

    this.contextValid = false;
    // Note: VAO is shared, don't delete it

    this.uniforms = {};
    this.customUniformLocations = {};
    this.customParams = [];
  }
}
