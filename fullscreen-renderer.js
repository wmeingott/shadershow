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

// Reused Date object to avoid allocation per frame
const reusedDate = new Date();

document.addEventListener('DOMContentLoaded', async () => {
  const canvas = document.getElementById('shader-canvas');

  // Set canvas to full window size
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  // Initialize both renderers
  shaderRenderer = new ShaderRenderer(canvas);
  sceneRenderer = new ThreeSceneRenderer(canvas);

  // Default to shader renderer
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
    sceneRenderer.setResolution(window.innerWidth, window.innerHeight);
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
  } else if (tiledMode) {
    // Render tiled display
    renderTiledFrame();
  } else {
    renderer.render();
  }
}

// Initialize with shader/scene state from main window
window.electronAPI.onInitFullscreen((state) => {
  console.log('[Fullscreen] Received init-fullscreen');
  console.log('[Fullscreen] tiledConfig:', state.tiledConfig ? 'present' : 'not present');
  if (state.tiledConfig) {
    console.log('[Fullscreen] tiledConfig.layout:', state.tiledConfig.layout);
    console.log('[Fullscreen] tiledConfig.tiles:', state.tiledConfig.tiles?.length, 'tiles');
    state.tiledConfig.tiles?.forEach((t, i) => {
      console.log(`[Fullscreen] Tile ${i}: slot=${t?.gridSlotIndex}, hasShader=${!!t?.shaderCode}`);
    });
  }

  // Switch renderer if mode specified
  if (state.renderMode) {
    renderMode = state.renderMode;
    renderer = renderMode === 'scene' ? sceneRenderer : shaderRenderer;
  }

  // Set resolution to native display resolution
  shaderRenderer.setResolution(window.innerWidth, window.innerHeight);
  sceneRenderer.setResolution(window.innerWidth, window.innerHeight);

  // Compile the shader/scene
  if (state.shaderCode) {
    try {
      renderer.compile(state.shaderCode);
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
});

// Handle shader/scene updates from main window
window.electronAPI.onShaderUpdate((data) => {
  // Switch renderer if mode changed
  if (data.renderMode && data.renderMode !== renderMode) {
    renderMode = data.renderMode;
    renderer = renderMode === 'scene' ? sceneRenderer : shaderRenderer;
    renderer.setResolution(window.innerWidth, window.innerHeight);
  }

  if (data.shaderCode) {
    try {
      renderer.compile(data.shaderCode);
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
  }
});

// Handle batched param updates from main window (more efficient)
window.electronAPI.onBatchParamUpdate?.((params) => {
  if (params && typeof params === 'object') {
    Object.entries(params).forEach(([name, value]) => {
      renderer.setParam(name, value);
    });
  }
});

// Handle preset sync from main window
window.electronAPI.onPresetSync((data) => {
  // Apply params directly from sync message
  if (data.params) {
    Object.keys(data.params).forEach(name => {
      renderer.setParam(name, data.params[name]);
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
