// Shader Mixer - dynamic channel compositor with per-channel parameters
import { state, notifyRemoteStateChanged } from './state.js';
import { MiniShaderRenderer } from './shader-grid.js';
import { AssetRenderer } from './asset-renderer.js';
import { loadParamsToSliders, generateCustomParamUI } from './params.js';
import { updateLocalPresetsUI } from './presets.js';
import { setStatus } from './utils.js';
import { log } from './logger.js';

const MAX_MIXER_CHANNELS = 8;

let mixerOverlayCanvas = null;
let mixerOverlayCtx = null;

// Create a mixer channel DOM element and attach event handlers
function createChannelElement(index) {
  const channelEl = document.createElement('div');
  channelEl.className = 'mixer-channel';
  channelEl.dataset.channel = String(index);

  const btn = document.createElement('button');
  btn.className = 'mixer-btn';
  btn.title = 'Click to arm, then click a grid shader to assign. Right-click to clear.';
  btn.textContent = '\u2014';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'mixer-slider';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.01';
  slider.value = '1';

  channelEl.appendChild(btn);
  channelEl.appendChild(slider);

  // Left click: if assigned, select for param editing; if not, arm/disarm
  btn.addEventListener('click', () => {
    const ch = state.mixerChannels[index];
    if (state.mixerArmedChannel === index) {
      state.mixerArmedChannel = null;
      btn.classList.remove('armed');
      setStatus('Mixer channel disarmed', 'success');
    } else if ((ch.slotIndex !== null && ch.tabIndex !== null) || ch.renderer) {
      disarmAll();
      selectMixerChannel(index);
    } else {
      disarmAll();
      state.mixerArmedChannel = index;
      btn.classList.add('armed');
      setStatus(`Mixer channel ${index + 1} armed \u2014 click a grid shader to assign`, 'success');
    }
  });

  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    clearMixerChannel(index);
  });

  slider.addEventListener('input', () => {
    const alpha = parseFloat(slider.value);
    state.mixerChannels[index].alpha = alpha;
    window.electronAPI.sendMixerAlphaUpdate({ channelIndex: index, alpha });
  });

  return channelEl;
}

function updateAddButtonVisibility() {
  const addBtn = document.getElementById('mixer-add-btn');
  if (addBtn) {
    addBtn.classList.toggle('hidden', state.mixerChannels.length >= MAX_MIXER_CHANNELS);
  }
}

export function addMixerChannel() {
  if (state.mixerChannels.length >= MAX_MIXER_CHANNELS) return null;

  const newIndex = state.mixerChannels.length;
  state.mixerChannels.push({
    slotIndex: null, alpha: 1.0, params: {}, customParams: {}, renderer: null, shaderCode: null
  });

  const container = document.getElementById('mixer-channels');
  if (container) {
    container.appendChild(createChannelElement(newIndex));
  }

  updateAddButtonVisibility();
  log.info('Mixer', 'Channel added, total:', state.mixerChannels.length);
  notifyRemoteStateChanged();
  return newIndex;
}

function removeMixerChannelDOM(index) {
  const container = document.getElementById('mixer-channels');
  if (!container) return;
  const channels = container.querySelectorAll('.mixer-channel');
  if (channels[index]) {
    channels[index].remove();
  }
  // Re-index remaining channel elements and rebind events
  rebuildChannelElements();
}

// Rebuild all channel DOM elements from state (used after splice)
function rebuildChannelElements() {
  const container = document.getElementById('mixer-channels');
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < state.mixerChannels.length; i++) {
    const ch = state.mixerChannels[i];
    const el = createChannelElement(i);
    const btn = el.querySelector('.mixer-btn');
    const slider = el.querySelector('.mixer-slider');

    if ((ch.slotIndex !== null && ch.tabIndex !== null) || ch.renderer) {
      if (ch.assetType) {
        btn.textContent = ch.slotIndex !== null ? 'A' + String(ch.slotIndex + 1) : 'A';
      } else {
        btn.textContent = ch.renderer && ch.slotIndex === null ? 'M' : String(ch.slotIndex + 1);
      }
      btn.classList.add('assigned');
    }
    if (state.mixerSelectedChannel === i) {
      btn.classList.add('selected');
    }
    if (state.mixerArmedChannel === i) {
      btn.classList.add('armed');
    }
    slider.value = String(ch.alpha);

    container.appendChild(el);
  }
  updateAddButtonVisibility();
}

export function initMixer() {
  const panel = document.getElementById('mixer-panel');
  if (!panel) return;

  // Generate initial channel elements from state
  rebuildChannelElements();

  const blendSelect = document.getElementById('mixer-blend-mode');
  if (blendSelect) {
    blendSelect.value = state.mixerBlendMode;
    blendSelect.addEventListener('change', () => {
      state.mixerBlendMode = blendSelect.value;
      window.electronAPI.sendMixerBlendMode({ blendMode: blendSelect.value });
    });
  }

  const resetBtn = document.getElementById('mixer-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      resetMixer();
    });
  }

  const toggleBtn = document.getElementById('mixer-toggle-btn');
  if (toggleBtn) {
    if (state.mixerEnabled) toggleBtn.classList.add('active');
    toggleBtn.addEventListener('click', () => {
      state.mixerEnabled = !state.mixerEnabled;
      toggleBtn.classList.toggle('active', state.mixerEnabled);
      if (!state.mixerEnabled) hideMixerOverlay();
      generateCustomParamUI();
      setStatus(state.mixerEnabled ? 'Mixer enabled' : 'Mixer disabled', 'success');
    });
  }

  const addBtn = document.getElementById('mixer-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const newIndex = addMixerChannel();
      if (newIndex !== null) {
        // Auto-arm the new channel
        disarmAll();
        state.mixerArmedChannel = newIndex;
        const btns = document.querySelectorAll('#mixer-channels .mixer-btn');
        btns[newIndex]?.classList.add('armed');
        setStatus(`Mixer channel ${newIndex + 1} added and armed`, 'success');
      }
    });
    updateAddButtonVisibility();
  }
}

function syncToggleButton() {
  const btn = document.getElementById('mixer-toggle-btn');
  if (btn) btn.classList.toggle('active', state.mixerEnabled);
}

function disarmAll() {
  state.mixerArmedChannel = null;
  const btns = document.querySelectorAll('#mixer-channels .mixer-btn');
  btns.forEach(b => b.classList.remove('armed'));
}

// Select a mixer channel for parameter editing
function selectMixerChannel(channelIndex) {
  const ch = state.mixerChannels[channelIndex];
  if (ch.slotIndex === null && ch.tabIndex === null && !ch.renderer) return;

  const btns = document.querySelectorAll('#mixer-channels .mixer-btn');
  btns.forEach(b => b.classList.remove('selected'));
  btns[channelIndex]?.classList.add('selected');

  state.mixerSelectedChannel = channelIndex;

  // For grid-assigned channels, look up from the correct tab
  let slotData = null;
  if (ch.slotIndex !== null && ch.tabIndex !== null) {
    const tab = state.shaderTabs[ch.tabIndex];
    slotData = tab?.slots?.[ch.slotIndex] || null;
  }
  const shaderCode = slotData?.shaderCode || ch.shaderCode;

  if (slotData) {
    // Update grid slot highlight
    if (state.activeGridSlot !== null) {
      const prevSlot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
      if (prevSlot) prevSlot.classList.remove('active');
    }
    state.activeGridSlot = ch.slotIndex;
    const slot = document.querySelector(`.grid-slot[data-slot="${ch.slotIndex}"]`);
    if (slot) slot.classList.add('active');
  }

  // Check if this is an asset channel
  const isAsset = ch.assetType || slotData?.type?.startsWith('asset-');

  if (!isAsset) {
    // Compile shader to main renderer so @param definitions are available for UI
    if (shaderCode) {
      try {
        state.renderer.compile(shaderCode);
      } catch (err) {
        log.warn('Mixer', 'Failed to compile shader for param UI:', err.message);
      }
    }

    // Load ALL channel params (speed + custom) into UI in a single pass.
    const allParams = { ...ch.params, ...ch.customParams };
    loadParamsToSliders(allParams, { skipMixerSync: true });
  }

  // Generate custom param UI (works for both shader and asset channels)
  generateCustomParamUI();
  updateLocalPresetsUI();

  const name = isAsset
    ? (slotData?.label || slotData?.mediaPath || `Asset ${ch.slotIndex + 1}`)
    : (slotData?.filePath?.split('/').pop()?.split('\\').pop() || (ch.shaderCode ? 'Mix Preset' : `Slot ${ch.slotIndex + 1}`));
  setStatus(`Mixer ${channelIndex + 1}: ${name}`, 'success');
}

export function assignShaderToMixer(channelIndex, slotIndex) {
  log.debug('Mixer', 'Assign shader to channel', channelIndex, 'from slot', slotIndex);
  const ch = state.mixerChannels[channelIndex];

  // Dispose only if we own the renderer (from a recalled mix preset)
  if (ch.renderer && ch._ownsRenderer && ch.renderer.dispose) {
    ch.renderer.dispose();
  }
  ch.renderer = null;
  ch.shaderCode = null;
  ch._ownsRenderer = false;

  ch.slotIndex = slotIndex;
  ch.tabIndex = state.activeShaderTab;  // Track which tab this slot belongs to

  const slotData = state.gridSlots[slotIndex];

  // Store shader code so mix presets can snapshot it even after tab switches
  ch.shaderCode = slotData?.shaderCode || null;
  ch.params = { ...(slotData?.params || {}) };
  ch.customParams = {};

  // Snapshot from @param defaults + slot overrides
  const miniRenderer = slotData?.renderer;
  if (miniRenderer?.customParams) {
    for (const param of miniRenderer.customParams) {
      const slotVal = slotData?.customParams?.[param.name];
      if (slotVal !== undefined) {
        ch.customParams[param.name] = Array.isArray(slotVal) ? [...slotVal] : slotVal;
      } else {
        ch.customParams[param.name] = Array.isArray(param.default) ? [...param.default] : param.default;
      }
    }
  }

  const btn = document.querySelectorAll('#mixer-channels .mixer-btn')[channelIndex];
  if (btn) {
    btn.textContent = String(slotIndex + 1);
    btn.classList.add('assigned');
    btn.classList.remove('armed');
  }

  state.mixerArmedChannel = null;
  state.mixerEnabled = true;
  syncToggleButton();
  selectMixerChannel(channelIndex);

  // Sync to fullscreen
  window.electronAPI.sendMixerChannelUpdate({
    channelIndex,
    shaderCode: slotData?.shaderCode,
    params: { speed: ch.params.speed ?? 1, ...ch.customParams }
  });

  const name = slotData?.filePath?.split('/').pop()?.split('\\').pop() || `Slot ${slotIndex + 1}`;
  setStatus(`Mixer ${channelIndex + 1} \u2190 ${name}`, 'success');
  notifyRemoteStateChanged();
}

export function assignAssetToMixer(channelIndex, slotIndex) {
  log.debug('Mixer', 'Assign asset to channel', channelIndex, 'from slot', slotIndex);
  const ch = state.mixerChannels[channelIndex];

  // Dispose only if we own the renderer
  if (ch.renderer && ch._ownsRenderer && ch.renderer.dispose) {
    ch.renderer.dispose();
  }
  ch.renderer = null;
  ch.shaderCode = null;
  ch._ownsRenderer = false;

  ch.slotIndex = slotIndex;
  ch.tabIndex = state.activeShaderTab;

  const slotData = state.gridSlots[slotIndex];
  ch.assetType = slotData?.type || null;  // 'asset-image' or 'asset-video'
  ch.params = {};
  ch.customParams = { ...(slotData?.customParams || {}) };

  const btn = document.querySelectorAll('#mixer-channels .mixer-btn')[channelIndex];
  if (btn) {
    btn.textContent = 'A' + String(slotIndex + 1);
    btn.classList.add('assigned');
    btn.classList.remove('armed');
  }

  state.mixerArmedChannel = null;
  state.mixerEnabled = true;
  syncToggleButton();
  selectMixerChannel(channelIndex);

  // Sync to fullscreen — send asset-specific data
  const assetRenderer = slotData?.renderer;
  const updateData = {
    channelIndex,
    assetType: slotData?.type,
    mediaPath: slotData?.mediaPath,
    params: { ...ch.customParams }
  };

  // For images, include data URL for fullscreen (it can't access renderer directly)
  if (assetRenderer?.assetType === 'image' && assetRenderer?.image?.src) {
    updateData.dataUrl = assetRenderer.image.src;
  }
  // For videos, send the absolute path
  if (assetRenderer?.assetType === 'video') {
    // Get absolute path asynchronously and send update
    window.electronAPI.getMediaAbsolutePath(slotData.mediaPath).then(absPath => {
      updateData.filePath = absPath;
      window.electronAPI.sendMixerChannelUpdate(updateData);
    });
  } else {
    window.electronAPI.sendMixerChannelUpdate(updateData);
  }

  const name = slotData?.label || slotData?.mediaPath || `Asset ${slotIndex + 1}`;
  setStatus(`Mixer ${channelIndex + 1} \u2190 ${name}`, 'success');
  notifyRemoteStateChanged();
}

export function clearMixerChannel(channelIndex) {
  const ch = state.mixerChannels[channelIndex];

  // Dispose only if we own the renderer (from a recalled mix preset)
  if (ch.renderer && ch._ownsRenderer && ch.renderer.dispose) {
    ch.renderer.dispose();
  }

  // If more than 1 channel, remove it entirely; otherwise just reset
  if (state.mixerChannels.length > 1) {
    state.mixerChannels.splice(channelIndex, 1);

    // Fix up armed/selected indices
    if (state.mixerArmedChannel === channelIndex) {
      state.mixerArmedChannel = null;
    } else if (state.mixerArmedChannel !== null && state.mixerArmedChannel > channelIndex) {
      state.mixerArmedChannel--;
    }

    if (state.mixerSelectedChannel === channelIndex) {
      state.mixerSelectedChannel = null;
      // Auto-select next active channel
      for (let i = 0; i < state.mixerChannels.length; i++) {
        const other = state.mixerChannels[i];
        if ((other.slotIndex !== null && other.tabIndex !== null) || other.renderer) {
          state.mixerSelectedChannel = i;
          break;
        }
      }
    } else if (state.mixerSelectedChannel !== null && state.mixerSelectedChannel > channelIndex) {
      state.mixerSelectedChannel--;
    }

    rebuildChannelElements();

    // Sync clear to fullscreen
    window.electronAPI.sendMixerChannelUpdate({ channelIndex, clear: true });

    if (!isMixerActive()) hideMixerOverlay();

    // Refresh multi-channel param UI
    generateCustomParamUI();

    setStatus(`Mixer channel ${channelIndex + 1} removed`, 'success');
    notifyRemoteStateChanged();
    return;
  }

  // Single channel — just reset it
  ch.renderer = null;
  ch.shaderCode = null;
  ch.assetType = null;
  ch._ownsRenderer = false;
  ch.slotIndex = null;
  ch.tabIndex = null;
  ch.alpha = 1.0;
  ch.params = {};
  ch.customParams = {};

  const btn = document.querySelectorAll('#mixer-channels .mixer-btn')[channelIndex];
  if (btn) {
    btn.textContent = '\u2014';
    btn.classList.remove('assigned', 'armed', 'selected');
  }

  const slider = document.querySelectorAll('#mixer-channels .mixer-slider')[channelIndex];
  if (slider) slider.value = '1';

  if (state.mixerArmedChannel === channelIndex) state.mixerArmedChannel = null;
  if (state.mixerSelectedChannel === channelIndex) state.mixerSelectedChannel = null;

  if (!isMixerActive()) hideMixerOverlay();

  // Sync to fullscreen
  window.electronAPI.sendMixerChannelUpdate({ channelIndex, clear: true });

  // Refresh multi-channel param UI
  generateCustomParamUI();

  setStatus(`Mixer channel ${channelIndex + 1} cleared`, 'success');
  notifyRemoteStateChanged();
}

export function isMixerActive() {
  if (!state.mixerEnabled) return false;
  return state.mixerChannels.some(ch => {
    if (ch.renderer) return true;  // Recalled mix preset
    if (ch.slotIndex !== null && ch.tabIndex !== null) {
      // Grid-assigned: verify the slot still has a renderer
      const tab = state.shaderTabs[ch.tabIndex];
      return !!tab?.slots?.[ch.slotIndex]?.renderer;
    }
    return false;
  });
}

export function resetMixer() {
  log.info('Mixer', 'Resetting mixer, disposing', state.mixerChannels.length, 'channels');
  // Dispose all channel renderers
  for (const ch of state.mixerChannels) {
    if (ch.renderer && ch._ownsRenderer && ch.renderer.dispose) {
      ch.renderer.dispose();
    }
  }

  // Sync clear all to fullscreen
  for (let i = 0; i < state.mixerChannels.length; i++) {
    window.electronAPI.sendMixerChannelUpdate({ channelIndex: i, clear: true });
  }

  // Reset to 1 empty channel
  state.mixerChannels.length = 0;
  state.mixerChannels.push({
    slotIndex: null, alpha: 1.0, params: {}, customParams: {}, renderer: null, shaderCode: null
  });
  state.mixerArmedChannel = null;
  state.mixerSelectedChannel = null;
  state.mixerEnabled = false;
  syncToggleButton();
  rebuildChannelElements();
  hideMixerOverlay();
  generateCustomParamUI();
  setStatus('Mixer reset', 'success');
  notifyRemoteStateChanged();
}

// Called from params.js when a mixer channel is selected and a param changes
export function updateMixerChannelParam(paramName, value) {
  const chIdx = state.mixerSelectedChannel;
  if (chIdx === null) return;
  const ch = state.mixerChannels[chIdx];
  if (!ch || (ch.slotIndex === null && ch.tabIndex === null && !ch.renderer)) return;

  if (paramName === 'speed') {
    ch.params.speed = value;
  } else {
    ch.customParams[paramName] = value;
  }

  window.electronAPI.sendMixerParamUpdate({ channelIndex: chIdx, paramName, value });
}

export function renderMixerComposite() {
  const mainCanvas = document.getElementById('shader-canvas');
  const canvasWidth = mainCanvas.width;
  const canvasHeight = mainCanvas.height;

  if (!mixerOverlayCanvas) {
    mixerOverlayCanvas = document.createElement('canvas');
    mixerOverlayCanvas.id = 'mixer-overlay-canvas';
    mixerOverlayCanvas.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);max-width:100%;max-height:100%;pointer-events:none';
    mainCanvas.parentElement.style.position = 'relative';
    mainCanvas.parentElement.appendChild(mixerOverlayCanvas);
  }

  if (mixerOverlayCanvas.width !== canvasWidth || mixerOverlayCanvas.height !== canvasHeight) {
    mixerOverlayCanvas.width = canvasWidth;
    mixerOverlayCanvas.height = canvasHeight;
    mixerOverlayCtx = null;
  }

  if (!mixerOverlayCtx) {
    mixerOverlayCtx = mixerOverlayCanvas.getContext('2d');
  }

  const ctx = mixerOverlayCtx;

  // Clear to opaque black
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Apply selected blend mode for compositing layers
  ctx.globalCompositeOperation = state.mixerBlendMode;

  MiniShaderRenderer.ensureSharedCanvasSize(canvasWidth, canvasHeight);

  const mainStats = state.renderer.getStats?.() || { time: 0, frame: 0, fps: 60 };

  for (const ch of state.mixerChannels) {
    if (ch.alpha <= 0) continue;

    // For grid-assigned channels, always look up the fresh renderer from
    // the correct tab (handles edits, rebuilds, and tab switches).
    // For recalled mix presets, use the channel's own renderer.
    let renderer = null;
    if (ch.slotIndex !== null && ch.tabIndex !== null) {
      const tab = state.shaderTabs[ch.tabIndex];
      renderer = tab?.slots?.[ch.slotIndex]?.renderer || null;
    }
    if (!renderer) renderer = ch.renderer;
    if (!renderer) continue;

    // Apply this channel's own speed
    renderer.setSpeed(ch.params.speed ?? 1);

    // Apply this channel's own custom params directly
    renderer.customParamValues = {};
    if (ch.customParams) {
      for (const [name, value] of Object.entries(ch.customParams)) {
        renderer.customParamValues[name] = value;
      }
    }

    ctx.globalAlpha = ch.alpha;
    try {
      renderer.renderDirect(ctx, 0, 0, canvasWidth, canvasHeight);
    } catch (err) {
      log.error('Mixer', 'Render error for slot', ch.slotIndex, err);
    }
  }

  ctx.globalAlpha = 1.0;
  ctx.globalCompositeOperation = 'source-over';

  mixerOverlayCanvas.style.display = 'block';

  return mainStats;
}

export function hideMixerOverlay() {
  if (mixerOverlayCanvas) {
    mixerOverlayCanvas.style.display = 'none';
  }
}

// Capture the current mixer composite as a small thumbnail data URL
export function captureMixerThumbnail() {
  if (!mixerOverlayCanvas || mixerOverlayCanvas.width === 0) return null;
  const thumbW = 240;
  const thumbH = Math.round(thumbW * mixerOverlayCanvas.height / mixerOverlayCanvas.width) || 135;
  const tmp = document.createElement('canvas');
  tmp.width = thumbW;
  tmp.height = thumbH;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(mixerOverlayCanvas, 0, 0, thumbW, thumbH);
  return tmp.toDataURL('image/jpeg', 0.7);
}

// Recall a complete mixer state from a mix preset
export function recallMixState(preset) {
  log.info('Mixer', 'Recalling mix preset:', preset.name, 'channels:', (preset.channels || []).length);
  // Dispose all existing channels
  for (const ch of state.mixerChannels) {
    if (ch.renderer && ch._ownsRenderer && ch.renderer.dispose) {
      ch.renderer.dispose();
    }
  }

  // Sync clear all existing channels to fullscreen
  for (let i = 0; i < state.mixerChannels.length; i++) {
    window.electronAPI.sendMixerChannelUpdate({ channelIndex: i, clear: true });
  }

  // Determine how many channels the preset needs
  const presetChannelCount = (preset.channels || []).length;
  const targetCount = Math.max(1, Math.min(presetChannelCount, MAX_MIXER_CHANNELS));

  // Resize state array to match preset
  state.mixerChannels.length = 0;
  for (let i = 0; i < targetCount; i++) {
    state.mixerChannels.push({
      slotIndex: null, alpha: 1.0, params: {}, customParams: {}, renderer: null, shaderCode: null
    });
  }

  state.mixerArmedChannel = null;
  state.mixerSelectedChannel = null;

  // Set blend mode
  state.mixerBlendMode = preset.blendMode || 'lighter';
  const blendSelect = document.getElementById('mixer-blend-mode');
  if (blendSelect) blendSelect.value = state.mixerBlendMode;
  window.electronAPI.sendMixerBlendMode({ blendMode: state.mixerBlendMode });

  // Restore each channel from the preset
  for (let i = 0; i < targetCount; i++) {
    const presetCh = preset.channels[i];
    if (!presetCh) continue;

    const ch = state.mixerChannels[i];
    ch.alpha = presetCh.alpha ?? 1.0;
    ch.params = { ...(presetCh.params || {}) };
    ch.customParams = { ...(presetCh.customParams || {}) };
    ch.slotIndex = null;  // Not tied to a grid slot

    // Handle asset channels
    if (presetCh.assetType && presetCh.mediaPath) {
      ch.assetType = presetCh.assetType;
      ch.mediaPath = presetCh.mediaPath;
      ch.shaderCode = null;

      const isVideo = presetCh.assetType === 'asset-video';
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = 160;
      tempCanvas.height = 90;

      // Create AssetRenderer and load media asynchronously
      const renderer = new AssetRenderer(tempCanvas);
      renderer.mediaPath = presetCh.mediaPath;
      if (presetCh.customParams) renderer.setParams(presetCh.customParams);

      ch.renderer = renderer;
      ch._ownsRenderer = true;

      // Load media async — don't block recall
      (async () => {
        try {
          if (isVideo) {
            const absPath = await window.electronAPI.getMediaAbsolutePath(presetCh.mediaPath);
            await renderer.loadVideo(absPath);
            // Sync to fullscreen
            window.electronAPI.sendMixerChannelUpdate({
              channelIndex: i,
              assetType: presetCh.assetType,
              mediaPath: presetCh.mediaPath,
              filePath: absPath,
              params: { ...ch.customParams }
            });
          } else {
            const loaded = await window.electronAPI.loadMediaDataUrl(presetCh.mediaPath);
            if (loaded.success) {
              await renderer.loadImage(loaded.dataUrl);
              window.electronAPI.sendMixerChannelUpdate({
                channelIndex: i,
                assetType: presetCh.assetType,
                mediaPath: presetCh.mediaPath,
                dataUrl: loaded.dataUrl,
                params: { ...ch.customParams }
              });
            }
          }
        } catch (err) {
          log.error('Mixer', `Failed to load asset for mix preset channel ${i + 1}:`, err.message);
        }
      })();

      window.electronAPI.sendMixerAlphaUpdate({ channelIndex: i, alpha: ch.alpha });
      continue;
    }

    // Shader channel
    if (!presetCh.shaderCode) continue;

    ch.shaderCode = presetCh.shaderCode;
    ch.assetType = null;

    // Create a MiniShaderRenderer for this channel
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = 160;
    tempCanvas.height = 90;
    try {
      const renderer = new MiniShaderRenderer(tempCanvas);
      renderer.compile(presetCh.shaderCode);

      if (presetCh.customParams) {
        renderer.customParamValues = { ...(presetCh.customParams) };
      }
      renderer.setSpeed(presetCh.params?.speed ?? 1);

      ch.renderer = renderer;
      ch._ownsRenderer = true;
    } catch (err) {
      log.error('Mixer', `Failed to compile mix preset channel ${i + 1}:`, err.message);
      continue;
    }

    // Sync to fullscreen
    window.electronAPI.sendMixerChannelUpdate({
      channelIndex: i,
      shaderCode: presetCh.shaderCode,
      params: { speed: ch.params.speed ?? 1, ...ch.customParams }
    });
    window.electronAPI.sendMixerAlphaUpdate({ channelIndex: i, alpha: ch.alpha });
  }

  // Rebuild DOM to match new channel count
  rebuildChannelElements();

  // Enable mixer and show overlay
  state.mixerEnabled = true;
  syncToggleButton();
  if (isMixerActive()) {
    if (mixerOverlayCanvas) mixerOverlayCanvas.style.display = 'block';
  }

  // Auto-select the first active channel so param changes route to mixer
  for (let i = 0; i < state.mixerChannels.length; i++) {
    const ch = state.mixerChannels[i];
    if (ch.renderer || ch.shaderCode || ch.assetType) {
      selectMixerChannel(i);
      break;
    }
  }

  setStatus(`Recalled mix preset: ${preset.name}`, 'success');
  notifyRemoteStateChanged();
}
