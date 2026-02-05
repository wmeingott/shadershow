// Settings Dialog module
import { state } from './state.js';
import { setStatus } from './utils.js';

let settingsKeyHandler = null;

export async function showSettingsDialog() {
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
            <span id="current-preview-res">${document.getElementById('shader-canvas').width}x${document.getElementById('shader-canvas').height}</span>
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
              <option value="claude-sonnet-4-20250514" ${claudeSettings.model === 'claude-sonnet-4-20250514' ? 'selected' : ''}>Claude Sonnet 4 (Recommended)</option>
              <option value="claude-opus-4-5-20251101" ${claudeSettings.model === 'claude-opus-4-5-20251101' ? 'selected' : ''}>Claude Opus 4.5 (Most Capable)</option>
              <option value="claude-3-5-haiku-20241022" ${claudeSettings.model === 'claude-3-5-haiku-20241022' ? 'selected' : ''}>Claude 3.5 Haiku (Fast)</option>
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
  document.getElementById('settings-close-btn').addEventListener('click', closeSettingsDialog);

  // Handle cancel button
  document.getElementById('settings-cancel-btn').addEventListener('click', closeSettingsDialog);

  // Handle apply button
  document.getElementById('settings-apply-btn').addEventListener('click', applySettings);

  // Handle resolution dropdown change
  const resSelect = document.getElementById('settings-ndi-resolution');
  resSelect.addEventListener('change', () => {
    const customRes = document.getElementById('custom-ndi-res');
    if (resSelect.value === 'Custom...') {
      customRes.classList.remove('hidden');
    } else {
      customRes.classList.add('hidden');
    }
  });

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSettingsDialog();
  });

  // Close on Escape
  settingsKeyHandler = (e) => {
    if (e.key === 'Escape') closeSettingsDialog();
  };
  document.addEventListener('keydown', settingsKeyHandler);

  // Claude API key test button
  document.getElementById('settings-test-key').addEventListener('click', testClaudeKey);
}

async function testClaudeKey() {
  const keyInput = document.getElementById('settings-claude-key');
  const resultSpan = document.getElementById('claude-test-result');
  const testBtn = document.getElementById('settings-test-key');

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
    } else {
      resultSpan.textContent = result.error || 'Invalid';
      resultSpan.className = 'test-result error';
    }
  } catch (err) {
    resultSpan.textContent = 'Test failed';
    resultSpan.className = 'test-result error';
  }

  testBtn.disabled = false;
}

export function closeSettingsDialog() {
  const overlay = document.getElementById('settings-overlay');
  if (overlay) {
    overlay.remove();
    if (settingsKeyHandler) {
      document.removeEventListener('keydown', settingsKeyHandler);
      settingsKeyHandler = null;
    }
  }
}

async function applySettings() {
  const resSelect = document.getElementById('settings-ndi-resolution');
  const selectedLabel = resSelect.value;

  let ndiResolution;
  if (selectedLabel === 'Custom...') {
    const width = parseInt(document.getElementById('settings-ndi-width').value) || 1920;
    const height = parseInt(document.getElementById('settings-ndi-height').value) || 1080;
    ndiResolution = { width, height, label: `${width}x${height} (Custom)` };
  } else {
    // Parse from label
    const match = selectedLabel.match(/(\d+)x(\d+)/);
    if (match) {
      ndiResolution = {
        width: parseInt(match[1]),
        height: parseInt(match[2]),
        label: selectedLabel
      };
    }
  }

  // Parse recording resolution
  const recResSelect = document.getElementById('settings-recording-resolution');
  let recordingResolution;
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
          label: recLabel
        };
      }
    }
  }

  // Parse NDI frame skip
  const frameSkipSelect = document.getElementById('settings-ndi-frameskip');
  const ndiFrameSkip = frameSkipSelect ? parseInt(frameSkipSelect.value) : 4;

  // Save to file
  const settingsData = { ndiResolution, ndiFrameSkip };
  if (recordingResolution) {
    settingsData.recordingResolution = recordingResolution;
  }
  window.electronAPI.saveSettings(settingsData);

  // Save Claude settings if key was entered
  const claudeKey = document.getElementById('settings-claude-key').value.trim();
  const claudeModel = document.getElementById('settings-claude-model').value;

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
