// Presets module
import { state } from './state.js';
import { setStatus } from './utils.js';
import { saveGridState } from './shader-grid.js';
import { loadParamsToSliders, applyParamRanges } from './params.js';

export async function initPresets() {
  // Local preset add button
  const addLocalBtn = document.getElementById('btn-add-local-preset');
  addLocalBtn.addEventListener('click', () => addLocalPreset());

  // Global preset add button
  const addGlobalBtn = document.getElementById('btn-add-global-preset');
  addGlobalBtn.addEventListener('click', () => addGlobalPreset());

  // Load saved global presets and param ranges
  await loadGlobalPresets();
  await loadParamRanges();
}

async function loadGlobalPresets() {
  const savedPresets = await window.electronAPI.loadPresets();
  if (savedPresets && Array.isArray(savedPresets)) {
    savedPresets.forEach((preset, index) => {
      // Handle old format (just params) and new format ({ params, name })
      if (preset.params) {
        state.globalPresets.push(preset);
      } else {
        state.globalPresets.push({ params: preset, name: null });
      }
      createGlobalPresetButton(index);
    });
  }
}

async function loadParamRanges() {
  const settings = await window.electronAPI.getSettings();
  if (settings && settings.paramRanges) {
    state.paramRanges = { ...state.paramRanges, ...settings.paramRanges };
    applyParamRanges();
  }
}

export function saveGlobalPresetsToFile() {
  window.electronAPI.savePresets(state.globalPresets);
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
  setStatus(`Shader preset ${presetIndex + 1} saved`, 'success');
}

function addGlobalPreset() {
  const params = state.renderer.getParams();
  const presetIndex = state.globalPresets.length;
  state.globalPresets.push({ params: { ...params }, name: null });

  createGlobalPresetButton(presetIndex);
  saveGlobalPresetsToFile();
  setStatus(`Global preset ${presetIndex + 1} saved`, 'success');
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
    showPresetContextMenu(e.clientX, e.clientY, index, btn, 'local');
  });

  localRow.insertBefore(btn, addBtn);
}

function createGlobalPresetButton(index) {
  const globalRow = document.getElementById('global-presets-row');
  const addBtn = document.getElementById('btn-add-global-preset');

  const btn = document.createElement('button');
  btn.className = 'preset-btn global-preset';
  updateGlobalPresetButtonLabel(btn, index);
  btn.dataset.presetIndex = index;
  btn.dataset.presetType = 'global';

  btn.addEventListener('click', () => recallGlobalPreset(index));
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showPresetContextMenu(e.clientX, e.clientY, index, btn, 'global');
  });

  globalRow.insertBefore(btn, addBtn);
}

function updateLocalPresetButtonLabel(btn, index) {
  if (state.activeGridSlot === null || !state.gridSlots[state.activeGridSlot]) return;
  const presets = state.gridSlots[state.activeGridSlot].presets || [];
  const preset = presets[index];
  const label = preset && preset.name ? preset.name : String(index + 1);
  btn.textContent = label;
  btn.title = preset && preset.name
    ? `${preset.name} (right-click for options)`
    : `Shader preset ${index + 1} (right-click for options)`;
}

function updateGlobalPresetButtonLabel(btn, index) {
  const preset = state.globalPresets[index];
  const label = preset && preset.name ? preset.name : String(index + 1);
  btn.textContent = label;
  btn.title = preset && preset.name
    ? `${preset.name} (right-click for options)`
    : `Global preset ${index + 1} (right-click for options)`;
}

function showPresetContextMenu(x, y, index, btn, type) {
  hidePresetContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'preset-context-menu';

  // Rename option
  const renameItem = document.createElement('div');
  renameItem.className = 'context-menu-item';
  renameItem.textContent = 'Rename...';
  renameItem.addEventListener('click', () => {
    hidePresetContextMenu();
    showRenamePresetDialog(index, btn, type);
  });
  menu.appendChild(renameItem);

  // Delete option
  const deleteItem = document.createElement('div');
  deleteItem.className = 'context-menu-item';
  deleteItem.textContent = 'Delete';
  deleteItem.addEventListener('click', () => {
    hidePresetContextMenu();
    if (type === 'local') {
      deleteLocalPreset(index, btn);
    } else {
      deleteGlobalPreset(index, btn);
    }
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

function showRenamePresetDialog(index, btn, type) {
  let preset, defaultName;
  if (type === 'local') {
    const presets = state.gridSlots[state.activeGridSlot]?.presets || [];
    preset = presets[index];
    defaultName = `Preset ${index + 1}`;
  } else {
    preset = state.globalPresets[index];
    defaultName = `Preset ${index + 1}`;
  }

  const currentName = preset?.name || defaultName;

  const overlay = document.createElement('div');
  overlay.id = 'rename-preset-overlay';
  overlay.className = 'dialog-overlay';
  overlay.innerHTML = `
    <div class="rename-dialog">
      <div class="dialog-header">Rename ${type === 'local' ? 'Shader' : 'Global'} Preset</div>
      <input type="text" id="preset-name-input" value="${currentName}" maxlength="12" placeholder="Preset name">
      <div class="dialog-buttons">
        <button class="btn-secondary" id="rename-cancel">Cancel</button>
        <button class="btn-primary" id="rename-ok">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = document.getElementById('preset-name-input');
  input.focus();
  input.select();

  const close = () => overlay.remove();

  document.getElementById('rename-cancel').onclick = close;
  document.getElementById('rename-ok').onclick = () => {
    const newName = input.value.trim();
    if (type === 'local') {
      if (state.gridSlots[state.activeGridSlot]?.presets?.[index]) {
        state.gridSlots[state.activeGridSlot].presets[index].name = newName || null;
        updateLocalPresetButtonLabel(btn, index);
        saveGridState();
      }
    } else {
      if (state.globalPresets[index]) {
        state.globalPresets[index].name = newName || null;
        updateGlobalPresetButtonLabel(btn, index);
        saveGlobalPresetsToFile();
      }
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

  // Update active highlighting
  updateActiveLocalPreset(index);
  state.activeGlobalPresetIndex = null;
  clearGlobalPresetHighlight();

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

export function recallGlobalPreset(index, fromSync = false) {
  if (index >= state.globalPresets.length) return;

  const preset = state.globalPresets[index];
  const params = preset.params || preset;
  loadParamsToSliders(params);

  // Also update the active shader's params if one is selected
  if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
    state.gridSlots[state.activeGridSlot].params = { ...params };
    saveGridState();
  }

  // Update active highlighting
  updateActiveGlobalPreset(index);
  state.activeLocalPresetIndex = null;
  clearLocalPresetHighlight();

  // Sync to fullscreen (unless this call came from sync)
  if (!fromSync) {
    window.electronAPI.sendPresetSync({
      type: 'global',
      index: index,
      params: params
    });
  }

  const name = preset.name || `Global preset ${index + 1}`;
  setStatus(`${name} loaded`, 'success');
}

function updateActiveLocalPreset(index) {
  state.activeLocalPresetIndex = index;
  clearLocalPresetHighlight();
  const btn = document.querySelector(`.preset-btn.local-preset[data-preset-index="${index}"]`);
  if (btn) btn.classList.add('active');
}

function updateActiveGlobalPreset(index) {
  state.activeGlobalPresetIndex = index;
  clearGlobalPresetHighlight();
  const btn = document.querySelector(`.preset-btn.global-preset[data-preset-index="${index}"]`);
  if (btn) btn.classList.add('active');
}

function clearLocalPresetHighlight() {
  document.querySelectorAll('.preset-btn.local-preset').forEach(btn => btn.classList.remove('active'));
}

function clearGlobalPresetHighlight() {
  document.querySelectorAll('.preset-btn.global-preset').forEach(btn => btn.classList.remove('active'));
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
      showPresetContextMenu(e.clientX, e.clientY, i, btn, 'local');
    };
  });

  if (state.activeLocalPresetIndex === index) state.activeLocalPresetIndex = null;
  else if (state.activeLocalPresetIndex > index) state.activeLocalPresetIndex--;

  saveGridState();
  setStatus('Shader preset deleted', 'success');
}

function deleteGlobalPreset(index, btnElement) {
  state.globalPresets.splice(index, 1);
  btnElement.remove();

  // Re-index remaining buttons
  const globalBtns = document.querySelectorAll('.preset-btn.global-preset');
  globalBtns.forEach((btn, i) => {
    btn.dataset.presetIndex = i;
    updateGlobalPresetButtonLabel(btn, i);
    btn.onclick = () => recallGlobalPreset(i);
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      showPresetContextMenu(e.clientX, e.clientY, i, btn, 'global');
    };
  });

  if (state.activeGlobalPresetIndex === index) state.activeGlobalPresetIndex = null;
  else if (state.activeGlobalPresetIndex > index) state.activeGlobalPresetIndex--;

  saveGlobalPresetsToFile();
  setStatus('Global preset deleted', 'success');
}
