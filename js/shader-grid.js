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

export async function initShaderGrid() {
  // Cleanup any existing listeners first
  cleanupShaderGrid();

  const slots = document.querySelectorAll('.grid-slot');

  slots.forEach((slot, index) => {
    const canvas = slot.querySelector('canvas');
    canvas.width = 160;
    canvas.height = 90;

    // Enable dragging
    slot.setAttribute('draggable', 'true');

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
      // Remove drag-over from all slots
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
      // Only remove if actually leaving the slot (not entering a child)
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

    // Left click - play shader in preview and/or fullscreen
    const clickHandler = () => {
      if (state.gridSlots[index]) {
        playGridShader(index);
      }
    };
    slot.addEventListener('click', clickHandler);
    listeners.push({ event: 'click', handler: clickHandler });

    // Double click - load shader into editor
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

    // Store all listeners for this slot
    slotEventListeners.set(slot, listeners);
  });

  // Close context menu when clicking elsewhere
  documentClickHandler = hideContextMenu;
  document.addEventListener('click', documentClickHandler);

  // Load saved grid state
  await loadGridState();
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

  // Update tile state
  assignTile(tileIndex, slotIndex, slotData.params);

  // Update tile renderer if tiled preview is enabled
  updateTileRenderer(tileIndex);

  // Sync to fullscreen if tiled mode is active
  if (window.electronAPI.assignTileShader) {
    window.electronAPI.assignTileShader(tileIndex, slotIndex, slotData.shaderCode, slotData.params);
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
    slot.title = `Slot ${index + 1} - Right-click to assign shader`;
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

  // Use provided params or capture current params
  const slotParams = params || state.renderer.getParams();
  const slotCustomParams = customParams || state.renderer.getCustomParamValues();

  try {
    miniRenderer.compile(shaderCode);
    state.gridSlots[slotIndex] = {
      shaderCode,
      filePath,
      renderer: miniRenderer,
      params: { ...slotParams },
      customParams: { ...slotCustomParams },
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
  const slotParams = params || state.renderer.getParams();

  try {
    // Ensure scene renderer is available
    const sceneRenderer = ensureSceneRenderer();
    if (!sceneRenderer) {
      throw new Error('ThreeSceneRenderer not available');
    }

    // Temporarily compile and render the scene to get a snapshot
    sceneRenderer.compile(sceneCode);
    sceneRenderer.resetTime();

    // Render a single frame at time=0
    sceneRenderer.render();

    // Get the main canvas (where scene was rendered)
    const mainCanvas = document.getElementById('shader-canvas');

    // Draw snapshot to the mini canvas
    ctx.drawImage(mainCanvas, 0, 0, mainCanvas.width, mainCanvas.height, 0, 0, canvas.width, canvas.height);

    // Store scene data (no renderer - just static snapshot)
    state.gridSlots[slotIndex] = {
      shaderCode: sceneCode,
      filePath,
      renderer: null,  // No mini renderer for scenes
      type: 'scene',   // Mark as scene type
      params: { ...slotParams },
      presets: presets || []
    };

    slot.classList.add('has-shader');
    slot.classList.remove('has-error');  // Clear any previous error state
    slot.title = filePath
      ? `Slot ${slotIndex + 1}: ${filePath.split('/').pop().split('\\').pop()} (scene)`
      : `Slot ${slotIndex + 1}: Current scene`;

    if (!skipSave) {
      // Save scene code to individual file
      await window.electronAPI.saveShaderToSlot(slotIndex, sceneCode);
      setStatus(`Scene assigned to slot ${slotIndex + 1}`, 'success');
      saveGridState();
    }
  } catch (err) {
    // Draw error indicator on canvas
    ctx.fillStyle = '#330000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ff4444';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Scene Error', canvas.width / 2, canvas.height / 2);

    if (!skipSave) {
      setStatus(`Failed to render scene for slot ${slotIndex + 1}: ${err.message}`, 'error');
    }
    throw err;
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
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  state.gridSlots[slotIndex] = null;
  slot.classList.remove('has-shader');
  slot.classList.remove('has-error');
  slot.title = `Slot ${slotIndex + 1} - Right-click to assign shader`;

  // Clear canvas
  const canvas = slot.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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
  if (!gridState || !Array.isArray(gridState)) return;

  let loadedCount = 0;
  const failedSlots = [];

  for (let i = 0; i < Math.min(gridState.length, 32); i++) {
    if (gridState[i] && gridState[i].shaderCode) {
      try {
        const isScene = gridState[i].type === 'scene';
        if (isScene) {
          await assignSceneToSlot(i, gridState[i].shaderCode, gridState[i].filePath, true, gridState[i].params, gridState[i].presets);
        } else {
          await assignShaderToSlot(i, gridState[i].shaderCode, gridState[i].filePath, true, gridState[i].params, gridState[i].presets, gridState[i].customParams);
        }
        loadedCount++;
      } catch (err) {
        // Store the shader anyway so user can edit it
        assignFailedShaderToSlot(i, gridState[i].shaderCode, gridState[i].filePath, gridState[i]);
        failedSlots.push(i + 1);
        console.warn(`Failed to compile slot ${i + 1}:`, err.message);
      }
    }
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

  // Clear all existing slots first
  for (let i = 0; i < 32; i++) {
    if (state.gridSlots[i]) {
      const slot = document.querySelector(`.grid-slot[data-slot="${i}"]`);
      state.gridSlots[i] = null;
      slot.classList.remove('has-shader');
      const canvas = slot.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  }

  // Load new presets
  let loadedCount = 0;
  for (let i = 0; i < Math.min(gridState.length, 32); i++) {
    if (gridState[i] && gridState[i].shaderCode) {
      try {
        const isScene = gridState[i].type === 'scene';
        if (isScene) {
          await assignSceneToSlot(i, gridState[i].shaderCode, gridState[i].filePath, true, gridState[i].params, gridState[i].presets);
        } else {
          await assignShaderToSlot(i, gridState[i].shaderCode, gridState[i].filePath, true, gridState[i].params, gridState[i].presets, gridState[i].customParams);
        }
        loadedCount++;
      } catch (err) {
        console.warn(`Failed to load ${gridState[i].type || 'shader'} in slot ${i + 1}:`, err);
      }
    }
  }

  const fileName = filePath.split('/').pop().split('\\').pop();
  if (loadedCount > 0) {
    setStatus(`Loaded ${loadedCount} shader${loadedCount > 1 ? 's' : ''} from ${fileName}`, 'success');
    // Save as current state
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

export function playGridShader(slotIndex) {
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

  // Observe all grid slots
  document.querySelectorAll('.grid-slot').forEach(slot => {
    gridIntersectionObserver.observe(slot);
  });
}

export function startGridAnimation() {
  if (state.gridAnimationId) return;

  // Initialize visibility observer if not already done
  initGridVisibilityObserver();

  // Use setTimeout instead of RAF for 10fps - more efficient since we don't need 60fps callbacks
  function animateGrid() {
    // Only render slots that are currently visible
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

// Mini shader renderer for grid previews
class MiniShaderRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false });

    if (!this.gl) {
      throw new Error('WebGL 2 not supported');
    }

    this.program = null;
    this.startTime = performance.now();
    this.uniforms = {};
    this.speed = 1.0;

    // Pre-allocated buffers with default values (for backward compatibility)
    this._colorArray = new Float32Array(30).fill(1.0);  // 10 colors * 3 components, all white
    this._paramsArray = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5]);  // 5 params at 0.5

    this.setupGeometry();
  }

  setSpeed(speed) {
    this.speed = speed;
  }

  setupGeometry() {
    const gl = this.gl;
    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  compile(fragmentSource) {
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
    gl.shaderSource(vertexShader, vertexSource);
    gl.compileShader(vertexShader);

    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(vertexShader));
    }

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragmentShader, wrappedFragment);
    gl.compileShader(fragmentShader);

    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(fragmentShader));
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
    if (!this.program) return;

    const gl = this.gl;
    const time = (performance.now() - this.startTime) / 1000 * this.speed;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);

    gl.uniform3f(this.uniforms.iResolution, this.canvas.width, this.canvas.height, 1);
    gl.uniform1f(this.uniforms.iTime, time);

    // Use pre-allocated arrays with default values (for backward compatibility)
    gl.uniform3fv(this.uniforms.iColorRGB, this._colorArray);
    gl.uniform1fv(this.uniforms.iParams, this._paramsArray);
    gl.uniform1f(this.uniforms.iSpeed, this.speed);

    // Set custom param uniforms with default values
    for (const param of this.customParams || []) {
      const loc = this.customUniformLocations[param.name];
      if (loc === null) continue;

      const value = param.default;
      switch (param.glslBaseType) {
        case 'float':
          gl.uniform1f(loc, value);
          break;
        case 'int':
          gl.uniform1i(loc, value);
          break;
        case 'vec2':
          gl.uniform2fv(loc, value);
          break;
        case 'vec3':
          gl.uniform3fv(loc, value);
          break;
        case 'vec4':
          gl.uniform4fv(loc, value);
          break;
      }
    }

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Dispose WebGL resources to prevent memory leaks
  dispose() {
    const gl = this.gl;
    if (!gl) return;

    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
    if (this.vao) {
      gl.deleteVertexArray(this.vao);
      this.vao = null;
    }
    // Note: VBO is created without storing reference, but WebGL garbage collects it
    // when the VAO is deleted

    this.uniforms = {};
    this.customUniformLocations = {};
    this.customParams = [];
  }
}
