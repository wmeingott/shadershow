// Presets module - Local shader presets only
import { state } from './state.js';
import { setStatus } from './utils.js';
import { saveGridState } from './shader-grid.js';
import { loadParamsToSliders, generateCustomParamUI } from './params.js';
import { tileState } from './tile-state.js';

export async function initPresets() {
  // Local preset add button
  const addLocalBtn = document.getElementById('btn-add-local-preset');
  addLocalBtn.addEventListener('click', () => addLocalPreset());

  // Reset to default button
  const resetBtn = document.getElementById('btn-reset-params');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => resetToDefaults());
  }
}

// Reset parameters to shader defaults
export function resetToDefaults() {
  if (!state.renderer) {
    setStatus('No shader loaded', 'error');
    return;
  }

  // Get custom param definitions with default values
  const paramDefs = state.renderer.getCustomParamDefs?.() || [];

  // Reset speed to 1
  state.renderer.setParam('speed', 1);
  const speedSlider = document.getElementById('param-speed');
  const speedValue = document.getElementById('param-speed-value');
  if (speedSlider) {
    speedSlider.value = 1;
    if (speedValue) speedValue.textContent = '1.00';
  }

  // Reset each custom param to its default
  paramDefs.forEach(param => {
    if (param.default !== undefined) {
      state.renderer.setParam(param.name, param.default);
    }
  });

  // Regenerate UI to show default values
  generateCustomParamUI();

  // Update selected tile if in tiled mode
  if (state.tiledPreviewEnabled) {
    const defaultParams = { speed: 1 };
    paramDefs.forEach(param => {
      if (param.default !== undefined) {
        defaultParams[param.name] = param.default;
      }
    });
    applyParamsToSelectedTile(defaultParams);
  }

  // Sync to fullscreen
  window.electronAPI.sendParamUpdate({ name: 'speed', value: 1 });
  paramDefs.forEach(param => {
    if (param.default !== undefined) {
      window.electronAPI.sendParamUpdate({ name: param.name, value: param.default });
    }
  });

  setStatus('Parameters reset to defaults', 'success');
}

// Update local presets UI when shader selection changes
export function updateLocalPresetsUI() {
  const localRow = document.getElementById('local-presets-row');
  const addBtn = document.getElementById('btn-add-local-preset');
  const hint = document.getElementById('no-shader-hint');

  // Clear existing local preset buttons
  const existingBtns = localRow.querySelectorAll('.preset-btn.local-preset');
  existingBtns.forEach(btn => btn.remove());

  if (state.activeGridSlot === null || !state.gridSlots[state.activeGridSlot]) {
    // No shader selected
    hint.classList.remove('hidden');
    addBtn.classList.add('hidden');
    return;
  }

  // Shader is selected
  hint.classList.add('hidden');
  addBtn.classList.remove('hidden');

  // Ensure presets array exists for this slot
  if (!state.gridSlots[state.activeGridSlot].presets) {
    state.gridSlots[state.activeGridSlot].presets = [];
  }

  // Create buttons for local presets
  const presets = state.gridSlots[state.activeGridSlot].presets;
  presets.forEach((preset, index) => {
    createLocalPresetButton(index);
  });
}

function addLocalPreset() {
  if (state.activeGridSlot === null || !state.gridSlots[state.activeGridSlot]) {
    setStatus('Select a shader first', 'error');
    return;
  }

  const params = state.renderer.getParams();
  if (!state.gridSlots[state.activeGridSlot].presets) {
    state.gridSlots[state.activeGridSlot].presets = [];
  }

  const presetIndex = state.gridSlots[state.activeGridSlot].presets.length;
  state.gridSlots[state.activeGridSlot].presets.push({ params: { ...params }, name: null });

  createLocalPresetButton(presetIndex);
  saveGridState();
  setStatus(`Preset ${presetIndex + 1} saved`, 'success');
}

function createLocalPresetButton(index) {
  const localRow = document.getElementById('local-presets-row');
  const addBtn = document.getElementById('btn-add-local-preset');

  const btn = document.createElement('button');
  btn.className = 'preset-btn local-preset';
  updateLocalPresetButtonLabel(btn, index);
  btn.dataset.presetIndex = index;
  btn.dataset.presetType = 'local';

  btn.addEventListener('click', () => recallLocalPreset(index));
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showPresetContextMenu(e.clientX, e.clientY, index, btn);
  });

  localRow.insertBefore(btn, addBtn);
}

function updateLocalPresetButtonLabel(btn, index) {
  if (state.activeGridSlot === null || !state.gridSlots[state.activeGridSlot]) return;
  const presets = state.gridSlots[state.activeGridSlot].presets || [];
  const preset = presets[index];
  const label = preset && preset.name ? preset.name : String(index + 1);
  btn.textContent = label;
  btn.title = preset && preset.name
    ? `${preset.name} (right-click for options)`
    : `Preset ${index + 1} (right-click for options)`;
}

function showPresetContextMenu(x, y, index, btn) {
  hidePresetContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'preset-context-menu';

  // Update option
  const updateItem = document.createElement('div');
  updateItem.className = 'context-menu-item';
  updateItem.textContent = 'Update';
  updateItem.addEventListener('click', () => {
    hidePresetContextMenu();
    updateLocalPreset(index);
  });
  menu.appendChild(updateItem);

  // Rename option
  const renameItem = document.createElement('div');
  renameItem.className = 'context-menu-item';
  renameItem.textContent = 'Rename...';
  renameItem.addEventListener('click', () => {
    hidePresetContextMenu();
    showRenamePresetDialog(index, btn);
  });
  menu.appendChild(renameItem);

  // Delete option
  const deleteItem = document.createElement('div');
  deleteItem.className = 'context-menu-item';
  deleteItem.textContent = 'Delete';
  deleteItem.addEventListener('click', () => {
    hidePresetContextMenu();
    deleteLocalPreset(index, btn);
  });
  menu.appendChild(deleteItem);

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

  setTimeout(() => {
    document.addEventListener('click', hidePresetContextMenu, { once: true });
  }, 0);
}

function hidePresetContextMenu() {
  const menu = document.getElementById('preset-context-menu');
  if (menu) menu.remove();
}

function showRenamePresetDialog(index, btn) {
  const presets = state.gridSlots[state.activeGridSlot]?.presets || [];
  const preset = presets[index];
  const defaultName = `Preset ${index + 1}`;
  const currentName = preset?.name || defaultName;

  const overlay = document.createElement('div');
  overlay.id = 'rename-preset-overlay';
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'rename-dialog';

  const header = document.createElement('div');
  header.className = 'dialog-header';
  header.textContent = 'Rename Preset';
  dialog.appendChild(header);

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'preset-name-input';
  input.value = currentName;
  input.maxLength = 12;
  input.placeholder = 'Preset name';
  dialog.appendChild(input);

  const buttons = document.createElement('div');
  buttons.className = 'dialog-buttons';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-secondary';
  cancelBtn.id = 'rename-cancel';
  cancelBtn.textContent = 'Cancel';
  buttons.appendChild(cancelBtn);

  const okBtn = document.createElement('button');
  okBtn.className = 'btn-primary';
  okBtn.id = 'rename-ok';
  okBtn.textContent = 'OK';
  buttons.appendChild(okBtn);

  dialog.appendChild(buttons);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  input.focus();
  input.select();

  const close = () => overlay.remove();

  cancelBtn.onclick = close;
  okBtn.onclick = () => {
    const newName = input.value.trim();
    if (state.gridSlots[state.activeGridSlot]?.presets?.[index]) {
      state.gridSlots[state.activeGridSlot].presets[index].name = newName || null;
      updateLocalPresetButtonLabel(btn, index);
      saveGridState();
    }
    close();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('rename-ok').click();
    if (e.key === 'Escape') close();
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
}

export function recallLocalPreset(index, fromSync = false) {
  if (state.activeGridSlot === null || !state.gridSlots[state.activeGridSlot]) return;
  const presets = state.gridSlots[state.activeGridSlot].presets || [];
  if (index >= presets.length) return;

  const preset = presets[index];
  const params = preset.params || preset;
  loadParamsToSliders(params);

  // Update selected tile if in tiled mode
  if (state.tiledPreviewEnabled) {
    applyParamsToSelectedTile(params);
  }

  // Update active highlighting
  updateActiveLocalPreset(index);

  // Sync to fullscreen (unless this call came from sync)
  if (!fromSync) {
    window.electronAPI.sendPresetSync({
      type: 'local',
      index: index,
      params: params
    });
  }

  const name = preset.name || `Preset ${index + 1}`;
  setStatus(`${name} loaded`, 'success');
}

// Apply params to selected tile (for tiled preview mode)
function applyParamsToSelectedTile(params) {
  if (!params) return;

  const tileIndex = state.selectedTileIndex;
  if (tileIndex < 0 || tileIndex >= tileState.tiles.length) return;

  const tile = tileState.tiles[tileIndex];
  if (!tile || tile.gridSlotIndex === null) return;

  const slotData = state.gridSlots[tile.gridSlotIndex];
  if (!slotData) return;

  // Separate speed from custom params
  const { speed, ...customParams } = params;

  // Update tile's stored params (speed)
  if (!tile.params) tile.params = {};
  if (speed !== undefined) {
    tile.params.speed = speed;
  }

  // Update tile's custom params
  if (!tile.customParams) tile.customParams = {};
  Object.assign(tile.customParams, customParams);

  // Also update the slot's params and customParams
  if (!slotData.params) slotData.params = {};
  if (speed !== undefined) {
    slotData.params.speed = speed;
  }
  if (!slotData.customParams) slotData.customParams = {};
  Object.assign(slotData.customParams, customParams);

  // Update the MiniShaderRenderer speed if available
  if (slotData.renderer && speed !== undefined) {
    slotData.renderer.setSpeed(speed);
  }
}

function updateActiveLocalPreset(index) {
  state.activeLocalPresetIndex = index;
  clearLocalPresetHighlight();
  const btn = document.querySelector(`.preset-btn.local-preset[data-preset-index="${index}"]`);
  if (btn) btn.classList.add('active');
}

function clearLocalPresetHighlight() {
  document.querySelectorAll('.preset-btn.local-preset').forEach(btn => btn.classList.remove('active'));
}

function updateLocalPreset(index) {
  if (state.activeGridSlot === null || !state.gridSlots[state.activeGridSlot]) return;
  const presets = state.gridSlots[state.activeGridSlot].presets;
  if (!presets || index >= presets.length) return;

  const params = state.renderer.getParams();
  presets[index].params = { ...params };
  saveGridState();

  const name = presets[index].name || `Preset ${index + 1}`;
  setStatus(`${name} updated`, 'success');
}

function deleteLocalPreset(index, btnElement) {
  if (state.activeGridSlot === null || !state.gridSlots[state.activeGridSlot]) return;

  state.gridSlots[state.activeGridSlot].presets.splice(index, 1);
  btnElement.remove();

  // Re-index remaining buttons
  const localBtns = document.querySelectorAll('.preset-btn.local-preset');
  localBtns.forEach((btn, i) => {
    btn.dataset.presetIndex = i;
    updateLocalPresetButtonLabel(btn, i);
    btn.onclick = () => recallLocalPreset(i);
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      showPresetContextMenu(e.clientX, e.clientY, i, btn);
    };
  });

  if (state.activeLocalPresetIndex === index) state.activeLocalPresetIndex = null;
  else if (state.activeLocalPresetIndex > index) state.activeLocalPresetIndex--;

  saveGridState();
  setStatus('Preset deleted', 'success');
}
