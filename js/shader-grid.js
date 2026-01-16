// Shader Grid module
import { state } from './state.js';
import { setStatus } from './utils.js';
import { loadParamsToSliders, updateParamLabels, resetParamLabels } from './params.js';
import { updateLocalPresetsUI } from './presets.js';

// Track drag state
let dragSourceIndex = null;

export async function initShaderGrid() {
  const slots = document.querySelectorAll('.grid-slot');

  slots.forEach((slot, index) => {
    const canvas = slot.querySelector('canvas');
    canvas.width = 160;
    canvas.height = 90;

    // Enable dragging
    slot.setAttribute('draggable', 'true');

    // Drag start - store source index
    slot.addEventListener('dragstart', (e) => {
      dragSourceIndex = index;
      slot.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index.toString());
    });

    // Drag end - cleanup
    slot.addEventListener('dragend', () => {
      slot.classList.remove('dragging');
      dragSourceIndex = null;
      // Remove drag-over from all slots
      document.querySelectorAll('.grid-slot.drag-over').forEach(s => {
        s.classList.remove('drag-over');
      });
    });

    // Drag over - allow drop
    slot.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    // Drag enter - visual feedback
    slot.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (dragSourceIndex !== null && dragSourceIndex !== index) {
        slot.classList.add('drag-over');
      }
    });

    // Drag leave - remove visual feedback
    slot.addEventListener('dragleave', (e) => {
      // Only remove if actually leaving the slot (not entering a child)
      if (!slot.contains(e.relatedTarget)) {
        slot.classList.remove('drag-over');
      }
    });

    // Drop - swap slots
    slot.addEventListener('drop', (e) => {
      e.preventDefault();
      slot.classList.remove('drag-over');
      const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (!isNaN(fromIndex) && fromIndex !== index) {
        swapGridSlots(fromIndex, index);
      }
    });

    // Left click - play shader in preview and/or fullscreen
    slot.addEventListener('click', () => {
      if (state.gridSlots[index]) {
        playGridShader(index);
      }
    });

    // Double click - load shader into editor
    slot.addEventListener('dblclick', () => {
      if (state.gridSlots[index]) {
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
    const newRenderer = new MiniShaderRenderer(fromCanvas);
    try {
      newRenderer.compile(data.shaderCode);
      data.renderer = newRenderer;
    } catch (err) {
      console.warn(`Failed to recompile shader for slot ${fromIndex + 1}:`, err);
    }
  }

  if (state.gridSlots[toIndex]) {
    const data = state.gridSlots[toIndex];
    const newRenderer = new MiniShaderRenderer(toCanvas);
    try {
      newRenderer.compile(data.shaderCode);
      data.renderer = newRenderer;
    } catch (err) {
      console.warn(`Failed to recompile shader for slot ${toIndex + 1}:`, err);
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
    slot.title = data.filePath
      ? `Slot ${index + 1}: ${data.filePath.split('/').pop().split('\\').pop()}`
      : `Slot ${index + 1}: Current shader`;
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
    assignShaderToSlot(slotIndex, result.content, result.filePath);
  } else if (result && result.error) {
    setStatus(`Failed to load shader: ${result.error}`, 'error');
  }
}

function assignCurrentShaderToSlot(slotIndex) {
  const shaderCode = state.editor.getValue();
  assignShaderToSlot(slotIndex, shaderCode, null);
}

export async function assignShaderToSlot(slotIndex, shaderCode, filePath, skipSave = false, params = null, presets = null, paramNames = null) {
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  const canvas = slot.querySelector('canvas');

  // Clean up existing renderer
  if (state.gridSlots[slotIndex] && state.gridSlots[slotIndex].renderer) {
    // Just clear the reference
  }

  // Create mini renderer for this slot
  const miniRenderer = new MiniShaderRenderer(canvas);

  // Use provided params or capture current params
  const slotParams = params || state.renderer.getParams();

  try {
    miniRenderer.compile(shaderCode);
    state.gridSlots[slotIndex] = {
      shaderCode,
      filePath,
      renderer: miniRenderer,
      params: { ...slotParams },
      presets: presets || [],
      paramNames: paramNames || {}
    };
    slot.classList.add('has-shader');
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

async function clearGridSlot(slotIndex) {
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  state.gridSlots[slotIndex] = null;
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
  if (state.activeGridSlot === slotIndex) {
    state.activeGridSlot = null;
    updateLocalPresetsUI();
    updateSaveButtonState();
    resetParamLabels();
  }

  setStatus(`Cleared slot ${slotIndex + 1}`, 'success');

  // Save grid state
  saveGridState();
}

export async function saveActiveSlotShader() {
  if (state.activeGridSlot === null) {
    setStatus('No shader slot selected', 'error');
    return;
  }

  if (!state.gridSlots[state.activeGridSlot]) {
    setStatus('No shader in active slot', 'error');
    return;
  }

  const shaderCode = state.editor.getValue();

  // Update the slot's shader code
  state.gridSlots[state.activeGridSlot].shaderCode = shaderCode;

  // Also update the renderer in the slot
  try {
    state.gridSlots[state.activeGridSlot].renderer.compile(shaderCode);
  } catch (err) {
    // Don't fail the save if compilation fails
    console.warn('Shader compilation warning:', err.message);
  }

  // Save to file
  const result = await window.electronAPI.saveShaderToSlot(state.activeGridSlot, shaderCode);
  if (result.success) {
    setStatus(`Shader saved to slot ${state.activeGridSlot + 1}`, 'success');
  } else {
    setStatus(`Failed to save shader: ${result.error}`, 'error');
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
      presets: slot.presets || [],
      paramNames: slot.paramNames || {}
    };
  });
  window.electronAPI.saveGridState(gridState);
}

export async function loadGridState() {
  const gridState = await window.electronAPI.loadGridState();
  if (!gridState || !Array.isArray(gridState)) return;

  let loadedCount = 0;
  for (let i = 0; i < Math.min(gridState.length, 32); i++) {
    if (gridState[i] && gridState[i].shaderCode) {
      try {
        await assignShaderToSlot(i, gridState[i].shaderCode, gridState[i].filePath, true, gridState[i].params, gridState[i].presets, gridState[i].paramNames);
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

export function loadGridPresetsFromData(gridState, filePath) {
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
        assignShaderToSlot(i, gridState[i].shaderCode, gridState[i].filePath, true, gridState[i].params, gridState[i].presets, gridState[i].paramNames);
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

  // Load shader into editor
  state.editor.setValue(slotData.shaderCode, -1);

  // Import compileShader dynamically to avoid circular dependency
  import('./editor.js').then(({ compileShader }) => {
    compileShader();
  });

  // Load params into sliders
  if (slotData.params) {
    loadParamsToSliders(slotData.params);
  }

  // Update parameter labels with custom names
  updateParamLabels(slotData.paramNames);

  // Update local presets UI for this shader
  updateLocalPresetsUI();

  // Update save button state
  updateSaveButtonState();

  const slotName = slotData.filePath ? slotData.filePath.split('/').pop().split('\\').pop() : `slot ${slotIndex + 1}`;
  setStatus(`Editing ${slotName} (slot ${slotIndex + 1})`, 'success');
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

  // Load the slot's params
  if (slotData.params) {
    loadParamsToSliders(slotData.params);
  }

  // Update parameter labels with custom names
  updateParamLabels(slotData.paramNames);

  // Update local presets UI for this shader
  updateLocalPresetsUI();

  // Update save button state
  updateSaveButtonState();

  // Show in preview if enabled
  if (state.previewEnabled) {
    try {
      state.renderer.compile(slotData.shaderCode);
      state.renderer.resetTime();
    } catch (err) {
      setStatus(`Failed to compile shader: ${err.message}`, 'error');
      return;
    }
  }

  // Send to fullscreen window (if open)
  const fullscreenState = {
    shaderCode: slotData.shaderCode,
    time: 0,
    frame: 0,
    isPlaying: true,
    channels: state.channelState,
    params: slotData.params || state.renderer.getParams()
  };
  window.electronAPI.sendShaderUpdate(fullscreenState);
  window.electronAPI.sendTimeSync({ time: 0, frame: 0, isPlaying: true });

  // Send all params to fullscreen
  if (slotData.params) {
    Object.entries(slotData.params).forEach(([name, value]) => {
      window.electronAPI.sendParamUpdate({ name, value });
    });
  }

  const slotName = slotData.filePath ? slotData.filePath.split('/').pop().split('\\').pop() : `slot ${slotIndex + 1}`;
  setStatus(`Playing ${slotName}`, 'success');
}

// Grid animation frame rate limiting (10fps = 100ms interval)
const GRID_FRAME_INTERVAL = 100;
let lastGridFrameTime = 0;

// Track which slots are visible using IntersectionObserver
const visibleSlots = new Set();
let gridIntersectionObserver = null;

function initGridVisibilityObserver() {
  if (gridIntersectionObserver) return;

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

  function animateGrid(currentTime) {
    state.gridAnimationId = requestAnimationFrame(animateGrid);

    // Limit to 10fps to save CPU/GPU
    if (currentTime - lastGridFrameTime < GRID_FRAME_INTERVAL) {
      return;
    }
    lastGridFrameTime = currentTime;

    // Only render slots that are currently visible
    for (const slotIndex of visibleSlots) {
      const slot = state.gridSlots[slotIndex];
      if (slot && slot.renderer) {
        slot.renderer.setParams(slot.params);
        slot.renderer.render();
      }
    }
  }
  animateGrid(performance.now());
}

export function stopGridAnimation() {
  if (state.gridAnimationId) {
    cancelAnimationFrame(state.gridAnimationId);
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
    this.params = null; // Will store slot params

    // Pre-allocated buffers to avoid GC pressure during render
    this._colorArray = new Float32Array(30);  // 10 colors * 3 components
    this._paramsArray = new Float32Array(5);  // 5 custom params

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

    // Use pre-allocated color array
    for (let i = 0; i < 10; i++) {
      this._colorArray[i * 3 + 0] = this.params?.[`r${i}`] ?? 1.0;
      this._colorArray[i * 3 + 1] = this.params?.[`g${i}`] ?? 1.0;
      this._colorArray[i * 3 + 2] = this.params?.[`b${i}`] ?? 1.0;
    }
    gl.uniform3fv(this.uniforms.iColorRGB, this._colorArray);

    // Use pre-allocated params array
    this._paramsArray[0] = this.params?.p0 ?? 0.5;
    this._paramsArray[1] = this.params?.p1 ?? 0.5;
    this._paramsArray[2] = this.params?.p2 ?? 0.5;
    this._paramsArray[3] = this.params?.p3 ?? 0.5;
    this._paramsArray[4] = this.params?.p4 ?? 0.5;
    gl.uniform1fv(this.uniforms.iParams, this._paramsArray);

    gl.uniform1f(this.uniforms.iSpeed, speed);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
