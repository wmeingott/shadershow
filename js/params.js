// Parameters module - Custom shader parameter UI
import { state } from './state.js';
import { setStatus } from './utils.js';
import { saveGridState } from './shader-grid.js';
import { tileState } from './tile-state.js';
import { updateMixerChannelParam } from './mixer.js';

// Debounced grid state save
let saveGridStateTimeout = null;
const SAVE_DEBOUNCE_MS = 500;

function debouncedSaveGridState() {
  if (saveGridStateTimeout) clearTimeout(saveGridStateTimeout);
  saveGridStateTimeout = setTimeout(() => {
    saveGridState();
    saveGridStateTimeout = null;
  }, SAVE_DEBOUNCE_MS);
}

// Track whether we have custom params
let usingCustomParams = false;

// Make a param-value span click-to-edit. On click, replaces the span with a
// text input. Enter/blur commits, Escape reverts. Calls onCommit(newValue).
function makeValueEditable(span, slider, { isInt = false, onCommit }) {
  span.style.cursor = 'pointer';
  span.title = 'Click to edit';

  span.addEventListener('click', (e) => {
    e.stopPropagation();
    if (span.querySelector('input')) return; // already editing

    const currentText = span.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'param-value-input';
    input.value = currentText;

    span.textContent = '';
    span.appendChild(input);
    input.focus();
    input.select();

    function commit() {
      const raw = input.value.trim();
      const parsed = isInt ? parseInt(raw, 10) : parseFloat(raw);
      if (isNaN(parsed)) {
        revert();
        return;
      }
      // Clamp to slider range
      const min = parseFloat(slider.min);
      const max = parseFloat(slider.max);
      const clamped = Math.min(max, Math.max(min, parsed));
      slider.value = clamped;
      span.textContent = isInt ? Math.round(clamped).toString() : clamped.toFixed(2);
      onCommit(clamped);
    }

    function revert() {
      span.textContent = currentText;
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); revert(); }
    });
    input.addEventListener('blur', commit);
  });
}

export function initParams() {
  // Speed slider only
  const speedSlider = document.getElementById('param-speed');
  const speedValue = document.getElementById('param-speed-value');

  if (speedSlider) {
    speedSlider.addEventListener('input', () => {
      const value = parseFloat(speedSlider.value);
      state.renderer.setParam('speed', value);
      speedValue.textContent = value.toFixed(2);
      window.electronAPI.sendParamUpdate({ name: 'speed', value });

      // Route to mixer channel or grid slot
      if (state.mixerSelectedChannel !== null) {
        updateMixerChannelParam('speed', value);
      } else {
        syncSpeedToActiveSlot(value);
      }

      // Also update selected tile's renderer if in tiled mode
      updateSelectedTileParam('speed', value);
    });

    // Click value display to type exact value
    makeValueEditable(speedValue, speedSlider, {
      onCommit(value) {
        state.renderer.setParam('speed', value);
        window.electronAPI.sendParamUpdate({ name: 'speed', value });
        if (state.mixerSelectedChannel !== null) {
          updateMixerChannelParam('speed', value);
        } else {
          syncSpeedToActiveSlot(value);
        }
        updateSelectedTileParam('speed', value);
      }
    });

    // Double-click to reset speed to 1
    speedSlider.addEventListener('dblclick', () => {
      speedSlider.value = 1;
      state.renderer.setParam('speed', 1);
      speedValue.textContent = '1.00';
      window.electronAPI.sendParamUpdate({ name: 'speed', value: 1 });

      // Route to mixer channel or grid slot
      if (state.mixerSelectedChannel !== null) {
        updateMixerChannelParam('speed', 1);
      } else {
        syncSpeedToActiveSlot(1);
      }

      // Also update selected tile's renderer if in tiled mode
      updateSelectedTileParam('speed', 1);
    });
  }
}

// Sync speed to the active grid slot's MiniShaderRenderer (for mixer compositing)
function syncSpeedToActiveSlot(value) {
  if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
    const slot = state.gridSlots[state.activeGridSlot];
    if (!slot.params) slot.params = {};
    slot.params.speed = value;
    if (slot.renderer?.setSpeed) {
      slot.renderer.setSpeed(value);
    }
  }
}

// Update parameter on selected tile (for tiled preview mode)
function updateSelectedTileParam(paramName, value) {
  if (!state.tiledPreviewEnabled) return;

  const tileIndex = state.selectedTileIndex;
  if (tileIndex < 0 || tileIndex >= tileState.tiles.length) return;

  const tile = tileState.tiles[tileIndex];
  if (!tile || tile.gridSlotIndex === null) return;

  // Update tile's stored params (tile has its own independent params)
  if (!tile.params) tile.params = {};
  tile.params[paramName] = value;

  // Sync tile param to fullscreen
  window.electronAPI.updateTileParam?.(tileIndex, paramName, value);

  // Save state
  debouncedSaveGridState();
}

export function initMouseAssignment() {
  // Mouse assignment is no longer used with legacy params removed
  // This function is kept for API compatibility but does nothing
}

export function loadParamsToSliders(params, { skipMixerSync = false } = {}) {
  if (!params) return;

  // Load speed if present
  if (params.speed !== undefined) {
    const speedSlider = document.getElementById('param-speed');
    const speedValue = document.getElementById('param-speed-value');
    if (speedSlider) {
      speedSlider.value = params.speed;
      if (speedValue) speedValue.textContent = params.speed.toFixed(2);
      if (state.renderer) state.renderer.setParam('speed', params.speed);

      // Route to mixer channel if selected
      if (!skipMixerSync && state.mixerSelectedChannel !== null) {
        updateMixerChannelParam('speed', params.speed);
      }

      // Also update selected tile if in tiled mode
      updateSelectedTileParam('speed', params.speed);
    }
  }

  // Load custom params to renderer
  if (state.renderer) {
    Object.entries(params).forEach(([name, value]) => {
      if (name !== 'speed') {
        state.renderer.setParam(name, value);

        // Route to mixer channel if selected
        if (!skipMixerSync && state.mixerSelectedChannel !== null) {
          updateMixerChannelParam(name, value);
        }

        // Also update selected tile if in tiled mode
        if (state.tiledPreviewEnabled) {
          updateSelectedTileParam(name, value);
        }
      }
    });
  }

  // Regenerate custom param UI to reflect loaded values
  generateCustomParamUI();
}

export function updateParamLabels(paramNames) {
  // No longer needed - custom params use their own labels
}

export function resetParamLabels() {
  // No longer needed
}

// =============================================================================
// Dynamic Custom Parameter UI Generation
// =============================================================================

// Generate UI controls for custom shader parameters
export function generateCustomParamUI() {
  const container = document.getElementById('custom-params-container');

  if (!container || !state.renderer) return;

  // Get custom param definitions from the shader
  const params = state.renderer.getCustomParamDefs();

  // Clear existing custom UI
  container.innerHTML = '';

  if (params.length === 0) {
    usingCustomParams = false;
    return;
  }

  usingCustomParams = true;

  // Group parameters: scalars first, then arrays
  const scalarParams = params.filter(p => !p.isArray);
  const arrayParams = params.filter(p => p.isArray);

  // Create section for scalar parameters
  if (scalarParams.length > 0) {
    const section = createParamSection('Shader Parameters');
    scalarParams.forEach(param => {
      const control = createParamControl(param);
      if (control) section.appendChild(control);
    });
    container.appendChild(section);
  }

  // Create sections for each array parameter
  arrayParams.forEach(param => {
    const section = createParamSection(param.description || param.name);
    const arrayControls = createArrayParamControls(param);
    arrayControls.forEach(control => section.appendChild(control));
    container.appendChild(section);
  });
}

// Create a params section with title
function createParamSection(title) {
  const section = document.createElement('div');
  section.className = 'params-section';

  const titleEl = document.createElement('div');
  titleEl.className = 'params-section-title';
  titleEl.textContent = title;
  section.appendChild(titleEl);

  return section;
}

// Create control for a single (non-array) parameter
function createParamControl(param, index = null, arrayName = null) {
  const row = document.createElement('div');
  row.className = 'param-row';

  // Determine the actual param name for value storage
  const paramName = arrayName ? arrayName : param.name;

  // Label
  const label = document.createElement('label');
  label.textContent = index !== null ? `${index}` : param.name;
  if (param.description && index === null) {
    label.title = param.description;
  }
  row.appendChild(label);

  // Get current value
  const values = state.renderer.getCustomParamValues();
  const currentValue = index !== null ? values[paramName][index] : values[paramName];

  // Create appropriate control based on type
  switch (param.type) {
    case 'int':
    case 'float':
      createSliderControl(row, param, currentValue, paramName, index);
      break;
    case 'vec2':
      createVec2Control(row, param, currentValue, paramName, index);
      break;
    case 'color':
      createColorControl(row, param, currentValue, paramName, index);
      break;
    case 'vec3':
      createVec3Control(row, param, currentValue, paramName, index);
      break;
    case 'vec4':
      createVec4Control(row, param, currentValue, paramName, index);
      break;
  }

  return row;
}

// Create slider control for int/float
function createSliderControl(row, param, value, paramName, arrayIndex) {
  const isInt = param.type === 'int';
  const min = param.min !== null ? param.min : (isInt ? 0 : 0);
  const max = param.max !== null ? param.max : (isInt ? 10 : 1);
  const step = isInt ? 1 : 0.01;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = min;
  slider.max = max;
  slider.step = step;
  slider.value = value;

  const valueDisplay = document.createElement('span');
  valueDisplay.className = 'param-value';
  valueDisplay.textContent = isInt ? Math.round(value).toString() : value.toFixed(2);

  slider.addEventListener('input', () => {
    const newValue = isInt ? parseInt(slider.value, 10) : parseFloat(slider.value);
    valueDisplay.textContent = isInt ? newValue.toString() : newValue.toFixed(2);
    updateCustomParamValue(paramName, newValue, arrayIndex);
  });

  // Double-click to reset
  slider.addEventListener('dblclick', () => {
    const defaultVal = arrayIndex !== null ? param.default[arrayIndex] : param.default;
    slider.value = defaultVal;
    valueDisplay.textContent = isInt ? Math.round(defaultVal).toString() : defaultVal.toFixed(2);
    updateCustomParamValue(paramName, defaultVal, arrayIndex);
  });

  // Click value display to type exact value
  makeValueEditable(valueDisplay, slider, {
    isInt,
    onCommit(newValue) {
      valueDisplay.textContent = isInt ? newValue.toString() : newValue.toFixed(2);
      updateCustomParamValue(paramName, newValue, arrayIndex);
    }
  });

  row.appendChild(slider);
  row.appendChild(valueDisplay);
}

// Create vec2 control (two sliders)
function createVec2Control(row, param, value, paramName, arrayIndex) {
  const min = param.min !== null ? param.min : 0;
  const max = param.max !== null ? param.max : 1;

  ['X', 'Y'].forEach((axis, i) => {
    const subLabel = document.createElement('label');
    subLabel.textContent = axis;
    subLabel.style.minWidth = '12px';
    row.appendChild(subLabel);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min;
    slider.max = max;
    slider.step = 0.01;
    slider.value = value[i];
    slider.style.width = '60px';

    const valueDisplay = document.createElement('span');
    valueDisplay.className = 'param-value';
    valueDisplay.textContent = value[i].toFixed(2);

    slider.addEventListener('input', () => {
      const newValue = parseFloat(slider.value);
      valueDisplay.textContent = newValue.toFixed(2);
      const values = state.renderer.getCustomParamValues();
      const fullValue = arrayIndex !== null
        ? [...values[paramName][arrayIndex]]
        : [...values[paramName]];
      fullValue[i] = newValue;
      updateCustomParamValue(paramName, fullValue, arrayIndex);
    });

    makeValueEditable(valueDisplay, slider, {
      isInt: false,
      onCommit(newValue) {
        valueDisplay.textContent = newValue.toFixed(2);
        const values = state.renderer.getCustomParamValues();
        const fullValue = arrayIndex !== null
          ? [...values[paramName][arrayIndex]]
          : [...values[paramName]];
        fullValue[i] = newValue;
        updateCustomParamValue(paramName, fullValue, arrayIndex);
      }
    });

    row.appendChild(slider);
    row.appendChild(valueDisplay);
  });
}

// Convert RGB array [0-1] to hex color string
function rgbToHex(r, g, b) {
  const toHex = (v) => {
    const hex = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

// Convert hex color string to RGB array [0-1]
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    return [
      parseInt(result[1], 16) / 255,
      parseInt(result[2], 16) / 255,
      parseInt(result[3], 16) / 255
    ];
  }
  return [1, 1, 1];
}

// Create color control with color picker and RGB sliders
function createColorControl(row, param, value, paramName, arrayIndex) {
  row.className = 'color-row color-picker-row';

  // Color picker input
  const colorPicker = document.createElement('input');
  colorPicker.type = 'color';
  colorPicker.className = 'color-picker-input';
  colorPicker.value = rgbToHex(value[0], value[1], value[2]);
  colorPicker.title = 'Click to pick color';

  // RGB sliders container
  const slidersDiv = document.createElement('div');
  slidersDiv.className = 'color-sliders';

  const channels = ['R', 'G', 'B'];
  const classes = ['color-red', 'color-green', 'color-blue'];
  const sliders = [];

  channels.forEach((channel, i) => {
    const sliderWrapper = document.createElement('div');
    sliderWrapper.className = 'color-slider-wrapper';

    const subLabel = document.createElement('label');
    subLabel.textContent = channel;
    subLabel.className = classes[i];
    sliderWrapper.appendChild(subLabel);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = 0;
    slider.max = 1;
    slider.step = 0.01;
    slider.value = value[i];
    sliders.push(slider);

    slider.addEventListener('input', () => {
      const newValue = parseFloat(slider.value);
      // Get current full value
      const values = state.renderer.getCustomParamValues();
      const fullValue = arrayIndex !== null
        ? [...values[paramName][arrayIndex]]
        : [...values[paramName]];
      fullValue[i] = newValue;

      // Update color picker
      colorPicker.value = rgbToHex(fullValue[0], fullValue[1], fullValue[2]);

      updateCustomParamValue(paramName, fullValue, arrayIndex);
    });

    sliderWrapper.appendChild(slider);
    slidersDiv.appendChild(sliderWrapper);
  });

  // Color picker change handler
  colorPicker.addEventListener('input', () => {
    const rgb = hexToRgb(colorPicker.value);
    // Update sliders
    sliders.forEach((slider, i) => {
      slider.value = rgb[i];
    });
    updateCustomParamValue(paramName, rgb, arrayIndex);
  });

  row.appendChild(colorPicker);
  row.appendChild(slidersDiv);
}

// Create vec3 control (three sliders, styled as RGB for colors)
function createVec3Control(row, param, value, paramName, arrayIndex) {
  row.className = 'color-row';

  const min = param.min !== null ? param.min : 0;
  const max = param.max !== null ? param.max : 1;

  const channels = ['R', 'G', 'B'];
  const classes = ['color-red', 'color-green', 'color-blue'];

  channels.forEach((channel, i) => {
    const subLabel = document.createElement('label');
    subLabel.textContent = channel;
    subLabel.className = classes[i];
    row.appendChild(subLabel);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min;
    slider.max = max;
    slider.step = 0.01;
    slider.value = value[i];

    slider.addEventListener('input', () => {
      const newValue = parseFloat(slider.value);
      // Get current full value
      const values = state.renderer.getCustomParamValues();
      const fullValue = arrayIndex !== null
        ? [...values[paramName][arrayIndex]]
        : [...values[paramName]];
      fullValue[i] = newValue;
      updateCustomParamValue(paramName, fullValue, arrayIndex);
    });

    row.appendChild(slider);
  });
}

// Create vec4 control (four sliders, styled as RGBA)
function createVec4Control(row, param, value, paramName, arrayIndex) {
  row.className = 'color-row';

  const min = param.min !== null ? param.min : 0;
  const max = param.max !== null ? param.max : 1;

  const channels = ['R', 'G', 'B', 'A'];
  const classes = ['color-red', 'color-green', 'color-blue', ''];

  channels.forEach((channel, i) => {
    const subLabel = document.createElement('label');
    subLabel.textContent = channel;
    if (classes[i]) subLabel.className = classes[i];
    row.appendChild(subLabel);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min;
    slider.max = max;
    slider.step = 0.01;
    slider.value = value[i];
    slider.style.width = '50px';

    slider.addEventListener('input', () => {
      const newValue = parseFloat(slider.value);
      const values = state.renderer.getCustomParamValues();
      const fullValue = arrayIndex !== null
        ? [...values[paramName][arrayIndex]]
        : [...values[paramName]];
      fullValue[i] = newValue;
      updateCustomParamValue(paramName, fullValue, arrayIndex);
    });

    row.appendChild(slider);
  });
}

// Create controls for array parameters
function createArrayParamControls(param) {
  const controls = [];

  for (let i = 0; i < param.arraySize; i++) {
    const control = createParamControl(param, i, param.name);
    controls.push(control);
  }

  return controls;
}

// Update a custom parameter value (without regenerating UI)
function updateCustomParamValue(paramName, value, arrayIndex = null) {
  if (!state.renderer) return;

  if (arrayIndex !== null) {
    // Update array element
    const values = state.renderer.getCustomParamValues();
    const arr = values[paramName];
    if (arr && Array.isArray(arr)) {
      arr[arrayIndex] = value;
      state.renderer.setParam(paramName, arr);
    }
  } else {
    state.renderer.setParam(paramName, value);
  }

  // Sync to fullscreen
  const fullValue = arrayIndex !== null
    ? state.renderer.getCustomParamValues()[paramName]
    : value;
  window.electronAPI.sendParamUpdate({ name: paramName, value: fullValue });

  // Route to mixer channel if one is selected, otherwise save to grid slot
  const paramValue = state.renderer.getCustomParamValues()[paramName];
  if (state.mixerSelectedChannel !== null) {
    updateMixerChannelParam(paramName, paramValue);
  } else if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
    const slot = state.gridSlots[state.activeGridSlot];
    if (!slot.customParams) slot.customParams = {};
    slot.customParams[paramName] = paramValue;
    if (slot.renderer?.setParam) {
      slot.renderer.setParam(paramName, paramValue);
    }
    debouncedSaveGridState();
  }

  // Also update selected tile's customParams if in tiled mode
  if (state.tiledPreviewEnabled) {
    const tileIndex = state.selectedTileIndex;
    if (tileIndex >= 0 && tileIndex < tileState.tiles.length) {
      const tile = tileState.tiles[tileIndex];
      if (tile && tile.gridSlotIndex !== null) {
        // Store the param value in the tile's own customParams
        if (!tile.customParams) tile.customParams = {};
        tile.customParams[paramName] = fullValue;

        // Sync tile param to fullscreen
        window.electronAPI.updateTileParam?.(tileIndex, paramName, fullValue);
      }
    }
  }
}

// Load custom param values to UI (after loading a slot or preset)
export function loadCustomParamsToUI() {
  if (!state.renderer || !usingCustomParams) return;

  // Regenerate the UI to reflect current values
  generateCustomParamUI();
}

// Check if currently using custom params
export function isUsingCustomParams() {
  return usingCustomParams;
}
