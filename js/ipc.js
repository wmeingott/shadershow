// IPC Handlers module
import { state } from './state.js';
import { setStatus, updateChannelSlot } from './utils.js';
import { compileShader } from './editor.js';
import { togglePlayback, resetTime } from './controls.js';
import { loadGridPresetsFromData, saveGridState } from './shader-grid.js';

export function initIPC() {
  // File operations
  window.electronAPI.onFileOpened(({ content, filePath }) => {
    state.editor.setValue(content, -1);
    compileShader();
  });

  window.electronAPI.onNewFile(() => {
    window.electronAPI.getDefaultShader().then(defaultShader => {
      state.editor.setValue(defaultShader, -1);
      compileShader();
    });
  });

  window.electronAPI.onRequestContentForSave(() => {
    window.electronAPI.saveContent(state.editor.getValue());
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

  // Fullscreen state request
  window.electronAPI.onRequestFullscreenState(() => {
    const stats = state.renderer.getStats();
    const fullscreenState = {
      shaderCode: state.editor.getValue(),
      time: stats.time,
      frame: stats.frame,
      isPlaying: stats.isPlaying,
      channels: state.channelState,
      params: state.renderer.getParams()
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

  // NDI input frame received
  window.electronAPI.onNDIInputFrame(({ channel, width, height, data }) => {
    if (state.channelState[channel]?.type === 'ndi') {
      // Convert base64 to Uint8Array
      const binaryString = atob(data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      state.renderer.setNDIFrame(channel, width, height, bytes);
    }
  });
}
