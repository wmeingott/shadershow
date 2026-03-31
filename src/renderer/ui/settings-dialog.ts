// Settings Dialog module — manages the application settings overlay.
// Typed version of js/settings.js.

import { state } from '../core/state.js';
import type {
  SettingsDialogData,
  AISettings,
  ClaudeModel,
  Resolution,
  AIProvider,
} from '@shared/types/settings.js';
import type { ArtNetMapping, ArtNetStatus } from '@shared/types/artnet.js';
import { showArtNetMappingDialog } from './artnet-dialog.js';

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
  artnetEnabled: boolean;
  artnetUniverse: number;
}

/** Minimal electronAPI surface used by this module */
declare const window: Window & {
  electronAPI: {
    getSettings(): Promise<SettingsDialogData>;
    getClaudeSettings(): Promise<AISettings>;
    testClaudeKey(key: string | null): Promise<{ success: boolean; error?: string }>;
    testOpenRouterKey(key: string | null): Promise<{ success: boolean; error?: string }>;
    saveClaudeKey(key: string | null, model: string): Promise<void>;
    saveOpenRouterKey(key: string | null): Promise<void>;
    getClaudeModels(): Promise<ClaudeModel[]>;
    saveSettings(data: SettingsData): void;
    setAIProvider(provider: string): Promise<void>;
    setArtNetMappings(mappings: ArtNetMapping[]): void;
    getArtNetStatus(): Promise<ArtNetStatus>;
    getArtNetDmxValues(): Promise<number[]>;
    toggleArtNet(): void;
  };
};

import { setStatus } from './utils.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let settingsKeyHandler: ((e: KeyboardEvent) => void) | null = null;

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

  // Get AI settings
  const aiSettings = await window.electronAPI.getClaudeSettings();

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
              ? `http://${settings.remoteIPs[0]}:${settings.remotePort || 9876}?token=${settings.remoteToken || ''}`
              : '(disabled)'}</span>
          </div>
          <div class="setting-row">
            <label>Token:</label>
            <code id="settings-remote-token" style="color: var(--text-secondary); user-select: all; font-size: 11px">${settings.remoteToken || '(generated on enable)'}</code>
          </div>
        </div>

        <div class="settings-section">
          <h3>Art-Net DMX</h3>
          <div class="setting-row">
            <label>Enable:</label>
            <input type="checkbox" id="settings-artnet-enabled" ${settings.artnetEnabled ? 'checked' : ''}>
          </div>
          <div class="setting-row">
            <label>Universe:</label>
            <input type="number" id="settings-artnet-universe" value="${settings.artnetUniverse ?? 0}" min="0" max="32767" style="width:80px">
          </div>
          <div class="setting-row">
            <label>Mappings:</label>
            <button class="btn-secondary" id="settings-artnet-mappings-btn">Configure (${settings.artnetMappings?.length ?? 0})</button>
          </div>
          <div class="setting-row">
            <label>Status:</label>
            <span id="settings-artnet-status" style="color: var(--text-secondary)">${settings.artnetEnabled ? 'Active' : 'Inactive'}</span>
          </div>
        </div>

        <div class="settings-section claude-settings-section">
          <h3>AI Assistant</h3>
          <div class="setting-row">
            <label>Provider:</label>
            <select id="settings-ai-provider">
              <option value="anthropic" ${aiSettings.provider === 'anthropic' ? 'selected' : ''}>Anthropic</option>
              <option value="openrouter" ${aiSettings.provider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
            </select>
          </div>
          <div id="settings-anthropic-key-row" class="setting-row ${aiSettings.provider !== 'anthropic' ? 'hidden' : ''}">
            <label>API Key:</label>
            <input type="password" id="settings-claude-key" class="api-key-input"
                   placeholder="${aiSettings.hasKey ? 'Key saved (' + aiSettings.maskedKey + ')' : 'Enter your Anthropic API key'}"
                   value="">
            <button class="btn-secondary" id="settings-test-anthropic-key">Test</button>
            <span id="anthropic-test-result" class="test-result"></span>
          </div>
          <div id="settings-openrouter-key-row" class="setting-row ${aiSettings.provider !== 'openrouter' ? 'hidden' : ''}">
            <label>API Key:</label>
            <input type="password" id="settings-openrouter-key" class="api-key-input"
                   placeholder="${aiSettings.hasOpenrouterKey ? 'Key saved (' + aiSettings.maskedOpenrouterKey + ')' : 'Enter your OpenRouter API key'}"
                   value="">
            <button class="btn-secondary" id="settings-test-openrouter-key">Test</button>
            <span id="openrouter-test-result" class="test-result"></span>
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
      const token = settings.remoteToken || '';
      remoteUrlSpan.textContent = `http://${settings.remoteIPs[0]}:${port}?token=${token}`;
    } else {
      remoteUrlSpan.textContent = '(disabled)';
    }
  }
  remoteEnabledCb.addEventListener('change', updateRemoteUrlDisplay);
  remotePortInput.addEventListener('input', updateRemoteUrlDisplay);

  // Art-Net mapping button
  const artnetMappingsBtn = document.getElementById('settings-artnet-mappings-btn');
  artnetMappingsBtn?.addEventListener('click', () => {
    showArtNetMappingDialog(settings.artnetMappings ?? [], (mappings) => {
      window.electronAPI.setArtNetMappings(mappings);
      artnetMappingsBtn.textContent = `Configure (${mappings.length})`;
    });
  });

  // AI provider toggle — show/hide key rows
  const providerSelect = document.getElementById('settings-ai-provider') as HTMLSelectElement;
  providerSelect.addEventListener('change', () => {
    const anthropicRow = document.getElementById('settings-anthropic-key-row') as HTMLElement;
    const openrouterRow = document.getElementById('settings-openrouter-key-row') as HTMLElement;
    if (providerSelect.value === 'anthropic') {
      anthropicRow.classList.remove('hidden');
      openrouterRow.classList.add('hidden');
    } else {
      anthropicRow.classList.add('hidden');
      openrouterRow.classList.remove('hidden');
    }
  });

  // Close on overlay click
  overlay.addEventListener('click', (e: MouseEvent) => {
    if (e.target === overlay) closeSettingsDialog();
  });

  // Close on Escape
  settingsKeyHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeSettingsDialog();
  };
  document.addEventListener('keydown', settingsKeyHandler);

  // Test key buttons
  (document.getElementById('settings-test-anthropic-key') as HTMLButtonElement).addEventListener('click', testAnthropicKey);
  (document.getElementById('settings-test-openrouter-key') as HTMLButtonElement).addEventListener('click', testOpenRouterKey);
}

// ---------------------------------------------------------------------------
// Internal functions
// ---------------------------------------------------------------------------

async function testAnthropicKey(): Promise<void> {
  const keyInput = document.getElementById('settings-claude-key') as HTMLInputElement;
  const resultSpan = document.getElementById('anthropic-test-result') as HTMLSpanElement;
  const testBtn = document.getElementById('settings-test-anthropic-key') as HTMLButtonElement;

  const key = keyInput.value.trim();

  if (!key) {
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

async function testOpenRouterKey(): Promise<void> {
  const keyInput = document.getElementById('settings-openrouter-key') as HTMLInputElement;
  const resultSpan = document.getElementById('openrouter-test-result') as HTMLSpanElement;
  const testBtn = document.getElementById('settings-test-openrouter-key') as HTMLButtonElement;

  const key = keyInput.value.trim();

  if (!key) {
    const settings = await window.electronAPI.getClaudeSettings();
    if (!settings.hasOpenrouterKey) {
      resultSpan.textContent = 'No key to test';
      resultSpan.className = 'test-result error';
      return;
    }
  }

  testBtn.disabled = true;
  resultSpan.textContent = 'Testing...';
  resultSpan.className = 'test-result';

  try {
    const result = await window.electronAPI.testOpenRouterKey(key || null);
    if (result.success) {
      resultSpan.textContent = 'Valid!';
      resultSpan.className = 'test-result success';
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

  // Parse Art-Net settings
  const artnetEnabled = (document.getElementById('settings-artnet-enabled') as HTMLInputElement).checked;
  const artnetUniverse = parseInt((document.getElementById('settings-artnet-universe') as HTMLInputElement).value) || 0;

  // Save to file
  const settingsData: SettingsData = { ndiResolution, ndiFrameSkip, gridSlotWidth, remoteEnabled, remotePort, artnetEnabled, artnetUniverse };
  if (recordingResolution) {
    settingsData.recordingResolution = recordingResolution;
  }
  window.electronAPI.saveSettings(settingsData);

  // Apply grid slot width immediately
  applyGridSlotWidth(gridSlotWidth);

  // Save AI provider
  const providerSelect = document.getElementById('settings-ai-provider') as HTMLSelectElement;
  const provider = providerSelect.value as AIProvider;
  await window.electronAPI.setAIProvider(provider);

  // Save Anthropic key if entered
  const claudeKey = (document.getElementById('settings-claude-key') as HTMLInputElement).value.trim();
  if (claudeKey) {
    const currentSettings = await window.electronAPI.getClaudeSettings();
    await window.electronAPI.saveClaudeKey(claudeKey, currentSettings.model);
  }

  // Save OpenRouter key if entered
  const openrouterKey = (document.getElementById('settings-openrouter-key') as HTMLInputElement).value.trim();
  if (openrouterKey) {
    await window.electronAPI.saveOpenRouterKey(openrouterKey);
  }

  closeSettingsDialog();
  setStatus('Settings saved', 'success');
}
