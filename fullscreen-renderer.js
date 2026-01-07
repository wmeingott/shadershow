// Fullscreen renderer - receives shader state from main window and renders
let renderer;
let animationId;
let localPresets = [];
let globalPresets = [];
let activeLocalPresetIndex = null;
let activeGlobalPresetIndex = null;
let presetBarTimeout = null;
let blackoutEnabled = false;

// FPS tracking
let frameCount = 0;
let lastFpsTime = performance.now();
let currentFps = 0;
let targetRefreshRate = 60;
let lastFrameTime = 0;
let minFrameInterval = 0; // Will be set based on refresh rate

document.addEventListener('DOMContentLoaded', async () => {
  const canvas = document.getElementById('shader-canvas');

  // Set canvas to full window size
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  renderer = new ShaderRenderer(canvas);

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
    renderer.setResolution(window.innerWidth, window.innerHeight);
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
    if (e.shiftKey) {
      // Shift+number for local presets
      if (index < localPresets.length) {
        recallLocalPreset(index);
      }
    } else {
      // Number for global presets
      if (index < globalPresets.length) {
        recallGlobalPreset(index);
      }
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
  activeGlobalPresetIndex = null;
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

function recallGlobalPreset(index, fromSync = false) {
  if (index >= globalPresets.length) return;
  const preset = globalPresets[index];
  const params = preset.params || preset;

  Object.keys(params).forEach(name => {
    renderer.setParam(name, params[name]);
  });

  activeGlobalPresetIndex = index;
  activeLocalPresetIndex = null;
  updatePresetHighlights();

  // Sync back to main window (unless this call came from sync)
  if (!fromSync) {
    window.electronAPI.sendPresetSync({
      type: 'global',
      index: index,
      params: params
    });
  }
}

function updatePresetHighlights() {
  document.querySelectorAll('#local-presets .preset-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === activeLocalPresetIndex);
  });
  document.querySelectorAll('#global-presets .preset-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === activeGlobalPresetIndex);
  });
}

function createPresetButtons() {
  const localContainer = document.getElementById('local-presets');
  const globalContainer = document.getElementById('global-presets');

  // Clear existing buttons (keep labels)
  localContainer.querySelectorAll('.preset-btn').forEach(btn => btn.remove());
  globalContainer.querySelectorAll('.preset-btn').forEach(btn => btn.remove());

  // Create local preset buttons
  localPresets.forEach((preset, index) => {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = preset.name || String(index + 1);
    btn.title = `Shader preset ${index + 1} (Shift+${index + 1})`;
    btn.addEventListener('click', () => recallLocalPreset(index));
    if (index === activeLocalPresetIndex) btn.classList.add('active');
    localContainer.appendChild(btn);
  });

  // Create global preset buttons
  globalPresets.forEach((preset, index) => {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = preset.name || String(index + 1);
    btn.title = `Global preset ${index + 1} (Key ${index + 1})`;
    btn.addEventListener('click', () => recallGlobalPreset(index));
    if (index === activeGlobalPresetIndex) btn.classList.add('active');
    globalContainer.appendChild(btn);
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
  } else {
    renderer.render();
  }
}

// Initialize with shader state from main window
window.electronAPI.onInitFullscreen((state) => {
  // Set resolution to native display resolution
  renderer.setResolution(window.innerWidth, window.innerHeight);

  // Compile the shader
  if (state.shaderCode) {
    try {
      renderer.compile(state.shaderCode);
    } catch (err) {
      console.error('Shader compile error:', err);
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
  if (state.globalPresets) {
    globalPresets = state.globalPresets;
  }
  activeLocalPresetIndex = state.activeLocalPresetIndex ?? null;
  activeGlobalPresetIndex = state.activeGlobalPresetIndex ?? null;

  createPresetButtons();
});

// Handle shader updates from main window
window.electronAPI.onShaderUpdate((data) => {
  if (data.shaderCode) {
    try {
      renderer.compile(data.shaderCode);
    } catch (err) {
      console.error('Shader compile error:', err);
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
    activeGlobalPresetIndex = null;
  } else if (data.type === 'global') {
    activeGlobalPresetIndex = data.index;
    activeLocalPresetIndex = null;
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
