// Settings Dialog module — manages the application settings overlay.
// Typed version of js/settings.js.

import { state } from '../core/state.js';
import type {
  SettingsDialogData,
  ClaudeSettings,
  ClaudeModel,
  Resolution,
} from '@shared/types/settings.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Payload sent to the main process when the user clicks Apply */
interface SettingsData {
  ndiResolution?: Resolution;
  ndiFrameSkip: number;
  gridSlotWidth: number;
  remoteEnabled: boolean;
  remotePort: number;
  recordingResolution?: Resolution;
}

/** Minimal electronAPI surface used by this module */
declare const window: Window & {
  electronAPI: {
    getSettings(): Promise<SettingsDialogData>;
    getClaudeSettings(): Promise<ClaudeSettings>;
    testClaudeKey(key: string | null): Promise<{ success: boolean; error?: string }>;
    saveClaudeKey(key: string | null, model: string): Promise<void>;
    getClaudeModels(): Promise<ClaudeModel[]>;
    saveSettings(data: SettingsData): void;
  };
};

// ---------------------------------------------------------------------------
// External module stubs (not yet converted to TS)
// ---------------------------------------------------------------------------

declare function setStatus(message: string, type?: 'success' | 'error' | 'info'): void;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let settingsKeyHandler: ((e: KeyboardEvent) => void) | null = null;

const FALLBACK_MODELS: ClaudeModel[] = [
  { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4 (Recommended)' },
  { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5 (Most Capable)' },
  { id: 'claude-3-5-haiku-20241022', display_name: 'Claude 3.5 Haiku (Fast)' },
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildModelOptions(models: ClaudeModel[] | null, selectedModel: string): string {
  const list = (models && models.length > 0) ? models : FALLBACK_MODELS;
  return list.map(m =>
    `<option value="${m.id}" ${m.id === selectedModel ? 'selected' : ''}>${m.display_name}</option>`
  ).join('');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function applyGridSlotWidth(width: number): void {
  document.documentElement.style.setProperty('--grid-slot-width', `${width}px`);
}

/** Load and apply grid slot width on startup */
export async function initSettingsOnLoad(): Promise<void> {
  const settings = await window.electronAPI.getSettings();
  if (settings.gridSlotWidth) {
    applyGridSlotWidth(settings.gridSlotWidth);
  }
}

export async function showSettingsDialog(): Promise<void> {
  // Get current settings
  const settings = await window.electronAPI.getSettings();

  // Get Claude settings
  const claudeSettings = await window.electronAPI.getClaudeSettings();

  // Create settings dialog overlay
  const overlay = document.createElement('div');
  overlay.id = 'settings-overlay';
  overlay.innerHTML = `
    <div class="settings-dialog">
      <div class="settings-header">
        <h2>Settings</h2>
        <button class="close-btn" id="settings-close-btn">&times;</button>
      </div>
      <div class="settings-content">
        <div class="settings-section">
          <h3>NDI Output</h3>
          <div class="setting-row">
            <label>Resolution:</label>
            <select id="settings-ndi-resolution">
              ${settings.ndiResolutions.map(res =>
                `<option value="${res.label}" ${settings.ndiResolution.label === res.label ? 'selected' : ''}>${res.label}</option>`
              ).join('')}
            </select>
          </div>
          <div class="setting-row custom-res ${settings.ndiResolution.label.includes('Custom') ? '' : 'hidden'}" id="custom-ndi-res">
            <label>Custom Size:</label>
            <input type="number" id="settings-ndi-width" value="${settings.ndiResolution.width}" min="128" max="7680" placeholder="Width">
            <span>x</span>
            <input type="number" id="settings-ndi-height" value="${settings.ndiResolution.height}" min="128" max="4320" placeholder="Height">
          </div>
          <div class="setting-row">
            <label>Frame Rate:</label>
            <select id="settings-ndi-frameskip">
              <option value="1" ${settings.ndiFrameSkip === 1 ? 'selected' : ''}>60 fps (every frame)</option>
              <option value="2" ${settings.ndiFrameSkip === 2 ? 'selected' : ''}>30 fps (every 2nd frame)</option>
              <option value="3" ${settings.ndiFrameSkip === 3 ? 'selected' : ''}>20 fps (every 3rd frame)</option>
              <option value="4" ${settings.ndiFrameSkip === 4 ? 'selected' : ''}>15 fps (every 4th frame)</option>
              <option value="6" ${settings.ndiFrameSkip === 6 ? 'selected' : ''}>10 fps (every 6th frame)</option>
            </select>
          </div>
          <div class="setting-row">
            <label>Status:</label>
            <span class="ndi-status ${settings.ndiEnabled ? 'active' : ''}">${settings.ndiEnabled ? 'Active' : 'Inactive'}</span>
          </div>
        </div>

        <div class="settings-section">
          <h3>Recording</h3>
          <div class="setting-row">
            <label>Resolution:</label>
            <select id="settings-recording-resolution">
              ${settings.recordingResolutions.map(res =>
                `<option value="${res.label}" ${settings.recordingResolution.label === res.label ? 'selected' : ''}>${res.label}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-section">
          <h3>Preview</h3>
          <div class="setting-row">
            <label>Resolution:</label>
            <span id="current-preview-res">${(document.getElementById('shader-canvas') as HTMLCanvasElement).width}x${(document.getElementById('shader-canvas') as HTMLCanvasElement).height}</span>
          </div>
        </div>

        <div class="settings-section">
          <h3>Shader Grid</h3>
          <div class="setting-row">
            <label>Slot Size:</label>
            <input type="range" id="settings-grid-slot-width" min="80" max="300" step="10" value="${settings.gridSlotWidth || 150}">
            <span id="settings-grid-slot-width-value">${settings.gridSlotWidth || 150}px</span>
          </div>
        </div>

        <div class="settings-section">
          <h3>Remote Control</h3>
          <div class="setting-row">
            <label>Enable:</label>
            <input type="checkbox" id="settings-remote-enabled" ${settings.remoteEnabled ? 'checked' : ''}>
          </div>
          <div class="setting-row">
            <label>Port:</label>
            <input type="number" id="settings-remote-port" value="${settings.remotePort || 9876}" min="1024" max="65535" style="width:80px">
          </div>
          <div class="setting-row">
            <label>URL:</label>
            <span id="settings-remote-url" style="color: var(--text-secondary); user-select: all">${settings.remoteEnabled && settings.remoteIPs?.length
              ? `http://${settings.remoteIPs[0]}:${settings.remotePort || 9876}`
              : '(disabled)'}</span>
          </div>
        </div>

        <div class="settings-section claude-settings-section">
          <h3>Claude AI Assistant</h3>
          <div class="setting-row">
            <label>API Key:</label>
            <input type="password" id="settings-claude-key" class="api-key-input"
                   placeholder="${claudeSettings.hasKey ? 'Key saved (' + claudeSettings.maskedKey + ')' : 'Enter your Anthropic API key'}"
                   value="">
            <button class="btn-secondary" id="settings-test-key">Test</button>
            <span id="claude-test-result" class="test-result"></span>
          </div>
          <div class="setting-row">
            <label>Model:</label>
            <select id="settings-claude-model">
              ${buildModelOptions(claudeSettings.models, claudeSettings.model)}
            </select>
          </div>
          <div class="setting-row">
            <label>Shortcut:</label>
            <span style="color: var(--text-secondary)">Ctrl+Shift+A opens AI assistant</span>
          </div>
        </div>
      </div>
      <div class="settings-footer">
        <button class="btn-secondary" id="settings-cancel-btn">Cancel</button>
        <button class="btn-primary" id="settings-apply-btn">Apply</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Handle close button
  (document.getElementById('settings-close-btn') as HTMLButtonElement).addEventListener('click', closeSettingsDialog);

  // Handle cancel button
  (document.getElementById('settings-cancel-btn') as HTMLButtonElement).addEventListener('click', closeSettingsDialog);

  // Handle apply button
  (document.getElementById('settings-apply-btn') as HTMLButtonElement).addEventListener('click', applySettings);

  // Handle resolution dropdown change
  const resSelect = document.getElementById('settings-ndi-resolution') as HTMLSelectElement;
  resSelect.addEventListener('change', () => {
    const customRes = document.getElementById('custom-ndi-res') as HTMLElement;
    if (resSelect.value === 'Custom...') {
      customRes.classList.remove('hidden');
    } else {
      customRes.classList.add('hidden');
    }
  });

  // Grid slot size slider live preview
  const slotWidthSlider = document.getElementById('settings-grid-slot-width') as HTMLInputElement;
  const slotWidthValue = document.getElementById('settings-grid-slot-width-value') as HTMLSpanElement;
  slotWidthSlider.addEventListener('input', () => {
    slotWidthValue.textContent = `${slotWidthSlider.value}px`;
  });

  // Remote control -- update URL display when toggling/changing port
  const remoteEnabledCb = document.getElementById('settings-remote-enabled') as HTMLInputElement;
  const remotePortInput = document.getElementById('settings-remote-port') as HTMLInputElement;
  const remoteUrlSpan = document.getElementById('settings-remote-url') as HTMLSpanElement;

  function updateRemoteUrlDisplay(): void {
    const enabled = remoteEnabledCb.checked;
    const port = parseInt(remotePortInput.value) || 9876;
    if (enabled && settings.remoteIPs?.length) {
      remoteUrlSpan.textContent = `http://${settings.remoteIPs[0]}:${port}`;
    } else {
      remoteUrlSpan.textContent = '(disabled)';
    }
  }
  remoteEnabledCb.addEventListener('change', updateRemoteUrlDisplay);
  remotePortInput.addEventListener('input', updateRemoteUrlDisplay);

  // Close on overlay click
  overlay.addEventListener('click', (e: MouseEvent) => {
    if (e.target === overlay) closeSettingsDialog();
  });

  // Close on Escape
  settingsKeyHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeSettingsDialog();
  };
  document.addEventListener('keydown', settingsKeyHandler);

  // Claude API key test button
  (document.getElementById('settings-test-key') as HTMLButtonElement).addEventListener('click', testClaudeKey);
}

// ---------------------------------------------------------------------------
// Internal functions
// ---------------------------------------------------------------------------

async function testClaudeKey(): Promise<void> {
  const keyInput = document.getElementById('settings-claude-key') as HTMLInputElement;
  const resultSpan = document.getElementById('claude-test-result') as HTMLSpanElement;
  const testBtn = document.getElementById('settings-test-key') as HTMLButtonElement;

  const key = keyInput.value.trim();

  if (!key) {
    // Test existing key
    const settings = await window.electronAPI.getClaudeSettings();
    if (!settings.hasKey) {
      resultSpan.textContent = 'No key to test';
      resultSpan.className = 'test-result error';
      return;
    }
  }

  testBtn.disabled = true;
  resultSpan.textContent = 'Testing...';
  resultSpan.className = 'test-result';

  try {
    const result = await window.electronAPI.testClaudeKey(key || null);

    if (result.success) {
      resultSpan.textContent = 'Valid!';
      resultSpan.className = 'test-result success';
      // Save the key so fetchClaudeModels can use it, then refresh dropdown
      if (key) {
        const modelSelect = document.getElementById('settings-claude-model') as HTMLSelectElement;
        const currentModel = modelSelect.value;
        await window.electronAPI.saveClaudeKey(key, currentModel);
        const models = await window.electronAPI.getClaudeModels();
        if (models && models.length > 0) {
          modelSelect.innerHTML = buildModelOptions(models, currentModel);
        }
      }
    } else {
      resultSpan.textContent = result.error || 'Invalid';
      resultSpan.className = 'test-result error';
    }
  } catch (_err) {
    resultSpan.textContent = 'Test failed';
    resultSpan.className = 'test-result error';
  }

  testBtn.disabled = false;
}

export function closeSettingsDialog(): void {
  const overlay = document.getElementById('settings-overlay');
  if (overlay) {
    overlay.remove();
    if (settingsKeyHandler) {
      document.removeEventListener('keydown', settingsKeyHandler);
      settingsKeyHandler = null;
    }
  }
}

async function applySettings(): Promise<void> {
  const resSelect = document.getElementById('settings-ndi-resolution') as HTMLSelectElement;
  const selectedLabel = resSelect.value;

  let ndiResolution: Resolution | undefined;
  if (selectedLabel === 'Custom...') {
    const width = parseInt((document.getElementById('settings-ndi-width') as HTMLInputElement).value) || 1920;
    const height = parseInt((document.getElementById('settings-ndi-height') as HTMLInputElement).value) || 1080;
    ndiResolution = { width, height, label: `${width}x${height} (Custom)` };
  } else {
    // Parse from label
    const match = selectedLabel.match(/(\d+)x(\d+)/);
    if (match) {
      ndiResolution = {
        width: parseInt(match[1]),
        height: parseInt(match[2]),
        label: selectedLabel,
      };
    }
  }

  // Parse recording resolution
  const recResSelect = document.getElementById('settings-recording-resolution') as HTMLSelectElement | null;
  let recordingResolution: Resolution | undefined;
  if (recResSelect) {
    const recLabel = recResSelect.value;
    if (recLabel === 'Match Preview') {
      recordingResolution = { width: 0, height: 0, label: 'Match Preview' };
    } else {
      const recMatch = recLabel.match(/(\d+)x(\d+)/);
      if (recMatch) {
        recordingResolution = {
          width: parseInt(recMatch[1]),
          height: parseInt(recMatch[2]),
          label: recLabel,
        };
      }
    }
  }

  // Parse NDI frame skip
  const frameSkipSelect = document.getElementById('settings-ndi-frameskip') as HTMLSelectElement | null;
  const ndiFrameSkip = frameSkipSelect ? parseInt(frameSkipSelect.value) : 4;

  // Parse grid slot width
  const gridSlotWidth = parseInt((document.getElementById('settings-grid-slot-width') as HTMLInputElement).value) || 150;

  // Parse remote control settings
  const remoteEnabled = (document.getElementById('settings-remote-enabled') as HTMLInputElement).checked;
  const remotePort = parseInt((document.getElementById('settings-remote-port') as HTMLInputElement).value) || 9876;

  // Save to file
  const settingsData: SettingsData = { ndiResolution, ndiFrameSkip, gridSlotWidth, remoteEnabled, remotePort };
  if (recordingResolution) {
    settingsData.recordingResolution = recordingResolution;
  }
  window.electronAPI.saveSettings(settingsData);

  // Apply grid slot width immediately
  applyGridSlotWidth(gridSlotWidth);

  // Save Claude settings if key was entered
  const claudeKey = (document.getElementById('settings-claude-key') as HTMLInputElement).value.trim();
  const claudeModel = (document.getElementById('settings-claude-model') as HTMLSelectElement).value;

  if (claudeKey) {
    await window.electronAPI.saveClaudeKey(claudeKey, claudeModel);
  } else {
    // Still save model selection even without new key
    const currentSettings = await window.electronAPI.getClaudeSettings();
    if (currentSettings.hasKey) {
      await window.electronAPI.saveClaudeKey(null, claudeModel);
    }
  }

  closeSettingsDialog();
  setStatus('Settings saved', 'success');
}
