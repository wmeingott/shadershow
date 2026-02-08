// Shader Mixer - 4-channel compositor with per-channel parameters
import { state, notifyRemoteStateChanged } from './state.js';
import { MiniShaderRenderer } from './shader-grid.js';
import { loadParamsToSliders, generateCustomParamUI } from './params.js';
import { updateLocalPresetsUI } from './presets.js';
import { setStatus } from './utils.js';

let mixerOverlayCanvas = null;
let mixerOverlayCtx = null;

export function initMixer() {
  const panel = document.getElementById('mixer-panel');
  if (!panel) return;

  const channels = panel.querySelectorAll('.mixer-channel');
  channels.forEach((channelEl, i) => {
    const btn = channelEl.querySelector('.mixer-btn');
    const slider = channelEl.querySelector('.mixer-slider');

    // Left click: if assigned, select for param editing; if not, arm/disarm
    btn.addEventListener('click', () => {
      const ch = state.mixerChannels[i];
      if (state.mixerArmedChannel === i) {
        state.mixerArmedChannel = null;
        btn.classList.remove('armed');
        setStatus('Mixer channel disarmed', 'success');
      } else if ((ch.slotIndex !== null && ch.tabIndex !== null) || ch.renderer) {
        disarmAll();
        selectMixerChannel(i);
      } else {
        disarmAll();
        state.mixerArmedChannel = i;
        btn.classList.add('armed');
        setStatus(`Mixer channel ${i + 1} armed — click a grid shader to assign`, 'success');
      }
    });

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      clearMixerChannel(i);
    });

    slider.addEventListener('input', () => {
      const alpha = parseFloat(slider.value);
      state.mixerChannels[i].alpha = alpha;
      window.electronAPI.sendMixerAlphaUpdate({ channelIndex: i, alpha });
    });
  });

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
      setStatus(state.mixerEnabled ? 'Mixer enabled' : 'Mixer disabled', 'success');
    });
  }
}

function syncToggleButton() {
  const btn = document.getElementById('mixer-toggle-btn');
  if (btn) btn.classList.toggle('active', state.mixerEnabled);
}

function disarmAll() {
  state.mixerArmedChannel = null;
  const btns = document.querySelectorAll('#mixer-panel .mixer-btn');
  btns.forEach(b => b.classList.remove('armed'));
}

// Select a mixer channel for parameter editing
function selectMixerChannel(channelIndex) {
  const ch = state.mixerChannels[channelIndex];
  if (ch.slotIndex === null && ch.tabIndex === null && !ch.renderer) return;

  const btns = document.querySelectorAll('#mixer-panel .mixer-btn');
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

  // Compile shader to main renderer so @param definitions are available for UI
  if (shaderCode) {
    try {
      state.renderer.compile(shaderCode);
    } catch (err) {
      console.warn('Failed to compile shader for param UI:', err.message);
    }
  }

  // Load ALL channel params (speed + custom) into UI in a single pass.
  const allParams = { ...ch.params, ...ch.customParams };
  loadParamsToSliders(allParams, { skipMixerSync: true });

  updateLocalPresetsUI();

  const name = slotData?.filePath?.split('/').pop() || (ch.shaderCode ? 'Mix Preset' : `Slot ${ch.slotIndex + 1}`);
  setStatus(`Mixer ${channelIndex + 1}: ${name}`, 'success');
}

export function assignShaderToMixer(channelIndex, slotIndex) {
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

  const btn = document.querySelectorAll('#mixer-panel .mixer-btn')[channelIndex];
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

  const name = slotData?.filePath?.split('/').pop() || `Slot ${slotIndex + 1}`;
  setStatus(`Mixer ${channelIndex + 1} ← ${name}`, 'success');
  notifyRemoteStateChanged();
}

export function clearMixerChannel(channelIndex) {
  const ch = state.mixerChannels[channelIndex];

  // Dispose only if we own the renderer (from a recalled mix preset)
  if (ch.renderer && ch._ownsRenderer && ch.renderer.dispose) {
    ch.renderer.dispose();
  }
  ch.renderer = null;
  ch.shaderCode = null;
  ch._ownsRenderer = false;

  ch.slotIndex = null;
  ch.tabIndex = null;
  ch.alpha = 1.0;
  ch.params = {};
  ch.customParams = {};

  const btn = document.querySelectorAll('#mixer-panel .mixer-btn')[channelIndex];
  if (btn) {
    btn.textContent = '—';
    btn.classList.remove('assigned', 'armed', 'selected');
  }

  const slider = document.querySelectorAll('#mixer-panel .mixer-slider')[channelIndex];
  if (slider) slider.value = '1';

  if (state.mixerArmedChannel === channelIndex) state.mixerArmedChannel = null;
  if (state.mixerSelectedChannel === channelIndex) {
    // Auto-select the next active mixer channel
    state.mixerSelectedChannel = null;
    const btns = document.querySelectorAll('#mixer-panel .mixer-btn');
    for (let i = 0; i < 4; i++) {
      if (i === channelIndex) continue;
      const other = state.mixerChannels[i];
      if ((other.slotIndex !== null && other.tabIndex !== null) || other.renderer) {
        state.mixerSelectedChannel = i;
        btns[i]?.classList.add('selected');
        break;
      }
    }
  }

  if (!isMixerActive()) hideMixerOverlay();

  // Sync to fullscreen
  window.electronAPI.sendMixerChannelUpdate({ channelIndex, clear: true });

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
  for (let i = 0; i < 4; i++) {
    clearMixerChannel(i);
  }
  state.mixerEnabled = false;
  syncToggleButton();
  hideMixerOverlay();
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
      console.error('Mixer render error for slot', ch.slotIndex, err);
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
  const btns = document.querySelectorAll('#mixer-panel .mixer-btn');
  const sliders = document.querySelectorAll('#mixer-panel .mixer-slider');

  // Clear all 4 channels
  for (let i = 0; i < 4; i++) {
    const ch = state.mixerChannels[i];
    if (ch.renderer && ch._ownsRenderer && ch.renderer.dispose) {
      ch.renderer.dispose();
    }
    ch.renderer = null;
    ch.shaderCode = null;
    ch._ownsRenderer = false;
    ch.slotIndex = null;
    ch.tabIndex = null;
    ch.alpha = 1.0;
    ch.params = {};
    ch.customParams = {};

    if (btns[i]) {
      btns[i].textContent = '—';
      btns[i].classList.remove('assigned', 'armed', 'selected');
    }
    if (sliders[i]) sliders[i].value = '1';

    // Sync clear to fullscreen
    window.electronAPI.sendMixerChannelUpdate({ channelIndex: i, clear: true });
  }

  state.mixerArmedChannel = null;
  state.mixerSelectedChannel = null;

  // Set blend mode
  state.mixerBlendMode = preset.blendMode || 'lighter';
  const blendSelect = document.getElementById('mixer-blend-mode');
  if (blendSelect) blendSelect.value = state.mixerBlendMode;
  window.electronAPI.sendMixerBlendMode({ blendMode: state.mixerBlendMode });

  // Restore each channel from the preset
  for (let i = 0; i < 4; i++) {
    const presetCh = preset.channels[i];
    if (!presetCh || !presetCh.shaderCode) continue;

    const ch = state.mixerChannels[i];
    ch.shaderCode = presetCh.shaderCode;
    ch.alpha = presetCh.alpha ?? 1.0;
    ch.params = { ...(presetCh.params || {}) };
    ch.customParams = { ...(presetCh.customParams || {}) };
    ch.slotIndex = null;  // Not tied to a grid slot

    // Create a MiniShaderRenderer for this channel
    // Use a small offscreen canvas (the shared GL context handles actual rendering)
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = 160;
    tempCanvas.height = 90;
    try {
      const renderer = new MiniShaderRenderer(tempCanvas);
      renderer.compile(presetCh.shaderCode);

      // Apply custom params
      if (presetCh.customParams) {
        renderer.customParamValues = { ...(presetCh.customParams) };
      }
      renderer.setSpeed(presetCh.params?.speed ?? 1);

      ch.renderer = renderer;
      ch._ownsRenderer = true;  // We created it — dispose on clear
    } catch (err) {
      console.warn(`Failed to compile mix preset channel ${i + 1}:`, err.message);
      continue;
    }

    // Update mixer UI button
    if (btns[i]) {
      btns[i].textContent = 'M';
      btns[i].classList.add('assigned');
    }
    if (sliders[i]) sliders[i].value = String(ch.alpha);

    // Sync to fullscreen
    window.electronAPI.sendMixerChannelUpdate({
      channelIndex: i,
      shaderCode: presetCh.shaderCode,
      params: { speed: ch.params.speed ?? 1, ...ch.customParams }
    });
    window.electronAPI.sendMixerAlphaUpdate({ channelIndex: i, alpha: ch.alpha });
  }

  // Enable mixer and show overlay
  state.mixerEnabled = true;
  syncToggleButton();
  if (isMixerActive()) {
    if (mixerOverlayCanvas) mixerOverlayCanvas.style.display = 'block';
  }

  // Auto-select the first active channel so param changes route to mixer
  for (let i = 0; i < 4; i++) {
    const ch = state.mixerChannels[i];
    if (ch.renderer || ch.shaderCode) {
      selectMixerChannel(i);
      break;
    }
  }

  setStatus(`Recalled mix preset: ${preset.name}`, 'success');
  notifyRemoteStateChanged();
}
