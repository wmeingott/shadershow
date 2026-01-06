// Global state
let editor;
let renderer;
let compileTimeout;
let animationId;
let previewEnabled = true;
let gridEnabled = false;
let editorEnabled = true;
let paramsEnabled = true;
let ndiEnabled = false;
let ndiFrameCounter = 0;

// Mouse assignment for params P0-P4
let mouseAssignments = { p0: '', p1: '', p2: '', p3: '', p4: '' };
let mousePosition = { x: 0.5, y: 0.5 };

// Track channel state for fullscreen sync
let channelState = [null, null, null, null];

// Shader grid state
const gridSlots = new Array(16).fill(null); // { shaderCode, filePath, renderer, params }
let gridAnimationId = null;
let activeGridSlot = null; // Track which slot is being edited

// Parameter presets - global and per-shader
let globalPresets = []; // Array of { params, name } objects - shared across all shaders
let activeGlobalPresetIndex = null;
let activeLocalPresetIndex = null;

// Parameter ranges (min, max) for P0-P4
let paramRanges = {
  p0: { min: 0, max: 1 },
  p1: { min: 0, max: 1 },
  p2: { min: 0, max: 1 },
  p3: { min: 0, max: 1 },
  p4: { min: 0, max: 1 }
};

// Initialize application
document.addEventListener('DOMContentLoaded', async () => {
  initEditor();
  initRenderer();
  initControls();
  initParams();
  initMouseAssignment();
  initPresets();
  initResizer();
  initIPC();
  initShaderGrid();

  // Load default shader
  const defaultShader = await window.electronAPI.getDefaultShader();
  editor.setValue(defaultShader, -1);
  compileShader();

  // Restore saved view state
  await restoreViewState();

  // Start render loop
  renderLoop();
});

function initEditor() {
  editor = ace.edit('editor');
  editor.setTheme('ace/theme/monokai');
  editor.session.setMode('ace/mode/glsl');
  editor.setOptions({
    fontSize: '14px',
    showPrintMargin: false,
    tabSize: 2,
    useSoftTabs: true,
    wrap: false,
    enableBasicAutocompletion: true
  });

  // Auto-compile on change (debounced)
  editor.session.on('change', () => {
    clearTimeout(compileTimeout);
    compileTimeout = setTimeout(compileShader, 500);
  });

  // Update cursor position in status bar
  editor.selection.on('changeCursor', () => {
    const pos = editor.getCursorPosition();
    document.getElementById('cursor-position').textContent =
      `Ln ${pos.row + 1}, Col ${pos.column + 1}`;
  });

  // Keyboard shortcuts
  editor.commands.addCommand({
    name: 'compile',
    bindKey: { win: 'Ctrl-Enter', mac: 'Cmd-Enter' },
    exec: compileShader
  });

  editor.commands.addCommand({
    name: 'save',
    bindKey: { win: 'Ctrl-S', mac: 'Cmd-S' },
    exec: () => {
      // If a grid slot is active, save to slot file
      if (activeGridSlot !== null && gridSlots[activeGridSlot]) {
        saveActiveSlotShader();
      } else {
        // Otherwise use standard file save
        window.electronAPI.saveContent(editor.getValue());
      }
    }
  });
}

function initRenderer() {
  const canvas = document.getElementById('shader-canvas');
  renderer = new ShaderRenderer(canvas);

  // Set initial resolution
  const select = document.getElementById('resolution-select');
  const [width, height] = select.value.split('x').map(Number);
  renderer.setResolution(width, height);
}

function initControls() {
  // Play/Pause button
  const btnPlay = document.getElementById('btn-play');
  btnPlay.addEventListener('click', togglePlayback);

  // Reset button
  const btnReset = document.getElementById('btn-reset');
  btnReset.addEventListener('click', resetTime);

  // Preview toggle button
  const btnPreview = document.getElementById('btn-preview');
  btnPreview.addEventListener('click', togglePreview);

  // Grid toggle button
  const btnGrid = document.getElementById('btn-grid');
  btnGrid.addEventListener('click', toggleGrid);

  // Editor toggle button
  const btnEditor = document.getElementById('btn-editor');
  btnEditor.addEventListener('click', toggleEditor);

  // Params toggle button
  const btnParams = document.getElementById('btn-params');
  btnParams.addEventListener('click', toggleParams);

  // NDI toggle button
  const btnNdi = document.getElementById('btn-ndi');
  btnNdi.addEventListener('click', toggleNDI);

  // Fullscreen button
  const btnFullscreen = document.getElementById('btn-fullscreen');
  btnFullscreen.addEventListener('click', openFullscreenPreview);

  // Settings button
  const btnSettings = document.getElementById('btn-settings');
  btnSettings.addEventListener('click', showSettingsDialog);

  // Save shader button
  const btnSaveShader = document.getElementById('btn-save-shader');
  btnSaveShader.addEventListener('click', saveActiveSlotShader);

  // Resolution selector
  const resolutionSelect = document.getElementById('resolution-select');
  const customWidth = document.getElementById('custom-width');
  const customHeight = document.getElementById('custom-height');
  const customX = document.getElementById('custom-x');

  resolutionSelect.addEventListener('change', () => {
    if (resolutionSelect.value === 'custom') {
      customWidth.classList.remove('hidden');
      customHeight.classList.remove('hidden');
      customX.classList.remove('hidden');
      updateResolution();
    } else {
      customWidth.classList.add('hidden');
      customHeight.classList.add('hidden');
      customX.classList.add('hidden');
      const [width, height] = resolutionSelect.value.split('x').map(Number);
      renderer.setResolution(width, height);
    }
  });

  const updateResolution = () => {
    const width = parseInt(customWidth.value) || 1280;
    const height = parseInt(customHeight.value) || 720;
    renderer.setResolution(width, height);
  };

  customWidth.addEventListener('change', updateResolution);
  customHeight.addEventListener('change', updateResolution);
}

function initParams() {
  // Build params array for speed + 5 params + 10 RGB colors
  const params = [
    { id: 'param-speed', name: 'speed' }
  ];

  // Add 5 custom params
  for (let i = 0; i < 5; i++) {
    params.push({ id: `param-p${i}`, name: `p${i}` });
  }

  // Add 10 RGB color sets
  for (let i = 0; i < 10; i++) {
    params.push({ id: `param-r${i}`, name: `r${i}` });
    params.push({ id: `param-g${i}`, name: `g${i}` });
    params.push({ id: `param-b${i}`, name: `b${i}` });
  }

  const defaults = {
    speed: 1
  };

  // Default all params to 0.5
  for (let i = 0; i < 5; i++) {
    defaults[`p${i}`] = 0.5;
  }

  // Default all colors to 1
  for (let i = 0; i < 10; i++) {
    defaults[`r${i}`] = 1;
    defaults[`g${i}`] = 1;
    defaults[`b${i}`] = 1;
  }

  params.forEach(({ id, name }) => {
    const slider = document.getElementById(id);
    const valueDisplay = document.getElementById(`${id}-value`);

    slider.addEventListener('input', () => {
      const value = parseFloat(slider.value);
      renderer.setParam(name, value);
      valueDisplay.textContent = value.toFixed(2);

      // Sync to fullscreen
      window.electronAPI.sendParamUpdate({ name, value });

      // Save to active grid slot if one is selected
      if (activeGridSlot !== null && gridSlots[activeGridSlot]) {
        gridSlots[activeGridSlot].params[name] = value;
        saveGridState();
      }
    });

    // Double-click to reset to default
    slider.addEventListener('dblclick', () => {
      slider.value = defaults[name];
      renderer.setParam(name, defaults[name]);
      if (valueDisplay) valueDisplay.textContent = defaults[name].toFixed(2);
      window.electronAPI.sendParamUpdate({ name, value: defaults[name] });
    });
  });

  // Reset button handler
  const resetBtn = document.getElementById('btn-reset-params');
  resetBtn.addEventListener('click', () => resetAllParams(defaults));

  // P0-P4 section reset buttons
  document.getElementById('btn-params-zero').addEventListener('click', () => resetParamsP0P4(0));
  document.getElementById('btn-params-full').addEventListener('click', () => resetParamsP0P4(1));

  // Colors section reset buttons
  document.getElementById('btn-colors-zero').addEventListener('click', () => resetAllColors(0));
  document.getElementById('btn-colors-full').addEventListener('click', () => resetAllColors(1));

  // Add min/max buttons to color sliders
  addColorSliderButtons();
}

function addColorSliderButtons() {
  // Add 0/1 buttons to each color slider
  for (let i = 0; i < 10; i++) {
    ['r', 'g', 'b'].forEach(channel => {
      const sliderId = `param-${channel}${i}`;
      const slider = document.getElementById(sliderId);
      if (!slider) return;

      // Create min button (0)
      const minBtn = document.createElement('button');
      minBtn.className = 'color-minmax-btn color-min-btn';
      minBtn.textContent = '0';
      minBtn.title = 'Set to 0';
      minBtn.addEventListener('click', () => setColorParam(sliderId, `${channel}${i}`, 0));

      // Create max button (1)
      const maxBtn = document.createElement('button');
      maxBtn.className = 'color-minmax-btn color-max-btn';
      maxBtn.textContent = '1';
      maxBtn.title = 'Set to 1';
      maxBtn.addEventListener('click', () => setColorParam(sliderId, `${channel}${i}`, 1));

      // Insert buttons around the slider
      slider.parentNode.insertBefore(minBtn, slider);
      slider.parentNode.insertBefore(maxBtn, slider.nextSibling);
    });
  }
}

function setColorParam(sliderId, paramName, value) {
  const slider = document.getElementById(sliderId);
  if (!slider) return;

  slider.value = value;
  renderer.setParam(paramName, value);
  window.electronAPI.sendParamUpdate({ name: paramName, value });

  // Update active grid slot
  if (activeGridSlot !== null && gridSlots[activeGridSlot]) {
    gridSlots[activeGridSlot].params[paramName] = value;
    saveGridState();
  }
}

function resetParamsP0P4(value) {
  for (let i = 0; i < 5; i++) {
    const paramName = `p${i}`;
    const slider = document.getElementById(`param-p${i}`);
    const valueDisplay = document.getElementById(`param-p${i}-value`);

    if (!slider) continue;

    // Use the slider's min/max for the value (respects custom ranges from settings)
    const minVal = parseFloat(slider.min);
    const maxVal = parseFloat(slider.max);
    const targetValue = value === 0 ? minVal : maxVal;

    slider.value = targetValue;
    renderer.setParam(paramName, targetValue);
    if (valueDisplay) valueDisplay.textContent = targetValue.toFixed(2);
    window.electronAPI.sendParamUpdate({ name: paramName, value: targetValue });

    // Update active grid slot
    if (activeGridSlot !== null && gridSlots[activeGridSlot]) {
      gridSlots[activeGridSlot].params[paramName] = targetValue;
    }
  }

  if (activeGridSlot !== null && gridSlots[activeGridSlot]) {
    saveGridState();
  }

  setStatus(`P0-P4 set to ${value === 0 ? 'minimum' : 'maximum'}`, 'success');
}

function resetAllColors(value) {
  for (let i = 0; i < 10; i++) {
    ['r', 'g', 'b'].forEach(channel => {
      const paramName = `${channel}${i}`;
      const sliderId = `param-${channel}${i}`;
      const slider = document.getElementById(sliderId);

      if (slider) {
        slider.value = value;
        renderer.setParam(paramName, value);
        window.electronAPI.sendParamUpdate({ name: paramName, value });

        // Update active grid slot
        if (activeGridSlot !== null && gridSlots[activeGridSlot]) {
          gridSlots[activeGridSlot].params[paramName] = value;
        }
      }
    });
  }

  if (activeGridSlot !== null && gridSlots[activeGridSlot]) {
    saveGridState();
  }

  setStatus(`All colors set to ${value}`, 'success');
}

function resetAllParams(defaults) {
  // Build param mappings
  const paramMappings = [{ id: 'param-speed', name: 'speed' }];
  for (let i = 0; i < 5; i++) {
    paramMappings.push({ id: `param-p${i}`, name: `p${i}` });
  }
  for (let i = 0; i < 10; i++) {
    paramMappings.push({ id: `param-r${i}`, name: `r${i}` });
    paramMappings.push({ id: `param-g${i}`, name: `g${i}` });
    paramMappings.push({ id: `param-b${i}`, name: `b${i}` });
  }

  // Default values if not provided
  if (!defaults) {
    defaults = { speed: 1 };
    for (let i = 0; i < 5; i++) defaults[`p${i}`] = 0.5;
    for (let i = 0; i < 10; i++) {
      defaults[`r${i}`] = 1;
      defaults[`g${i}`] = 1;
      defaults[`b${i}`] = 1;
    }
  }

  paramMappings.forEach(({ id, name }) => {
    const slider = document.getElementById(id);
    const valueDisplay = document.getElementById(`${id}-value`);
    const value = defaults[name];

    if (slider) {
      slider.value = value;
      renderer.setParam(name, value);
      if (valueDisplay) valueDisplay.textContent = value.toFixed(2);
      window.electronAPI.sendParamUpdate({ name, value });
    }
  });

  // Update active grid slot if selected
  if (activeGridSlot !== null && gridSlots[activeGridSlot]) {
    gridSlots[activeGridSlot].params = { ...defaults };
    saveGridState();
  }

  setStatus('Parameters reset to defaults', 'success');
}

function initMouseAssignment() {
  // Setup mouse tracking on canvas
  const canvas = document.getElementById('shader-canvas');
  const canvasContainer = document.getElementById('preview-canvas-container');

  canvasContainer.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    mousePosition.x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    mousePosition.y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height)); // Invert Y
    updateMouseControlledParams();
  });

  // Setup dropdowns for P0-P4
  for (let i = 0; i < 5; i++) {
    const select = document.getElementById(`mouse-p${i}`);
    const paramRow = select.closest('.param-row');

    select.addEventListener('change', () => {
      mouseAssignments[`p${i}`] = select.value;

      if (select.value) {
        paramRow.classList.add('mouse-controlled');
      } else {
        paramRow.classList.remove('mouse-controlled');
      }

      updateMouseControlledParams();
    });
  }
}

function updateMouseControlledParams() {
  for (let i = 0; i < 5; i++) {
    const assignment = mouseAssignments[`p${i}`];
    if (!assignment) continue;

    const value = assignment === 'x' ? mousePosition.x : mousePosition.y;
    const slider = document.getElementById(`param-p${i}`);
    const valueDisplay = document.getElementById(`param-p${i}-value`);

    slider.value = value;
    valueDisplay.textContent = value.toFixed(2);
    renderer.setParam(`p${i}`, value);
    window.electronAPI.sendParamUpdate({ name: `p${i}`, value });

    // Update grid slot if active
    if (activeGridSlot !== null && gridSlots[activeGridSlot]) {
      gridSlots[activeGridSlot].params[`p${i}`] = value;
    }
  }
}

async function initPresets() {
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
        globalPresets.push(preset);
      } else {
        globalPresets.push({ params: preset, name: null });
      }
      createGlobalPresetButton(index);
    });
  }
}

async function loadParamRanges() {
  const settings = await window.electronAPI.getSettings();
  if (settings && settings.paramRanges) {
    paramRanges = { ...paramRanges, ...settings.paramRanges };
    applyParamRanges();
  }
}

function applyParamRanges() {
  for (let i = 0; i < 5; i++) {
    const slider = document.getElementById(`param-p${i}`);
    const range = paramRanges[`p${i}`];
    if (slider && range) {
      slider.min = range.min;
      slider.max = range.max;
      slider.step = (range.max - range.min) / 100;
    }
  }
}

function saveGlobalPresetsToFile() {
  window.electronAPI.savePresets(globalPresets);
}

// Update local presets UI when shader selection changes
function updateLocalPresetsUI() {
  const localRow = document.getElementById('local-presets-row');
  const addBtn = document.getElementById('btn-add-local-preset');
  const hint = document.getElementById('no-shader-hint');

  // Clear existing local preset buttons
  const existingBtns = localRow.querySelectorAll('.preset-btn.local-preset');
  existingBtns.forEach(btn => btn.remove());

  if (activeGridSlot === null || !gridSlots[activeGridSlot]) {
    // No shader selected
    hint.classList.remove('hidden');
    addBtn.classList.add('hidden');
    return;
  }

  // Shader is selected
  hint.classList.add('hidden');
  addBtn.classList.remove('hidden');

  // Ensure presets array exists for this slot
  if (!gridSlots[activeGridSlot].presets) {
    gridSlots[activeGridSlot].presets = [];
  }

  // Create buttons for local presets
  const presets = gridSlots[activeGridSlot].presets;
  presets.forEach((preset, index) => {
    createLocalPresetButton(index);
  });
}

function addLocalPreset() {
  if (activeGridSlot === null || !gridSlots[activeGridSlot]) {
    setStatus('Select a shader first', 'error');
    return;
  }

  const params = renderer.getParams();
  if (!gridSlots[activeGridSlot].presets) {
    gridSlots[activeGridSlot].presets = [];
  }

  const presetIndex = gridSlots[activeGridSlot].presets.length;
  gridSlots[activeGridSlot].presets.push({ params: { ...params }, name: null });

  createLocalPresetButton(presetIndex);
  saveGridState();
  setStatus(`Shader preset ${presetIndex + 1} saved`, 'success');
}

function addGlobalPreset() {
  const params = renderer.getParams();
  const presetIndex = globalPresets.length;
  globalPresets.push({ params: { ...params }, name: null });

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
  if (activeGridSlot === null || !gridSlots[activeGridSlot]) return;
  const presets = gridSlots[activeGridSlot].presets || [];
  const preset = presets[index];
  const label = preset && preset.name ? preset.name : String(index + 1);
  btn.textContent = label;
  btn.title = preset && preset.name
    ? `${preset.name} (right-click for options)`
    : `Shader preset ${index + 1} (right-click for options)`;
}

function updateGlobalPresetButtonLabel(btn, index) {
  const preset = globalPresets[index];
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
    const presets = gridSlots[activeGridSlot]?.presets || [];
    preset = presets[index];
    defaultName = `Preset ${index + 1}`;
  } else {
    preset = globalPresets[index];
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
      if (gridSlots[activeGridSlot]?.presets?.[index]) {
        gridSlots[activeGridSlot].presets[index].name = newName || null;
        updateLocalPresetButtonLabel(btn, index);
        saveGridState();
      }
    } else {
      if (globalPresets[index]) {
        globalPresets[index].name = newName || null;
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

function recallLocalPreset(index) {
  if (activeGridSlot === null || !gridSlots[activeGridSlot]) return;
  const presets = gridSlots[activeGridSlot].presets || [];
  if (index >= presets.length) return;

  const preset = presets[index];
  const params = preset.params || preset;
  loadParamsToSliders(params);

  // Update active highlighting
  updateActiveLocalPreset(index);
  activeGlobalPresetIndex = null;
  clearGlobalPresetHighlight();

  const name = preset.name || `Preset ${index + 1}`;
  setStatus(`${name} loaded`, 'success');
}

function recallGlobalPreset(index) {
  if (index >= globalPresets.length) return;

  const preset = globalPresets[index];
  const params = preset.params || preset;
  loadParamsToSliders(params);

  // Also update the active shader's params if one is selected
  if (activeGridSlot !== null && gridSlots[activeGridSlot]) {
    gridSlots[activeGridSlot].params = { ...params };
    saveGridState();
  }

  // Update active highlighting
  updateActiveGlobalPreset(index);
  activeLocalPresetIndex = null;
  clearLocalPresetHighlight();

  const name = preset.name || `Global preset ${index + 1}`;
  setStatus(`${name} loaded`, 'success');
}

function updateActiveLocalPreset(index) {
  activeLocalPresetIndex = index;
  clearLocalPresetHighlight();
  const btn = document.querySelector(`.preset-btn.local-preset[data-preset-index="${index}"]`);
  if (btn) btn.classList.add('active');
}

function updateActiveGlobalPreset(index) {
  activeGlobalPresetIndex = index;
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
  if (activeGridSlot === null || !gridSlots[activeGridSlot]) return;

  gridSlots[activeGridSlot].presets.splice(index, 1);
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

  if (activeLocalPresetIndex === index) activeLocalPresetIndex = null;
  else if (activeLocalPresetIndex > index) activeLocalPresetIndex--;

  saveGridState();
  setStatus('Shader preset deleted', 'success');
}

function deleteGlobalPreset(index, btnElement) {
  globalPresets.splice(index, 1);
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

  if (activeGlobalPresetIndex === index) activeGlobalPresetIndex = null;
  else if (activeGlobalPresetIndex > index) activeGlobalPresetIndex--;

  saveGlobalPresetsToFile();
  setStatus('Global preset deleted', 'success');
}

function initResizer() {
  const resizer = document.getElementById('resizer');
  const editorPanel = document.getElementById('editor-panel');
  let isResizing = false;

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizer.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    const containerWidth = document.getElementById('main-content').offsetWidth;
    const newWidth = (e.clientX / containerWidth) * 100;

    if (newWidth >= 20 && newWidth <= 80) {
      editorPanel.style.width = `${newWidth}%`;
      editor.resize();
    }
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      resizer.classList.remove('dragging');
      saveViewState(); // Save editor width on resize end
    }
  });
}

// View State Management
function saveViewState() {
  const editorPanel = document.getElementById('editor-panel');
  const resolutionSelect = document.getElementById('resolution-select');
  const customWidth = document.getElementById('custom-width');
  const customHeight = document.getElementById('custom-height');

  const viewState = {
    editorEnabled,
    previewEnabled,
    gridEnabled,
    paramsEnabled,
    editorWidth: editorPanel.style.width || '50%',
    resolution: resolutionSelect.value,
    customWidth: customWidth.value,
    customHeight: customHeight.value
  };

  window.electronAPI.saveViewState(viewState);
}

async function restoreViewState() {
  const viewState = await window.electronAPI.loadViewState();
  if (!viewState) return;

  const editorPanel = document.getElementById('editor-panel');
  const resizer = document.getElementById('resizer');
  const rightPanel = document.getElementById('right-panel');
  const previewPanel = document.getElementById('preview-panel');
  const gridPanel = document.getElementById('grid-panel');
  const paramsPanel = document.getElementById('params-panel');

  // Restore editor visibility
  if (viewState.editorEnabled !== undefined) {
    editorEnabled = viewState.editorEnabled;
    if (!editorEnabled) {
      editorPanel.classList.add('hidden');
      resizer.classList.add('hidden');
    }
    document.getElementById('btn-editor').classList.toggle('active', editorEnabled);
  }

  // Restore preview visibility
  if (viewState.previewEnabled !== undefined) {
    previewEnabled = viewState.previewEnabled;
    if (!previewEnabled) {
      previewPanel.classList.add('hidden');
    }
    document.getElementById('btn-preview').classList.toggle('active', previewEnabled);
  }

  // Restore grid visibility
  if (viewState.gridEnabled !== undefined) {
    gridEnabled = viewState.gridEnabled;
    if (gridEnabled) {
      gridPanel.classList.remove('hidden');
      startGridAnimation();
    }
    document.getElementById('btn-grid').classList.toggle('active', gridEnabled);
  }

  // Restore params visibility
  if (viewState.paramsEnabled !== undefined) {
    paramsEnabled = viewState.paramsEnabled;
    if (!paramsEnabled) {
      paramsPanel.classList.add('hidden');
    }
    document.getElementById('btn-params').classList.toggle('active', paramsEnabled);
  }

  // Restore editor width
  if (viewState.editorWidth) {
    editorPanel.style.width = viewState.editorWidth;
  }

  // Restore resolution
  if (viewState.resolution) {
    const resolutionSelect = document.getElementById('resolution-select');
    resolutionSelect.value = viewState.resolution;

    const customWidth = document.getElementById('custom-width');
    const customHeight = document.getElementById('custom-height');
    const customX = document.getElementById('custom-x');

    if (viewState.resolution === 'custom') {
      customWidth.classList.remove('hidden');
      customHeight.classList.remove('hidden');
      customX.classList.remove('hidden');
      if (viewState.customWidth) customWidth.value = viewState.customWidth;
      if (viewState.customHeight) customHeight.value = viewState.customHeight;
      const w = parseInt(customWidth.value) || 1280;
      const h = parseInt(customHeight.value) || 720;
      renderer.setResolution(w, h);
    } else {
      const [w, h] = viewState.resolution.split('x').map(Number);
      if (w && h) renderer.setResolution(w, h);
    }
  }

  // Update layout classes
  updateLayoutClasses();
}

function updateLayoutClasses() {
  const rightPanel = document.getElementById('right-panel');
  const gridPanel = document.getElementById('grid-panel');
  const previewPanel = document.getElementById('preview-panel');

  if (!editorEnabled && gridEnabled && previewEnabled) {
    rightPanel.classList.add('side-by-side');
  } else {
    rightPanel.classList.remove('side-by-side');
  }
}

function initIPC() {
  // File operations
  window.electronAPI.onFileOpened(({ content, filePath }) => {
    editor.setValue(content, -1);
    compileShader();
  });

  window.electronAPI.onNewFile(() => {
    window.electronAPI.getDefaultShader().then(defaultShader => {
      editor.setValue(defaultShader, -1);
      compileShader();
    });
  });

  window.electronAPI.onRequestContentForSave(() => {
    window.electronAPI.saveContent(editor.getValue());
  });

  // Texture loading
  window.electronAPI.onTextureLoaded(async ({ channel, dataUrl, filePath }) => {
    try {
      const result = await renderer.loadTexture(channel, dataUrl);
      channelState[channel] = { type: 'image', dataUrl, filePath };
      updateChannelSlot(channel, 'image', filePath, result.width, result.height, dataUrl);
      setStatus(`Loaded texture to iChannel${channel}`, 'success');
    } catch (err) {
      setStatus(`Failed to load texture: ${err.message}`, 'error');
    }
  });

  // Video loading
  window.electronAPI.onVideoLoaded(async ({ channel, filePath }) => {
    try {
      const result = await renderer.loadVideo(channel, filePath);
      channelState[channel] = { type: 'video', filePath };
      updateChannelSlot(channel, 'video', filePath, result.width, result.height);
      setStatus(`Loaded video to iChannel${channel}`, 'success');
    } catch (err) {
      setStatus(`Failed to load video: ${err.message}`, 'error');
    }
  });

  // Camera loading
  window.electronAPI.onCameraRequested(async ({ channel }) => {
    try {
      const result = await renderer.loadCamera(channel);
      channelState[channel] = { type: 'camera' };
      updateChannelSlot(channel, 'camera', 'Camera', result.width, result.height);
      setStatus(`Camera connected to iChannel${channel}`, 'success');
    } catch (err) {
      setStatus(`Failed to access camera: ${err.message}`, 'error');
    }
  });

  // Audio loading
  window.electronAPI.onAudioRequested(async ({ channel }) => {
    try {
      const result = await renderer.loadAudio(channel);
      channelState[channel] = { type: 'audio' };
      updateChannelSlot(channel, 'audio', 'Audio FFT', result.width, result.height);
      setStatus(`Audio input connected to iChannel${channel}`, 'success');
    } catch (err) {
      setStatus(`Failed to access audio: ${err.message}`, 'error');
    }
  });

  // Channel clear
  window.electronAPI.onChannelCleared(({ channel }) => {
    renderer.clearChannel(channel);
    channelState[channel] = null;
    updateChannelSlot(channel, 'empty');
    setStatus(`Cleared iChannel${channel}`, 'success');
  });

  // Shader controls from menu
  window.electronAPI.onCompileShader(compileShader);
  window.electronAPI.onTogglePlayback(togglePlayback);
  window.electronAPI.onResetTime(resetTime);

  // Fullscreen state request
  window.electronAPI.onRequestFullscreenState(() => {
    const stats = renderer.getStats();
    const state = {
      shaderCode: editor.getValue(),
      time: stats.time,
      frame: stats.frame,
      isPlaying: stats.isPlaying,
      channels: channelState,
      params: renderer.getParams()
    };
    window.electronAPI.sendFullscreenState(state);
  });

  // Grid presets save/load
  window.electronAPI.onRequestGridStateForSave(() => {
    const state = gridSlots.map(slot => {
      if (!slot) return null;
      return {
        shaderCode: slot.shaderCode,
        filePath: slot.filePath
      };
    });
    window.electronAPI.saveGridPresetsToFile(state);
  });

  window.electronAPI.onGridPresetsSaved(({ filePath }) => {
    const fileName = filePath.split('/').pop().split('\\').pop();
    setStatus(`Grid presets saved to ${fileName}`, 'success');
  });

  window.electronAPI.onLoadGridPresets(({ gridState, filePath }) => {
    loadGridPresetsFromData(gridState, filePath);
  });

  // NDI status
  window.electronAPI.onNDIStatus(({ enabled, width, height }) => {
    ndiEnabled = enabled;
    const btnNdi = document.getElementById('btn-ndi');
    if (enabled) {
      btnNdi.classList.add('active');
      btnNdi.title = `NDI Output Active (${width}x${height})`;
      setStatus(`NDI output started at ${width}x${height}`, 'success');
    } else {
      btnNdi.classList.remove('active');
      btnNdi.title = 'Toggle NDI Output';
      setStatus('NDI output stopped', 'success');
    }
  });

  // Preview resolution request for NDI "Match Preview" option
  window.electronAPI.onRequestPreviewResolution(() => {
    const canvas = document.getElementById('shader-canvas');
    window.electronAPI.sendPreviewResolution({
      width: canvas.width,
      height: canvas.height
    });
  });
}

function compileShader() {
  const source = editor.getValue();

  // Clear previous error markers
  editor.session.clearAnnotations();

  try {
    renderer.compile(source);
    setStatus('Shader compiled successfully', 'success');

    // Sync to fullscreen window
    window.electronAPI.sendShaderUpdate({ shaderCode: source });
  } catch (err) {
    const message = err.message || err.raw || String(err);
    setStatus(`Compile error: ${message}`, 'error');

    // Add error annotation to editor
    if (err.line) {
      editor.session.setAnnotations([{
        row: err.line - 1,
        column: 0,
        text: err.message,
        type: 'error'
      }]);
    }
  }
}

function togglePlayback() {
  const isPlaying = renderer.togglePlayback();
  const btnPlay = document.getElementById('btn-play');
  btnPlay.innerHTML = isPlaying ?
    '<span class="icon">&#10074;&#10074;</span>' :
    '<span class="icon">&#9658;</span>';
  btnPlay.title = isPlaying ? 'Pause (Space)' : 'Play (Space)';

  // Sync to fullscreen window
  const stats = renderer.getStats();
  window.electronAPI.sendTimeSync({
    time: stats.time,
    frame: stats.frame,
    isPlaying: stats.isPlaying
  });
}

function resetTime() {
  renderer.resetTime();

  // Sync to fullscreen window
  window.electronAPI.sendTimeSync({
    time: 0,
    frame: 0,
    isPlaying: renderer.isPlaying
  });
}

function togglePreview() {
  previewEnabled = !previewEnabled;
  const btnPreview = document.getElementById('btn-preview');
  const previewPanel = document.getElementById('preview-panel');

  if (previewEnabled) {
    btnPreview.classList.add('active');
    btnPreview.title = 'Disable Preview';
    previewPanel.classList.remove('hidden');
  } else {
    btnPreview.classList.remove('active');
    btnPreview.title = 'Enable Preview';
    previewPanel.classList.add('hidden');
  }

  updatePanelVisibility();
  saveViewState();
}

function toggleGrid() {
  gridEnabled = !gridEnabled;
  const btnGrid = document.getElementById('btn-grid');
  const gridPanel = document.getElementById('grid-panel');

  if (gridEnabled) {
    btnGrid.classList.add('active');
    btnGrid.title = 'Hide Shader Grid';
    gridPanel.classList.remove('hidden');
    startGridAnimation();
  } else {
    btnGrid.classList.remove('active');
    btnGrid.title = 'Show Shader Grid';
    gridPanel.classList.add('hidden');
    stopGridAnimation();
  }

  updatePanelVisibility();
  saveViewState();
}

function toggleEditor() {
  editorEnabled = !editorEnabled;
  const btnEditor = document.getElementById('btn-editor');
  const editorPanel = document.getElementById('editor-panel');
  const resizer = document.getElementById('resizer');

  if (editorEnabled) {
    btnEditor.classList.add('active');
    btnEditor.title = 'Hide Editor';
    editorPanel.classList.remove('hidden');
  } else {
    btnEditor.classList.remove('active');
    btnEditor.title = 'Show Editor';
    editorPanel.classList.add('hidden');
  }

  updatePanelVisibility();
  saveViewState();
}

function toggleParams() {
  paramsEnabled = !paramsEnabled;
  const btnParams = document.getElementById('btn-params');
  const paramsPanel = document.getElementById('params-panel');

  if (paramsEnabled) {
    btnParams.classList.add('active');
    btnParams.title = 'Hide Parameters';
    paramsPanel.classList.remove('hidden');
  } else {
    btnParams.classList.remove('active');
    btnParams.title = 'Show Parameters';
    paramsPanel.classList.add('hidden');
  }

  saveViewState();
}

function updatePanelVisibility() {
  const rightPanel = document.getElementById('right-panel');
  const resizer = document.getElementById('resizer');
  const editorPanel = document.getElementById('editor-panel');

  const rightVisible = previewEnabled || gridEnabled;
  const leftVisible = editorEnabled;

  // Side-by-side layout when editor hidden and both grid+preview visible
  const sideBySide = !leftVisible && gridEnabled && previewEnabled;
  rightPanel.classList.toggle('side-by-side', sideBySide);

  if (!rightVisible && leftVisible) {
    // Only editor - full width
    rightPanel.classList.add('hidden');
    resizer.classList.add('hidden');
    editorPanel.style.width = '100%';
  } else if (rightVisible && !leftVisible) {
    // Only right panel - full width
    rightPanel.classList.remove('hidden');
    rightPanel.style.width = '100%';
    resizer.classList.add('hidden');
    editorPanel.style.width = '';
  } else if (rightVisible && leftVisible) {
    // Both visible
    rightPanel.classList.remove('hidden');
    rightPanel.style.width = '';
    resizer.classList.remove('hidden');
    editorPanel.style.width = '';
  } else {
    // Neither visible - show editor by default
    editorEnabled = true;
    const btnEditor = document.getElementById('btn-editor');
    btnEditor.classList.add('active');
    editorPanel.classList.remove('hidden');
    editorPanel.style.width = '100%';
    rightPanel.classList.add('hidden');
    resizer.classList.add('hidden');
  }

  editor.resize();
}

// Keep old function name for compatibility
function updateRightPanelVisibility() {
  updatePanelVisibility();
}

async function initShaderGrid() {
  const slots = document.querySelectorAll('.grid-slot');

  slots.forEach((slot, index) => {
    const canvas = slot.querySelector('canvas');
    canvas.width = 160;
    canvas.height = 90;

    // Left click - play shader in preview and/or fullscreen
    slot.addEventListener('click', () => {
      if (gridSlots[index]) {
        playGridShader(index);
      }
    });

    // Double click - load shader into editor
    slot.addEventListener('dblclick', () => {
      if (gridSlots[index]) {
        loadGridShaderToEditor(index);
      }
    });

    // Right click - context menu
    slot.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showGridContextMenu(e.clientX, e.clientY, index);
    });
  });

  // Close context menu when clicking elsewhere
  document.addEventListener('click', hideContextMenu);

  // Load saved grid state
  await loadGridState();
}

function showGridContextMenu(x, y, slotIndex) {
  hideContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'grid-context-menu';

  const hasShader = gridSlots[slotIndex] !== null;

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

async function loadShaderToSlot(slotIndex) {
  const result = await window.electronAPI.loadShaderForGrid();
  if (result && result.content) {
    assignShaderToSlot(slotIndex, result.content, result.filePath);
  } else if (result && result.error) {
    setStatus(`Failed to load shader: ${result.error}`, 'error');
  }
}

function assignCurrentShaderToSlot(slotIndex) {
  const shaderCode = editor.getValue();
  assignShaderToSlot(slotIndex, shaderCode, null);
}

async function assignShaderToSlot(slotIndex, shaderCode, filePath, skipSave = false, params = null, presets = null) {
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  const canvas = slot.querySelector('canvas');

  // Clean up existing renderer
  if (gridSlots[slotIndex] && gridSlots[slotIndex].renderer) {
    // Just clear the reference
  }

  // Create mini renderer for this slot
  const miniRenderer = new MiniShaderRenderer(canvas);

  // Use provided params or capture current params
  const slotParams = params || renderer.getParams();

  try {
    miniRenderer.compile(shaderCode);
    gridSlots[slotIndex] = {
      shaderCode,
      filePath,
      renderer: miniRenderer,
      params: { ...slotParams },
      presets: presets || []
    };
    slot.classList.add('has-shader');
    slot.title = filePath ? `Slot ${slotIndex + 1}: ${filePath.split('/').pop()}` : `Slot ${slotIndex + 1}: Current shader`;

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

async function clearGridSlot(slotIndex) {
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  gridSlots[slotIndex] = null;
  slot.classList.remove('has-shader');
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
  if (activeGridSlot === slotIndex) {
    activeGridSlot = null;
    updateLocalPresetsUI();
    updateSaveButtonState();
  }

  setStatus(`Cleared slot ${slotIndex + 1}`, 'success');

  // Save grid state
  saveGridState();
}

async function saveActiveSlotShader() {
  if (activeGridSlot === null) {
    setStatus('No shader slot selected', 'error');
    return;
  }

  if (!gridSlots[activeGridSlot]) {
    setStatus('No shader in active slot', 'error');
    return;
  }

  const shaderCode = editor.getValue();

  // Update the slot's shader code
  gridSlots[activeGridSlot].shaderCode = shaderCode;

  // Also update the renderer in the slot
  try {
    gridSlots[activeGridSlot].renderer.compile(shaderCode);
  } catch (err) {
    // Don't fail the save if compilation fails
    console.warn('Shader compilation warning:', err.message);
  }

  // Save to file
  const result = await window.electronAPI.saveShaderToSlot(activeGridSlot, shaderCode);
  if (result.success) {
    setStatus(`Shader saved to slot ${activeGridSlot + 1}`, 'success');
  } else {
    setStatus(`Failed to save shader: ${result.error}`, 'error');
  }
}

function updateSaveButtonState() {
  const btnSaveShader = document.getElementById('btn-save-shader');
  if (activeGridSlot !== null && gridSlots[activeGridSlot]) {
    btnSaveShader.disabled = false;
    btnSaveShader.title = `Save Shader to Slot ${activeGridSlot + 1} (Ctrl+S)`;
  } else {
    btnSaveShader.disabled = true;
    btnSaveShader.title = 'Save Shader to Active Slot (select a slot first)';
  }
}

function saveGridState() {
  const state = gridSlots.map(slot => {
    if (!slot) return null;
    // Don't include shaderCode - it's saved to individual files
    return {
      filePath: slot.filePath,
      params: slot.params,
      presets: slot.presets || []
    };
  });
  window.electronAPI.saveGridState(state);
}

async function loadGridState() {
  const state = await window.electronAPI.loadGridState();
  if (!state || !Array.isArray(state)) return;

  let loadedCount = 0;
  for (let i = 0; i < Math.min(state.length, 16); i++) {
    if (state[i] && state[i].shaderCode) {
      try {
        assignShaderToSlot(i, state[i].shaderCode, state[i].filePath, true, state[i].params, state[i].presets);
        loadedCount++;
      } catch (err) {
        console.warn(`Failed to restore shader in slot ${i + 1}:`, err);
      }
    }
  }

  if (loadedCount > 0) {
    setStatus(`Restored ${loadedCount} shader${loadedCount > 1 ? 's' : ''} from saved state`, 'success');
  }
}

function loadGridPresetsFromData(state, filePath) {
  if (!state || !Array.isArray(state)) {
    setStatus('Invalid grid presets file', 'error');
    return;
  }

  // Clear all existing slots first
  for (let i = 0; i < 16; i++) {
    if (gridSlots[i]) {
      const slot = document.querySelector(`.grid-slot[data-slot="${i}"]`);
      gridSlots[i] = null;
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
  for (let i = 0; i < Math.min(state.length, 16); i++) {
    if (state[i] && state[i].shaderCode) {
      try {
        assignShaderToSlot(i, state[i].shaderCode, state[i].filePath, true, state[i].params, state[i].presets);
        loadedCount++;
      } catch (err) {
        console.warn(`Failed to load shader in slot ${i + 1}:`, err);
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

function loadGridShaderToEditor(slotIndex) {
  const slotData = gridSlots[slotIndex];
  if (!slotData) return;

  // Clear previous active slot highlight
  if (activeGridSlot !== null) {
    const prevSlot = document.querySelector(`.grid-slot[data-slot="${activeGridSlot}"]`);
    if (prevSlot) prevSlot.classList.remove('active');
  }

  // Set new active slot
  activeGridSlot = slotIndex;
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  slot.classList.add('active');

  // Load shader into editor
  editor.setValue(slotData.shaderCode, -1);
  compileShader();

  // Load params into sliders
  if (slotData.params) {
    loadParamsToSliders(slotData.params);
  }

  // Update local presets UI for this shader
  updateLocalPresetsUI();

  // Update save button state
  updateSaveButtonState();

  const slotName = slotData.filePath ? slotData.filePath.split('/').pop() : `slot ${slotIndex + 1}`;
  setStatus(`Editing ${slotName} (slot ${slotIndex + 1})`, 'success');
}

function loadParamsToSliders(params) {
  const paramMappings = [
    { id: 'param-speed', name: 'speed' }
  ];

  // Add 5 custom params
  for (let i = 0; i < 5; i++) {
    paramMappings.push({ id: `param-p${i}`, name: `p${i}` });
  }

  // Add 10 RGB color mappings
  for (let i = 0; i < 10; i++) {
    paramMappings.push({ id: `param-r${i}`, name: `r${i}` });
    paramMappings.push({ id: `param-g${i}`, name: `g${i}` });
    paramMappings.push({ id: `param-b${i}`, name: `b${i}` });
  }

  paramMappings.forEach(({ id, name }) => {
    if (params[name] !== undefined) {
      const slider = document.getElementById(id);
      const valueDisplay = document.getElementById(`${id}-value`);
      if (slider) {
        slider.value = params[name];
        if (valueDisplay) {
          valueDisplay.textContent = params[name].toFixed(2);
        }
        renderer.setParam(name, params[name]);
      }
    }
  });
}

function playGridShader(slotIndex) {
  const slotData = gridSlots[slotIndex];
  if (!slotData) return;

  // Clear previous active slot highlight
  if (activeGridSlot !== null) {
    const prevSlot = document.querySelector(`.grid-slot[data-slot="${activeGridSlot}"]`);
    if (prevSlot) prevSlot.classList.remove('active');
  }

  // Set active slot
  activeGridSlot = slotIndex;
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  if (slot) slot.classList.add('active');

  // Load the slot's params
  if (slotData.params) {
    loadParamsToSliders(slotData.params);
  }

  // Update local presets UI for this shader
  updateLocalPresetsUI();

  // Update save button state
  updateSaveButtonState();

  // Show in preview if enabled
  if (previewEnabled) {
    try {
      renderer.compile(slotData.shaderCode);
      renderer.resetTime();
    } catch (err) {
      setStatus(`Failed to compile shader: ${err.message}`, 'error');
      return;
    }
  }

  // Send to fullscreen window (if open)
  const state = {
    shaderCode: slotData.shaderCode,
    time: 0,
    frame: 0,
    isPlaying: true,
    channels: channelState,
    params: slotData.params || renderer.getParams()
  };
  window.electronAPI.sendShaderUpdate(state);
  window.electronAPI.sendTimeSync({ time: 0, frame: 0, isPlaying: true });

  // Send all params to fullscreen
  if (slotData.params) {
    Object.entries(slotData.params).forEach(([name, value]) => {
      window.electronAPI.sendParamUpdate({ name, value });
    });
  }

  const slotName = slotData.filePath ? slotData.filePath.split('/').pop() : `slot ${slotIndex + 1}`;
  setStatus(`Playing ${slotName}`, 'success');
}

function startGridAnimation() {
  if (gridAnimationId) return;

  function animateGrid() {
    for (let i = 0; i < 16; i++) {
      if (gridSlots[i] && gridSlots[i].renderer) {
        // Update params from slot before rendering
        gridSlots[i].renderer.setParams(gridSlots[i].params);
        gridSlots[i].renderer.render();
      }
    }
    gridAnimationId = requestAnimationFrame(animateGrid);
  }
  animateGrid();
}

function stopGridAnimation() {
  if (gridAnimationId) {
    cancelAnimationFrame(gridAnimationId);
    gridAnimationId = null;
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
    this.params = null; // Will store slot params

    this.setupGeometry();
  }

  setParams(params) {
    this.params = params;
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

    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
  }

  render() {
    if (!this.program) return;

    const gl = this.gl;
    const speed = this.params?.speed ?? 1;
    const time = (performance.now() - this.startTime) / 1000 * speed;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);

    gl.uniform3f(this.uniforms.iResolution, this.canvas.width, this.canvas.height, 1);
    gl.uniform1f(this.uniforms.iTime, time);

    // Use slot params for colors or default to white
    const colorArray = new Float32Array(30);
    for (let i = 0; i < 10; i++) {
      colorArray[i * 3 + 0] = this.params?.[`r${i}`] ?? 1.0;
      colorArray[i * 3 + 1] = this.params?.[`g${i}`] ?? 1.0;
      colorArray[i * 3 + 2] = this.params?.[`b${i}`] ?? 1.0;
    }
    gl.uniform3fv(this.uniforms.iColorRGB, colorArray);

    // Use slot params for p0-p4 or default to 0.5
    const paramsArray = new Float32Array([
      this.params?.p0 ?? 0.5,
      this.params?.p1 ?? 0.5,
      this.params?.p2 ?? 0.5,
      this.params?.p3 ?? 0.5,
      this.params?.p4 ?? 0.5
    ]);
    gl.uniform1fv(this.uniforms.iParams, paramsArray);

    gl.uniform1f(this.uniforms.iSpeed, speed);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

function setStatus(message, type = '') {
  const statusBar = document.getElementById('status-bar');
  const statusMessage = document.getElementById('status-message');

  statusBar.className = type;
  statusMessage.textContent = message;

  // Auto-clear success messages after 3 seconds
  if (type === 'success') {
    setTimeout(() => {
      if (statusMessage.textContent === message) {
        statusBar.className = '';
        statusMessage.textContent = 'Ready';
      }
    }, 3000);
  }
}

function updateChannelSlot(channel, type, source = '', width = 0, height = 0, dataUrl = null) {
  const slot = document.getElementById(`channel-${channel}`);

  // Reset classes
  slot.classList.remove('has-texture', 'has-video', 'has-camera', 'has-audio');
  slot.style.backgroundImage = '';

  const fileName = source ? source.split('/').pop().split('\\').pop() : '';

  switch (type) {
    case 'image':
      slot.classList.add('has-texture');
      if (dataUrl) {
        slot.style.backgroundImage = `url(${dataUrl})`;
      }
      slot.title = `iChannel${channel}: ${fileName} (${width}x${height}) [Image]`;
      slot.textContent = '';
      break;
    case 'video':
      slot.classList.add('has-video');
      slot.title = `iChannel${channel}: ${fileName} (${width}x${height}) [Video]`;
      slot.textContent = 'V';
      break;
    case 'camera':
      slot.classList.add('has-camera');
      slot.title = `iChannel${channel}: Camera (${width}x${height}) [Camera]`;
      slot.textContent = 'C';
      break;
    case 'audio':
      slot.classList.add('has-audio');
      slot.title = `iChannel${channel}: Audio FFT (${width}x${height}) [Audio]\nRow 0: Frequency spectrum, Row 1: Waveform`;
      slot.textContent = 'A';
      break;
    default:
      slot.title = `iChannel${channel} - Click File > Load Texture/Video/Camera`;
      slot.textContent = channel;
  }
}

function renderLoop() {
  // Only render if preview is enabled
  if (previewEnabled) {
    const stats = renderer.render();

    if (stats) {
      document.getElementById('fps-display').textContent = `FPS: ${stats.fps}`;
      document.getElementById('time-display').textContent = `Time: ${stats.time.toFixed(2)}s`;
      document.getElementById('frame-display').textContent = `Frame: ${stats.frame}`;
    }

    // Send frame to NDI output if enabled (every other frame to reduce load)
    if (ndiEnabled && ndiFrameCounter % 2 === 0) {
      sendNDIFrame();
    }
    ndiFrameCounter++;
  } else {
    // Still update time even when preview disabled (for fullscreen sync)
    renderer.updateTime();
  }

  animationId = requestAnimationFrame(renderLoop);
}

function sendNDIFrame() {
  try {
    const canvas = document.getElementById('shader-canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');

    if (!gl) {
      console.warn('No WebGL context for NDI frame');
      return;
    }

    const width = canvas.width;
    const height = canvas.height;

    // Read pixels from WebGL canvas (RGBA format)
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // WebGL reads pixels bottom-to-top, so we need to flip vertically
    const flippedPixels = new Uint8Array(width * height * 4);
    const rowSize = width * 4;
    for (let y = 0; y < height; y++) {
      const srcRow = (height - 1 - y) * rowSize;
      const dstRow = y * rowSize;
      flippedPixels.set(pixels.subarray(srcRow, srcRow + rowSize), dstRow);
    }

    // Convert to base64 in chunks to avoid stack overflow
    const chunkSize = 65536;
    let base64 = '';
    for (let i = 0; i < flippedPixels.length; i += chunkSize) {
      const chunk = flippedPixels.subarray(i, Math.min(i + chunkSize, flippedPixels.length));
      base64 += String.fromCharCode.apply(null, chunk);
    }
    base64 = btoa(base64);

    window.electronAPI.sendNDIFrame({
      rgbaData: base64,
      width: width,
      height: height
    });
  } catch (err) {
    console.warn('Failed to send NDI frame:', err);
  }
}

function toggleNDI() {
  window.electronAPI.toggleNDI();
}

function openFullscreenPreview() {
  window.electronAPI.openFullscreen();
}

async function showSettingsDialog() {
  // Get current settings
  const settings = await window.electronAPI.getSettings();

  // Build parameter ranges HTML
  const paramRangesHtml = [0, 1, 2, 3, 4].map(i => {
    const range = paramRanges[`p${i}`] || { min: 0, max: 1 };
    return `
      <div class="param-range-row">
        <label>P${i}</label>
        <input type="number" id="settings-p${i}-min" value="${range.min}" step="0.1" placeholder="Min">
        <span>to</span>
        <input type="number" id="settings-p${i}-max" value="${range.max}" step="0.1" placeholder="Max">
      </div>
    `;
  }).join('');

  // Create settings dialog overlay
  const overlay = document.createElement('div');
  overlay.id = 'settings-overlay';
  overlay.innerHTML = `
    <div class="settings-dialog">
      <div class="settings-header">
        <h2>Settings</h2>
        <button class="close-btn" onclick="closeSettingsDialog()">&times;</button>
      </div>
      <div class="settings-content">
        <div class="settings-section">
          <h3>Parameter Ranges</h3>
          ${paramRangesHtml}
        </div>

        <div class="settings-section">
          <h3>NDI Output</h3>
          <div class="setting-row">
            <label>Resolution:</label>
            <select id="settings-ndi-resolution">
              ${settings.ndiResolutions.map(res =>
                `<option value="${res.label}" ${settings.ndiResolution.label === res.label ? 'selected' : ''}>${res.label}</option>`
              ).join('')}
            </select>
          </div>
          <div class="setting-row custom-res ${settings.ndiResolution.label.includes('Custom') ? '' : 'hidden'}" id="custom-ndi-res">
            <label>Custom Size:</label>
            <input type="number" id="settings-ndi-width" value="${settings.ndiResolution.width}" min="128" max="7680" placeholder="Width">
            <span>x</span>
            <input type="number" id="settings-ndi-height" value="${settings.ndiResolution.height}" min="128" max="4320" placeholder="Height">
          </div>
          <div class="setting-row">
            <label>Status:</label>
            <span class="ndi-status ${settings.ndiEnabled ? 'active' : ''}">${settings.ndiEnabled ? 'Active' : 'Inactive'}</span>
          </div>
        </div>

        <div class="settings-section">
          <h3>Preview</h3>
          <div class="setting-row">
            <label>Resolution:</label>
            <span id="current-preview-res">${document.getElementById('shader-canvas').width}x${document.getElementById('shader-canvas').height}</span>
          </div>
        </div>
      </div>
      <div class="settings-footer">
        <button class="btn-secondary" onclick="closeSettingsDialog()">Cancel</button>
        <button class="btn-primary" onclick="applySettings()">Apply</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Handle resolution dropdown change
  const resSelect = document.getElementById('settings-ndi-resolution');
  resSelect.addEventListener('change', () => {
    const customRes = document.getElementById('custom-ndi-res');
    if (resSelect.value === 'Custom...') {
      customRes.classList.remove('hidden');
    } else {
      customRes.classList.add('hidden');
    }
  });

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSettingsDialog();
  });

  // Close on Escape
  document.addEventListener('keydown', settingsKeyHandler);
}

function settingsKeyHandler(e) {
  if (e.key === 'Escape') closeSettingsDialog();
}

function closeSettingsDialog() {
  const overlay = document.getElementById('settings-overlay');
  if (overlay) {
    overlay.remove();
    document.removeEventListener('keydown', settingsKeyHandler);
  }
}

function applySettings() {
  const resSelect = document.getElementById('settings-ndi-resolution');
  const selectedLabel = resSelect.value;

  let ndiResolution;
  if (selectedLabel === 'Custom...') {
    const width = parseInt(document.getElementById('settings-ndi-width').value) || 1920;
    const height = parseInt(document.getElementById('settings-ndi-height').value) || 1080;
    ndiResolution = { width, height, label: `${width}x${height} (Custom)` };
  } else {
    // Parse from label
    const match = selectedLabel.match(/(\d+)x(\d+)/);
    if (match) {
      ndiResolution = {
        width: parseInt(match[1]),
        height: parseInt(match[2]),
        label: selectedLabel
      };
    }
  }

  // Collect parameter ranges
  const newParamRanges = {};
  for (let i = 0; i < 5; i++) {
    const min = parseFloat(document.getElementById(`settings-p${i}-min`).value) || 0;
    const max = parseFloat(document.getElementById(`settings-p${i}-max`).value) || 1;
    newParamRanges[`p${i}`] = { min, max };
  }

  // Update local param ranges and apply to sliders
  paramRanges = newParamRanges;
  applyParamRanges();

  // Save to file
  window.electronAPI.saveSettings({ ndiResolution, paramRanges: newParamRanges });

  closeSettingsDialog();
  setStatus('Settings saved', 'success');
}
