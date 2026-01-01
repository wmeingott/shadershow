// Global state
let editor;
let renderer;
let compileTimeout;
let animationId;
let previewEnabled = true;
let gridEnabled = false;
let ndiEnabled = false;
let ndiFrameCounter = 0;

// Track channel state for fullscreen sync
let channelState = [null, null, null, null];

// Shader grid state
const gridSlots = new Array(16).fill(null); // { shaderCode, filePath, renderer, params }
let gridAnimationId = null;
let activeGridSlot = null; // Track which slot is being edited

// Initialize application
document.addEventListener('DOMContentLoaded', async () => {
  initEditor();
  initRenderer();
  initControls();
  initParams();
  initResizer();
  initIPC();
  initShaderGrid();

  // Load default shader
  const defaultShader = await window.electronAPI.getDefaultShader();
  editor.setValue(defaultShader, -1);
  compileShader();

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
    exec: () => window.electronAPI.saveContent(editor.getValue())
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
      valueDisplay.textContent = defaults[name].toFixed(2);
      window.electronAPI.sendParamUpdate({ name, value: defaults[name] });
    });
  });
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
    }
  });
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
  window.electronAPI.onNDIStatus(({ enabled, port }) => {
    ndiEnabled = enabled;
    if (enabled) {
      setStatus(`NDI output started on port ${port}`, 'success');
    } else {
      setStatus('NDI output stopped', 'success');
    }
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

  updateRightPanelVisibility();
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

  updateRightPanelVisibility();
}

function updateRightPanelVisibility() {
  const rightPanel = document.getElementById('right-panel');
  const resizer = document.getElementById('resizer');
  const editorPanel = document.getElementById('editor-panel');

  if (!previewEnabled && !gridEnabled) {
    // Both hidden - editor takes full width
    rightPanel.classList.add('hidden');
    resizer.classList.add('hidden');
    editorPanel.style.width = '100%';
  } else {
    // At least one visible
    rightPanel.classList.remove('hidden');
    resizer.classList.remove('hidden');
    editorPanel.style.width = '';
  }

  editor.resize();
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

function assignShaderToSlot(slotIndex, shaderCode, filePath, skipSave = false, params = null) {
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
      params: { ...slotParams }
    };
    slot.classList.add('has-shader');
    slot.title = filePath ? `Slot ${slotIndex + 1}: ${filePath.split('/').pop()}` : `Slot ${slotIndex + 1}: Current shader`;

    if (!skipSave) {
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

function clearGridSlot(slotIndex) {
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
  setStatus(`Cleared slot ${slotIndex + 1}`, 'success');

  // Save grid state
  saveGridState();
}

function saveGridState() {
  const state = gridSlots.map(slot => {
    if (!slot) return null;
    return {
      shaderCode: slot.shaderCode,
      filePath: slot.filePath,
      params: slot.params
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
        assignShaderToSlot(i, state[i].shaderCode, state[i].filePath, true, state[i].params);
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
        assignShaderToSlot(i, state[i].shaderCode, state[i].filePath, true, state[i].params);
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
      if (slider && valueDisplay) {
        slider.value = params[name];
        valueDisplay.textContent = params[name].toFixed(2);
        renderer.setParam(name, params[name]);
      }
    }
  });
}

function playGridShader(slotIndex) {
  const slotData = gridSlots[slotIndex];
  if (!slotData) return;

  // Load the slot's params
  if (slotData.params) {
    loadParamsToSliders(slotData.params);
  }

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

    this.setupGeometry();
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
    const time = (performance.now() - this.startTime) / 1000;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);

    gl.uniform3f(this.uniforms.iResolution, this.canvas.width, this.canvas.height, 1);
    gl.uniform1f(this.uniforms.iTime, time);

    // Default all 10 colors to white
    const colorArray = new Float32Array(30);
    for (let i = 0; i < 30; i++) colorArray[i] = 1.0;
    gl.uniform3fv(this.uniforms.iColorRGB, colorArray);

    // Default all 5 params to 0.5
    const paramsArray = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5]);
    gl.uniform1fv(this.uniforms.iParams, paramsArray);

    gl.uniform1f(this.uniforms.iSpeed, 1);

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
