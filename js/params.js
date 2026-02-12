// Parameters module - Custom shader parameter UI
import { state } from './state.js';
import { setStatus } from './utils.js';
import { saveGridState } from './shader-grid.js';
import { tileState } from './tile-state.js';
import { updateMixerChannelParam } from './mixer.js';
import { parseShaderParams } from './param-parser.js';
import { ASSET_PARAM_DEFS, VIDEO_PARAM_DEFS } from './asset-renderer.js';

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

// Drag-and-drop state for color pickers
let draggedColor = null;

// Right-click drag state for color swap
let rightDragState = null; // { rgb, paramName, arrayIndex, sourcePicker }
let rightDragTarget = null;

function initRightDragListeners() {
  document.addEventListener('mousemove', (e) => {
    if (!rightDragState) return;
    // Find color picker under cursor
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const picker = el?.closest?.('.color-picker-input');
    if (picker !== rightDragTarget) {
      rightDragTarget?.classList.remove('color-swap-target');
      rightDragTarget = (picker && picker !== rightDragState.sourcePicker) ? picker : null;
      rightDragTarget?.classList.add('color-swap-target');
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (!rightDragState || e.button !== 2) return;
    const source = rightDragState;
    source.sourcePicker.classList.remove('color-dragging');

    if (rightDragTarget) {
      rightDragTarget.classList.remove('color-swap-target');
      // Read target's current color, apply source color to target, target color to source
      const targetRgb = hexToRgb(rightDragTarget.value);
      const sourceRgb = [...source.rgb];

      // Apply source → target (via target's own update callback)
      rightDragTarget._colorSwapApply(sourceRgb);
      // Apply target → source
      source.sourcePicker._colorSwapApply(targetRgb);
    }

    rightDragState = null;
    rightDragTarget = null;
  });
}

let rightDragListenersInit = false;

// Multi-select state for color pickers
const selectedColorPickers = new Set();

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
    // Double-click label to reset speed to default (1)
    const speedLabel = speedSlider.closest('.param-row')?.querySelector('label');
    if (speedLabel) {
      speedLabel.style.cursor = 'pointer';
      speedLabel.title = 'Double-click to reset';
      speedLabel.addEventListener('dblclick', () => {
        speedSlider.value = 1;
        state.renderer.setParam('speed', 1);
        speedValue.textContent = '1.00';
        window.electronAPI.sendParamUpdate({ name: 'speed', value: 1 });
        if (state.mixerSelectedChannel !== null) {
          updateMixerChannelParam('speed', 1);
        } else {
          syncSpeedToActiveSlot(1);
        }
        updateSelectedTileParam('speed', 1);
      });
    }

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

    // Click on free area in params panel clears color multi-select
    const paramsPanel = document.getElementById('params-panel');
    if (paramsPanel) {
      paramsPanel.addEventListener('click', (e) => {
        if (selectedColorPickers.size === 0) return;
        if (e.target.closest('.color-picker-input')) return;
        for (const picker of selectedColorPickers) {
          picker.classList.remove('color-selected');
        }
        selectedColorPickers.clear();
      });
    }

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

  // Keyboard shortcuts for color multi-select
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || !e.altKey) return;
    const code = e.code;
    if (code !== 'KeyA' && code !== 'KeyE' && code !== 'KeyO') return;
    const key = code.charAt(3).toLowerCase();

    e.preventDefault();
    const container = document.getElementById('custom-params-container');
    if (!container) return;

    const pickers = [...container.querySelectorAll('.color-picker-input')];
    if (pickers.length === 0) return;

    // Clear current selection
    for (const picker of selectedColorPickers) {
      picker.classList.remove('color-selected');
    }
    selectedColorPickers.clear();

    // Select based on shortcut
    pickers.forEach((picker, i) => {
      const select = key === 'a'
        || (key === 'e' && i % 2 === 1)
        || (key === 'o' && i % 2 === 0);
      if (select) {
        selectedColorPickers.add(picker);
        picker.classList.add('color-selected');
      }
    });
  });
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

  if (!container) return;

  // If mixer is active with assigned channels, show multi-channel view
  if (state.mixerEnabled && state.mixerChannels.some(ch =>
    ch.renderer || (ch.slotIndex !== null && ch.tabIndex !== null)
  )) {
    generateMixerParamsUI(container);
    return;
  }

  // Check if the active grid slot is an asset (non-mixer case)
  const activeSlot = state.activeGridSlot !== null ? state.gridSlots[state.activeGridSlot] : null;
  if (activeSlot && activeSlot.type?.startsWith('asset-') && activeSlot.renderer) {
    generateAssetParamUI(container, activeSlot);
    return;
  }

  if (!state.renderer) return;

  // Get custom param definitions from the shader
  const params = state.renderer.getCustomParamDefs();

  // Clear existing custom UI
  selectedColorPickers.clear();
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
  label.style.cursor = 'pointer';
  label.addEventListener('dblclick', () => {
    const defaultVal = index !== null ? param.default[index] : param.default;
    updateCustomParamValue(paramName, defaultVal, index);
    generateCustomParamUI();
  });
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

  // Ctrl+click to toggle multi-select, normal click on selected opens picker for all
  colorPicker.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      if (selectedColorPickers.has(colorPicker)) {
        selectedColorPickers.delete(colorPicker);
        colorPicker.classList.remove('color-selected');
      } else {
        selectedColorPickers.add(colorPicker);
        colorPicker.classList.add('color-selected');
      }
    }
  });

  // Color picker change handler — propagate to all selected pickers
  colorPicker.addEventListener('input', () => {
    const rgb = hexToRgb(colorPicker.value);
    // Update own sliders
    sliders.forEach((slider, i) => {
      slider.value = rgb[i];
    });
    updateCustomParamValue(paramName, rgb, arrayIndex);

    // Apply to all other selected pickers
    if (selectedColorPickers.has(colorPicker)) {
      for (const picker of selectedColorPickers) {
        if (picker === colorPicker) continue;
        picker._colorSwapApply(rgb);
      }
    }
  });

  // Swap apply callback (used by right-click drag swap and multi-select)
  colorPicker._colorSwapApply = (rgb) => {
    colorPicker.value = rgbToHex(rgb[0], rgb[1], rgb[2]);
    sliders.forEach((slider, i) => { slider.value = rgb[i]; });
    updateCustomParamValue(paramName, rgb, arrayIndex);
  };

  // Right-click drag to swap colors
  if (!rightDragListenersInit) {
    initRightDragListeners();
    rightDragListenersInit = true;
  }
  colorPicker.addEventListener('contextmenu', (e) => e.preventDefault());
  colorPicker.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    e.preventDefault();
    const values = state.renderer.getCustomParamValues();
    const rgb = arrayIndex !== null ? [...values[paramName][arrayIndex]] : [...values[paramName]];
    rightDragState = { rgb, paramName, arrayIndex, sourcePicker: colorPicker };
    colorPicker.classList.add('color-dragging');
  });

  // Left-click drag-and-drop: copy color from one picker to another
  colorPicker.draggable = true;
  colorPicker.addEventListener('dragstart', (e) => {
    const values = state.renderer.getCustomParamValues();
    const rgb = arrayIndex !== null ? [...values[paramName][arrayIndex]] : [...values[paramName]];
    draggedColor = rgb;
    e.dataTransfer.effectAllowed = 'copy';
    colorPicker.classList.add('color-dragging');
  });
  colorPicker.addEventListener('dragend', () => {
    draggedColor = null;
    colorPicker.classList.remove('color-dragging');
  });
  colorPicker.addEventListener('dragover', (e) => {
    if (draggedColor) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      colorPicker.classList.add('color-drop-target');
    }
  });
  colorPicker.addEventListener('dragleave', () => {
    colorPicker.classList.remove('color-drop-target');
  });
  colorPicker.addEventListener('drop', (e) => {
    e.preventDefault();
    colorPicker.classList.remove('color-drop-target');
    if (!draggedColor) return;
    const rgb = [...draggedColor];
    colorPicker.value = rgbToHex(rgb[0], rgb[1], rgb[2]);
    sliders.forEach((slider, i) => { slider.value = rgb[i]; });
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

// =============================================================================
// Mixer Multi-Channel Parameter UI
// =============================================================================

// Channel accent colors for visual distinction
const MIXER_CHANNEL_COLORS = [
  '#4a9eff', '#ff6b6b', '#51cf66', '#ffd43b',
  '#cc5de8', '#ff922b', '#22b8cf', '#ff8787'
];

// Generate multi-channel param UI for all active mixer channels
// Generate param UI for a standalone asset slot (not in mixer)
function generateAssetParamUI(container, slotData) {
  selectedColorPickers.clear();
  container.innerHTML = '';
  usingCustomParams = true;

  const renderer = slotData.renderer;
  if (!renderer) return;

  const params = renderer.getCustomParamDefs();
  if (params.length === 0) return;

  const section = createParamSection(`Asset: ${slotData.label || slotData.mediaPath || 'untitled'}`);

  params.forEach(param => {
    const row = document.createElement('div');
    row.className = 'param-row';

    const label = document.createElement('label');
    label.textContent = param.name;
    if (param.description) label.title = param.description;
    row.appendChild(label);

    const currentValue = slotData.customParams?.[param.name] !== undefined
      ? slotData.customParams[param.name]
      : param.default;

    const isInt = param.type === 'int';
    const min = param.min !== undefined ? param.min : 0;
    const max = param.max !== undefined ? param.max : (isInt ? 10 : 1);
    const step = param.step || (isInt ? 1 : 0.01);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min;
    slider.max = max;
    slider.step = step;
    slider.value = currentValue;

    const valueDisplay = document.createElement('span');
    valueDisplay.className = 'param-value';
    valueDisplay.textContent = isInt ? Math.round(currentValue).toString() : Number(currentValue).toFixed(2);

    slider.addEventListener('input', () => {
      const newValue = isInt ? parseInt(slider.value, 10) : parseFloat(slider.value);
      valueDisplay.textContent = isInt ? newValue.toString() : newValue.toFixed(2);
      // Update the renderer and slot data
      renderer.setParam(param.name, newValue);
      if (slotData.customParams) slotData.customParams[param.name] = newValue;
      debouncedSaveGridState();
    });

    slider.addEventListener('dblclick', () => {
      slider.value = param.default;
      valueDisplay.textContent = isInt ? Math.round(param.default).toString() : Number(param.default).toFixed(2);
      renderer.setParam(param.name, param.default);
      if (slotData.customParams) slotData.customParams[param.name] = param.default;
      debouncedSaveGridState();
    });

    row.appendChild(slider);
    row.appendChild(valueDisplay);
    section.appendChild(row);
  });

  container.appendChild(section);
}

function generateMixerParamsUI(container) {
  selectedColorPickers.clear();
  container.innerHTML = '';
  usingCustomParams = true;

  for (let i = 0; i < state.mixerChannels.length; i++) {
    const ch = state.mixerChannels[i];

    // Skip unassigned channels
    const hasSource = ch.renderer || (ch.slotIndex !== null && ch.tabIndex !== null);
    if (!hasSource) continue;

    // Check if this channel is an asset
    let slotData = null;
    if (ch.slotIndex !== null && ch.tabIndex !== null) {
      const tab = state.shaderTabs[ch.tabIndex];
      slotData = tab?.slots?.[ch.slotIndex] || null;
    }
    const isAsset = ch.assetType || slotData?.type?.startsWith('asset-');

    let params;
    if (isAsset) {
      // Use static asset param definitions
      const isVideo = ch.assetType === 'asset-video' || slotData?.type === 'asset-video';
      params = isVideo ? [...ASSET_PARAM_DEFS, ...VIDEO_PARAM_DEFS] : [...ASSET_PARAM_DEFS];
    } else {
      // Get shader code and parse @param definitions
      let shaderCode = ch.shaderCode;
      if (!shaderCode && slotData) {
        shaderCode = slotData.shaderCode || null;
      }
      if (!shaderCode) continue;

      params = parseShaderParams(shaderCode);
      if (params.length === 0) continue;
    }

    // Determine channel label
    let filename = null;
    if (slotData) {
      filename = isAsset
        ? (slotData.label || slotData.mediaPath)
        : slotData.filePath?.split('/').pop();
    }
    const label = `Ch ${i + 1}: ${filename || (isAsset ? 'Asset' : 'Mix Preset')}`;
    const accentColor = MIXER_CHANNEL_COLORS[i % MIXER_CHANNEL_COLORS.length];

    // Create channel section
    const section = document.createElement('div');
    section.className = 'params-section mixer-channel-section';
    section.style.borderLeftColor = accentColor;

    const titleEl = document.createElement('div');
    titleEl.className = 'params-section-title mixer-channel-title';
    titleEl.textContent = label;
    titleEl.style.color = accentColor;

    // Highlight if this is the selected channel
    if (state.mixerSelectedChannel === i) {
      section.classList.add('mixer-channel-selected');
    }

    // Click title to select this channel
    titleEl.style.cursor = 'pointer';
    titleEl.addEventListener('click', () => {
      // Import dynamically to avoid circular dep issues at module load
      const btns = document.querySelectorAll('#mixer-channels .mixer-btn');
      btns.forEach(b => b.classList.remove('selected'));
      btns[i]?.classList.add('selected');
      state.mixerSelectedChannel = i;

      // Update selected styling
      container.querySelectorAll('.mixer-channel-section').forEach(s =>
        s.classList.remove('mixer-channel-selected')
      );
      section.classList.add('mixer-channel-selected');
    });

    section.appendChild(titleEl);

    // Group parameters: scalars first, then arrays
    const scalarParams = params.filter(p => !p.isArray);
    const arrayParams = params.filter(p => p.isArray);

    scalarParams.forEach(param => {
      const control = createMixerParamControl(param, i, ch, null, null);
      if (control) section.appendChild(control);
    });

    arrayParams.forEach(param => {
      const arrayTitle = document.createElement('div');
      arrayTitle.className = 'params-section-title';
      arrayTitle.textContent = param.description || param.name;
      arrayTitle.style.marginTop = '8px';
      section.appendChild(arrayTitle);
      for (let ai = 0; ai < param.arraySize; ai++) {
        const control = createMixerParamControl(param, i, ch, ai, param.name);
        if (control) section.appendChild(control);
      }
    });

    container.appendChild(section);
  }
}

// Create a single parameter control wired to a specific mixer channel
function createMixerParamControl(param, channelIndex, ch, arrayIndex, arrayName) {
  const row = document.createElement('div');
  row.className = 'param-row';

  const paramName = arrayName || param.name;

  // Label
  const label = document.createElement('label');
  label.textContent = arrayIndex !== null ? `${arrayIndex}` : param.name;
  if (param.description && arrayIndex === null) {
    label.title = param.description;
  }
  label.style.cursor = 'pointer';
  label.addEventListener('dblclick', () => {
    const defaultVal = arrayIndex !== null ? param.default[arrayIndex] : param.default;
    updateMixerChannelParamDirect(channelIndex, paramName, defaultVal, arrayIndex);
    generateCustomParamUI();
  });
  row.appendChild(label);

  // Get current value from channel's customParams
  let currentValue;
  if (arrayIndex !== null) {
    const arr = ch.customParams[paramName];
    currentValue = arr ? arr[arrayIndex] : param.default[arrayIndex];
  } else {
    currentValue = ch.customParams[paramName] !== undefined
      ? ch.customParams[paramName]
      : param.default;
  }

  // Create appropriate control based on type
  switch (param.type) {
    case 'int':
    case 'float':
      createMixerSliderControl(row, param, currentValue, paramName, arrayIndex, channelIndex, ch);
      break;
    case 'vec2':
      createMixerVec2Control(row, param, currentValue, paramName, arrayIndex, channelIndex, ch);
      break;
    case 'color':
      createMixerColorControl(row, param, currentValue, paramName, arrayIndex, channelIndex, ch);
      break;
    case 'vec3':
      createMixerVec3Control(row, param, currentValue, paramName, arrayIndex, channelIndex, ch);
      break;
    case 'vec4':
      createMixerVec4Control(row, param, currentValue, paramName, arrayIndex, channelIndex, ch);
      break;
  }

  return row;
}

// Mixer-specific slider control
function createMixerSliderControl(row, param, value, paramName, arrayIndex, channelIndex, ch) {
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
    updateMixerChannelParamDirect(channelIndex, paramName, newValue, arrayIndex);
  });

  slider.addEventListener('dblclick', () => {
    const defaultVal = arrayIndex !== null ? param.default[arrayIndex] : param.default;
    slider.value = defaultVal;
    valueDisplay.textContent = isInt ? Math.round(defaultVal).toString() : defaultVal.toFixed(2);
    updateMixerChannelParamDirect(channelIndex, paramName, defaultVal, arrayIndex);
  });

  makeValueEditable(valueDisplay, slider, {
    isInt,
    onCommit(newValue) {
      valueDisplay.textContent = isInt ? newValue.toString() : newValue.toFixed(2);
      updateMixerChannelParamDirect(channelIndex, paramName, newValue, arrayIndex);
    }
  });

  row.appendChild(slider);
  row.appendChild(valueDisplay);
}

// Mixer-specific vec2 control
function createMixerVec2Control(row, param, value, paramName, arrayIndex, channelIndex, ch) {
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
      const fullValue = getMixerParamValue(ch, paramName, arrayIndex);
      fullValue[i] = newValue;
      updateMixerChannelParamDirect(channelIndex, paramName, fullValue, arrayIndex);
    });

    makeValueEditable(valueDisplay, slider, {
      isInt: false,
      onCommit(newValue) {
        valueDisplay.textContent = newValue.toFixed(2);
        const fullValue = getMixerParamValue(ch, paramName, arrayIndex);
        fullValue[i] = newValue;
        updateMixerChannelParamDirect(channelIndex, paramName, fullValue, arrayIndex);
      }
    });

    row.appendChild(slider);
    row.appendChild(valueDisplay);
  });
}

// Mixer-specific color control
function createMixerColorControl(row, param, value, paramName, arrayIndex, channelIndex, ch) {
  row.className = 'color-row color-picker-row';

  const colorPicker = document.createElement('input');
  colorPicker.type = 'color';
  colorPicker.className = 'color-picker-input';
  colorPicker.value = rgbToHex(value[0], value[1], value[2]);
  colorPicker.title = 'Click to pick color';

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
      const fullValue = getMixerParamValue(ch, paramName, arrayIndex);
      fullValue[i] = parseFloat(slider.value);
      colorPicker.value = rgbToHex(fullValue[0], fullValue[1], fullValue[2]);
      updateMixerChannelParamDirect(channelIndex, paramName, fullValue, arrayIndex);
    });

    sliderWrapper.appendChild(slider);
    slidersDiv.appendChild(sliderWrapper);
  });

  colorPicker.addEventListener('input', () => {
    const rgb = hexToRgb(colorPicker.value);
    sliders.forEach((slider, i) => { slider.value = rgb[i]; });
    updateMixerChannelParamDirect(channelIndex, paramName, rgb, arrayIndex);
  });

  // Swap apply callback for drag-and-drop / multi-select
  colorPicker._colorSwapApply = (rgb) => {
    colorPicker.value = rgbToHex(rgb[0], rgb[1], rgb[2]);
    sliders.forEach((slider, i) => { slider.value = rgb[i]; });
    updateMixerChannelParamDirect(channelIndex, paramName, rgb, arrayIndex);
  };

  // Ctrl+click to toggle multi-select
  colorPicker.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      if (selectedColorPickers.has(colorPicker)) {
        selectedColorPickers.delete(colorPicker);
        colorPicker.classList.remove('color-selected');
      } else {
        selectedColorPickers.add(colorPicker);
        colorPicker.classList.add('color-selected');
      }
    }
  });

  // Right-click drag swap
  if (!rightDragListenersInit) {
    initRightDragListeners();
    rightDragListenersInit = true;
  }
  colorPicker.addEventListener('contextmenu', (e) => e.preventDefault());
  colorPicker.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    e.preventDefault();
    const rgb = getMixerParamValue(ch, paramName, arrayIndex);
    rightDragState = { rgb: [...rgb], paramName, arrayIndex, sourcePicker: colorPicker };
    colorPicker.classList.add('color-dragging');
  });

  // Left-click drag-and-drop
  colorPicker.draggable = true;
  colorPicker.addEventListener('dragstart', (e) => {
    const rgb = getMixerParamValue(ch, paramName, arrayIndex);
    draggedColor = [...rgb];
    e.dataTransfer.effectAllowed = 'copy';
    colorPicker.classList.add('color-dragging');
  });
  colorPicker.addEventListener('dragend', () => {
    draggedColor = null;
    colorPicker.classList.remove('color-dragging');
  });
  colorPicker.addEventListener('dragover', (e) => {
    if (draggedColor) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      colorPicker.classList.add('color-drop-target');
    }
  });
  colorPicker.addEventListener('dragleave', () => {
    colorPicker.classList.remove('color-drop-target');
  });
  colorPicker.addEventListener('drop', (e) => {
    e.preventDefault();
    colorPicker.classList.remove('color-drop-target');
    if (!draggedColor) return;
    const rgb = [...draggedColor];
    colorPicker.value = rgbToHex(rgb[0], rgb[1], rgb[2]);
    sliders.forEach((slider, i) => { slider.value = rgb[i]; });
    updateMixerChannelParamDirect(channelIndex, paramName, rgb, arrayIndex);
  });

  row.appendChild(colorPicker);
  row.appendChild(slidersDiv);
}

// Mixer-specific vec3 control
function createMixerVec3Control(row, param, value, paramName, arrayIndex, channelIndex, ch) {
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
      const fullValue = getMixerParamValue(ch, paramName, arrayIndex);
      fullValue[i] = parseFloat(slider.value);
      updateMixerChannelParamDirect(channelIndex, paramName, fullValue, arrayIndex);
    });

    row.appendChild(slider);
  });
}

// Mixer-specific vec4 control
function createMixerVec4Control(row, param, value, paramName, arrayIndex, channelIndex, ch) {
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
      const fullValue = getMixerParamValue(ch, paramName, arrayIndex);
      fullValue[i] = parseFloat(slider.value);
      updateMixerChannelParamDirect(channelIndex, paramName, fullValue, arrayIndex);
    });

    row.appendChild(slider);
  });
}

// Helper: get a copy of the current param value from a mixer channel's customParams
function getMixerParamValue(ch, paramName, arrayIndex) {
  const val = ch.customParams[paramName];
  if (arrayIndex !== null && Array.isArray(val)) {
    return Array.isArray(val[arrayIndex]) ? [...val[arrayIndex]] : val[arrayIndex];
  }
  return Array.isArray(val) ? [...val] : val;
}

// Update a specific mixer channel's parameter value directly
function updateMixerChannelParamDirect(channelIndex, paramName, value, arrayIndex) {
  const ch = state.mixerChannels[channelIndex];
  if (!ch) return;

  // Write to channel's customParams
  if (arrayIndex !== null) {
    if (!ch.customParams[paramName]) ch.customParams[paramName] = [];
    ch.customParams[paramName][arrayIndex] = value;
  } else {
    ch.customParams[paramName] = value;
  }

  // Get the full param value for IPC (entire array for array params)
  const fullValue = ch.customParams[paramName];

  // Sync to fullscreen via IPC
  window.electronAPI.sendMixerParamUpdate({ channelIndex, paramName, value: fullValue });

  // Update mini renderer in grid slot (for local compositing)
  if (ch.slotIndex !== null && ch.tabIndex !== null) {
    const tab = state.shaderTabs[ch.tabIndex];
    const slotData = tab?.slots?.[ch.slotIndex];
    if (slotData?.renderer?.setParam) {
      slotData.renderer.setParam(paramName, fullValue);
    }
  }

  // If this channel is the selected one and its shader is compiled in the main renderer,
  // also update the main renderer so the preview reflects the change
  if (state.mixerSelectedChannel === channelIndex && state.renderer) {
    state.renderer.setParam(paramName, fullValue);
    window.electronAPI.sendParamUpdate({ name: paramName, value: fullValue });
  }

  debouncedSaveGridState();
}
