// Editor Module — Ace editor setup, shader compilation, and directive processing.
// Typed version of js/editor.js.

import { state } from '../core/state.js';
import type { RenderMode } from '../core/state.js';
import { setRenderMode } from '../core/renderer-manager.js';

import { setStatus, updateChannelSlot } from './utils.js';
import { saveActiveSlotShader } from '../grid/shader-grid.js';
import { generateCustomParamUI } from './params.js';
import { initTabs, markTabSaved, getActiveTab } from './tabs.js';
import { toggleConsolePanel } from './console-panel.js';

/** Logger stub. */
const log = {
  debug: (..._a: unknown[]) => {},
  info: (..._a: unknown[]) => {},
  warn: (..._a: unknown[]) => {},
  error: (..._a: unknown[]) => {},
};

// ---------------------------------------------------------------------------
// Ace Editor types
// ---------------------------------------------------------------------------

/** Minimal Ace EditSession surface used by this module. */
interface AceEditSession {
  getValue(): string;
  setValue(content: string): void;
  setMode(mode: string): void;
  clearAnnotations(): void;
  setAnnotations(annotations: AceAnnotation[]): void;
}

interface AceAnnotation {
  row: number;
  column: number;
  text: string;
  type: 'error' | 'warning' | 'info';
}

interface AceSelection {
  on(event: string, handler: () => void): void;
}

/** Minimal Ace Editor surface used by this module. */
interface AceEditor {
  setTheme(theme: string): void;
  setOptions(opts: Record<string, unknown>): void;
  session: AceEditSession;
  selection: AceSelection;
  on(event: string, handler: () => void): void;
  commands: {
    addCommand(cmd: AceCommand): void;
  };
  getValue(): string;
  getCursorPosition(): { row: number; column: number };
}

interface AceCommand {
  name: string;
  bindKey: { win: string; mac: string };
  exec: () => void;
}

/** Ambient global for the Ace editor library (loaded via script tag). */
declare const ace: {
  edit(elementId: string): AceEditor;
};

// ---------------------------------------------------------------------------
// window.electronAPI surface used by this module
// ---------------------------------------------------------------------------

declare const window: Window & {
  electronAPI: {
    saveContent(content: string): void;
    sendShaderUpdate(data: { shaderCode: string; renderMode: string }): void;
    loadFileTexture(name: string): Promise<{ success: boolean; dataUrl?: string }>;
    sendParamUpdate(data: unknown): void;
  };
};

// ---------------------------------------------------------------------------
// Renderer interface (for state.renderer)
// ---------------------------------------------------------------------------

interface TextureDirective {
  channel: number;
  textureName: string;
}

interface AudioDirective {
  channel: number;
  fftSize?: number;
  textureName: string;
}

interface FileTextureDirective {
  channel: number;
  textureName: string;
}

interface ShaderRendererSurface {
  compile(source: string): void;
  getCustomParamDefs?(): unknown[];
  textureDirectives?: TextureDirective[];
  audioDirectives?: AudioDirective[];
  fileTextureDirectives?: FileTextureDirective[];
  loadTexture(channel: number, dataUrl: string): Promise<void>;
  channelResolutions: [number, number, number][];
  setParam?(name: string, value: unknown): void;
}

// ---------------------------------------------------------------------------
// Compile error type
// ---------------------------------------------------------------------------

interface CompileError extends Error {
  raw?: string;
  line?: number;
}

// ---------------------------------------------------------------------------
// Texture size specs
// ---------------------------------------------------------------------------

const TEXTURE_SPECS: Record<string, [number, number]> = {
  RGBANoise: [256, 256],
  RGBANoiseBig: [1024, 1024],
  RGBANoiseSmall: [64, 64],
  GrayNoise: [256, 256],
  GrayNoiseBig: [1024, 1024],
  GrayNoiseSmall: [64, 64],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Initialize the Ace editor, wire up keyboard shortcuts, and bootstrap tabs. */
export async function initEditor(): Promise<void> {
  log.debug('Editor', 'Initializing editor');
  const editor: AceEditor = ace.edit('editor');
  state.editor = editor;

  editor.setTheme('ace/theme/monokai');
  editor.session.setMode('ace/mode/glsl');
  editor.setOptions({
    fontSize: '14px',
    showPrintMargin: false,
    tabSize: 2,
    useSoftTabs: true,
    wrap: false,
    enableBasicAutocompletion: true,
  });

  // Auto-compile on change (debounced) - attached to editor, works across all sessions
  editor.on('change', () => {
    if (state.compileTimeout) clearTimeout(state.compileTimeout);
    state.compileTimeout = setTimeout(compileShader, 500);
  });

  // Update cursor position in status bar
  editor.selection.on('changeCursor', () => {
    const pos = editor.getCursorPosition();
    const el = document.getElementById('cursor-position');
    if (el) {
      el.textContent = `Ln ${pos.row + 1}, Col ${pos.column + 1}`;
    }
  });

  // Keyboard shortcuts
  editor.commands.addCommand({
    name: 'compile',
    bindKey: { win: 'Ctrl-Enter', mac: 'Cmd-Enter' },
    exec: compileShader,
  });

  editor.commands.addCommand({
    name: 'save',
    bindKey: { win: 'Ctrl-S', mac: 'Cmd-S' },
    exec: () => {
      // If a grid slot is active, save to slot file
      if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
        saveActiveSlotShader();
      } else {
        // Otherwise use standard file save
        window.electronAPI.saveContent(editor.getValue());
      }
      // Mark the current tab as saved
      const activeTab = getActiveTab();
      if (activeTab) {
        markTabSaved(activeTab.id);
      }
    },
  });

  editor.commands.addCommand({
    name: 'toggleConsole',
    bindKey: { win: 'Ctrl-J', mac: 'Cmd-J' },
    exec: toggleConsolePanel,
  });

  // Listen for tab activation to switch modes and compile
  window.addEventListener('tab-activated', ((e: CustomEvent<{ type: string }>) => {
    const { type } = e.detail;

    // Set editor mode based on tab type
    setEditorMode(type);

    // Import setRenderMode dynamically to avoid circular dependency
    setRenderMode(type as RenderMode).then(() => {
      // Compile after mode is set
      compileShader();
      generateCustomParamUI();
    });
  }) as EventListener);

  // Initialize tabs system (will create initial tab with default shader)
  await initTabs();
}

/** Set editor mode based on file type. */
export function setEditorMode(mode: string): void {
  const editor = state.editor as AceEditor;
  if (mode === 'scene' || mode === 'jsx' || mode === 'javascript') {
    editor.session.setMode('ace/mode/javascript');
  } else {
    editor.session.setMode('ace/mode/glsl');
  }
}

/** Compile current editor content (shader or scene). */
export async function compileShader(): Promise<void> {
  // Guard: renderer may not be initialized yet during startup
  if (!state.renderer) return;

  const editor = state.editor as AceEditor;
  const renderer = state.renderer as ShaderRendererSurface;
  const source: string = editor.getValue();

  // Clear previous error markers
  editor.session.clearAnnotations();

  try {
    // Compile using the active renderer
    renderer.compile(source);

    const modeLabel = state.renderMode === 'scene' ? 'Scene' : 'Shader';
    log.info('Editor', modeLabel, 'compiled successfully');
    setStatus(`${modeLabel} compiled successfully`, 'success');

    // Generate dynamic UI for custom parameters
    generateCustomParamUI();

    // Update channel UI for builtin @texture directives
    if (renderer.textureDirectives) {
      for (const { channel, textureName } of renderer.textureDirectives) {
        const [w, h] = TEXTURE_SPECS[textureName] ?? [0, 0];
        updateChannelSlot(channel, 'builtin', textureName, w, h);
      }
    }

    // Load AudioFFT channels from @texture directives
    if (renderer.audioDirectives) {
      for (const { channel, fftSize } of renderer.audioDirectives) {
        const sz = fftSize ?? 1024;
        const bins = sz / 2;
        state.channelState[channel] = { type: 'audio' };
        updateChannelSlot(channel, 'audio', `Audio FFT ${bins}`, bins, 2);
      }
    }

    // Load file textures from @texture directives (async)
    if (renderer.fileTextureDirectives) {
      for (const { channel, textureName } of renderer.fileTextureDirectives) {
        try {
          const result = await window.electronAPI.loadFileTexture(textureName);
          if (result.success) {
            await renderer.loadTexture(channel, result.dataUrl!);
            state.channelState[channel] = { type: 'file-texture', name: textureName };
            const w = renderer.channelResolutions[channel][0];
            const h = renderer.channelResolutions[channel][1];
            log.debug('Editor', 'Loaded file texture', textureName, 'ch' + channel, w + 'x' + h);
            updateChannelSlot(channel, 'builtin', `texture:${textureName}`, w, h);
          } else {
            log.warn('Editor', 'Texture not found:', textureName);
            setStatus(`Texture "${textureName}" not found in data/textures/`, 'error');
          }
        } catch (texErr: unknown) {
          log.error('Editor', 'Failed to load file texture', textureName, texErr);
          setStatus(`Failed to load texture "${textureName}"`, 'error');
        }
      }
    }

    // Sync to fullscreen window
    window.electronAPI.sendShaderUpdate({
      shaderCode: source,
      renderMode: state.renderMode,
    });
  } catch (err: unknown) {
    const compileErr = err as CompileError;
    const message: string = compileErr.message || compileErr.raw || String(err);
    log.error('Editor', 'Compile error:', message);
    setStatus(`Compile error: ${message}`, 'error');

    // Add error annotation to editor
    if (compileErr.line) {
      editor.session.setAnnotations([{
        row: compileErr.line - 1,
        column: 0,
        text: compileErr.message,
        type: 'error',
      }]);
    }
  }
}
