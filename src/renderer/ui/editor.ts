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
  getFontSize(): string;
  setFontSize(size: string): void;
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
    loadShaderFile(path: string): Promise<{ success: boolean; source?: string }>;
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

interface ShaderTextureDirective {
  channel: number;
  textureName: string;
  shaderFunc?: string;
  shaderFile?: string;
  shaderWidth?: number;
  shaderHeight?: number;
  shaderDynamic?: boolean;
}

interface ShaderRendererSurface {
  compile(source: string): void;
  getCustomParamDefs?(): unknown[];
  textureDirectives?: TextureDirective[];
  audioDirectives?: AudioDirective[];
  fileTextureDirectives?: FileTextureDirective[];
  shaderTextureDirectives?: ShaderTextureDirective[];
  loadTexture(channel: number, dataUrl: string): Promise<void>;
  loadShaderTextureFile?(channel: number, fileSource: string, directive: ShaderTextureDirective): unknown[];
  channelResolutions: [number, number, number][];
  setParam?(name: string, value: unknown): void;
  extraWrapperLines?: number;
}

// ---------------------------------------------------------------------------
// Compile error type
// ---------------------------------------------------------------------------

interface CompileError {
  message: string;
  raw?: string;
  line?: number | null;
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

  editor.commands.addCommand({
    name: 'increaseFontSize',
    bindKey: { win: 'Ctrl-=|Ctrl-+', mac: 'Cmd-=|Cmd-+' },
    exec: () => {
      const size = parseInt(editor.getFontSize(), 10) || 14;
      editor.setFontSize((size + 1) + 'px');
    },
  });

  editor.commands.addCommand({
    name: 'decreaseFontSize',
    bindKey: { win: 'Ctrl--|Ctrl-Shift--', mac: 'Cmd--|Cmd-Shift--' },
    exec: () => {
      const size = parseInt(editor.getFontSize(), 10) || 14;
      if (size > 6) editor.setFontSize((size - 1) + 'px');
    },
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

    // Handle shader texture directives
    if (renderer.shaderTextureDirectives) {
      for (const dir of renderer.shaderTextureDirectives) {
        if (dir.shaderFunc) {
          // Inline function — already set up during compile
          const label = `shader:${dir.shaderFunc}`;
          const wStr = dir.shaderWidth! <= 1 ? `${(dir.shaderWidth! * 100).toFixed(0)}%` : `${dir.shaderWidth}`;
          const hStr = dir.shaderHeight! <= 1 ? `${(dir.shaderHeight! * 100).toFixed(0)}%` : `${dir.shaderHeight}`;
          updateChannelSlot(dir.channel, 'builtin', label, 0, 0);
          log.debug('Editor', `Shader texture ch${dir.channel}: ${dir.shaderFunc} ${wStr}x${hStr} dynamic=${dir.shaderDynamic}`);
        } else if (dir.shaderFile && renderer.loadShaderTextureFile) {
          // File-based — load async
          try {
            const result = await window.electronAPI.loadShaderFile(dir.shaderFile);
            if (result.success && result.source) {
              const newParams = renderer.loadShaderTextureFile(dir.channel, result.source, dir);
              if (newParams && (newParams as unknown[]).length > 0) {
                // Re-generate param UI to include new params from file shader
                generateCustomParamUI();
              }
              const label = `shader:${dir.shaderFile.split('/').pop()}`;
              updateChannelSlot(dir.channel, 'builtin', label, 0, 0);
              log.debug('Editor', `Shader texture file ch${dir.channel}: ${dir.shaderFile}`);
            } else {
              log.warn('Editor', `Shader file not found: ${dir.shaderFile}`);
              setStatus(`Shader file "${dir.shaderFile}" not found`, 'error');
            }
          } catch (texErr: unknown) {
            log.error('Editor', 'Failed to load shader texture file', dir.shaderFile, texErr);
            setStatus(`Failed to load shader file "${dir.shaderFile}"`, 'error');
          }
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

    // Build status message with line number
    const lineInfo = compileErr.line ? ` (line ${compileErr.line})` : '';
    setStatus(`Compile error${lineInfo}: ${message}`, 'error');

    // Parse all errors from raw WebGL log for editor annotations
    const annotations: Array<{ row: number; column: number; text: string; type: 'error' | 'warning' | 'info' }> = [];
    if (compileErr.raw) {
      const errorRegex = /ERROR:\s*\d+:(\d+):\s*(.+)/g;
      let m;
      // Get wrapper line count from the renderer
      const sr = state.renderer as any;
      const baseWrapperLines = 18;
      const customUniformLines = sr?.customParams ? sr.customParams.length : 0;
      const extraEffectLines = sr?.extraWrapperLines ?? 0;
      const wrapperLines = baseWrapperLines + customUniformLines + extraEffectLines + 3;
      while ((m = errorRegex.exec(compileErr.raw)) !== null) {
        const line = Math.max(1, parseInt(m[1]) - wrapperLines);
        annotations.push({ row: line - 1, column: 0, text: m[2], type: 'error' });
      }
    }
    if (annotations.length === 0 && compileErr.line) {
      annotations.push({ row: compileErr.line - 1, column: 0, text: message, type: 'error' });
    }
    if (annotations.length > 0) {
      editor.session.setAnnotations(annotations);
    }
  }
}
