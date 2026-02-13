// Main preload script — typed electronAPI bridge
import { contextBridge, ipcRenderer } from 'electron';

/** Register an IPC listener with automatic cleanup of previous listener */
function onIPC(channel: string, handler: (...args: any[]) => void): void {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, handler);
}

/** Validate slot index (integer 0-999) */
function validSlot(slotIndex: number): boolean {
  return Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex <= 999;
}

/** Validate channel index (integer 0-3) */
function validChannel(ch: number): boolean {
  return Number.isInteger(ch) && ch >= 0 && ch <= 3;
}

contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  newFile: (fileType: string) => ipcRenderer.send('trigger-new-file', fileType),
  openFile: () => ipcRenderer.send('trigger-open-file'),
  onFileOpened: (callback: (data: any) => void) => onIPC('file-opened', (_event: any, data: any) => callback(data)),
  onNewFile: (callback: (data: any) => void) => onIPC('new-file', (_event: any, data: any) => callback(data)),
  onRequestContentForSave: (callback: () => void) => onIPC('request-content-for-save', () => callback()),
  saveContent: (content: string) => ipcRenderer.send('save-content', content),
  getDefaultShader: () => ipcRenderer.invoke('get-default-shader'),
  getDefaultScene: () => ipcRenderer.invoke('get-default-scene'),
  onCheckEditorChanges: (callback: () => void) => onIPC('check-editor-changes', () => callback()),
  sendEditorHasChanges: (hasChanges: boolean) => ipcRenderer.send('editor-has-changes-response', hasChanges),

  // Texture operations
  onTextureLoaded: (callback: (data: any) => void) => onIPC('texture-loaded', (_event: any, data: any) => callback(data)),
  onVideoLoaded: (callback: (data: any) => void) => onIPC('video-loaded', (_event: any, data: any) => callback(data)),
  onCameraRequested: (callback: (data: any) => void) => onIPC('camera-requested', (_event: any, data: any) => callback(data)),
  onAudioRequested: (callback: (data: any) => void) => onIPC('audio-requested', (_event: any, data: any) => callback(data)),
  onChannelCleared: (callback: (data: any) => void) => onIPC('channel-cleared', (_event: any, data: any) => callback(data)),

  // Shader controls
  onCompileShader: (callback: () => void) => onIPC('compile-shader', () => callback()),
  onTogglePlayback: (callback: () => void) => onIPC('toggle-playback', () => callback()),
  onResetTime: (callback: () => void) => onIPC('reset-time', () => callback()),
  onRunBenchmark: (callback: () => void) => onIPC('run-benchmark', () => callback()),
  onRestartRender: (callback: () => void) => onIPC('restart-render', () => callback()),

  // Fullscreen operations (main window)
  onRequestFullscreenState: (callback: () => void) => onIPC('request-fullscreen-state', () => callback()),
  sendFullscreenState: (state: any) => ipcRenderer.send('fullscreen-state', state),
  sendShaderUpdate: (data: any) => ipcRenderer.send('shader-update', data),
  sendTimeSync: (data: any) => ipcRenderer.send('time-sync', data),
  sendParamUpdate: (data: any) => ipcRenderer.send('param-update', data),
  sendBatchParamUpdate: (params: any) => ipcRenderer.send('batch-param-update', params),

  // Fullscreen operations (fullscreen window)
  onInitFullscreen: (callback: (data: any) => void) => onIPC('init-fullscreen', (_event: any, data: any) => callback(data)),
  onShaderUpdate: (callback: (data: any) => void) => onIPC('shader-update', (_event: any, data: any) => callback(data)),
  onTimeSync: (callback: (data: any) => void) => onIPC('time-sync', (_event: any, data: any) => callback(data)),
  onParamUpdate: (callback: (data: any) => void) => onIPC('param-update', (_event: any, data: any) => callback(data)),
  onBatchParamUpdate: (callback: (data: any) => void) => onIPC('batch-param-update', (_event: any, data: any) => callback(data)),
  onPresetSync: (callback: (data: any) => void) => onIPC('preset-sync', (_event: any, data: any) => callback(data)),
  sendPresetSync: (data: any) => ipcRenderer.send('preset-sync', data),
  onBlackout: (callback: (data: any) => void) => onIPC('blackout', (_event: any, data: any) => callback(data)),
  sendBlackout: (enabled: boolean) => ipcRenderer.send('blackout', enabled),
  getDisplayRefreshRate: () => ipcRenderer.invoke('get-display-refresh-rate'),
  sendFullscreenFps: (fps: number) => ipcRenderer.send('fullscreen-fps', fps),
  onFullscreenFps: (callback: (data: any) => void) => onIPC('fullscreen-fps', (_event: any, data: any) => callback(data)),
  onFullscreenClosed: (callback: () => void) => onIPC('fullscreen-closed', () => callback()),
  onFullscreenOpened: (callback: (displayId: number) => void) => onIPC('fullscreen-opened', (_event: any, displayId: number) => callback(displayId)),

  // Grid operations
  loadShaderForGrid: () => ipcRenderer.invoke('load-shader-for-grid'),
  openFullscreenWithShader: (shaderState: any) => ipcRenderer.send('open-fullscreen-with-shader', shaderState),
  saveGridState: (gridState: any) => ipcRenderer.send('save-grid-state', gridState),
  loadGridState: () => ipcRenderer.invoke('load-grid-state'),

  // Grid presets file operations
  onRequestGridStateForSave: (callback: () => void) => onIPC('request-grid-state-for-save', () => callback()),
  saveGridPresetsToFile: (gridState: any) => ipcRenderer.send('save-grid-presets-to-file', gridState),
  onGridPresetsSaved: (callback: (data: any) => void) => onIPC('grid-presets-saved', (_event: any, data: any) => callback(data)),
  onLoadGridPresets: (callback: (data: any) => void) => onIPC('load-grid-presets', (_event: any, data: any) => callback(data)),

  // NDI output
  onNDIStatus: (callback: (data: any) => void) => onIPC('ndi-status', (_event: any, data: any) => callback(data)),
  sendNDIFrame: (frameData: any) => ipcRenderer.send('ndi-frame', frameData),
  onRequestPreviewResolution: (callback: () => void) => onIPC('request-preview-resolution', () => callback()),
  sendPreviewResolution: (data: any) => ipcRenderer.send('preview-resolution', data),
  toggleNDI: () => ipcRenderer.send('toggle-ndi'),
  openFullscreen: () => ipcRenderer.send('open-fullscreen-primary'),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  openFullscreenOnDisplay: (displayId: number) => ipcRenderer.send('open-fullscreen-on-display', displayId),
  closeFullscreen: () => ipcRenderer.send('close-fullscreen'),
  onNDIFrameSkipChanged: (callback: (data: any) => void) => onIPC('ndi-frame-skip-changed', (_event: any, data: any) => callback(data)),

  // Syphon output (macOS only)
  onSyphonStatus: (callback: (data: any) => void) => onIPC('syphon-status', (_event: any, data: any) => callback(data)),
  sendSyphonFrame: (frameData: any) => ipcRenderer.send('syphon-frame', frameData),
  toggleSyphon: () => ipcRenderer.send('toggle-syphon'),

  // Recording output (H.265 MP4)
  startRecording: () => ipcRenderer.invoke('start-recording'),
  stopRecording: () => ipcRenderer.send('stop-recording'),
  sendRecordingFrame: (frameData: any) => ipcRenderer.send('recording-frame', frameData),
  onRecordingStatus: (callback: (data: any) => void) => onIPC('recording-status', (_event: any, data: any) => callback(data)),
  onRequestPreviewResolutionForRecording: (callback: () => void) => onIPC('request-preview-resolution-for-recording', () => callback()),
  sendPreviewResolutionForRecording: (data: any) => ipcRenderer.send('preview-resolution-for-recording', data),

  // NDI input (sources as channel textures)
  findNDISources: () => ipcRenderer.invoke('find-ndi-sources'),
  setChannelNDI: (channel: number, source: any) => {
    if (!validChannel(channel)) return;
    ipcRenderer.send('set-channel-ndi', { channel, source });
  },
  clearChannelNDI: (channel: number) => {
    if (!validChannel(channel)) return;
    ipcRenderer.send('clear-channel-ndi', { channel });
  },
  onNDIInputFrame: (callback: (data: any) => void) => onIPC('ndi-input-frame', (_event: any, data: any) => callback(data)),
  onNDISourceSet: (callback: (data: any) => void) => onIPC('ndi-source-set', (_event: any, data: any) => callback(data)),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: any) => ipcRenderer.send('save-settings', settings),
  onSettingsChanged: (callback: (data: any) => void) => onIPC('settings-changed', (_event: any, data: any) => callback(data)),

  // Parameter presets
  savePresets: (presets: any) => ipcRenderer.send('save-presets', presets),
  loadPresets: () => ipcRenderer.invoke('load-presets'),

  // View state
  saveViewState: (viewState: any) => ipcRenderer.send('save-view-state', viewState),
  loadViewState: () => ipcRenderer.invoke('load-view-state'),

  // Shader file operations
  saveShaderToSlot: (slotIndex: number, shaderCode: string) => {
    if (!validSlot(slotIndex)) return Promise.reject(new Error('Invalid slot index'));
    return ipcRenderer.invoke('save-shader-to-slot', slotIndex, shaderCode);
  },
  loadShaderFromSlot: (slotIndex: number) => {
    if (!validSlot(slotIndex)) return Promise.reject(new Error('Invalid slot index'));
    return ipcRenderer.invoke('load-shader-from-slot', slotIndex);
  },
  deleteShaderFromSlot: (slotIndex: number) => {
    if (!validSlot(slotIndex)) return Promise.reject(new Error('Invalid slot index'));
    return ipcRenderer.invoke('delete-shader-from-slot', slotIndex);
  },
  readFileContent: (filePath: string) => ipcRenderer.invoke('read-file-content', filePath),

  // Mixer fullscreen
  sendMixerParamUpdate: (data: any) => ipcRenderer.send('mixer-param-update', data),
  sendMixerAlphaUpdate: (data: any) => ipcRenderer.send('mixer-alpha-update', data),
  sendMixerBlendMode: (data: any) => ipcRenderer.send('mixer-blend-mode', data),
  sendMixerChannelUpdate: (data: any) => ipcRenderer.send('mixer-channel-update', data),
  onMixerParamUpdate: (callback: (data: any) => void) => onIPC('mixer-param-update', (_event: any, data: any) => callback(data)),
  onMixerAlphaUpdate: (callback: (data: any) => void) => onIPC('mixer-alpha-update', (_event: any, data: any) => callback(data)),
  onMixerBlendMode: (callback: (data: any) => void) => onIPC('mixer-blend-mode', (_event: any, data: any) => callback(data)),
  onMixerChannelUpdate: (callback: (data: any) => void) => onIPC('mixer-channel-update', (_event: any, data: any) => callback(data)),

  // Tiled display operations
  initTiledFullscreen: (config: any) => ipcRenderer.send('init-tiled-fullscreen', config),
  updateTileLayout: (layout: any) => ipcRenderer.send('tile-layout-update', layout),
  assignTileShader: (tileIndex: number, shaderCode: string, params: any) => ipcRenderer.send('tile-assign', { tileIndex, shaderCode, params }),
  updateTileParam: (tileIndex: number, name: string, value: any) => ipcRenderer.send('tile-param-update', { tileIndex, name, value }),
  exitTiledMode: () => ipcRenderer.send('exit-tiled-mode'),
  onInitTiledFullscreen: (callback: (data: any) => void) => onIPC('init-tiled-fullscreen', (_event: any, data: any) => callback(data)),
  onTileLayoutUpdate: (callback: (data: any) => void) => onIPC('tile-layout-update', (_event: any, data: any) => callback(data)),
  onTileAssign: (callback: (data: any) => void) => onIPC('tile-assign', (_event: any, data: any) => callback(data)),
  onTileParamUpdate: (callback: (data: any) => void) => onIPC('tile-param-update', (_event: any, data: any) => callback(data)),
  onExitTiledMode: (callback: () => void) => onIPC('exit-tiled-mode', () => callback()),

  // Tile state persistence
  saveTileState: (tileState: any) => ipcRenderer.send('save-tile-state', tileState),
  loadTileState: () => ipcRenderer.invoke('load-tile-state'),
  saveTilePresets: (presets: any) => ipcRenderer.send('save-tile-presets', presets),
  loadTilePresets: () => ipcRenderer.invoke('load-tile-presets'),
  openTiledFullscreen: (config: any) => ipcRenderer.send('open-tiled-fullscreen', config),
  onOpenTileConfig: (callback: () => void) => onIPC('open-tile-config', () => callback()),

  // Remote control
  sendRemoteStateChanged: (data: any) => ipcRenderer.send('remote-state-changed', data),
  onRemoteGetState: (callback: (data: any) => void) => onIPC('remote-get-state', (_event: any, data: any) => callback(data)),
  sendRemoteGetStateResponse: (state: any) => ipcRenderer.send('remote-get-state-response', state),
  onRemoteGetThumbnail: (callback: (data: any) => void) => onIPC('remote-get-thumbnail', (_event: any, data: any) => callback(data)),
  sendRemoteGetThumbnailResponse: (data: any) => ipcRenderer.send('remote-get-thumbnail-response', data),
  onRemoteSelectTab: (callback: (data: any) => void) => onIPC('remote-select-tab', (_event: any, data: any) => callback(data)),
  onRemoteSelectSlot: (callback: (data: any) => void) => onIPC('remote-select-slot', (_event: any, data: any) => callback(data)),
  onRemoteSetParam: (callback: (data: any) => void) => onIPC('remote-set-param', (_event: any, data: any) => callback(data)),
  onRemoteRecallPreset: (callback: (data: any) => void) => onIPC('remote-recall-preset', (_event: any, data: any) => callback(data)),
  onRemoteMixerAssign: (callback: (data: any) => void) => onIPC('remote-mixer-assign', (_event: any, data: any) => callback(data)),
  onRemoteMixerClear: (callback: (data: any) => void) => onIPC('remote-mixer-clear', (_event: any, data: any) => callback(data)),
  onRemoteMixerAlpha: (callback: (data: any) => void) => onIPC('remote-mixer-alpha', (_event: any, data: any) => callback(data)),
  onRemoteMixerSelect: (callback: (data: any) => void) => onIPC('remote-mixer-select', (_event: any, data: any) => callback(data)),
  onRemoteMixerBlend: (callback: (data: any) => void) => onIPC('remote-mixer-blend', (_event: any, data: any) => callback(data)),
  onRemoteMixerReset: (callback: () => void) => onIPC('remote-mixer-reset', () => callback()),
  onRemoteMixerToggle: (callback: (data: any) => void) => onIPC('remote-mixer-toggle', (_event: any, data: any) => callback(data)),
  onRemoteRecallMixPreset: (callback: (data: any) => void) => onIPC('remote-recall-mix-preset', (_event: any, data: any) => callback(data)),
  onRemoteTogglePlayback: (callback: () => void) => onIPC('remote-toggle-playback', () => callback()),
  onRemoteResetTime: (callback: () => void) => onIPC('remote-reset-time', () => callback()),
  onRemoteBlackout: (callback: (data: any) => void) => onIPC('remote-blackout', (_event: any, data: any) => callback(data)),

  // File textures
  loadFileTexture: (name: string) => ipcRenderer.invoke('load-file-texture', name),
  listFileTextures: () => ipcRenderer.invoke('list-file-textures'),

  // Asset display
  sendAssetUpdate: (data: any) => ipcRenderer.send('asset-update', data),
  onAssetUpdate: (callback: (data: any) => void) => onIPC('asset-update', (_event: any, data: any) => callback(data)),

  // Asset media
  openMediaForAsset: () => ipcRenderer.invoke('open-media-for-asset'),
  copyMediaToLibrary: (sourcePath: string) => ipcRenderer.invoke('copy-media-to-library', sourcePath),
  getMediaAbsolutePath: (mediaPath: string) => ipcRenderer.invoke('get-media-absolute-path', mediaPath),
  loadMediaDataUrl: (mediaPath: string) => ipcRenderer.invoke('load-media-data-url', mediaPath),

  // Per-button export/import
  exportButtonData: (format: string, data: any, defaultName: string) => ipcRenderer.invoke('export-button-data', format, data, defaultName),
  importButtonData: (format: string) => ipcRenderer.invoke('import-button-data', format),
  exportButtonDataBulk: (format: string, items: any[]) => ipcRenderer.invoke('export-button-data-bulk', format, items),
  importButtonDataBulk: (format: string) => ipcRenderer.invoke('import-button-data-bulk', format),
  exportTexturesToFolder: (folder: string, textureNames: string[]) => ipcRenderer.invoke('export-textures-to-folder', folder, textureNames),
  importTexturesFromFolder: (sourceFolder: string) => ipcRenderer.invoke('import-textures-from-folder', sourceFolder),

  // Claude AI
  sendClaudePrompt: (data: any) => ipcRenderer.send('claude-prompt', data),
  onClaudeStreamChunk: (callback: (data: any) => void) => onIPC('claude-stream-chunk', (_event: any, data: any) => callback(data)),
  onClaudeStreamEnd: (callback: (data: any) => void) => onIPC('claude-stream-end', (_event: any, data: any) => callback(data)),
  onClaudeError: (callback: (data: any) => void) => onIPC('claude-error', (_event: any, data: any) => callback(data)),
  cancelClaudeRequest: () => ipcRenderer.send('claude-cancel'),
  saveClaudeKey: (key: string | null, model: string) => ipcRenderer.invoke('save-claude-key', key, model),
  hasClaudeKey: () => ipcRenderer.invoke('has-claude-key'),
  getClaudeSettings: () => ipcRenderer.invoke('get-claude-settings'),
  testClaudeKey: (key: string | null) => ipcRenderer.invoke('test-claude-key', key),
  getClaudeModels: () => ipcRenderer.invoke('get-claude-models'),
});
