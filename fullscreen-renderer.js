// Fullscreen renderer - receives shader state from main window and renders
let renderer;
let animationId;

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('shader-canvas');

  // Set canvas to full window size
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  renderer = new ShaderRenderer(canvas);

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

  // Start render loop
  renderLoop();
});

function renderLoop() {
  renderer.render();
  animationId = requestAnimationFrame(renderLoop);
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
