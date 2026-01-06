// Parameters module
import { state } from './state.js';
import { setStatus } from './utils.js';
import { saveGridState } from './shader-grid.js';

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
