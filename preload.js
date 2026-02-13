const { contextBridge, ipcRenderer } = require('electron');

// Helper: register an IPC listener with automatic cleanup of previous listener
// Prevents listener accumulation when callbacks are re-registered
function onIPC(channel, handler) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, handler);
}

// Validate slot index (integer 0-999)
function validSlot(slotIndex) {
  return Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex <= 999;
}

// Validate channel index (integer 0-3)
function validChannel(ch) {
  return Number.isInteger(ch) && ch >= 0 && ch <= 3;
}

contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  newFile: (fileType) => ipcRenderer.send('trigger-new-file', fileType),
  openFile: () => ipcRenderer.send('trigger-open-file'),
  onFileOpened: (callback) => onIPC('file-opened', (event, data) => callback(data)),
  onNewFile: (callback) => onIPC('new-file', (event, data) => callback(data)),
  onRequestContentForSave: (callback) => onIPC('request-content-for-save', () => callback()),
  saveContent: (content) => ipcRenderer.send('save-content', content),
  getDefaultShader: () => ipcRenderer.invoke('get-default-shader'),
  getDefaultScene: () => ipcRenderer.invoke('get-default-scene'),
  onCheckEditorChanges: (callback) => onIPC('check-editor-changes', () => callback()),
  sendEditorHasChanges: (hasChanges) => ipcRenderer.send('editor-has-changes-response', hasChanges),

  // Texture operations
  onTextureLoaded: (callback) => onIPC('texture-loaded', (event, data) => callback(data)),

  // Video operations
  onVideoLoaded: (callback) => onIPC('video-loaded', (event, data) => callback(data)),

  // Camera operations
  onCameraRequested: (callback) => onIPC('camera-requested', (event, data) => callback(data)),

  // Audio operations
  onAudioRequested: (callback) => onIPC('audio-requested', (event, data) => callback(data)),

  // Channel clear
  onChannelCleared: (callback) => onIPC('channel-cleared', (event, data) => callback(data)),

  // Shader controls
  onCompileShader: (callback) => onIPC('compile-shader', () => callback()),
  onTogglePlayback: (callback) => onIPC('toggle-playback', () => callback()),
  onResetTime: (callback) => onIPC('reset-time', () => callback()),
  onRunBenchmark: (callback) => onIPC('run-benchmark', () => callback()),
  onRestartRender: (callback) => onIPC('restart-render', () => callback()),

  // Fullscreen operations (main window)
  onRequestFullscreenState: (callback) => onIPC('request-fullscreen-state', () => callback()),
  sendFullscreenState: (state) => ipcRenderer.send('fullscreen-state', state),
  sendShaderUpdate: (data) => ipcRenderer.send('shader-update', data),
  sendTimeSync: (data) => ipcRenderer.send('time-sync', data),
  sendParamUpdate: (data) => ipcRenderer.send('param-update', data),
  sendBatchParamUpdate: (params) => ipcRenderer.send('batch-param-update', params),

  // Fullscreen operations (fullscreen window)
  onInitFullscreen: (callback) => onIPC('init-fullscreen', (event, data) => callback(data)),
  onShaderUpdate: (callback) => onIPC('shader-update', (event, data) => callback(data)),
  onTimeSync: (callback) => onIPC('time-sync', (event, data) => callback(data)),
  onParamUpdate: (callback) => onIPC('param-update', (event, data) => callback(data)),
  onBatchParamUpdate: (callback) => onIPC('batch-param-update', (event, data) => callback(data)),
  onPresetSync: (callback) => onIPC('preset-sync', (event, data) => callback(data)),
  sendPresetSync: (data) => ipcRenderer.send('preset-sync', data),
  onBlackout: (callback) => onIPC('blackout', (event, data) => callback(data)),
  sendBlackout: (enabled) => ipcRenderer.send('blackout', enabled),
  getDisplayRefreshRate: () => ipcRenderer.invoke('get-display-refresh-rate'),
  sendFullscreenFps: (fps) => ipcRenderer.send('fullscreen-fps', fps),
  onFullscreenFps: (callback) => onIPC('fullscreen-fps', (event, data) => callback(data)),
  onFullscreenClosed: (callback) => onIPC('fullscreen-closed', () => callback()),
  onFullscreenOpened: (callback) => onIPC('fullscreen-opened', (event, displayId) => callback(displayId)),

  // Grid operations
  loadShaderForGrid: () => ipcRenderer.invoke('load-shader-for-grid'),
  openFullscreenWithShader: (shaderState) => ipcRenderer.send('open-fullscreen-with-shader', shaderState),
  saveGridState: (gridState) => ipcRenderer.send('save-grid-state', gridState),
  loadGridState: () => ipcRenderer.invoke('load-grid-state'),

  // Grid presets file operations
  onRequestGridStateForSave: (callback) => onIPC('request-grid-state-for-save', () => callback()),
  saveGridPresetsToFile: (gridState) => ipcRenderer.send('save-grid-presets-to-file', gridState),
  onGridPresetsSaved: (callback) => onIPC('grid-presets-saved', (event, data) => callback(data)),
  onLoadGridPresets: (callback) => onIPC('load-grid-presets', (event, data) => callback(data)),

  // NDI output
  onNDIStatus: (callback) => onIPC('ndi-status', (event, data) => callback(data)),
  sendNDIFrame: (frameData) => ipcRenderer.send('ndi-frame', frameData),
  onRequestPreviewResolution: (callback) => onIPC('request-preview-resolution', () => callback()),
  sendPreviewResolution: (data) => ipcRenderer.send('preview-resolution', data),
  toggleNDI: () => ipcRenderer.send('toggle-ndi'),
  openFullscreen: () => ipcRenderer.send('open-fullscreen-primary'),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  openFullscreenOnDisplay: (displayId) => ipcRenderer.send('open-fullscreen-on-display', displayId),
  closeFullscreen: () => ipcRenderer.send('close-fullscreen'),
  onNDIFrameSkipChanged: (callback) => onIPC('ndi-frame-skip-changed', (event, data) => callback(data)),

  // Syphon output (macOS only)
  onSyphonStatus: (callback) => onIPC('syphon-status', (event, data) => callback(data)),
  sendSyphonFrame: (frameData) => ipcRenderer.send('syphon-frame', frameData),
  toggleSyphon: () => ipcRenderer.send('toggle-syphon'),

  // Recording output (H.265 MP4)
  startRecording: () => ipcRenderer.invoke('start-recording'),
  stopRecording: () => ipcRenderer.send('stop-recording'),
  sendRecordingFrame: (frameData) => ipcRenderer.send('recording-frame', frameData),
  onRecordingStatus: (callback) => onIPC('recording-status', (event, data) => callback(data)),
  onRequestPreviewResolutionForRecording: (callback) => onIPC('request-preview-resolution-for-recording', () => callback()),
  sendPreviewResolutionForRecording: (data) => ipcRenderer.send('preview-resolution-for-recording', data),

  // NDI input (sources as channel textures)
  findNDISources: () => ipcRenderer.invoke('find-ndi-sources'),
  setChannelNDI: (channel, source) => {
    if (!validChannel(channel)) return;
    ipcRenderer.send('set-channel-ndi', { channel, source });
  },
  clearChannelNDI: (channel) => {
    if (!validChannel(channel)) return;
    ipcRenderer.send('clear-channel-ndi', { channel });
  },
  onNDIInputFrame: (callback) => onIPC('ndi-input-frame', (event, data) => callback(data)),
  onNDISourceSet: (callback) => onIPC('ndi-source-set', (event, data) => callback(data)),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),
  onSettingsChanged: (callback) => onIPC('settings-changed', (event, data) => callback(data)),

  // Parameter presets
  savePresets: (presets) => ipcRenderer.send('save-presets', presets),
  loadPresets: () => ipcRenderer.invoke('load-presets'),

  // View state
  saveViewState: (viewState) => ipcRenderer.send('save-view-state', viewState),
  loadViewState: () => ipcRenderer.invoke('load-view-state'),

  // Shader file operations
  saveShaderToSlot: (slotIndex, shaderCode) => {
    if (!validSlot(slotIndex)) return Promise.reject(new Error('Invalid slot index'));
    return ipcRenderer.invoke('save-shader-to-slot', slotIndex, shaderCode);
  },
  loadShaderFromSlot: (slotIndex) => {
    if (!validSlot(slotIndex)) return Promise.reject(new Error('Invalid slot index'));
    return ipcRenderer.invoke('load-shader-from-slot', slotIndex);
  },
  deleteShaderFromSlot: (slotIndex) => {
    if (!validSlot(slotIndex)) return Promise.reject(new Error('Invalid slot index'));
    return ipcRenderer.invoke('delete-shader-from-slot', slotIndex);
  },
  readFileContent: (filePath) => ipcRenderer.invoke('read-file-content', filePath),

  // Mixer fullscreen (renderer → main → fullscreen)
  sendMixerParamUpdate: (data) => ipcRenderer.send('mixer-param-update', data),
  sendMixerAlphaUpdate: (data) => ipcRenderer.send('mixer-alpha-update', data),
  sendMixerBlendMode: (data) => ipcRenderer.send('mixer-blend-mode', data),
  sendMixerChannelUpdate: (data) => ipcRenderer.send('mixer-channel-update', data),

  // Mixer fullscreen (fullscreen window receives)
  onMixerParamUpdate: (callback) => onIPC('mixer-param-update', (event, data) => callback(data)),
  onMixerAlphaUpdate: (callback) => onIPC('mixer-alpha-update', (event, data) => callback(data)),
  onMixerBlendMode: (callback) => onIPC('mixer-blend-mode', (event, data) => callback(data)),
  onMixerChannelUpdate: (callback) => onIPC('mixer-channel-update', (event, data) => callback(data)),

  // Tiled display operations (main window)
  initTiledFullscreen: (config) => ipcRenderer.send('init-tiled-fullscreen', config),
  updateTileLayout: (layout) => ipcRenderer.send('tile-layout-update', layout),
  assignTileShader: (tileIndex, shaderCode, params) => ipcRenderer.send('tile-assign', { tileIndex, shaderCode, params }),
  updateTileParam: (tileIndex, name, value) => ipcRenderer.send('tile-param-update', { tileIndex, name, value }),
  exitTiledMode: () => ipcRenderer.send('exit-tiled-mode'),

  // Tiled display operations (fullscreen window)
  onInitTiledFullscreen: (callback) => onIPC('init-tiled-fullscreen', (event, data) => callback(data)),
  onTileLayoutUpdate: (callback) => onIPC('tile-layout-update', (event, data) => callback(data)),
  onTileAssign: (callback) => onIPC('tile-assign', (event, data) => callback(data)),
  onTileParamUpdate: (callback) => onIPC('tile-param-update', (event, data) => callback(data)),
  onExitTiledMode: (callback) => onIPC('exit-tiled-mode', () => callback()),

  // Tile state persistence
  saveTileState: (tileState) => ipcRenderer.send('save-tile-state', tileState),
  loadTileState: () => ipcRenderer.invoke('load-tile-state'),

  // Tile preset persistence (full snapshots with shader code)
  saveTilePresets: (presets) => ipcRenderer.send('save-tile-presets', presets),
  loadTilePresets: () => ipcRenderer.invoke('load-tile-presets'),

  // Open tiled fullscreen
  openTiledFullscreen: (config) => ipcRenderer.send('open-tiled-fullscreen', config),

  // Menu handlers for tile config
  onOpenTileConfig: (callback) => onIPC('open-tile-config', () => callback()),

  // Remote control
  sendRemoteStateChanged: (data) => ipcRenderer.send('remote-state-changed', data),
  onRemoteGetState: (callback) => onIPC('remote-get-state', (event, data) => callback(data)),
  sendRemoteGetStateResponse: (state) => ipcRenderer.send('remote-get-state-response', state),
  onRemoteGetThumbnail: (callback) => onIPC('remote-get-thumbnail', (event, data) => callback(data)),
  sendRemoteGetThumbnailResponse: (data) => ipcRenderer.send('remote-get-thumbnail-response', data),
  onRemoteSelectTab: (callback) => onIPC('remote-select-tab', (event, data) => callback(data)),
  onRemoteSelectSlot: (callback) => onIPC('remote-select-slot', (event, data) => callback(data)),
  onRemoteSetParam: (callback) => onIPC('remote-set-param', (event, data) => callback(data)),
  onRemoteRecallPreset: (callback) => onIPC('remote-recall-preset', (event, data) => callback(data)),
  onRemoteMixerAssign: (callback) => onIPC('remote-mixer-assign', (event, data) => callback(data)),
  onRemoteMixerClear: (callback) => onIPC('remote-mixer-clear', (event, data) => callback(data)),
  onRemoteMixerAlpha: (callback) => onIPC('remote-mixer-alpha', (event, data) => callback(data)),
  onRemoteMixerSelect: (callback) => onIPC('remote-mixer-select', (event, data) => callback(data)),
  onRemoteMixerBlend: (callback) => onIPC('remote-mixer-blend', (event, data) => callback(data)),
  onRemoteMixerReset: (callback) => onIPC('remote-mixer-reset', (event, data) => callback(data)),
  onRemoteMixerToggle: (callback) => onIPC('remote-mixer-toggle', (event, data) => callback(data)),
  onRemoteRecallMixPreset: (callback) => onIPC('remote-recall-mix-preset', (event, data) => callback(data)),
  onRemoteTogglePlayback: (callback) => onIPC('remote-toggle-playback', (event, data) => callback(data)),
  onRemoteResetTime: (callback) => onIPC('remote-reset-time', (event, data) => callback(data)),
  onRemoteBlackout: (callback) => onIPC('remote-blackout', (event, data) => callback(data)),

  // File textures (persistent textures from data/textures/)
  loadFileTexture: (name) => ipcRenderer.invoke('load-file-texture', name),
  listFileTextures: () => ipcRenderer.invoke('list-file-textures'),

  // Asset media (images & videos in data/media/)
  openMediaForAsset: () => ipcRenderer.invoke('open-media-for-asset'),
  copyMediaToLibrary: (sourcePath) => ipcRenderer.invoke('copy-media-to-library', sourcePath),
  getMediaAbsolutePath: (mediaPath) => ipcRenderer.invoke('get-media-absolute-path', mediaPath),
  loadMediaDataUrl: (mediaPath) => ipcRenderer.invoke('load-media-data-url', mediaPath),

  // Claude AI
  sendClaudePrompt: (data) => ipcRenderer.send('claude-prompt', data),
  onClaudeStreamChunk: (callback) => onIPC('claude-stream-chunk', (event, data) => callback(data)),
  onClaudeStreamEnd: (callback) => onIPC('claude-stream-end', (event, data) => callback(data)),
  onClaudeError: (callback) => onIPC('claude-error', (event, data) => callback(data)),
  cancelClaudeRequest: () => ipcRenderer.send('claude-cancel'),
  saveClaudeKey: (key, model) => ipcRenderer.invoke('save-claude-key', key, model),
  hasClaudeKey: () => ipcRenderer.invoke('has-claude-key'),
  getClaudeSettings: () => ipcRenderer.invoke('get-claude-settings'),
  testClaudeKey: (key) => ipcRenderer.invoke('test-claude-key', key),
  getClaudeModels: () => ipcRenderer.invoke('get-claude-models')
});
