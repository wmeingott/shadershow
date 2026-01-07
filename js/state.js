// Global state - shared across modules
export const state = {
  editor: null,
  renderer: null,
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

  // Mouse assignment for params P0-P4
  mouseAssignments: { p0: '', p1: '', p2: '', p3: '', p4: '' },
  mousePosition: { x: 0.5, y: 0.5 },

  // Track channel state for fullscreen sync
  channelState: [null, null, null, null],

  // Shader grid state
  gridSlots: new Array(16).fill(null),
  gridAnimationId: null,
  activeGridSlot: null,

  // Parameter presets
  globalPresets: [],
  activeGlobalPresetIndex: null,
  activeLocalPresetIndex: null,

  // Parameter ranges (min, max) for P0-P4
  paramRanges: {
    p0: { min: 0, max: 1 },
    p1: { min: 0, max: 1 },
    p2: { min: 0, max: 1 },
    p3: { min: 0, max: 1 },
    p4: { min: 0, max: 1 }
  }
};
