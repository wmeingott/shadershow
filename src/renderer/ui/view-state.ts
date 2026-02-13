// View State module — manages persistent UI layout state (editor width, panel visibility, etc.)
// Typed version of js/view-state.js.

import { state } from '../core/state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Persisted view state saved to data/view-state.json */
interface ViewState {
  editorEnabled?: boolean;
  previewEnabled?: boolean;
  gridEnabled?: boolean;
  paramsEnabled?: boolean;
  editorWidth?: string;
  previewHeight?: string;
  gridWidth?: string;
  resolution?: string;
  customWidth?: string;
  customHeight?: string;
  consolePanelHeight?: number;
  consolePanelCollapsed?: boolean;
  visualPresetsEnabled?: boolean;
}

/** Console panel state returned by getConsolePanelState */
interface ConsolePanelState {
  height: number;
  collapsed: boolean;
}

/** Minimal electronAPI surface used by this module */
declare const window: Window & {
  electronAPI: {
    saveViewState: (viewState: ViewState) => void;
    loadViewState: () => Promise<ViewState | null>;
  };
};

// ---------------------------------------------------------------------------
// External module stubs (not yet converted to TS)
// ---------------------------------------------------------------------------

declare function startGridAnimation(): void;
declare function rebuildVisualPresetsDOM(): void;
declare function getConsolePanelState(): ConsolePanelState;
declare function restoreConsolePanelState(saved: Partial<ConsolePanelState>): void;

// In the real build these come from sibling JS modules. For type-checking
// purposes we declare them above and import at runtime via dynamic import or
// a future TS conversion.  When the peer modules are converted, replace the
// declares with proper imports:
//   import { startGridAnimation, rebuildVisualPresetsDOM } from '../grid/shader-grid.js';
//   import { getConsolePanelState, restoreConsolePanelState } from './console-panel.js';

// ---------------------------------------------------------------------------
// Logger stub (mirrors js/logger.js interface)
// ---------------------------------------------------------------------------

const log = {
  debug(_tag: string, _msg: string, ..._args: unknown[]): void { /* noop in TS build */ },
  info(_tag: string, _msg: string, ..._args: unknown[]): void { /* noop in TS build */ },
  warn(_tag: string, _msg: string, ..._args: unknown[]): void { /* noop in TS build */ },
  error(_tag: string, _msg: string, ..._args: unknown[]): void { /* noop in TS build */ },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function saveViewState(): void {
  const editorPanel = document.getElementById('editor-panel') as HTMLElement | null;
  const resolutionSelect = document.getElementById('resolution-select') as HTMLSelectElement | null;
  const customWidth = document.getElementById('custom-width') as HTMLInputElement | null;
  const customHeight = document.getElementById('custom-height') as HTMLInputElement | null;

  const previewPanel = document.getElementById('preview-panel') as HTMLElement | null;
  const gridPanel = document.getElementById('grid-panel') as HTMLElement | null;

  const consoleState = getConsolePanelState();
  const viewState: ViewState = {
    editorEnabled: state.editorEnabled,
    previewEnabled: state.previewEnabled,
    gridEnabled: state.gridEnabled,
    paramsEnabled: state.paramsEnabled,
    editorWidth: editorPanel?.style.width || '50%',
    previewHeight: previewPanel?.style.height || '',
    gridWidth: gridPanel?.style.width || '',
    resolution: resolutionSelect?.value,
    customWidth: customWidth?.value,
    customHeight: customHeight?.value,
    consolePanelHeight: consoleState.height,
    consolePanelCollapsed: consoleState.collapsed,
    visualPresetsEnabled: state.visualPresetsEnabled,
  };

  log.debug('ViewState', 'Saving view state');
  window.electronAPI.saveViewState(viewState);
}

export async function restoreViewState(): Promise<void> {
  const viewState = await window.electronAPI.loadViewState();
  if (!viewState) return;

  log.info(
    'ViewState',
    'Restoring view state — editor:',
    viewState.editorEnabled,
    'preview:',
    viewState.previewEnabled,
    'grid:',
    viewState.gridEnabled,
    'params:',
    viewState.paramsEnabled,
  );

  const editorPanel = document.getElementById('editor-panel');
  const resizer = document.getElementById('resizer');
  const previewPanel = document.getElementById('preview-panel');
  const gridPanel = document.getElementById('grid-panel');
  const paramsPanel = document.getElementById('params-panel');

  // Restore editor visibility
  if (viewState.editorEnabled !== undefined) {
    state.editorEnabled = viewState.editorEnabled;
    if (!state.editorEnabled) {
      editorPanel?.classList.add('hidden');
      resizer?.classList.add('hidden');
    }
    document.getElementById('btn-editor')?.classList.toggle('active', state.editorEnabled);
  }

  // Restore preview visibility
  if (viewState.previewEnabled !== undefined) {
    state.previewEnabled = viewState.previewEnabled;
    if (!state.previewEnabled) {
      previewPanel?.classList.add('hidden');
    }
    document.getElementById('btn-preview')?.classList.toggle('active', state.previewEnabled);
  }

  // Restore grid visibility
  if (viewState.gridEnabled !== undefined) {
    state.gridEnabled = viewState.gridEnabled;
    if (state.gridEnabled) {
      gridPanel?.classList.remove('hidden');
      startGridAnimation();
    }
    document.getElementById('btn-grid')?.classList.toggle('active', state.gridEnabled);
  }

  // Restore params visibility
  if (viewState.paramsEnabled !== undefined) {
    state.paramsEnabled = viewState.paramsEnabled;
    if (!state.paramsEnabled) {
      paramsPanel?.classList.add('hidden');
    }
    document.getElementById('btn-params')?.classList.toggle('active', state.paramsEnabled);
  }

  // Restore editor width (validate format: must be percentage like "50%")
  if (viewState.editorWidth && /^\d{1,3}(\.\d+)?%$/.test(viewState.editorWidth)) {
    const pct = parseFloat(viewState.editorWidth);
    if (pct >= 10 && pct <= 90 && editorPanel) {
      editorPanel.style.width = viewState.editorWidth;
    }
  }

  // Restore preview height (percentage or pixel value)
  if (viewState.previewHeight && previewPanel) {
    previewPanel.style.flex = 'none';
    previewPanel.style.height = viewState.previewHeight;
  }

  // Restore grid panel width
  if (viewState.gridWidth && gridPanel) {
    gridPanel.style.flex = 'none';
    gridPanel.style.width = viewState.gridWidth;
  }

  // Restore resolution
  if (viewState.resolution) {
    const resolutionSelect = document.getElementById('resolution-select') as HTMLSelectElement | null;
    if (resolutionSelect) {
      resolutionSelect.value = viewState.resolution;
    }

    const customWidthEl = document.getElementById('custom-width') as HTMLInputElement | null;
    const customHeightEl = document.getElementById('custom-height') as HTMLInputElement | null;
    const customX = document.getElementById('custom-x');

    if (viewState.resolution === 'custom') {
      customWidthEl?.classList.remove('hidden');
      customHeightEl?.classList.remove('hidden');
      customX?.classList.remove('hidden');
      if (viewState.customWidth && customWidthEl) customWidthEl.value = viewState.customWidth;
      if (viewState.customHeight && customHeightEl) customHeightEl.value = viewState.customHeight;
      const w = Math.min(Math.max(parseInt(customWidthEl?.value || '1280') || 1280, 1), 7680);
      const h = Math.min(Math.max(parseInt(customHeightEl?.value || '720') || 720, 1), 4320);
      (state.renderer as { setResolution: (w: number, h: number) => void })?.setResolution(w, h);
    } else if (/^\d+x\d+$/.test(viewState.resolution)) {
      const [w, h] = viewState.resolution.split('x').map(Number);
      if (w >= 1 && w <= 7680 && h >= 1 && h <= 4320) {
        (state.renderer as { setResolution: (w: number, h: number) => void })?.setResolution(w, h);
      }
    }
  }

  // Restore visual presets panel visibility
  if (viewState.visualPresetsEnabled) {
    state.visualPresetsEnabled = true;
    const vpPanel = document.getElementById('visual-presets-panel');
    if (vpPanel) vpPanel.classList.remove('hidden');
    document.getElementById('btn-visual-presets')?.classList.add('active');
    rebuildVisualPresetsDOM();
  }

  // Restore console panel state
  if (viewState.consolePanelHeight !== undefined || viewState.consolePanelCollapsed !== undefined) {
    restoreConsolePanelState({
      height: viewState.consolePanelHeight,
      collapsed: viewState.consolePanelCollapsed,
    });
  }

  // Update layout classes
  updateLayoutClasses();
}

function updateLayoutClasses(): void {
  const rightPanel = document.getElementById('right-panel');
  if (!rightPanel) return;

  if (!state.editorEnabled && state.gridEnabled && state.previewEnabled) {
    rightPanel.classList.add('side-by-side');
  } else {
    rightPanel.classList.remove('side-by-side');
  }
}
