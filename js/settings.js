// Settings Dialog module
import { state } from './state.js';
import { setStatus } from './utils.js';

let settingsKeyHandler = null;

export async function showSettingsDialog() {
  // Get current settings
  const settings = await window.electronAPI.getSettings();

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
            <label>Status:</label>
            <span class="ndi-status ${settings.ndiEnabled ? 'active' : ''}">${settings.ndiEnabled ? 'Active' : 'Inactive'}</span>
          </div>
        </div>

        <div class="settings-section">
          <h3>Preview</h3>
          <div class="setting-row">
            <label>Resolution:</label>
            <span id="current-preview-res">${document.getElementById('shader-canvas').width}x${document.getElementById('shader-canvas').height}</span>
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

function applySettings() {
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

  // Save to file
  window.electronAPI.saveSettings({ ndiResolution });

  closeSettingsDialog();
  setStatus('Settings saved', 'success');
}
