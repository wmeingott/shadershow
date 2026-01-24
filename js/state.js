// Global state - shared across modules
export const state = {
  editor: null,
  renderer: null,        // Current active renderer (ShaderRenderer or ThreeSceneRenderer)
  shaderRenderer: null,  // WebGL shader renderer
  sceneRenderer: null,   // Three.js scene renderer
  renderMode: 'shader',  // 'shader' or 'scene'
  compileTimeout: null,
  animationId: null,
  previewEnabled: true,
  gridEnabled: false,
  editorEnabled: true,
  paramsEnabled: true,
  ndiEnabled: false,
  ndiFrameCounter: 0,
  ndiFrameSkip: 4,  // Send every Nth frame (4 = 15fps at 60fps render)
  syphonEnabled: false,
  syphonFrameCounter: 0,
  syphonFrameSkip: 4,  // Send every Nth frame
  blackoutEnabled: false,

  // Fullscreen tracking for adaptive preview framerate
  fullscreenActive: false,
  fullscreenFps: 0,
  fullscreenTargetFps: 60,  // Display refresh rate
  previewFrameInterval: 0,  // 0 = no limiting, otherwise ms between frames

  // Track channel state for fullscreen sync
  channelState: [null, null, null, null],

  // Shader grid state
  gridSlots: new Array(32).fill(null),
  gridAnimationId: null,
  activeGridSlot: null,

  // Parameter presets
  globalPresets: [],
  activeGlobalPresetIndex: null,
  activeLocalPresetIndex: null,

  // Tiled preview state
  tiledPreviewEnabled: false,
  tileRenderers: [],  // Array of MiniShaderRenderer for tiled preview
  selectedTileIndex: 0  // Currently selected tile for parameter/shader routing
};
