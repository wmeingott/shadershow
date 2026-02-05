const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  newFile: (fileType) => ipcRenderer.send('trigger-new-file', fileType),
  openFile: () => ipcRenderer.send('trigger-open-file'),
  onFileOpened: (callback) => ipcRenderer.on('file-opened', (event, data) => callback(data)),
  onNewFile: (callback) => ipcRenderer.on('new-file', (event, data) => callback(data)),
  onRequestContentForSave: (callback) => ipcRenderer.on('request-content-for-save', () => callback()),
  saveContent: (content) => ipcRenderer.send('save-content', content),
  getDefaultShader: () => ipcRenderer.invoke('get-default-shader'),
  getDefaultScene: () => ipcRenderer.invoke('get-default-scene'),
  onCheckEditorChanges: (callback) => ipcRenderer.on('check-editor-changes', () => callback()),
  sendEditorHasChanges: (hasChanges) => ipcRenderer.send('editor-has-changes-response', hasChanges),

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
  sendBatchParamUpdate: (params) => ipcRenderer.send('batch-param-update', params),

  // Fullscreen operations (fullscreen window)
  onInitFullscreen: (callback) => ipcRenderer.on('init-fullscreen', (event, data) => callback(data)),
  onShaderUpdate: (callback) => ipcRenderer.on('shader-update', (event, data) => callback(data)),
  onTimeSync: (callback) => ipcRenderer.on('time-sync', (event, data) => callback(data)),
  onParamUpdate: (callback) => ipcRenderer.on('param-update', (event, data) => callback(data)),
  onBatchParamUpdate: (callback) => ipcRenderer.on('batch-param-update', (event, data) => callback(data)),
  onPresetSync: (callback) => ipcRenderer.on('preset-sync', (event, data) => callback(data)),
  sendPresetSync: (data) => ipcRenderer.send('preset-sync', data),
  onBlackout: (callback) => ipcRenderer.on('blackout', (event, data) => callback(data)),
  sendBlackout: (enabled) => ipcRenderer.send('blackout', enabled),
  getDisplayRefreshRate: () => ipcRenderer.invoke('get-display-refresh-rate'),
  sendFullscreenFps: (fps) => ipcRenderer.send('fullscreen-fps', fps),
  onFullscreenFps: (callback) => ipcRenderer.on('fullscreen-fps', (event, data) => callback(data)),
  onFullscreenClosed: (callback) => ipcRenderer.on('fullscreen-closed', () => callback()),

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
  onNDIFrameSkipChanged: (callback) => ipcRenderer.on('ndi-frame-skip-changed', (event, data) => callback(data)),

  // Syphon output (macOS only)
  onSyphonStatus: (callback) => ipcRenderer.on('syphon-status', (event, data) => callback(data)),
  sendSyphonFrame: (frameData) => ipcRenderer.send('syphon-frame', frameData),
  toggleSyphon: () => ipcRenderer.send('toggle-syphon'),

  // Recording output (H.265 MP4)
  startRecording: () => ipcRenderer.invoke('start-recording'),
  stopRecording: () => ipcRenderer.send('stop-recording'),
  sendRecordingFrame: (frameData) => ipcRenderer.send('recording-frame', frameData),
  onRecordingStatus: (callback) => ipcRenderer.on('recording-status', (event, data) => callback(data)),
  onRequestPreviewResolutionForRecording: (callback) => ipcRenderer.on('request-preview-resolution-for-recording', () => callback()),
  sendPreviewResolutionForRecording: (data) => ipcRenderer.send('preview-resolution-for-recording', data),

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
  deleteShaderFromSlot: (slotIndex) => ipcRenderer.invoke('delete-shader-from-slot', slotIndex),

  // Tiled display operations (main window)
  initTiledFullscreen: (config) => ipcRenderer.send('init-tiled-fullscreen', config),
  updateTileLayout: (layout) => ipcRenderer.send('tile-layout-update', layout),
  assignTileShader: (tileIndex, shaderCode, params) => ipcRenderer.send('tile-assign', { tileIndex, shaderCode, params }),
  updateTileParam: (tileIndex, name, value) => ipcRenderer.send('tile-param-update', { tileIndex, name, value }),
  exitTiledMode: () => ipcRenderer.send('exit-tiled-mode'),

  // Tiled display operations (fullscreen window)
  onInitTiledFullscreen: (callback) => ipcRenderer.on('init-tiled-fullscreen', (event, data) => callback(data)),
  onTileLayoutUpdate: (callback) => ipcRenderer.on('tile-layout-update', (event, data) => callback(data)),
  onTileAssign: (callback) => ipcRenderer.on('tile-assign', (event, data) => callback(data)),
  onTileParamUpdate: (callback) => ipcRenderer.on('tile-param-update', (event, data) => callback(data)),
  onExitTiledMode: (callback) => ipcRenderer.on('exit-tiled-mode', () => callback()),

  // Tile state persistence
  saveTileState: (tileState) => ipcRenderer.send('save-tile-state', tileState),
  loadTileState: () => ipcRenderer.invoke('load-tile-state'),

  // Tile preset persistence (full snapshots with shader code)
  saveTilePresets: (presets) => ipcRenderer.send('save-tile-presets', presets),
  loadTilePresets: () => ipcRenderer.invoke('load-tile-presets'),

  // Open tiled fullscreen
  openTiledFullscreen: (config) => ipcRenderer.send('open-tiled-fullscreen', config),

  // Menu handlers for tile config
  onOpenTileConfig: (callback) => ipcRenderer.on('open-tile-config', () => callback()),

  // Claude AI
  sendClaudePrompt: (data) => ipcRenderer.send('claude-prompt', data),
  onClaudeStreamChunk: (callback) => ipcRenderer.on('claude-stream-chunk', (event, data) => callback(data)),
  onClaudeStreamEnd: (callback) => ipcRenderer.on('claude-stream-end', (event, data) => callback(data)),
  onClaudeError: (callback) => ipcRenderer.on('claude-error', (event, data) => callback(data)),
  cancelClaudeRequest: () => ipcRenderer.send('claude-cancel'),
  saveClaudeKey: (key, model) => ipcRenderer.invoke('save-claude-key', key, model),
  hasClaudeKey: () => ipcRenderer.invoke('has-claude-key'),
  getClaudeSettings: () => ipcRenderer.invoke('get-claude-settings'),
  testClaudeKey: (key) => ipcRenderer.invoke('test-claude-key', key)
});
