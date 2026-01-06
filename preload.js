const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  onFileOpened: (callback) => ipcRenderer.on('file-opened', (event, data) => callback(data)),
  onNewFile: (callback) => ipcRenderer.on('new-file', () => callback()),
  onRequestContentForSave: (callback) => ipcRenderer.on('request-content-for-save', () => callback()),
  saveContent: (content) => ipcRenderer.send('save-content', content),
  getDefaultShader: () => ipcRenderer.invoke('get-default-shader'),

  // Texture operations
  onTextureLoaded: (callback) => ipcRenderer.on('texture-loaded', (event, data) => callback(data)),

  // Video operations
  onVideoLoaded: (callback) => ipcRenderer.on('video-loaded', (event, data) => callback(data)),

  // Camera operations
  onCameraRequested: (callback) => ipcRenderer.on('camera-requested', (event, data) => callback(data)),

  // Audio operations
  onAudioRequested: (callback) => ipcRenderer.on('audio-requested', (event, data) => callback(data)),

  // Channel clear
  onChannelCleared: (callback) => ipcRenderer.on('channel-cleared', (event, data) => callback(data)),

  // Shader controls
  onCompileShader: (callback) => ipcRenderer.on('compile-shader', () => callback()),
  onTogglePlayback: (callback) => ipcRenderer.on('toggle-playback', () => callback()),
  onResetTime: (callback) => ipcRenderer.on('reset-time', () => callback()),

  // Fullscreen operations (main window)
  onRequestFullscreenState: (callback) => ipcRenderer.on('request-fullscreen-state', () => callback()),
  sendFullscreenState: (state) => ipcRenderer.send('fullscreen-state', state),
  sendShaderUpdate: (data) => ipcRenderer.send('shader-update', data),
  sendTimeSync: (data) => ipcRenderer.send('time-sync', data),
  sendParamUpdate: (data) => ipcRenderer.send('param-update', data),

  // Fullscreen operations (fullscreen window)
  onInitFullscreen: (callback) => ipcRenderer.on('init-fullscreen', (event, data) => callback(data)),
  onShaderUpdate: (callback) => ipcRenderer.on('shader-update', (event, data) => callback(data)),
  onTimeSync: (callback) => ipcRenderer.on('time-sync', (event, data) => callback(data)),
  onParamUpdate: (callback) => ipcRenderer.on('param-update', (event, data) => callback(data)),

  // Grid operations
  loadShaderForGrid: () => ipcRenderer.invoke('load-shader-for-grid'),
  openFullscreenWithShader: (shaderState) => ipcRenderer.send('open-fullscreen-with-shader', shaderState),
  saveGridState: (gridState) => ipcRenderer.send('save-grid-state', gridState),
  loadGridState: () => ipcRenderer.invoke('load-grid-state'),

  // Grid presets file operations
  onRequestGridStateForSave: (callback) => ipcRenderer.on('request-grid-state-for-save', () => callback()),
  saveGridPresetsToFile: (gridState) => ipcRenderer.send('save-grid-presets-to-file', gridState),
  onGridPresetsSaved: (callback) => ipcRenderer.on('grid-presets-saved', (event, data) => callback(data)),
  onLoadGridPresets: (callback) => ipcRenderer.on('load-grid-presets', (event, data) => callback(data)),

  // NDI output
  onNDIStatus: (callback) => ipcRenderer.on('ndi-status', (event, data) => callback(data)),
  sendNDIFrame: (frameData) => ipcRenderer.send('ndi-frame', frameData),
  onRequestPreviewResolution: (callback) => ipcRenderer.on('request-preview-resolution', () => callback()),
  sendPreviewResolution: (data) => ipcRenderer.send('preview-resolution', data),
  toggleNDI: () => ipcRenderer.send('toggle-ndi'),
  openFullscreen: () => ipcRenderer.send('open-fullscreen-primary'),

  // NDI input (sources as channel textures)
  findNDISources: () => ipcRenderer.invoke('find-ndi-sources'),
  setChannelNDI: (channel, source) => ipcRenderer.send('set-channel-ndi', { channel, source }),
  clearChannelNDI: (channel) => ipcRenderer.send('clear-channel-ndi', { channel }),
  onNDIInputFrame: (callback) => ipcRenderer.on('ndi-input-frame', (event, data) => callback(data)),
  onNDISourceSet: (callback) => ipcRenderer.on('ndi-source-set', (event, data) => callback(data)),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),
  onSettingsChanged: (callback) => ipcRenderer.on('settings-changed', (event, data) => callback(data)),

  // Parameter presets
  savePresets: (presets) => ipcRenderer.send('save-presets', presets),
  loadPresets: () => ipcRenderer.invoke('load-presets'),

  // View state
  saveViewState: (viewState) => ipcRenderer.send('save-view-state', viewState),
  loadViewState: () => ipcRenderer.invoke('load-view-state'),

  // Shader file operations
  saveShaderToSlot: (slotIndex, shaderCode) => ipcRenderer.invoke('save-shader-to-slot', slotIndex, shaderCode),
  loadShaderFromSlot: (slotIndex) => ipcRenderer.invoke('load-shader-from-slot', slotIndex),
  deleteShaderFromSlot: (slotIndex) => ipcRenderer.invoke('delete-shader-from-slot', slotIndex)
});
