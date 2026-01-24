// Controls module
import { state } from './state.js';
import { saveActiveSlotShader, startGridAnimation, stopGridAnimation } from './shader-grid.js';
import { saveViewState } from './view-state.js';
import { showSettingsDialog } from './settings.js';

export function initControls() {
  // New File button - show dialog
  const btnNew = document.getElementById('btn-new');
  const newFileDialog = document.getElementById('new-file-dialog');
  const newFileClose = document.getElementById('new-file-close');
  const newShaderBtn = document.getElementById('new-shader-btn');
  const newSceneBtn = document.getElementById('new-scene-btn');

  btnNew.addEventListener('click', () => {
    newFileDialog.classList.remove('hidden');
  });

  newFileClose.addEventListener('click', () => {
    newFileDialog.classList.add('hidden');
  });

  // Close on backdrop click
  newFileDialog.addEventListener('click', (e) => {
    if (e.target === newFileDialog) {
      newFileDialog.classList.add('hidden');
    }
  });

  // New Shader
  newShaderBtn.addEventListener('click', () => {
    newFileDialog.classList.add('hidden');
    window.electronAPI.newFile('shader');
  });

  // New Scene
  newSceneBtn.addEventListener('click', () => {
    newFileDialog.classList.add('hidden');
    window.electronAPI.newFile('scene');
  });

  // Open File button
  const btnOpen = document.getElementById('btn-open');
  btnOpen.addEventListener('click', () => {
    window.electronAPI.openFile();
  });

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

  // Editor toggle button
  const btnEditor = document.getElementById('btn-editor');
  btnEditor.addEventListener('click', toggleEditor);

  // Params toggle button
  const btnParams = document.getElementById('btn-params');
  btnParams.addEventListener('click', toggleParams);

  // NDI toggle button
  const btnNdi = document.getElementById('btn-ndi');
  btnNdi.addEventListener('click', toggleNDI);

  // Fullscreen button
  const btnFullscreen = document.getElementById('btn-fullscreen');
  btnFullscreen.addEventListener('click', openFullscreenPreview);

  // Blackout button
  const btnBlackout = document.getElementById('btn-blackout');
  btnBlackout.addEventListener('click', toggleBlackout);

  // Settings button
  const btnSettings = document.getElementById('btn-settings');
  btnSettings.addEventListener('click', showSettingsDialog);

  // Save shader button
  const btnSaveShader = document.getElementById('btn-save-shader');
  btnSaveShader.addEventListener('click', saveActiveSlotShader);

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
      state.renderer.setResolution(width, height);
    }
  });

  const updateResolution = () => {
    const width = parseInt(customWidth.value) || 1280;
    const height = parseInt(customHeight.value) || 720;
    state.renderer.setResolution(width, height);
  };

  customWidth.addEventListener('change', updateResolution);
  customHeight.addEventListener('change', updateResolution);
}

export function initResizer() {
  const resizer = document.getElementById('resizer');
  const resizerVertical = document.getElementById('resizer-vertical');
  const resizerBottom = document.getElementById('resizer-bottom');
  const editorPanel = document.getElementById('editor-panel');
  const previewPanel = document.getElementById('preview-panel');
  const bottomRow = document.getElementById('bottom-row');
  const gridPanel = document.getElementById('grid-panel');
  const paramsPanel = document.getElementById('params-panel');
  const rightPanel = document.getElementById('right-panel');

  let activeResizer = null;

  // Editor/Right panel horizontal resizer
  resizer.addEventListener('mousedown', (e) => {
    activeResizer = 'editor';
    resizer.classList.add('dragging');
    e.preventDefault();
  });

  // Preview/Bottom row vertical resizer
  resizerVertical.addEventListener('mousedown', (e) => {
    activeResizer = 'vertical';
    resizerVertical.classList.add('dragging');
    e.preventDefault();
  });

  // Grid/Params horizontal resizer
  resizerBottom.addEventListener('mousedown', (e) => {
    activeResizer = 'bottom';
    resizerBottom.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!activeResizer) return;

    if (activeResizer === 'editor') {
      const containerWidth = document.getElementById('main-content').offsetWidth;
      const newWidth = (e.clientX / containerWidth) * 100;
      if (newWidth >= 20 && newWidth <= 80) {
        editorPanel.style.width = `${newWidth}%`;
        state.editor.resize();
      }
    } else if (activeResizer === 'vertical') {
      const rightPanelRect = rightPanel.getBoundingClientRect();
      const relativeY = e.clientY - rightPanelRect.top;
      const totalHeight = rightPanelRect.height;
      const minPreviewHeight = 100;
      const minBottomHeight = 200;

      if (relativeY >= minPreviewHeight && relativeY <= totalHeight - minBottomHeight) {
        previewPanel.style.flex = 'none';
        previewPanel.style.height = `${relativeY}px`;
        bottomRow.style.height = `${totalHeight - relativeY - 4}px`; // 4px for resizer
      }
    } else if (activeResizer === 'bottom') {
      const bottomRowRect = bottomRow.getBoundingClientRect();
      const relativeX = e.clientX - bottomRowRect.left;
      const minGridWidth = 200;
      const minParamsWidth = 200;

      if (relativeX >= minGridWidth && relativeX <= bottomRowRect.width - minParamsWidth) {
        gridPanel.style.width = `${relativeX}px`;
        paramsPanel.style.flex = '1';
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (activeResizer) {
      resizer.classList.remove('dragging');
      resizerVertical.classList.remove('dragging');
      resizerBottom.classList.remove('dragging');
      activeResizer = null;
      saveViewState();
    }
  });
}

export function togglePlayback() {
  const isPlaying = state.renderer.togglePlayback();
  const btnPlay = document.getElementById('btn-play');
  btnPlay.innerHTML = isPlaying ?
    '<span class="icon">&#10074;&#10074;</span>' :
    '<span class="icon">&#9658;</span>';
  btnPlay.title = isPlaying ? 'Pause (Space)' : 'Play (Space)';

  // Sync to fullscreen window
  const stats = state.renderer.getStats();
  window.electronAPI.sendTimeSync({
    time: stats.time,
    frame: stats.frame,
    isPlaying: stats.isPlaying
  });
}

export function resetTime() {
  state.renderer.resetTime();

  // Sync to fullscreen window
  window.electronAPI.sendTimeSync({
    time: 0,
    frame: 0,
    isPlaying: state.renderer.isPlaying
  });
}

export function togglePreview() {
  state.previewEnabled = !state.previewEnabled;
  const btnPreview = document.getElementById('btn-preview');
  const previewPanel = document.getElementById('preview-panel');

  if (state.previewEnabled) {
    btnPreview.classList.add('active');
    btnPreview.title = 'Disable Preview';
    previewPanel.classList.remove('hidden');
  } else {
    btnPreview.classList.remove('active');
    btnPreview.title = 'Enable Preview';
    previewPanel.classList.add('hidden');
  }

  updatePanelVisibility();
  saveViewState();
}

export function toggleGrid() {
  state.gridEnabled = !state.gridEnabled;
  const btnGrid = document.getElementById('btn-grid');
  const gridPanel = document.getElementById('grid-panel');

  if (state.gridEnabled) {
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

  updatePanelVisibility();
  saveViewState();
}

export function toggleEditor() {
  state.editorEnabled = !state.editorEnabled;
  const btnEditor = document.getElementById('btn-editor');
  const editorPanel = document.getElementById('editor-panel');

  if (state.editorEnabled) {
    btnEditor.classList.add('active');
    btnEditor.title = 'Hide Editor';
    editorPanel.classList.remove('hidden');
  } else {
    btnEditor.classList.remove('active');
    btnEditor.title = 'Show Editor';
    editorPanel.classList.add('hidden');
  }

  updatePanelVisibility();
  saveViewState();
}

export function toggleParams() {
  state.paramsEnabled = !state.paramsEnabled;
  const btnParams = document.getElementById('btn-params');
  const paramsPanel = document.getElementById('params-panel');

  if (state.paramsEnabled) {
    btnParams.classList.add('active');
    btnParams.title = 'Hide Parameters';
    paramsPanel.classList.remove('hidden');
  } else {
    btnParams.classList.remove('active');
    btnParams.title = 'Show Parameters';
    paramsPanel.classList.add('hidden');
  }

  updatePanelVisibility();
  saveViewState();
}

export function updatePanelVisibility() {
  const rightPanel = document.getElementById('right-panel');
  const resizer = document.getElementById('resizer');
  const resizerVertical = document.getElementById('resizer-vertical');
  const resizerBottom = document.getElementById('resizer-bottom');
  const editorPanel = document.getElementById('editor-panel');
  const bottomRow = document.getElementById('bottom-row');

  const rightVisible = state.previewEnabled || state.gridEnabled || state.paramsEnabled;
  const leftVisible = state.editorEnabled;
  const bottomVisible = state.gridEnabled || state.paramsEnabled;

  // Show/hide vertical resizer between preview and bottom row
  if (state.previewEnabled && bottomVisible) {
    resizerVertical.classList.remove('hidden');
  } else {
    resizerVertical.classList.add('hidden');
  }

  // Show/hide bottom row and horizontal resizer
  if (bottomVisible) {
    bottomRow.classList.remove('hidden');
    // Show resizer between grid and params only if both visible
    if (state.gridEnabled && state.paramsEnabled) {
      resizerBottom.classList.remove('hidden');
    } else {
      resizerBottom.classList.add('hidden');
    }
  } else {
    bottomRow.classList.add('hidden');
    resizerBottom.classList.add('hidden');
  }

  if (!rightVisible && leftVisible) {
    // Only editor - full width
    rightPanel.classList.add('hidden');
    resizer.classList.add('hidden');
    editorPanel.style.width = '100%';
  } else if (rightVisible && !leftVisible) {
    // Only right panel - full width
    rightPanel.classList.remove('hidden');
    rightPanel.style.width = '100%';
    resizer.classList.add('hidden');
    editorPanel.style.width = '';
  } else if (rightVisible && leftVisible) {
    // Both visible
    rightPanel.classList.remove('hidden');
    rightPanel.style.width = '';
    resizer.classList.remove('hidden');
    editorPanel.style.width = '';
  } else {
    // Neither visible - show editor by default
    state.editorEnabled = true;
    const btnEditor = document.getElementById('btn-editor');
    btnEditor.classList.add('active');
    editorPanel.classList.remove('hidden');
    editorPanel.style.width = '100%';
    rightPanel.classList.add('hidden');
    resizer.classList.add('hidden');
  }

  state.editor.resize();
}

export function toggleNDI() {
  window.electronAPI.toggleNDI();
}

export function openFullscreenPreview() {
  window.electronAPI.openFullscreen();
}

export function toggleBlackout() {
  state.blackoutEnabled = !state.blackoutEnabled;
  const btnBlackout = document.getElementById('btn-blackout');

  if (state.blackoutEnabled) {
    btnBlackout.classList.add('active');
    btnBlackout.title = 'Disable Blackout (B)';
  } else {
    btnBlackout.classList.remove('active');
    btnBlackout.title = 'Blackout Fullscreen (B)';
  }

  window.electronAPI.sendBlackout(state.blackoutEnabled);
}
