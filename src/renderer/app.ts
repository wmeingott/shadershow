// ShaderShow — Renderer process entry point
// DOMContentLoaded wiring, instantiation of all UI controllers

import { state } from './core/state.js';
import { initEditor, compileShader } from './ui/editor.js';
import { initControls, initResizer } from './ui/controls.js';
import { initParams, initMouseAssignment } from './ui/params.js';
import { initPresets } from './ui/presets.js';
import { initShaderGrid } from './grid/shader-grid.js';
import { initIPC } from './ipc/ipc-handlers.js';
import { restoreViewState } from './ui/view-state.js';
import { initTileConfig, showTileConfigDialog } from './tiles/tile-config.js';
import { initMixer } from './ui/mixer.js';
import { initSettingsOnLoad } from './ui/settings-dialog.js';
import { initConsolePanel } from './ui/console-panel.js';
import { createTaggedLogger, LOG_LEVEL } from '../shared/logger.js';

// --- Stubs for modules not yet ported to TypeScript ---
// These will be replaced by real imports once the modules are created.
declare function initRenderer(): void;
declare function cacheRenderLoopElements(): void;
declare function renderLoop(): void;

// --- ElectronAPI type for IPC handlers used in this file ---
declare const window: Window & {
  electronAPI: {
    onOpenTileConfig?: (cb: () => void) => void;
  };
};

const log = createTaggedLogger(LOG_LEVEL.DEBUG);

// ---------------------------------------------------------------------------
// Main initialization sequence
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  try {
    log.info('Renderer', 'Starting initialization...');

    // Initialize console panel before editor so compile messages are captured
    initConsolePanel();

    // Initialize editor first (creates initial tab with default shader)
    await initEditor();
    log.debug('Renderer', 'Editor initialized');

    initRenderer();
    log.debug('Renderer', 'Renderer initialized');

    initControls();
    log.debug('Renderer', 'Controls initialized');

    await initSettingsOnLoad();
    initParams();
    initMouseAssignment();
    initPresets();
    initResizer();
    initIPC();
    initMixer();
    await initTileConfig();

    // Compile the initial shader BEFORE loading grid slots to ensure main renderer
    // has its WebGL context established first (grid slots create many WebGL contexts)
    compileShader();
    log.debug('Renderer', 'Initial shader compiled');

    // Now load grid slots (each creates a MiniShaderRenderer with its own context)
    await initShaderGrid();

    // Restore saved view state
    await restoreViewState();

    // Cache DOM elements and start render loop
    cacheRenderLoopElements();
    renderLoop();

    log.info('Renderer', 'Initialization complete');
  } catch (err) {
    log.error('Renderer', 'Initialization error:', err);
  }
});

// ---------------------------------------------------------------------------
// IPC handler: open tile config dialog from application menu
// ---------------------------------------------------------------------------
window.electronAPI.onOpenTileConfig?.(() => {
  showTileConfigDialog();
});
