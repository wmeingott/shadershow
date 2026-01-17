// Editor module
import { state } from './state.js';
import { setStatus } from './utils.js';
import { saveActiveSlotShader } from './shader-grid.js';
import { generateCustomParamUI } from './params.js';

export function initEditor() {
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

  // Auto-compile on change (debounced)
  state.editor.session.on('change', () => {
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
    }
  });
}

export function compileShader() {
  const source = state.editor.getValue();

  // Clear previous error markers
  state.editor.session.clearAnnotations();

  try {
    state.renderer.compile(source);
    setStatus('Shader compiled successfully', 'success');

    // Generate dynamic UI for custom shader parameters
    generateCustomParamUI();

    // Sync to fullscreen window
    window.electronAPI.sendShaderUpdate({ shaderCode: source });
  } catch (err) {
    const message = err.message || err.raw || String(err);
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
