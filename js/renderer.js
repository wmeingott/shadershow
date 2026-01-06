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
  state.renderer = new ShaderRenderer(canvas);

  // Set initial resolution
  const select = document.getElementById('resolution-select');
  const [width, height] = select.value.split('x').map(Number);
  state.renderer.setResolution(width, height);
}

function renderLoop() {
  // Only render if preview is enabled
  if (state.previewEnabled) {
    const stats = state.renderer.render();

    if (stats) {
      document.getElementById('fps-display').textContent = `FPS: ${stats.fps}`;
      document.getElementById('time-display').textContent = `Time: ${stats.time.toFixed(2)}s`;
      document.getElementById('frame-display').textContent = `Frame: ${stats.frame}`;
    }

    // Send frame to NDI output if enabled (every other frame to reduce load)
    if (state.ndiEnabled && state.ndiFrameCounter % 2 === 0) {
      sendNDIFrame();
    }
    state.ndiFrameCounter++;
  } else {
    // Still update time even when preview disabled (for fullscreen sync)
    state.renderer.updateTime();
  }

  state.animationId = requestAnimationFrame(renderLoop);
}
