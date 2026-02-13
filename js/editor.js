// Editor module
import { state } from './state.js';
import { setStatus, updateChannelSlot } from './utils.js';
import { saveActiveSlotShader } from './shader-grid.js';
import { generateCustomParamUI } from './params.js';
import { initTabs, markTabSaved, getActiveTab } from './tabs.js';
import { toggleConsolePanel } from './console-panel.js';
import { log } from './logger.js';

export async function initEditor() {
  log.debug('Editor', 'Initializing editor');
  state.editor = ace.edit('editor');
  state.editor.setTheme('ace/theme/monokai');
  state.editor.session.setMode('ace/mode/glsl');
  state.editor.setOptions({
    fontSize: '14px',
    showPrintMargin: false,
    tabSize: 2,
    useSoftTabs: true,
    wrap: false,
    enableBasicAutocompletion: true
  });

  // Auto-compile on change (debounced) - attached to editor, works across all sessions
  state.editor.on('change', () => {
    clearTimeout(state.compileTimeout);
    state.compileTimeout = setTimeout(compileShader, 500);
  });

  // Update cursor position in status bar
  state.editor.selection.on('changeCursor', () => {
    const pos = state.editor.getCursorPosition();
    document.getElementById('cursor-position').textContent =
      `Ln ${pos.row + 1}, Col ${pos.column + 1}`;
  });

  // Keyboard shortcuts
  state.editor.commands.addCommand({
    name: 'compile',
    bindKey: { win: 'Ctrl-Enter', mac: 'Cmd-Enter' },
    exec: compileShader
  });

  state.editor.commands.addCommand({
    name: 'save',
    bindKey: { win: 'Ctrl-S', mac: 'Cmd-S' },
    exec: () => {
      // If a grid slot is active, save to slot file
      if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
        saveActiveSlotShader();
      } else {
        // Otherwise use standard file save
        window.electronAPI.saveContent(state.editor.getValue());
      }
      // Mark the current tab as saved
      const activeTab = getActiveTab();
      if (activeTab) {
        markTabSaved(activeTab.id);
      }
    }
  });

  state.editor.commands.addCommand({
    name: 'toggleConsole',
    bindKey: { win: 'Ctrl-J', mac: 'Cmd-J' },
    exec: toggleConsolePanel
  });

  // Listen for tab activation to switch modes and compile
  window.addEventListener('tab-activated', (e) => {
    const { type } = e.detail;

    // Set editor mode based on tab type
    setEditorMode(type);

    // Import setRenderMode dynamically to avoid circular dependency
    import('./renderer.js').then(async ({ setRenderMode }) => {
      await setRenderMode(type);
      // Compile after mode is set
      compileShader();
      generateCustomParamUI();
    });
  });

  // Initialize tabs system (will create initial tab with default shader)
  await initTabs();
}

// Set editor mode based on file type
export function setEditorMode(mode) {
  if (mode === 'scene' || mode === 'jsx' || mode === 'javascript') {
    state.editor.session.setMode('ace/mode/javascript');
  } else {
    state.editor.session.setMode('ace/mode/glsl');
  }
}

// Compile current editor content (shader or scene)
export async function compileShader() {
  // Guard: renderer may not be initialized yet during startup
  if (!state.renderer) return;

  const source = state.editor.getValue();

  // Clear previous error markers
  state.editor.session.clearAnnotations();

  try {
    // Compile using the active renderer
    state.renderer.compile(source);

    const modeLabel = state.renderMode === 'scene' ? 'Scene' : 'Shader';
    log.info('Editor', modeLabel, 'compiled successfully');
    setStatus(`${modeLabel} compiled successfully`, 'success');

    // Generate dynamic UI for custom parameters
    generateCustomParamUI();

    // Update channel UI for builtin @texture directives
    if (state.renderer.textureDirectives) {
      for (const { channel, textureName } of state.renderer.textureDirectives) {
        const spec = { RGBANoise: [256, 256], RGBANoiseSmall: [64, 64], GrayNoise: [256, 256], GrayNoiseSmall: [64, 64] };
        const [w, h] = spec[textureName] || [0, 0];
        updateChannelSlot(channel, 'builtin', textureName, w, h);
      }
    }

    // Load AudioFFT channels from @texture directives
    if (state.renderer.audioDirectives) {
      for (const { channel } of state.renderer.audioDirectives) {
        state.channelState[channel] = { type: 'audio' };
        updateChannelSlot(channel, 'audio', 'Audio FFT', 512, 2);
      }
    }

    // Load file textures from @texture directives (async)
    if (state.renderer.fileTextureDirectives) {
      for (const { channel, textureName } of state.renderer.fileTextureDirectives) {
        try {
          const result = await window.electronAPI.loadFileTexture(textureName);
          if (result.success) {
            await state.renderer.loadTexture(channel, result.dataUrl);
            state.channelState[channel] = { type: 'file-texture', name: textureName };
            const w = state.renderer.channelResolutions[channel][0];
            const h = state.renderer.channelResolutions[channel][1];
            log.debug('Editor', 'Loaded file texture', textureName, 'ch' + channel, w + 'x' + h);
            updateChannelSlot(channel, 'builtin', `texture:${textureName}`, w, h);
          } else {
            log.warn('Editor', 'Texture not found:', textureName);
            setStatus(`Texture "${textureName}" not found in data/textures/`, 'error');
          }
        } catch (texErr) {
          log.error('Editor', 'Failed to load file texture', textureName, texErr);
          setStatus(`Failed to load texture "${textureName}"`, 'error');
        }
      }
    }

    // Sync to fullscreen window
    window.electronAPI.sendShaderUpdate({
      shaderCode: source,
      renderMode: state.renderMode
    });
  } catch (err) {
    const message = err.message || err.raw || String(err);
    log.error('Editor', 'Compile error:', message);
    setStatus(`Compile error: ${message}`, 'error');

    // Add error annotation to editor
    if (err.line) {
      state.editor.session.setAnnotations([{
        row: err.line - 1,
        column: 0,
        text: err.message,
        type: 'error'
      }]);
    }
  }
}
