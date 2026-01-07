// Parameters module
import { state } from './state.js';
import { setStatus } from './utils.js';
import { saveGridState } from './shader-grid.js';

// Default parameter names
const defaultParamNames = {
  p0: 'P0', p1: 'P1', p2: 'P2', p3: 'P3', p4: 'P4',
  c0: 'C0', c1: 'C1', c2: 'C2', c3: 'C3', c4: 'C4',
  c5: 'C5', c6: 'C6', c7: 'C7', c8: 'C8', c9: 'C9'
};

export function initParams() {
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
      state.renderer.setParam(name, value);
      valueDisplay.textContent = value.toFixed(2);

      // Sync to fullscreen
      window.electronAPI.sendParamUpdate({ name, value });

      // Save to active grid slot if one is selected
      if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
        state.gridSlots[state.activeGridSlot].params[name] = value;
        saveGridState();
      }
    });

    // Double-click to reset to default
    slider.addEventListener('dblclick', () => {
      slider.value = defaults[name];
      state.renderer.setParam(name, defaults[name]);
      if (valueDisplay) valueDisplay.textContent = defaults[name].toFixed(2);
      window.electronAPI.sendParamUpdate({ name, value: defaults[name] });
    });
  });

  // Reset button handler
  const resetBtn = document.getElementById('btn-reset-params');
  resetBtn.addEventListener('click', () => resetParamsP0P4ToDefault());

  // P0-P4 section reset buttons
  document.getElementById('btn-params-zero').addEventListener('click', () => resetParamsP0P4(0));
  document.getElementById('btn-params-full').addEventListener('click', () => resetParamsP0P4(1));

  // Colors section reset buttons
  document.getElementById('btn-colors-zero').addEventListener('click', () => resetAllColors(0));
  document.getElementById('btn-colors-full').addEventListener('click', () => resetAllColors(1));

  // Add min/max buttons to color sliders
  addColorSliderButtons();

  // Init parameter label editing
  initParamLabelEditing();
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
  state.renderer.setParam(paramName, value);
  window.electronAPI.sendParamUpdate({ name: paramName, value });

  // Update active grid slot
  if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
    state.gridSlots[state.activeGridSlot].params[paramName] = value;
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
    state.renderer.setParam(paramName, targetValue);
    if (valueDisplay) valueDisplay.textContent = targetValue.toFixed(2);
    window.electronAPI.sendParamUpdate({ name: paramName, value: targetValue });

    // Update active grid slot
    if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
      state.gridSlots[state.activeGridSlot].params[paramName] = targetValue;
    }
  }

  if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
    saveGridState();
  }

  setStatus(`P0-P4 set to ${value === 0 ? 'minimum' : 'maximum'}`, 'success');
}

function resetParamsP0P4ToDefault() {
  const defaultValue = 0.5;
  for (let i = 0; i < 5; i++) {
    const paramName = `p${i}`;
    const slider = document.getElementById(`param-p${i}`);
    const valueDisplay = document.getElementById(`param-p${i}-value`);

    if (!slider) continue;

    slider.value = defaultValue;
    state.renderer.setParam(paramName, defaultValue);
    if (valueDisplay) valueDisplay.textContent = defaultValue.toFixed(2);
    window.electronAPI.sendParamUpdate({ name: paramName, value: defaultValue });

    if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
      state.gridSlots[state.activeGridSlot].params[paramName] = defaultValue;
    }
  }

  if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
    saveGridState();
  }

  setStatus('P0-P4 reset to default', 'success');
}

function resetAllColors(value) {
  for (let i = 0; i < 10; i++) {
    ['r', 'g', 'b'].forEach(channel => {
      const paramName = `${channel}${i}`;
      const sliderId = `param-${channel}${i}`;
      const slider = document.getElementById(sliderId);

      if (slider) {
        slider.value = value;
        state.renderer.setParam(paramName, value);
        window.electronAPI.sendParamUpdate({ name: paramName, value });

        // Update active grid slot
        if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
          state.gridSlots[state.activeGridSlot].params[paramName] = value;
        }
      }
    });
  }

  if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
    saveGridState();
  }

  setStatus(`All colors set to ${value}`, 'success');
}

export function resetAllParams(defaults) {
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
      state.renderer.setParam(name, value);
      if (valueDisplay) valueDisplay.textContent = value.toFixed(2);
      window.electronAPI.sendParamUpdate({ name, value });
    }
  });

  // Update active grid slot if selected
  if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
    state.gridSlots[state.activeGridSlot].params = { ...defaults };
    saveGridState();
  }

  setStatus('Parameters reset to defaults', 'success');
}

export function initMouseAssignment() {
  // Setup mouse tracking on canvas
  const canvas = document.getElementById('shader-canvas');
  const canvasContainer = document.getElementById('preview-canvas-container');

  canvasContainer.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    state.mousePosition.x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    state.mousePosition.y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height)); // Invert Y
    updateMouseControlledParams();
  });

  // Setup dropdowns for P0-P4
  for (let i = 0; i < 5; i++) {
    const select = document.getElementById(`mouse-p${i}`);
    const paramRow = select.closest('.param-row');

    select.addEventListener('change', () => {
      state.mouseAssignments[`p${i}`] = select.value;

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
    const assignment = state.mouseAssignments[`p${i}`];
    if (!assignment) continue;

    const value = assignment === 'x' ? state.mousePosition.x : state.mousePosition.y;
    const slider = document.getElementById(`param-p${i}`);
    const valueDisplay = document.getElementById(`param-p${i}-value`);

    slider.value = value;
    valueDisplay.textContent = value.toFixed(2);
    state.renderer.setParam(`p${i}`, value);
    window.electronAPI.sendParamUpdate({ name: `p${i}`, value });

    // Update grid slot if active
    if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
      state.gridSlots[state.activeGridSlot].params[`p${i}`] = value;
    }
  }
}

export function loadParamsToSliders(params) {
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
        state.renderer.setParam(name, params[name]);
      }
    }
  });
}

export function applyParamRanges() {
  for (let i = 0; i < 5; i++) {
    const slider = document.getElementById(`param-p${i}`);
    const range = state.paramRanges[`p${i}`];
    if (slider && range) {
      slider.min = range.min;
      slider.max = range.max;
      slider.step = (range.max - range.min) / 100;
    }
  }
}

function initParamLabelEditing() {
  // P0-P4 labels
  for (let i = 0; i < 5; i++) {
    const label = document.getElementById(`label-p${i}`);
    if (label) {
      label.addEventListener('dblclick', () => startLabelEdit(label, `p${i}`));
    }
  }

  // C0-C9 labels
  for (let i = 0; i < 10; i++) {
    const label = document.getElementById(`label-c${i}`);
    if (label) {
      label.addEventListener('dblclick', () => startLabelEdit(label, `c${i}`));
    }
  }
}

function startLabelEdit(label, paramKey) {
  // Only allow editing when a grid slot is active
  if (state.activeGridSlot === null || !state.gridSlots[state.activeGridSlot]) {
    setStatus('Select a shader slot first to customize parameter names', 'info');
    return;
  }

  const slot = state.gridSlots[state.activeGridSlot];
  const currentName = label.textContent;

  // Create input element
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'param-name-input';
  input.value = currentName;
  input.maxLength = 8;

  // Replace label content with input
  label.textContent = '';
  label.appendChild(input);
  label.classList.add('editing');

  // Focus and select all text
  input.focus();
  input.select();

  const finishEdit = (save) => {
    const newName = input.value.trim() || defaultParamNames[paramKey];
    label.classList.remove('editing');
    label.textContent = newName;

    if (save && newName !== defaultParamNames[paramKey]) {
      // Save custom name to slot
      if (!slot.paramNames) slot.paramNames = {};
      slot.paramNames[paramKey] = newName;
      label.classList.add('custom-name');
      saveGridState();
      setStatus(`Renamed ${paramKey.toUpperCase()} to "${newName}"`, 'success');
    } else if (save && newName === defaultParamNames[paramKey]) {
      // Revert to default
      if (slot.paramNames) delete slot.paramNames[paramKey];
      label.classList.remove('custom-name');
      saveGridState();
    } else {
      // Cancelled - restore previous name
      label.textContent = currentName;
      if (slot.paramNames && slot.paramNames[paramKey]) {
        label.classList.add('custom-name');
      }
    }
  };

  input.addEventListener('blur', () => finishEdit(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishEdit(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finishEdit(false);
    }
  });
}

export function updateParamLabels(paramNames) {
  // Update P0-P4 labels
  for (let i = 0; i < 5; i++) {
    const label = document.getElementById(`label-p${i}`);
    if (label) {
      const customName = paramNames && paramNames[`p${i}`];
      label.textContent = customName || defaultParamNames[`p${i}`];
      label.classList.toggle('custom-name', !!customName);
    }
  }

  // Update C0-C9 labels
  for (let i = 0; i < 10; i++) {
    const label = document.getElementById(`label-c${i}`);
    if (label) {
      const customName = paramNames && paramNames[`c${i}`];
      label.textContent = customName || defaultParamNames[`c${i}`];
      label.classList.toggle('custom-name', !!customName);
    }
  }
}

export function resetParamLabels() {
  // Reset all labels to defaults
  updateParamLabels(null);
}
