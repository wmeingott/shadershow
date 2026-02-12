// IPC Handlers module
import { state, notifyRemoteStateChanged } from './state.js';
import { setStatus, updateChannelSlot } from './utils.js';
import { compileShader, setEditorMode } from './editor.js';
import { togglePlayback, resetTime, resetFullscreenSelect } from './controls.js';
import { runBenchmark } from './benchmark.js';
import { loadGridPresetsFromData, saveGridState, selectGridSlot, switchShaderTab } from './shader-grid.js';
import { recallLocalPreset } from './presets.js';
import { loadParamsToSliders } from './params.js';
import { updatePreviewFrameLimit, setRenderMode, detectRenderMode, restartRender } from './renderer.js';
import { createTab, openInTab, activeTabHasChanges, markTabSaved, getActiveTab } from './tabs.js';
import { tileState } from './tile-state.js';
import { isMixerActive, assignShaderToMixer, clearMixerChannel, resetMixer, recallMixState } from './mixer.js';

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
  window.electronAPI.onTogglePlayback(() => {
    // Ignore Space-triggered toggle when editor or any text input is focused
    const active = document.activeElement;
    if (active && (active.closest('#editor') || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
      return;
    }
    togglePlayback();
  });
  window.electronAPI.onResetTime(resetTime);
  window.electronAPI.onRunBenchmark(runBenchmark);
  window.electronAPI.onRestartRender(restartRender);

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

  // =========================================================================
  // Remote Control Handlers
  // =========================================================================
  initRemoteHandlers();

  // Listen for remote state change notifications from other modules
  window.addEventListener('remote-state-changed', () => {
    sendRemoteStateUpdate();
  });
}

// =============================================================================
// Remote Control — State Snapshot Builders & Action Handlers
// =============================================================================

function buildRemoteStateSnapshot() {
  const filename = (fp) => fp ? fp.split('/').pop().split('\\').pop() : null;

  return {
    tabs: state.shaderTabs.map((tab, i) => ({
      name: tab.name,
      type: tab.type || 'shaders',
      slots: tab.type !== 'mix' ? (tab.slots || []).map((s, j) => s ? {
        index: j,
        label: s.label || filename(s.filePath) || `Slot ${j + 1}`,
        hasShader: !!s.shaderCode,
        presetCount: (s.presets || []).length,
        presetNames: (s.presets || []).map(p => p.name || `Preset ${(s.presets || []).indexOf(p) + 1}`)
      } : null).filter(Boolean) : undefined,
      mixPresets: tab.type === 'mix' ? (tab.mixPresets || []).map((p, j) => ({
        index: j,
        name: p.name
      })) : undefined
    })),
    activeTab: state.activeShaderTab,
    activeSlot: state.activeGridSlot,
    mixer: {
      enabled: state.mixerEnabled,
      blendMode: state.mixerBlendMode,
      selectedChannel: state.mixerSelectedChannel,
      channels: state.mixerChannels.map(ch => ({
        slotIndex: ch.slotIndex,
        tabIndex: ch.tabIndex,
        alpha: ch.alpha,
        hasShader: ch.slotIndex !== null || !!ch.renderer,
        label: ch.slotIndex !== null ? `Slot ${ch.slotIndex + 1}` : ch.renderer ? 'Mix' : null
      }))
    },
    params: buildCurrentParams(),
    customParamDefs: getCustomParamDefs(),
    presets: getCurrentSlotPresetNames(),
    playback: {
      isPlaying: state.renderer?.getStats?.()?.isPlaying ?? true,
      time: state.renderer?.getStats?.()?.time || 0
    },
    blackout: state.blackoutEnabled
  };
}

function buildCurrentParams() {
  const params = {};
  if (state.renderer) {
    const stats = state.renderer.getStats?.();
    // Speed
    const speedSlider = document.getElementById('param-speed');
    if (speedSlider) params.speed = parseFloat(speedSlider.value);

    // Custom params
    const customValues = state.renderer.getCustomParamValues?.();
    if (customValues) {
      Object.assign(params, customValues);
    }
  }
  return params;
}

function getCustomParamDefs() {
  if (!state.renderer?.getCustomParamDefs) return [];
  return state.renderer.getCustomParamDefs().map(p => ({
    name: p.name,
    type: p.type,
    min: p.min,
    max: p.max,
    default: p.default,
    description: p.description,
    isArray: p.isArray || false,
    arraySize: p.arraySize || 0
  }));
}

function getCurrentSlotPresetNames() {
  if (state.activeGridSlot === null || !state.gridSlots[state.activeGridSlot]) return [];
  const presets = state.gridSlots[state.activeGridSlot].presets || [];
  return presets.map((p, i) => p.name || `Preset ${i + 1}`);
}

// Send full state update to remote clients
export function sendRemoteStateUpdate() {
  window.electronAPI.sendRemoteStateChanged({
    type: 'state-update',
    data: buildRemoteStateSnapshot()
  });
}

function initRemoteHandlers() {
  // ---- State queries (request → response) ----

  window.electronAPI.onRemoteGetState(() => {
    const snapshot = buildRemoteStateSnapshot();
    window.electronAPI.sendRemoteGetStateResponse(snapshot);
  });

  window.electronAPI.onRemoteGetThumbnail((req) => {
    const { tabIndex, slotIndex } = req || {};
    let dataUrl = null;

    try {
      const tab = state.shaderTabs[tabIndex];
      if (tab && tab.type !== 'mix') {
        const slot = tab.slots?.[slotIndex];
        if (slot && slot.renderer) {
          // Use existing canvas to capture thumbnail
          const canvas = slot.renderer.canvas;
          if (canvas && canvas.width > 0) {
            dataUrl = canvas.toDataURL('image/jpeg', 0.6);
          }
        }
      }
    } catch (err) {
      console.warn('Remote thumbnail error:', err);
    }

    window.electronAPI.sendRemoteGetThumbnailResponse({
      tabIndex, slotIndex, dataUrl
    });
  });

  // ---- Action dispatch (fire-and-forget) ----

  window.electronAPI.onRemoteSelectTab(({ tabIndex }) => {
    if (typeof tabIndex === 'number') {
      switchShaderTab(tabIndex);
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteSelectSlot(({ slotIndex }) => {
    if (typeof slotIndex === 'number') {
      selectGridSlot(slotIndex);
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteSetParam(({ name, value }) => {
    if (!name || !state.renderer) return;

    if (name === 'speed') {
      const speedSlider = document.getElementById('param-speed');
      const speedValue = document.getElementById('param-speed-value');
      if (speedSlider) {
        speedSlider.value = value;
        if (speedValue) speedValue.textContent = parseFloat(value).toFixed(2);
      }
      state.renderer.setParam('speed', value);
      window.electronAPI.sendParamUpdate({ name: 'speed', value });
    } else {
      state.renderer.setParam(name, value);
      window.electronAPI.sendParamUpdate({ name, value });
    }

    // Store to active grid slot
    if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
      const slot = state.gridSlots[state.activeGridSlot];
      if (name === 'speed') {
        if (!slot.params) slot.params = {};
        slot.params.speed = value;
      } else {
        if (!slot.customParams) slot.customParams = {};
        slot.customParams[name] = value;
      }
    }
  });

  window.electronAPI.onRemoteRecallPreset(({ presetIndex }) => {
    if (typeof presetIndex === 'number') {
      recallLocalPreset(presetIndex);
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteMixerAssign(({ channelIndex, slotIndex }) => {
    if (typeof channelIndex === 'number' && typeof slotIndex === 'number') {
      assignShaderToMixer(channelIndex, slotIndex);
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteMixerClear(({ channelIndex }) => {
    if (typeof channelIndex === 'number') {
      clearMixerChannel(channelIndex);
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteMixerAlpha(({ channelIndex, value }) => {
    if (typeof channelIndex !== 'number') return;
    const ch = state.mixerChannels[channelIndex];
    if (ch) {
      ch.alpha = value;
      const slider = document.querySelectorAll('#mixer-channels .mixer-slider')[channelIndex];
      if (slider) slider.value = String(value);
      window.electronAPI.sendMixerAlphaUpdate({ channelIndex, alpha: value });
    }
  });

  window.electronAPI.onRemoteMixerSelect(({ channelIndex }) => {
    if (typeof channelIndex === 'number') {
      // Simulate selecting the mixer channel
      const btns = document.querySelectorAll('#mixer-channels .mixer-btn');
      btns.forEach(b => b.classList.remove('selected'));
      btns[channelIndex]?.classList.add('selected');
      state.mixerSelectedChannel = channelIndex;
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteMixerBlend(({ mode }) => {
    if (mode) {
      state.mixerBlendMode = mode;
      const select = document.getElementById('mixer-blend-mode');
      if (select) select.value = mode;
      window.electronAPI.sendMixerBlendMode({ blendMode: mode });
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteMixerReset(() => {
    resetMixer();
    sendRemoteStateUpdate();
  });

  window.electronAPI.onRemoteMixerToggle(() => {
    state.mixerEnabled = !state.mixerEnabled;
    const btn = document.getElementById('mixer-toggle-btn');
    if (btn) btn.classList.toggle('active', state.mixerEnabled);
    sendRemoteStateUpdate();
  });

  window.electronAPI.onRemoteRecallMixPreset(({ tabIndex, presetIndex }) => {
    if (typeof tabIndex !== 'number' || typeof presetIndex !== 'number') return;
    const tab = state.shaderTabs[tabIndex];
    if (tab?.type === 'mix' && tab.mixPresets?.[presetIndex]) {
      recallMixState(tab.mixPresets[presetIndex]);
      sendRemoteStateUpdate();
    }
  });

  window.electronAPI.onRemoteTogglePlayback(() => {
    togglePlayback();
    sendRemoteStateUpdate();
  });

  window.electronAPI.onRemoteResetTime(() => {
    resetTime();
    sendRemoteStateUpdate();
  });

  window.electronAPI.onRemoteBlackout(({ enabled }) => {
    state.blackoutEnabled = !!enabled;
    window.electronAPI.sendBlackout(state.blackoutEnabled);

    const canvas = document.getElementById('shader-canvas');
    if (canvas) canvas.style.opacity = state.blackoutEnabled ? '0' : '1';

    sendRemoteStateUpdate();
  });
}
