// Fullscreen renderer - receives shader state from main window and renders
let renderer;           // Current active renderer
let shaderRenderer;     // WebGL shader renderer
let sceneRenderer;      // Three.js scene renderer
let renderMode = 'shader';  // 'shader' or 'scene'
let animationId;
let localPresets = [];
let activeLocalPresetIndex = null;
let presetBarTimeout = null;
let blackoutEnabled = false;

// FPS tracking
let frameCount = 0;
let lastFpsTime = performance.now();
let currentFps = 0;
let targetRefreshRate = 60;
let lastFrameTime = 0;
let minFrameInterval = 0; // Will be set based on refresh rate

// Tiled mode state
let tiledMode = false;
let tileRenderers = [];     // Array of TileRenderer instances
let tileConfig = null;      // Current tile configuration
let sharedGL = null;        // Shared WebGL context for tiled mode

// Mixer mode state
let mixerMode = false;
let mixerRenderers = [];       // TileRenderer per channel (full-screen bounds)
let mixerBlendMode = 'lighter';
let mixerChannelAlphas = [];
let mixerSelectedChannel = -1; // Track which channel receives param-update fallback
let mixerOverlayCanvas = null;
let mixerOverlayCtx = null;

// Reused Date object to avoid allocation per frame
const reusedDate = new Date();

// Load file textures for a renderer after compile (reads from data/textures/ via IPC)
async function loadFileTexturesForRenderer(targetRenderer) {
  if (!targetRenderer.fileTextureDirectives || targetRenderer.fileTextureDirectives.length === 0) return;
  for (const { channel, textureName } of targetRenderer.fileTextureDirectives) {
    try {
      const result = await window.electronAPI.loadFileTexture(textureName);
      if (result.success) {
        await targetRenderer.loadTexture(channel, result.dataUrl);
      }
    } catch (err) {
      console.error(`Failed to load file texture "${textureName}":`, err);
    }
  }
}

// Lazy-initialize ThreeSceneRenderer (Three.js is lazy-loaded in fullscreen)
async function ensureSceneRenderer() {
  if (sceneRenderer) return sceneRenderer;
  const canvas = document.getElementById('shader-canvas');
  await window.loadThreeJS();
  sceneRenderer = new ThreeSceneRenderer(canvas);
  sceneRenderer.setResolution(window.innerWidth, window.innerHeight);
  // Restore ShaderRenderer GL state after Three.js creates its WebGLRenderer
  shaderRenderer.reinitialize();
  return sceneRenderer;
}

document.addEventListener('DOMContentLoaded', async () => {
  const canvas = document.getElementById('shader-canvas');

  // Set canvas to full window size
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  // Initialize shader renderer (always available)
  shaderRenderer = new ShaderRenderer(canvas);

  // Default to shader renderer (scene renderer created on demand)
  renderer = shaderRenderer;

  // Get display refresh rate and set frame interval limit
  try {
    const refreshRate = await window.electronAPI.getDisplayRefreshRate();
    if (refreshRate && refreshRate > 0) {
      targetRefreshRate = refreshRate;
      // Allow slightly faster than refresh rate to avoid frame drops
      minFrameInterval = (1000 / targetRefreshRate) * 0.95;
    }
  } catch (err) {
    console.warn('Could not get display refresh rate, using 60Hz default');
    minFrameInterval = (1000 / 60) * 0.95;
  }

  // Handle window resize
  window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    shaderRenderer.setResolution(window.innerWidth, window.innerHeight);
    if (sceneRenderer) {
      sceneRenderer.setResolution(window.innerWidth, window.innerHeight);
    }
  });

  // Fade out the exit hint after 3 seconds
  setTimeout(() => {
    document.getElementById('exit-hint').classList.add('fade');
  }, 3000);

  // Show preset bar on mouse move
  document.addEventListener('mousemove', showPresetBar);

  // Keyboard shortcuts for presets (1-9 for global, Shift+1-9 for local)
  document.addEventListener('keydown', handlePresetKey);

  // Start render loop
  renderLoop();
});

function showPresetBar() {
  const bar = document.getElementById('preset-bar');
  bar.classList.add('visible');
  document.body.style.cursor = 'default';

  clearTimeout(presetBarTimeout);
  presetBarTimeout = setTimeout(() => {
    bar.classList.remove('visible');
    document.body.style.cursor = 'none';
  }, 3000);
}

function handlePresetKey(e) {
  const key = e.key;
  if (key >= '1' && key <= '9') {
    const index = parseInt(key) - 1;
    // Number keys for local presets
    if (index < localPresets.length) {
      recallLocalPreset(index);
    }
  }
}

function recallLocalPreset(index, fromSync = false) {
  if (index >= localPresets.length) return;
  const preset = localPresets[index];
  const params = preset.params || preset;

  Object.keys(params).forEach(name => {
    renderer.setParam(name, params[name]);
  });

  activeLocalPresetIndex = index;
  updatePresetHighlights();

  // Sync back to main window (unless this call came from sync)
  if (!fromSync) {
    window.electronAPI.sendPresetSync({
      type: 'local',
      index: index,
      params: params
    });
  }
}

function updatePresetHighlights() {
  document.querySelectorAll('#local-presets .preset-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === activeLocalPresetIndex);
  });
}

function createPresetButtons() {
  const localContainer = document.getElementById('local-presets');

  // Clear existing buttons (keep labels)
  localContainer.querySelectorAll('.preset-btn').forEach(btn => btn.remove());

  // Create local preset buttons
  localPresets.forEach((preset, index) => {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = preset.name || String(index + 1);
    btn.title = `Shader preset ${index + 1} (Key ${index + 1})`;
    btn.addEventListener('click', () => recallLocalPreset(index));
    if (index === activeLocalPresetIndex) btn.classList.add('active');
    localContainer.appendChild(btn);
  });
}

function renderLoop(currentTime) {
  animationId = requestAnimationFrame(renderLoop);

  // Frame rate limiting - skip frame if too soon
  if (minFrameInterval > 0 && currentTime - lastFrameTime < minFrameInterval) {
    return;
  }
  lastFrameTime = currentTime;

  // FPS calculation
  frameCount++;
  const elapsed = currentTime - lastFpsTime;
  if (elapsed >= 1000) {
    currentFps = Math.round((frameCount * 1000) / elapsed);
    frameCount = 0;
    lastFpsTime = currentTime;

    // Send FPS to main window
    window.electronAPI.sendFullscreenFps(currentFps);
  }

  if (blackoutEnabled) {
    // Clear to black when blackout is enabled
    const canvas = document.getElementById('shader-canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (mixerOverlayCanvas) mixerOverlayCanvas.style.display = 'none';
  } else if (mixerMode) {
    renderMixerFrame();
  } else if (tiledMode) {
    // Render tiled display
    renderTiledFrame();
  } else {
    renderer.render();
    if (mixerOverlayCanvas) mixerOverlayCanvas.style.display = 'none';
  }
}

// Initialize with shader/scene state from main window
window.electronAPI.onInitFullscreen(async (state) => {

  // Switch renderer if mode specified
  if (state.renderMode) {
    renderMode = state.renderMode;
    if (renderMode === 'scene') {
      renderer = await ensureSceneRenderer();
    } else {
      renderer = shaderRenderer;
    }
  }

  // Set resolution to native display resolution
  shaderRenderer.setResolution(window.innerWidth, window.innerHeight);
  if (sceneRenderer) {
    sceneRenderer.setResolution(window.innerWidth, window.innerHeight);
  }

  // Compile the shader/scene
  if (state.shaderCode) {
    try {
      renderer.compile(state.shaderCode);
      loadFileTexturesForRenderer(renderer);
    } catch (err) {
      console.error('Compile error:', err);
    }
  }

  // Sync time
  if (state.time !== undefined) {
    renderer.startTime = performance.now() - (state.time * 1000);
    renderer.frameCount = state.frame || 0;
    renderer.isPlaying = state.isPlaying !== false;
    if (!renderer.isPlaying) {
      renderer.pausedTime = state.time * 1000;
    }
  }

  // Load textures/videos/cameras
  if (state.channels) {
    state.channels.forEach((channel, index) => {
      if (channel) {
        loadChannel(index, channel);
      }
    });
  }

  // Set custom parameters
  if (state.params) {
    Object.keys(state.params).forEach(name => {
      renderer.setParam(name, state.params[name]);
    });
  }

  // Load presets
  if (state.localPresets) {
    localPresets = state.localPresets;
  }
  activeLocalPresetIndex = state.activeLocalPresetIndex ?? null;

  createPresetButtons();

  // Initialize tiled mode if configuration provided
  if (state.tiledConfig) {
    initTiledMode(state.tiledConfig);
  }

  // Initialize mixer mode if configuration provided
  if (state.mixerConfig) {
    initMixerMode(state.mixerConfig);
  }
});

// Handle shader/scene updates from main window
window.electronAPI.onShaderUpdate(async (data) => {
  // Switch renderer if mode changed
  if (data.renderMode && data.renderMode !== renderMode) {
    renderMode = data.renderMode;
    if (renderMode === 'scene') {
      renderer = await ensureSceneRenderer();
    } else {
      renderer = shaderRenderer;
      // Reinitialize GL state after Three.js has used the shared WebGL context
      shaderRenderer.reinitialize();
    }
    renderer.setResolution(window.innerWidth, window.innerHeight);
  }

  if (data.shaderCode) {
    try {
      renderer.compile(data.shaderCode);
      loadFileTexturesForRenderer(renderer);
    } catch (err) {
      console.error('Compile error:', err);
    }
  }
});

// Handle time sync from main window
window.electronAPI.onTimeSync((data) => {
  if (data.time !== undefined) {
    renderer.startTime = performance.now() - (data.time * 1000);
    renderer.frameCount = data.frame || 0;
    renderer.isPlaying = data.isPlaying !== false;
    if (!renderer.isPlaying) {
      renderer.pausedTime = data.time * 1000;
    }
  }
});

// Handle param updates from main window
window.electronAPI.onParamUpdate((data) => {
  if (data.name && data.value !== undefined) {
    renderer.setParam(data.name, data.value);
    // Also route to the active mixer channel when in mixer mode
    if (mixerMode && mixerSelectedChannel >= 0 && mixerRenderers[mixerSelectedChannel]) {
      mixerRenderers[mixerSelectedChannel].setParam(data.name, data.value);
    }
  }
});

// Handle batched param updates from main window (more efficient)
window.electronAPI.onBatchParamUpdate?.((params) => {
  if (params && typeof params === 'object') {
    const mixerTarget = (mixerMode && mixerSelectedChannel >= 0) ? mixerRenderers[mixerSelectedChannel] : null;
    Object.entries(params).forEach(([name, value]) => {
      renderer.setParam(name, value);
      if (mixerTarget) mixerTarget.setParam(name, value);
    });
  }
});

// Handle preset sync from main window
window.electronAPI.onPresetSync((data) => {
  // Apply params directly from sync message
  if (data.params) {
    const mixerTarget = (mixerMode && mixerSelectedChannel >= 0) ? mixerRenderers[mixerSelectedChannel] : null;
    Object.keys(data.params).forEach(name => {
      renderer.setParam(name, data.params[name]);
      if (mixerTarget) mixerTarget.setParam(name, data.params[name]);
    });
  }

  // Update highlighting
  if (data.type === 'local') {
    activeLocalPresetIndex = data.index;
  }
  updatePresetHighlights();
});

// Handle blackout from main window
window.electronAPI.onBlackout((enabled) => {
  blackoutEnabled = enabled;
});

async function loadChannel(index, channel) {
  try {
    switch (channel.type) {
      case 'image':
        if (channel.dataUrl) {
          await renderer.loadTexture(index, channel.dataUrl);
        }
        break;
      case 'video':
        if (channel.filePath) {
          await renderer.loadVideo(index, channel.filePath);
        }
        break;
      case 'camera':
        await renderer.loadCamera(index);
        break;
      case 'audio':
        await renderer.loadAudio(index);
        break;
      case 'file-texture':
        if (channel.name) {
          try {
            const result = await window.electronAPI.loadFileTexture(channel.name);
            if (result.success) {
              await renderer.loadTexture(index, result.dataUrl);
            }
          } catch (texErr) {
            console.error(`Failed to load file texture "${channel.name}":`, texErr);
          }
        }
        break;
    }
  } catch (err) {
    console.error(`Failed to load channel ${index}:`, err);
  }
}

// =============================================================================
// Tiled Mode Functions
// =============================================================================

// Initialize tiled mode with configuration
function initTiledMode(config) {
  const canvas = document.getElementById('shader-canvas');

  tiledMode = true;
  tileConfig = config;

  // Use the same WebGL context as shaderRenderer (critical for texture sharing)
  if (!sharedGL) {
    sharedGL = shaderRenderer.gl;
  }

  // Clear existing tile renderers
  disposeTileRenderers();

  // Calculate tile bounds - use preview resolution aspect ratio if available
  let renderWidth = canvas.width;
  let renderHeight = canvas.height;
  let offsetX = 0;
  let offsetY = 0;

  if (config.previewResolution) {
    const previewAspect = config.previewResolution.width / config.previewResolution.height;
    const canvasAspect = canvas.width / canvas.height;

    if (canvasAspect > previewAspect) {
      // Canvas is wider - pillarbox (black bars on sides)
      renderWidth = Math.floor(canvas.height * previewAspect);
      offsetX = Math.floor((canvas.width - renderWidth) / 2);
    } else {
      // Canvas is taller - letterbox (black bars on top/bottom)
      renderHeight = Math.floor(canvas.width / previewAspect);
      offsetY = Math.floor((canvas.height - renderHeight) / 2);
    }
    console.log(`Aspect ratio correction: preview=${previewAspect.toFixed(2)}, canvas=${canvasAspect.toFixed(2)}`);
    console.log(`Render area: ${renderWidth}x${renderHeight} at offset (${offsetX},${offsetY})`);
  }

  // Store offset for rendering
  tileConfig.renderOffset = { x: offsetX, y: offsetY };
  tileConfig.renderSize = { width: renderWidth, height: renderHeight };

  // Calculate tile bounds within the aspect-corrected area
  const bounds = calculateTileBounds(
    renderWidth,
    renderHeight,
    config.layout.rows,
    config.layout.cols,
    config.layout.gaps
  );

  // Apply offset to bounds
  bounds.forEach(b => {
    b.x += offsetX;
    b.y += offsetY;
  });

  // Create TileRenderer for each tile
  tileRenderers = bounds.map(b => new TileRenderer(sharedGL, b));

  // Compile shaders for tiles that have assignments
  if (config.tiles) {
    config.tiles.forEach((tile, index) => {
      if (tile && tile.shaderCode && index < tileRenderers.length) {
        try {
          tileRenderers[index].compile(tile.shaderCode);
          if (tile.params) {
            tileRenderers[index].setParams(tile.params);
          }
        } catch (err) {
          console.error(`Failed to compile shader for tile ${index}:`, err);
        }
      }
    });
  }
}

// Calculate tile bounds in pixels
function calculateTileBounds(canvasWidth, canvasHeight, rows, cols, gaps) {
  const bounds = [];

  const totalGapX = gaps * (cols - 1);
  const totalGapY = gaps * (rows - 1);
  const tileWidth = Math.floor((canvasWidth - totalGapX) / cols);
  const tileHeight = Math.floor((canvasHeight - totalGapY) / rows);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tileIndex = row * cols + col;
      const x = col * (tileWidth + gaps);
      // WebGL has Y=0 at bottom, so flip the row order
      const y = (rows - 1 - row) * (tileHeight + gaps);

      bounds.push({
        tileIndex,
        x,
        y,
        width: tileWidth,
        height: tileHeight
      });
    }
  }

  return bounds;
}

// Update tile layout (recalculate bounds)
function updateTileLayout(layout) {
  if (!tiledMode || !tileConfig) return;

  const canvas = document.getElementById('shader-canvas');
  tileConfig.layout = layout;

  const bounds = calculateTileBounds(
    canvas.width,
    canvas.height,
    layout.rows,
    layout.cols,
    layout.gaps
  );

  // Resize existing renderers or create new ones
  const newCount = layout.rows * layout.cols;
  const oldCount = tileRenderers.length;

  // Update bounds for existing renderers
  for (let i = 0; i < Math.min(oldCount, newCount); i++) {
    tileRenderers[i].setBounds(bounds[i]);
  }

  // Create new renderers if needed
  for (let i = oldCount; i < newCount; i++) {
    tileRenderers.push(new TileRenderer(sharedGL, bounds[i]));
  }

  // Remove excess renderers
  for (let i = newCount; i < oldCount; i++) {
    tileRenderers[i].dispose();
  }
  tileRenderers.length = newCount;

  // Update tile config tiles array
  while (tileConfig.tiles.length < newCount) {
    tileConfig.tiles.push({ gridSlotIndex: null, params: null, visible: true });
  }
  tileConfig.tiles.length = newCount;
}

// Assign a shader to a specific tile
function assignTileShader(tileIndex, shaderCode, params) {
  if (tileIndex < 0 || tileIndex >= tileRenderers.length) return;

  console.log(`assignTileShader: tile ${tileIndex}, hasShader: ${!!shaderCode}`);

  // Handle clearing a tile
  if (!shaderCode) {
    tileRenderers[tileIndex].program = null;
    if (tileConfig && tileConfig.tiles && tileIndex < tileConfig.tiles.length) {
      tileConfig.tiles[tileIndex] = {
        ...tileConfig.tiles[tileIndex],
        shaderCode: null,
        params: null
      };
    }
    return;
  }

  try {
    tileRenderers[tileIndex].compile(shaderCode);
    if (params) {
      tileRenderers[tileIndex].setParams(params);
    }

    // Update config
    if (tileConfig && tileConfig.tiles && tileIndex < tileConfig.tiles.length) {
      tileConfig.tiles[tileIndex] = {
        ...tileConfig.tiles[tileIndex],
        shaderCode,
        params
      };
    }
    console.log(`Tile ${tileIndex} shader updated successfully`);
  } catch (err) {
    console.error(`Failed to assign shader to tile ${tileIndex}:`, err);
  }
}

// Update parameter for a specific tile
function updateTileParam(tileIndex, name, value) {
  if (tileIndex < 0 || tileIndex >= tileRenderers.length) return;

  tileRenderers[tileIndex].setParam(name, value);
}

// Render all tiles
function renderTiledFrame() {
  const canvas = document.getElementById('shader-canvas');

  if (!tiledMode || !sharedGL || tileRenderers.length === 0) {
    return;
  }

  const gl = sharedGL;

  // Recalculate bounds based on current canvas size (fixes resize issues)
  const layout = tileConfig?.layout || { rows: 2, cols: 2, gaps: 4 };

  // Get render area (with aspect ratio correction if configured)
  let renderWidth = canvas.width;
  let renderHeight = canvas.height;
  let offsetX = 0;
  let offsetY = 0;

  if (tileConfig?.renderOffset && tileConfig?.renderSize) {
    // Use saved aspect ratio correction
    offsetX = tileConfig.renderOffset.x;
    offsetY = tileConfig.renderOffset.y;
    renderWidth = tileConfig.renderSize.width;
    renderHeight = tileConfig.renderSize.height;
  }

  const freshBounds = calculateTileBounds(renderWidth, renderHeight, layout.rows, layout.cols, layout.gaps);

  // Apply offset to bounds
  freshBounds.forEach(b => {
    b.x += offsetX;
    b.y += offsetY;
  });

  // Update tile renderer bounds
  for (let i = 0; i < tileRenderers.length && i < freshBounds.length; i++) {
    tileRenderers[i].setBounds(freshBounds[i]);
  }

  // Clear entire canvas (gaps will show as black)
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Prepare shared state for all tiles
  const now = performance.now();
  const time = (now - shaderRenderer.startTime) / 1000;
  const timeDelta = (now - shaderRenderer.lastFrameTime) / 1000;
  shaderRenderer.lastFrameTime = now;

  // Reuse Date object to avoid allocation per frame
  reusedDate.setTime(Date.now());
  const dateValues = new Float32Array([
    reusedDate.getFullYear(),
    reusedDate.getMonth(),
    reusedDate.getDate(),
    reusedDate.getHours() * 3600 + reusedDate.getMinutes() * 60 + reusedDate.getSeconds() + reusedDate.getMilliseconds() / 1000
  ]);

  // Update video/camera/audio textures
  shaderRenderer.updateVideoTextures();

  // Prepare channel resolutions array
  const resolutions = new Float32Array(12);
  for (let i = 0; i < 4; i++) {
    resolutions[i * 3] = shaderRenderer.channelResolutions[i][0];
    resolutions[i * 3 + 1] = shaderRenderer.channelResolutions[i][1];
    resolutions[i * 3 + 2] = shaderRenderer.channelResolutions[i][2];
  }

  const sharedState = {
    time,
    timeDelta,
    frame: shaderRenderer.frameCount,
    mouse: shaderRenderer.mouse,
    date: dateValues,
    channelTextures: shaderRenderer.channelTextures,
    channelResolutions: resolutions
  };

  // Render each visible tile
  let renderedCount = 0;

  for (let index = 0; index < tileRenderers.length; index++) {
    const tileRenderer = tileRenderers[index];
    const tileInfo = tileConfig?.tiles?.[index];
    const isVisible = tileInfo?.visible !== false;

    // Render shader if available
    if (isVisible && tileRenderer.program) {
      try {
        tileRenderer.render(sharedState);
        renderedCount++;
      } catch (err) {
        console.error(`Tile ${index} render error:`, err);
      }
    }
  }

  if (shaderRenderer.isPlaying) {
    shaderRenderer.frameCount++;
  }
}

// Dispose all tile renderers
function disposeTileRenderers() {
  tileRenderers.forEach(tr => tr.dispose());
  tileRenderers = [];
}

// Exit tiled mode
function exitTiledMode() {
  tiledMode = false;
  disposeTileRenderers();
  tileConfig = null;
}

// =============================================================================
// Mixer Mode Functions
// =============================================================================

function initMixerMode(config) {
  const canvas = document.getElementById('shader-canvas');

  mixerMode = true;
  mixerBlendMode = config.blendMode || 'lighter';

  // Use the same WebGL context as shaderRenderer
  if (!sharedGL) {
    sharedGL = shaderRenderer.gl;
  }

  // Dispose existing mixer renderers
  mixerRenderers.forEach(r => { if (r) r.dispose(); });
  const channelCount = (config.channels || []).length;
  mixerRenderers = new Array(channelCount).fill(null);
  mixerChannelAlphas = new Array(channelCount).fill(1);

  // Create 2D overlay canvas for compositing
  initMixerModeIfNeeded(canvas);

  const gl = sharedGL;

  for (let i = 0; i < channelCount; i++) {
    const channelConfig = config.channels?.[i];
    if (!channelConfig || !channelConfig.shaderCode) continue;

    const bounds = { tileIndex: i, x: 0, y: 0, width: canvas.width, height: canvas.height };
    const tr = new TileRenderer(gl, bounds);

    try {
      tr.compile(channelConfig.shaderCode);
      loadFileTexturesForRenderer(tr);
      if (channelConfig.params) {
        tr.setParams(channelConfig.params);
      }
    } catch (err) {
      console.error(`Failed to compile mixer channel ${i}:`, err);
    }

    mixerChannelAlphas[i] = channelConfig.alpha ?? 1;
    mixerRenderers[i] = tr;
    mixerSelectedChannel = i;
  }
}

function renderMixerFrame() {
  const canvas = document.getElementById('shader-canvas');

  if (!mixerOverlayCanvas || !mixerOverlayCtx || mixerRenderers.length === 0) return;

  // Ensure overlay matches canvas size
  if (mixerOverlayCanvas.width !== canvas.width || mixerOverlayCanvas.height !== canvas.height) {
    mixerOverlayCanvas.width = canvas.width;
    mixerOverlayCanvas.height = canvas.height;
    mixerOverlayCtx = mixerOverlayCanvas.getContext('2d');

    // Update TileRenderer bounds
    mixerRenderers.forEach(tr => {
      if (tr) tr.setBounds({ tileIndex: tr.bounds.tileIndex, x: 0, y: 0, width: canvas.width, height: canvas.height });
    });
  }

  const ctx = mixerOverlayCtx;
  const gl = sharedGL;

  // Prepare shared state (same as tiled mode)
  const now = performance.now();
  const time = (now - shaderRenderer.startTime) / 1000;
  const timeDelta = (now - shaderRenderer.lastFrameTime) / 1000;
  shaderRenderer.lastFrameTime = now;

  reusedDate.setTime(Date.now());
  const dateValues = new Float32Array([
    reusedDate.getFullYear(),
    reusedDate.getMonth(),
    reusedDate.getDate(),
    reusedDate.getHours() * 3600 + reusedDate.getMinutes() * 60 + reusedDate.getSeconds() + reusedDate.getMilliseconds() / 1000
  ]);

  shaderRenderer.updateVideoTextures();

  const resolutions = new Float32Array(12);
  for (let i = 0; i < 4; i++) {
    resolutions[i * 3] = shaderRenderer.channelResolutions[i][0];
    resolutions[i * 3 + 1] = shaderRenderer.channelResolutions[i][1];
    resolutions[i * 3 + 2] = shaderRenderer.channelResolutions[i][2];
  }

  const sharedState = {
    time,
    timeDelta,
    frame: shaderRenderer.frameCount,
    mouse: shaderRenderer.mouse,
    date: dateValues,
    channelTextures: shaderRenderer.channelTextures,
    channelResolutions: resolutions
  };

  // Clear 2D overlay to opaque black
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Set blend mode for compositing
  ctx.globalCompositeOperation = mixerBlendMode;

  // Ensure clean GL state for mixer rendering
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  // Render each active channel
  for (let i = 0; i < mixerRenderers.length; i++) {
    const tr = mixerRenderers[i];
    if (!tr || !tr.program || mixerChannelAlphas[i] <= 0) continue;

    // Render the channel's shader to the WebGL canvas
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    try {
      tr.render(sharedState);
    } catch (err) {
      console.error(`[Fullscreen] Mixer channel ${i} render error:`, err);
      continue;
    }

    // Composite WebGL result onto 2D overlay with alpha
    ctx.globalAlpha = mixerChannelAlphas[i];
    ctx.drawImage(canvas, 0, 0);
  }

  ctx.globalAlpha = 1.0;
  ctx.globalCompositeOperation = 'source-over';
  mixerOverlayCanvas.style.display = 'block';

  if (shaderRenderer.isPlaying) {
    shaderRenderer.frameCount++;
  }
}

function exitMixerMode() {
  mixerMode = false;
  mixerSelectedChannel = -1;
  mixerRenderers.forEach(r => { if (r) r.dispose(); });
  mixerRenderers = [];
  if (mixerOverlayCanvas) {
    mixerOverlayCanvas.style.display = 'none';
  }
}

// =============================================================================
// Mixer Mode IPC Handlers
// =============================================================================

window.electronAPI.onMixerParamUpdate?.((data) => {
  const { channelIndex, paramName, value } = data;
  if (channelIndex >= 0 && channelIndex < mixerRenderers.length && mixerRenderers[channelIndex]) {
    mixerRenderers[channelIndex].setParam(paramName, value);
    mixerSelectedChannel = channelIndex;
  }
});

window.electronAPI.onMixerAlphaUpdate?.((data) => {
  const { channelIndex, alpha } = data;
  if (channelIndex >= 0) {
    // Grow array if needed
    while (mixerChannelAlphas.length <= channelIndex) mixerChannelAlphas.push(1);
    mixerChannelAlphas[channelIndex] = alpha;
  }
});

window.electronAPI.onMixerBlendMode?.((data) => {
  const { blendMode } = data;
  if (blendMode) {
    mixerBlendMode = blendMode;
  }
});

window.electronAPI.onMixerChannelUpdate?.((data) => {
  const { channelIndex, shaderCode, params, clear } = data;
  if (channelIndex < 0) return;

  const canvas = document.getElementById('shader-canvas');

  if (clear) {
    // Clear this channel
    if (channelIndex < mixerRenderers.length && mixerRenderers[channelIndex]) {
      mixerRenderers[channelIndex].dispose();
      mixerRenderers[channelIndex] = null;
    }
    if (channelIndex < mixerChannelAlphas.length) {
      mixerChannelAlphas[channelIndex] = 1;
    }

    // Auto-select next active channel if cleared channel was selected
    if (mixerSelectedChannel === channelIndex) {
      mixerSelectedChannel = -1;
      for (let i = 0; i < mixerRenderers.length; i++) {
        if (i !== channelIndex && mixerRenderers[i]) {
          mixerSelectedChannel = i;
          break;
        }
      }
    }

    // If no channels active, exit mixer mode
    if (!mixerRenderers.some(Boolean)) {
      exitMixerMode();
    }
    return;
  }

  if (!shaderCode) return;

  // Ensure shared GL is available
  if (!sharedGL) {
    sharedGL = shaderRenderer.gl;
  }

  // Grow arrays as needed
  while (mixerRenderers.length <= channelIndex) mixerRenderers.push(null);
  while (mixerChannelAlphas.length <= channelIndex) mixerChannelAlphas.push(1);

  // Create or replace TileRenderer for this channel
  if (mixerRenderers[channelIndex]) {
    mixerRenderers[channelIndex].dispose();
  }

  const bounds = { tileIndex: channelIndex, x: 0, y: 0, width: canvas.width, height: canvas.height };
  const tr = new TileRenderer(sharedGL, bounds);

  try {
    tr.compile(shaderCode);
    loadFileTexturesForRenderer(tr);
    if (params) {
      tr.setParams(params);
    }
  } catch (err) {
    console.error(`Failed to compile mixer channel ${channelIndex}:`, err);
  }

  mixerRenderers[channelIndex] = tr;
  mixerSelectedChannel = channelIndex;

  // Ensure mixer mode is active
  if (!mixerMode) {
    initMixerModeIfNeeded(canvas);
  }
});

function initMixerModeIfNeeded(canvas) {
  mixerMode = true;

  if (!mixerOverlayCanvas) {
    mixerOverlayCanvas = document.createElement('canvas');
    mixerOverlayCanvas.id = 'mixer-overlay-canvas';
    mixerOverlayCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1';
    canvas.parentElement.style.position = 'relative';
    canvas.parentElement.appendChild(mixerOverlayCanvas);
  }

  mixerOverlayCanvas.width = canvas.width;
  mixerOverlayCanvas.height = canvas.height;
  mixerOverlayCtx = mixerOverlayCanvas.getContext('2d');
}

// =============================================================================
// Tiled Mode IPC Handlers
// =============================================================================

// Initialize tiled fullscreen mode
window.electronAPI.onInitTiledFullscreen?.((config) => {
  console.log('Received tiled fullscreen init:', config);
  initTiledMode(config);
});

// Update tile layout
window.electronAPI.onTileLayoutUpdate?.((layout) => {
  updateTileLayout(layout);
});

// Assign shader to a tile
window.electronAPI.onTileAssign?.((data) => {
  const { tileIndex, shaderCode, params } = data;
  assignTileShader(tileIndex, shaderCode, params);
});

// Update tile parameter
window.electronAPI.onTileParamUpdate?.((data) => {
  const { tileIndex, name, value } = data;
  updateTileParam(tileIndex, name, value);
});

// Exit tiled mode
window.electronAPI.onExitTiledMode?.(() => {
  exitTiledMode();
});
