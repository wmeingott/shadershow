// View State module
import { state } from './state.js';
import { startGridAnimation, rebuildVisualPresetsDOM } from './shader-grid.js';
import { getConsolePanelState, restoreConsolePanelState } from './console-panel.js';

export function saveViewState() {
  const editorPanel = document.getElementById('editor-panel');
  const resolutionSelect = document.getElementById('resolution-select');
  const customWidth = document.getElementById('custom-width');
  const customHeight = document.getElementById('custom-height');

  const previewPanel = document.getElementById('preview-panel');
  const gridPanel = document.getElementById('grid-panel');

  const consoleState = getConsolePanelState();
  const viewState = {
    editorEnabled: state.editorEnabled,
    previewEnabled: state.previewEnabled,
    gridEnabled: state.gridEnabled,
    paramsEnabled: state.paramsEnabled,
    editorWidth: editorPanel.style.width || '50%',
    previewHeight: previewPanel.style.height || '',
    gridWidth: gridPanel.style.width || '',
    resolution: resolutionSelect.value,
    customWidth: customWidth.value,
    customHeight: customHeight.value,
    consolePanelHeight: consoleState.height,
    consolePanelCollapsed: consoleState.collapsed,
    visualPresetsEnabled: state.visualPresetsEnabled
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

  // Restore editor width (validate format: must be percentage like "50%")
  if (viewState.editorWidth && /^\d{1,3}(\.\d+)?%$/.test(viewState.editorWidth)) {
    const pct = parseFloat(viewState.editorWidth);
    if (pct >= 10 && pct <= 90) {
      editorPanel.style.width = viewState.editorWidth;
    }
  }

  // Restore preview height (percentage or pixel value)
  if (viewState.previewHeight) {
    previewPanel.style.flex = 'none';
    previewPanel.style.height = viewState.previewHeight;
  }

  // Restore grid panel width
  if (viewState.gridWidth) {
    gridPanel.style.flex = 'none';
    gridPanel.style.width = viewState.gridWidth;
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
      const w = Math.min(Math.max(parseInt(customWidth.value) || 1280, 1), 7680);
      const h = Math.min(Math.max(parseInt(customHeight.value) || 720, 1), 4320);
      state.renderer.setResolution(w, h);
    } else if (/^\d+x\d+$/.test(viewState.resolution)) {
      const [w, h] = viewState.resolution.split('x').map(Number);
      if (w >= 1 && w <= 7680 && h >= 1 && h <= 4320) {
        state.renderer.setResolution(w, h);
      }
    }
  }

  // Restore visual presets panel visibility
  if (viewState.visualPresetsEnabled) {
    state.visualPresetsEnabled = true;
    const vpPanel = document.getElementById('visual-presets-panel');
    if (vpPanel) vpPanel.classList.remove('hidden');
    document.getElementById('btn-visual-presets')?.classList.add('active');
    rebuildVisualPresetsDOM();
  }

  // Restore console panel state
  if (viewState.consolePanelHeight !== undefined || viewState.consolePanelCollapsed !== undefined) {
    restoreConsolePanelState({
      height: viewState.consolePanelHeight,
      collapsed: viewState.consolePanelCollapsed
    });
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
