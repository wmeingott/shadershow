// View State module
import { state } from './state.js';
import { startGridAnimation } from './shader-grid.js';

export function saveViewState() {
  const editorPanel = document.getElementById('editor-panel');
  const resolutionSelect = document.getElementById('resolution-select');
  const customWidth = document.getElementById('custom-width');
  const customHeight = document.getElementById('custom-height');

  const viewState = {
    editorEnabled: state.editorEnabled,
    previewEnabled: state.previewEnabled,
    gridEnabled: state.gridEnabled,
    paramsEnabled: state.paramsEnabled,
    editorWidth: editorPanel.style.width || '50%',
    resolution: resolutionSelect.value,
    customWidth: customWidth.value,
    customHeight: customHeight.value
  };

  window.electronAPI.saveViewState(viewState);
}

export async function restoreViewState() {
  const viewState = await window.electronAPI.loadViewState();
  if (!viewState) return;

  const editorPanel = document.getElementById('editor-panel');
  const resizer = document.getElementById('resizer');
  const previewPanel = document.getElementById('preview-panel');
  const gridPanel = document.getElementById('grid-panel');
  const paramsPanel = document.getElementById('params-panel');

  // Restore editor visibility
  if (viewState.editorEnabled !== undefined) {
    state.editorEnabled = viewState.editorEnabled;
    if (!state.editorEnabled) {
      editorPanel.classList.add('hidden');
      resizer.classList.add('hidden');
    }
    document.getElementById('btn-editor').classList.toggle('active', state.editorEnabled);
  }

  // Restore preview visibility
  if (viewState.previewEnabled !== undefined) {
    state.previewEnabled = viewState.previewEnabled;
    if (!state.previewEnabled) {
      previewPanel.classList.add('hidden');
    }
    document.getElementById('btn-preview').classList.toggle('active', state.previewEnabled);
  }

  // Restore grid visibility
  if (viewState.gridEnabled !== undefined) {
    state.gridEnabled = viewState.gridEnabled;
    if (state.gridEnabled) {
      gridPanel.classList.remove('hidden');
      startGridAnimation();
    }
    document.getElementById('btn-grid').classList.toggle('active', state.gridEnabled);
  }

  // Restore params visibility
  if (viewState.paramsEnabled !== undefined) {
    state.paramsEnabled = viewState.paramsEnabled;
    if (!state.paramsEnabled) {
      paramsPanel.classList.add('hidden');
    }
    document.getElementById('btn-params').classList.toggle('active', state.paramsEnabled);
  }

  // Restore editor width
  if (viewState.editorWidth) {
    editorPanel.style.width = viewState.editorWidth;
  }

  // Restore resolution
  if (viewState.resolution) {
    const resolutionSelect = document.getElementById('resolution-select');
    resolutionSelect.value = viewState.resolution;

    const customWidth = document.getElementById('custom-width');
    const customHeight = document.getElementById('custom-height');
    const customX = document.getElementById('custom-x');

    if (viewState.resolution === 'custom') {
      customWidth.classList.remove('hidden');
      customHeight.classList.remove('hidden');
      customX.classList.remove('hidden');
      if (viewState.customWidth) customWidth.value = viewState.customWidth;
      if (viewState.customHeight) customHeight.value = viewState.customHeight;
      const w = parseInt(customWidth.value) || 1280;
      const h = parseInt(customHeight.value) || 720;
      state.renderer.setResolution(w, h);
    } else {
      const [w, h] = viewState.resolution.split('x').map(Number);
      if (w && h) state.renderer.setResolution(w, h);
    }
  }

  // Update layout classes
  updateLayoutClasses();
}

function updateLayoutClasses() {
  const rightPanel = document.getElementById('right-panel');

  if (!state.editorEnabled && state.gridEnabled && state.previewEnabled) {
    rightPanel.classList.add('side-by-side');
  } else {
    rightPanel.classList.remove('side-by-side');
  }
}
