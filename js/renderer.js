// Main renderer entry point
import { state } from './state.js';
import { initEditor, compileShader } from './editor.js';
import { initControls, initResizer } from './controls.js';
import { initParams, initMouseAssignment } from './params.js';
import { initPresets } from './presets.js';
import { initShaderGrid } from './shader-grid.js';
import { initIPC } from './ipc.js';
import { restoreViewState } from './view-state.js';
import { sendNDIFrame } from './ndi.js';
import { sendSyphonFrame } from './syphon.js';

// Initialize application
document.addEventListener('DOMContentLoaded', async () => {
  initEditor();
  initRenderer();
  initControls();
  initParams();
  initMouseAssignment();
  initPresets();
  initResizer();
  initIPC();
  initShaderGrid();

  // Load default shader
  const defaultShader = await window.electronAPI.getDefaultShader();
  state.editor.setValue(defaultShader, -1);
  compileShader();

  // Restore saved view state
  await restoreViewState();

  // Start render loop
  renderLoop();
});

function initRenderer() {
  const canvas = document.getElementById('shader-canvas');

  // Initialize both renderers
  state.shaderRenderer = new ShaderRenderer(canvas);
  state.sceneRenderer = new ThreeSceneRenderer(canvas);

  // Start with shader renderer as default
  state.renderer = state.shaderRenderer;
  state.renderMode = 'shader';

  // Set initial resolution for both renderers
  const select = document.getElementById('resolution-select');
  const [width, height] = select.value.split('x').map(Number);
  state.shaderRenderer.setResolution(width, height);
  state.sceneRenderer.setResolution(width, height);
}

// Switch between shader and scene renderers
export function setRenderMode(mode) {
  if (mode === state.renderMode) return;

  state.renderMode = mode;

  if (mode === 'scene') {
    state.renderer = state.sceneRenderer;
    // Set editor mode to JavaScript/JSX
    state.editor.session.setMode('ace/mode/javascript');
  } else {
    state.renderer = state.shaderRenderer;
    // Set editor mode to GLSL
    state.editor.session.setMode('ace/mode/glsl');
  }

  // Sync resolution
  const canvas = document.getElementById('shader-canvas');
  state.renderer.setResolution(canvas.width, canvas.height);
}

// Detect render mode from file extension or content
export function detectRenderMode(filename, content) {
  if (!filename) {
    // Detect from content
    if (content.includes('function setup') && content.includes('THREE')) {
      return 'scene';
    }
    if (content.includes('void mainImage') || content.includes('void main()')) {
      return 'shader';
    }
    return 'shader'; // Default
  }

  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'jsx' || ext === 'js' && filename.includes('.scene.')) {
    return 'scene';
  }
  if (ext === 'glsl' || ext === 'frag' || ext === 'vert') {
    return 'shader';
  }

  // Check content as fallback
  if (content && content.includes('function setup')) {
    return 'scene';
  }

  return 'shader';
}

// Preview frame rate limiting
let lastPreviewFrameTime = 0;

function renderLoop(currentTime) {
  state.animationId = requestAnimationFrame(renderLoop);

  // Render if preview is enabled OR if NDI/Syphon needs frames
  const needsRender = state.previewEnabled || state.ndiEnabled || state.syphonEnabled;

  if (!needsRender) {
    // Still update time even when preview disabled (for fullscreen sync)
    state.renderer.updateTime();
    return;
  }

  // Apply frame rate limiting when fullscreen is active
  if (state.fullscreenActive && state.previewFrameInterval > 0) {
    if (currentTime - lastPreviewFrameTime < state.previewFrameInterval) {
      return;
    }
    lastPreviewFrameTime = currentTime;
  }

  const stats = state.renderer.render();

  if (stats && state.previewEnabled) {
    document.getElementById('fps-display').textContent = `FPS: ${stats.fps}`;
    document.getElementById('time-display').textContent = `Time: ${stats.time.toFixed(2)}s`;
    document.getElementById('frame-display').textContent = `Frame: ${stats.frame}`;
  }

  // Send frame to NDI output if enabled (skip frames to reduce load)
  if (state.ndiEnabled && state.ndiFrameCounter % state.ndiFrameSkip === 0) {
    sendNDIFrame();
  }
  if (state.ndiEnabled) state.ndiFrameCounter++;

  // Send frame to Syphon output if enabled (skip frames to reduce load)
  if (state.syphonEnabled && state.syphonFrameCounter % state.syphonFrameSkip === 0) {
    sendSyphonFrame();
  }
  if (state.syphonEnabled) state.syphonFrameCounter++;
}

// Update preview frame rate limiting based on fullscreen FPS
export function updatePreviewFrameLimit() {
  if (!state.fullscreenActive) {
    state.previewFrameInterval = 0;  // No limiting when fullscreen inactive
    return;
  }

  // If fullscreen is reaching target refresh rate, allow 60fps preview
  // Otherwise limit to 30fps to reduce GPU load
  const threshold = state.fullscreenTargetFps * 0.95;  // 95% of target
  if (state.fullscreenFps >= threshold) {
    state.previewFrameInterval = 1000 / 60;  // ~16.67ms for 60fps
  } else {
    state.previewFrameInterval = 1000 / 30;  // ~33.33ms for 30fps
  }
}
