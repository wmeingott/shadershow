// IPC Handlers module
import { state } from './state.js';
import { setStatus, updateChannelSlot } from './utils.js';
import { compileShader, setEditorMode } from './editor.js';
import { togglePlayback, resetTime, resetFullscreenSelect } from './controls.js';
import { runBenchmark } from './benchmark.js';
import { loadGridPresetsFromData, saveGridState } from './shader-grid.js';
import { recallLocalPreset } from './presets.js';
import { loadParamsToSliders } from './params.js';
import { updatePreviewFrameLimit, setRenderMode, detectRenderMode } from './renderer.js';
import { createTab, openInTab, activeTabHasChanges, markTabSaved, getActiveTab } from './tabs.js';
import { tileState } from './tile-state.js';
import { isMixerActive } from './mixer.js';

export async function initIPC() {
  // Load initial settings (including ndiFrameSkip)
  try {
    const settings = await window.electronAPI.getSettings();
    if (settings.ndiFrameSkip) {
      state.ndiFrameSkip = settings.ndiFrameSkip;
    }
  } catch (err) {
    console.warn('Failed to load initial settings:', err);
  }

  // File operations
  window.electronAPI.onFileOpened(({ content, filePath }) => {
    // Detect render mode from file extension/content
    const mode = detectRenderMode(filePath, content);

    // Open in a new tab (or activate existing if already open)
    openInTab({
      content,
      filePath,
      type: mode,
      activate: true
    });
  });

  window.electronAPI.onNewFile(async (data) => {
    const fileType = data?.fileType || 'shader';

    if (fileType === 'scene') {
      const defaultScene = await window.electronAPI.getDefaultScene();
      createTab({
        content: defaultScene,
        type: 'scene',
        title: 'Untitled Scene',
        activate: true
      });
    } else {
      const defaultShader = await window.electronAPI.getDefaultShader();
      createTab({
        content: defaultShader,
        type: 'shader',
        title: 'Untitled Shader',
        activate: true
      });
    }
  });

  window.electronAPI.onRequestContentForSave(() => {
    const content = state.editor.getValue();
    window.electronAPI.saveContent(content);
    // Mark current tab as saved
    const activeTab = getActiveTab();
    if (activeTab) {
      markTabSaved(activeTab.id);
    }
  });

  // Check if editor has unsaved changes
  window.electronAPI.onCheckEditorChanges(() => {
    const hasChanges = activeTabHasChanges();
    window.electronAPI.sendEditorHasChanges(hasChanges);
  });

  // Texture loading
  window.electronAPI.onTextureLoaded(async ({ channel, dataUrl, filePath }) => {
    try {
      const result = await state.renderer.loadTexture(channel, dataUrl);
      state.channelState[channel] = { type: 'image', dataUrl, filePath };
      updateChannelSlot(channel, 'image', filePath, result.width, result.height, dataUrl);
      setStatus(`Loaded texture to iChannel${channel}`, 'success');
    } catch (err) {
      setStatus(`Failed to load texture: ${err.message}`, 'error');
    }
  });

  // Video loading
  window.electronAPI.onVideoLoaded(async ({ channel, filePath }) => {
    try {
      const result = await state.renderer.loadVideo(channel, filePath);
      state.channelState[channel] = { type: 'video', filePath };
      updateChannelSlot(channel, 'video', filePath, result.width, result.height);
      setStatus(`Loaded video to iChannel${channel}`, 'success');
    } catch (err) {
      setStatus(`Failed to load video: ${err.message}`, 'error');
    }
  });

  // Camera loading
  window.electronAPI.onCameraRequested(async ({ channel }) => {
    try {
      const result = await state.renderer.loadCamera(channel);
      state.channelState[channel] = { type: 'camera' };
      updateChannelSlot(channel, 'camera', 'Camera', result.width, result.height);
      setStatus(`Camera connected to iChannel${channel}`, 'success');
    } catch (err) {
      setStatus(`Failed to access camera: ${err.message}`, 'error');
    }
  });

  // Audio loading
  window.electronAPI.onAudioRequested(async ({ channel }) => {
    try {
      const result = await state.renderer.loadAudio(channel);
      state.channelState[channel] = { type: 'audio' };
      updateChannelSlot(channel, 'audio', 'Audio FFT', result.width, result.height);
      setStatus(`Audio input connected to iChannel${channel}`, 'success');
    } catch (err) {
      setStatus(`Failed to access audio: ${err.message}`, 'error');
    }
  });

  // Channel clear
  window.electronAPI.onChannelCleared(({ channel }) => {
    state.renderer.clearChannel(channel);
    state.channelState[channel] = null;
    updateChannelSlot(channel, 'empty');
    setStatus(`Cleared iChannel${channel}`, 'success');
  });

  // Shader controls from menu
  window.electronAPI.onCompileShader(compileShader);
  window.electronAPI.onTogglePlayback(togglePlayback);
  window.electronAPI.onResetTime(resetTime);
  window.electronAPI.onRunBenchmark(runBenchmark);

  // Fullscreen state request
  window.electronAPI.onRequestFullscreenState(() => {
    const stats = state.renderer.getStats();

    // Get shader code from active grid slot if selected, otherwise from editor
    let shaderCode = state.editor.getValue();
    let localPresets = [];
    if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
      shaderCode = state.gridSlots[state.activeGridSlot].shaderCode || shaderCode;
      localPresets = state.gridSlots[state.activeGridSlot].presets || [];
    }

    // Build tiled mode configuration if enabled
    let tiledConfig = null;
    console.log('Building fullscreen state, tiledPreviewEnabled:', state.tiledPreviewEnabled);
    if (state.tiledPreviewEnabled) {
      const tiles = tileState.tiles.map((tile) => {
        if (!tile || tile.gridSlotIndex === null) {
          return { gridSlotIndex: null, shaderCode: null, params: null, visible: true };
        }
        const slotData = state.gridSlots[tile.gridSlotIndex];
        if (!slotData) {
          return { gridSlotIndex: tile.gridSlotIndex, shaderCode: null, params: null, visible: tile.visible };
        }
        const params = {
          speed: tile.params?.speed ?? slotData.params?.speed ?? 1,
          ...(slotData.customParams || {}),
          ...(tile.customParams || {})
        };
        return {
          gridSlotIndex: tile.gridSlotIndex,
          shaderCode: slotData.shaderCode,
          params,
          visible: tile.visible !== false
        };
      });
      // Include preview resolution so fullscreen can match aspect ratio
      const previewCanvas = document.getElementById('shader-canvas');
      tiledConfig = {
        layout: { ...tileState.layout },
        tiles,
        previewResolution: {
          width: previewCanvas.width,
          height: previewCanvas.height
        }
      };
      console.log('Built tiledConfig:', tiledConfig);
    }

    // Build mixer configuration if mixer is active
    let mixerConfig = null;
    if (isMixerActive()) {
      const previewCanvas = document.getElementById('shader-canvas');
      mixerConfig = {
        blendMode: state.mixerBlendMode,
        channels: state.mixerChannels.map(ch => {
          // Grid-assigned channel: use tab-aware lookup
          if (ch.slotIndex !== null && ch.tabIndex !== null) {
            const tab = state.shaderTabs[ch.tabIndex];
            const slotData = tab?.slots?.[ch.slotIndex];
            if (!slotData) return null;
            return {
              shaderCode: slotData.shaderCode,
              alpha: ch.alpha,
              params: { speed: ch.params.speed ?? slotData.params?.speed ?? 1, ...ch.customParams }
            };
          }
          // Recalled mix preset: use stored shaderCode
          if (ch.shaderCode) {
            return {
              shaderCode: ch.shaderCode,
              alpha: ch.alpha,
              params: { speed: ch.params.speed ?? 1, ...ch.customParams }
            };
          }
          return null;
        }),
        previewResolution: { width: previewCanvas.width, height: previewCanvas.height }
      };
    }

    console.log('Sending fullscreen state with tiledConfig:', tiledConfig ? 'yes' : 'no', 'mixerConfig:', mixerConfig ? 'yes' : 'no');
    const fullscreenState = {
      shaderCode: shaderCode,
      renderMode: state.renderMode,  // Include render mode for scene support
      time: stats.time,
      frame: stats.frame,
      isPlaying: stats.isPlaying,
      channels: state.channelState,
      params: state.renderer.getParams(),
      localPresets: localPresets,
      activeLocalPresetIndex: state.activeLocalPresetIndex,
      tiledConfig: tiledConfig,  // Include tiled mode config
      mixerConfig: mixerConfig   // Include mixer mode config
    };
    window.electronAPI.sendFullscreenState(fullscreenState);
  });

  // Grid presets save/load
  window.electronAPI.onRequestGridStateForSave(() => {
    const gridState = state.gridSlots.map(slot => {
      if (!slot) return null;
      return {
        shaderCode: slot.shaderCode,
        filePath: slot.filePath
      };
    });
    window.electronAPI.saveGridPresetsToFile(gridState);
  });

  window.electronAPI.onGridPresetsSaved(({ filePath }) => {
    const fileName = filePath.split('/').pop().split('\\').pop();
    setStatus(`Grid presets saved to ${fileName}`, 'success');
  });

  window.electronAPI.onLoadGridPresets(({ gridState, filePath }) => {
    loadGridPresetsFromData(gridState, filePath);
  });

  // NDI status
  window.electronAPI.onNDIStatus(({ enabled, width, height }) => {
    state.ndiEnabled = enabled;
    const btnNdi = document.getElementById('btn-ndi');
    if (enabled) {
      btnNdi.classList.add('active');
      btnNdi.title = `NDI Output Active (${width}x${height})`;
      setStatus(`NDI output started at ${width}x${height}`, 'success');
    } else {
      btnNdi.classList.remove('active');
      btnNdi.title = 'Toggle NDI Output';
      setStatus('NDI output stopped', 'success');
    }
  });

  // NDI frame skip changed
  window.electronAPI.onNDIFrameSkipChanged?.((frameSkip) => {
    state.ndiFrameSkip = frameSkip;
    const fpsMap = { 1: 60, 2: 30, 3: 20, 4: 15, 6: 10 };
    const fps = fpsMap[frameSkip] || Math.round(60 / frameSkip);
    setStatus(`NDI frame rate set to ${fps} fps`, 'success');
  });

  // Recording status
  window.electronAPI.onRecordingStatus(({ enabled, filePath, exitCode, error }) => {
    if (!enabled) {
      state.recordingEnabled = false;
      const btnRecord = document.getElementById('btn-record');
      if (btnRecord) {
        btnRecord.classList.remove('active');
        btnRecord.title = 'Start Recording (Cmd+Shift+R)';
      }
      if (error) {
        setStatus(`Recording error: ${error}`, 'error');
      } else if (filePath && exitCode === 0) {
        const fileName = filePath.split('/').pop().split('\\').pop();
        setStatus(`Recording saved: ${fileName}`, 'success');
      } else if (exitCode !== 0 && exitCode !== undefined) {
        setStatus(`Recording finished with errors (exit code ${exitCode})`, 'error');
      }
    }
  });

  // Preview resolution request for recording "Match Preview" option
  window.electronAPI.onRequestPreviewResolutionForRecording?.(() => {
    const canvas = document.getElementById('shader-canvas');
    window.electronAPI.sendPreviewResolutionForRecording({
      width: canvas.width,
      height: canvas.height
    });
  });

  // Syphon status (macOS only)
  window.electronAPI.onSyphonStatus(({ enabled, error }) => {
    state.syphonEnabled = enabled;
    if (enabled) {
      setStatus('Syphon output started', 'success');
    } else if (error) {
      setStatus(`Syphon error: ${error}`, 'error');
    } else {
      setStatus('Syphon output stopped', 'success');
    }
  });

  // Preset sync from fullscreen window
  window.electronAPI.onPresetSync((data) => {
    // Apply params directly from sync message to renderer and sliders
    if (data.params) {
      loadParamsToSliders(data.params);
    }

    // Update highlighting without triggering another sync
    if (data.type === 'local') {
      state.activeLocalPresetIndex = data.index;
      document.querySelectorAll('.preset-btn.local-preset').forEach((btn, i) => {
        btn.classList.toggle('active', i === data.index);
      });
    }
  });

  // Preview resolution request for NDI "Match Preview" option
  window.electronAPI.onRequestPreviewResolution(() => {
    const canvas = document.getElementById('shader-canvas');
    window.electronAPI.sendPreviewResolution({
      width: canvas.width,
      height: canvas.height
    });
  });

  // NDI input source set
  window.electronAPI.onNDISourceSet(({ channel, source, width, height }) => {
    state.renderer.initNDIChannel(channel, source);
    state.channelState[channel] = { type: 'ndi', source };
    updateChannelSlot(channel, 'ndi', source, width || 0, height || 0);
    setStatus(`NDI source "${source}" connected to iChannel${channel}`, 'success');
  });

  // NDI input frame received (binary data via structured clone)
  window.electronAPI.onNDIInputFrame(({ channel, width, height, data }) => {
    if (state.channelState[channel]?.type === 'ndi') {
      // data is already a Uint8Array (sent as binary from main process)
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      state.renderer.setNDIFrame(channel, width, height, bytes);
    }
  });

  // Fullscreen FPS display and adaptive preview framerate
  window.electronAPI.onFullscreenFps((fps) => {
    // Update state for adaptive preview framerate
    state.fullscreenFps = fps;
    state.fullscreenActive = true;
    updatePreviewFrameLimit();

    // Update UI display
    const fpsDisplay = document.getElementById('fullscreen-fps');
    if (fpsDisplay) {
      fpsDisplay.textContent = `${fps} fps`;
      fpsDisplay.classList.remove('active', 'low', 'very-low');
      if (fps >= 50) {
        fpsDisplay.classList.add('active');
      } else if (fps >= 30) {
        fpsDisplay.classList.add('low');
      } else {
        fpsDisplay.classList.add('very-low');
      }
    }
  });

  // Track fullscreen window closed
  window.electronAPI.onFullscreenClosed(() => {
    state.fullscreenActive = false;
    state.fullscreenFps = 0;
    state.previewFrameInterval = 0;  // Remove frame limiting

    // Reset FPS display
    const fpsDisplay = document.getElementById('fullscreen-fps');
    if (fpsDisplay) {
      fpsDisplay.textContent = '-- fps';
      fpsDisplay.classList.remove('active', 'low', 'very-low');
    }

    // Reset fullscreen select to "No Fullscreen"
    resetFullscreenSelect();
  });

  // Sync fullscreen select when opened via menu (Cmd+F)
  window.electronAPI.onFullscreenOpened((displayId) => {
    const select = document.getElementById('fullscreen-select');
    if (select) select.value = String(displayId);
  });
}
