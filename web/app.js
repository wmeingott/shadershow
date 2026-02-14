// ShaderShow Remote — Web Client
(function () {
  'use strict';

  // ---- State ----
  let appState = null;
  let ws = null;
  let reconnectTimer = null;
  let currentView = 'grid';
  let assigningChannel = null; // When non-null, next slot tap assigns to this mixer channel

  // ---- Thumbnail versioning ----
  const thumbnailVersions = {}; // key: 'tab-slot' → version counter
  let thumbnailRefreshTimer = null;

  function getThumbnailUrl(tab, slot) {
    const key = `${tab}-${slot}`;
    if (thumbnailVersions[key] === undefined) thumbnailVersions[key] = 0;
    return `/api/thumbnail/${tab}/${slot}?v=${thumbnailVersions[key]}`;
  }

  function bumpSlotThumbnail(tab, slot) {
    const key = `${tab}-${slot}`;
    thumbnailVersions[key] = (thumbnailVersions[key] || 0) + 1;
    // Tell server to clear its cache for this slot
    wsSend('invalidate-thumbnail', { tab, slot });
  }

  function scheduleActiveThumbnailRefresh() {
    clearTimeout(thumbnailRefreshTimer);
    thumbnailRefreshTimer = setTimeout(() => {
      if (!appState) return;
      const tab = appState.activeTab;
      const slot = appState.activeSlot;
      if (tab === undefined || slot === undefined) return;
      bumpSlotThumbnail(tab, slot);
      // Update the <img> element for the active slot
      const img = document.querySelector(`.slot-thumb[data-tab="${tab}"][data-slot="${slot}"]`);
      if (img) img.src = getThumbnailUrl(tab, slot);
    }, 500);
  }

  // ---- WebSocket ----
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      setConnectionStatus('Connected', 'connected');
      clearTimeout(reconnectTimer);
      fetchState();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (err) {
        console.warn('Invalid WS message:', err);
      }
    };

    ws.onclose = () => {
      setConnectionStatus('Disconnected', 'error');
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  }

  function wsSend(type, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data }));
    }
  }

  // ---- HTTP API ----
  async function fetchState() {
    try {
      const res = await fetch('/api/state');
      if (res.ok) {
        appState = await res.json();
        renderAll();
      }
    } catch (err) {
      console.warn('Failed to fetch state:', err);
    }
  }

  async function postAction(endpoint, data = {}) {
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    } catch (err) {
      console.warn('Action failed:', err);
    }
  }

  // ---- Server messages ----
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'state-update':
        appState = msg.data;
        renderAll();
        break;
      case 'param-changed':
        if (appState && msg.data) {
          if (!appState.params) appState.params = {};
          appState.params[msg.data.name] = msg.data.value;
          renderParams();
        }
        break;
      case 'mixer-update':
        if (appState && msg.data) {
          appState.mixer = msg.data;
          renderMixer();
        }
        break;
      case 'playback-update':
        if (appState && msg.data) {
          appState.playback = msg.data;
          renderPlayback();
        }
        break;
    }
  }

  // ---- Connection status ----
  function setConnectionStatus(text, cls) {
    const el = document.getElementById('connection-status');
    el.textContent = text;
    el.className = cls || '';
  }

  // ---- Rendering ----
  function renderAll() {
    if (!appState) return;
    renderGrid();
    renderMixer();
    renderParams();
    renderPlayback();
    renderVP();
  }

  function renderGrid() {
    if (!appState) return;

    // Tab bar
    const tabBar = document.getElementById('tab-bar');
    tabBar.innerHTML = '';
    appState.tabs.forEach((tab, i) => {
      const btn = document.createElement('button');
      btn.className = 'tab-btn' + (i === appState.activeTab ? ' active' : '');
      btn.textContent = tab.name;
      btn.addEventListener('click', () => {
        postAction('/api/tab/select', { tabIndex: i });
      });
      tabBar.appendChild(btn);
    });

    // Slot grid
    const grid = document.getElementById('slot-grid');
    grid.innerHTML = '';
    const tab = appState.tabs[appState.activeTab];
    if (!tab) return;

    if (tab.type === 'mix') {
      // Show mix presets
      if (tab.mixPresets && tab.mixPresets.length > 0) {
        tab.mixPresets.forEach(p => {
          const btn = document.createElement('button');
          btn.className = 'mix-preset-btn';
          btn.textContent = p.name || `Mix ${p.index + 1}`;
          btn.addEventListener('click', () => {
            postAction('/api/mixer/recall-preset', {
              tabIndex: appState.activeTab,
              presetIndex: p.index
            });
          });
          grid.appendChild(btn);
        });
      } else {
        grid.innerHTML = '<div class="empty-message">No mix presets on this tab</div>';
      }
      return;
    }

    if (!tab.slots || tab.slots.length === 0) {
      grid.innerHTML = '<div class="empty-message">No shaders on this tab</div>';
      return;
    }

    tab.slots.forEach(slot => {
      const card = document.createElement('div');
      card.className = 'slot-card' + (slot.index === appState.activeSlot ? ' active' : '');

      const img = document.createElement('img');
      img.className = 'slot-thumb';
      img.dataset.tab = appState.activeTab;
      img.dataset.slot = slot.index;
      img.src = getThumbnailUrl(appState.activeTab, slot.index);
      img.alt = slot.label;
      img.loading = 'lazy';
      // Prevent broken image icon
      img.onerror = function() { this.style.visibility = 'hidden'; };
      img.onload = function() { this.style.visibility = 'visible'; };

      const label = document.createElement('div');
      label.className = 'slot-label';
      label.textContent = slot.label;

      card.appendChild(img);
      card.appendChild(label);

      card.addEventListener('click', () => {
        if (assigningChannel !== null) {
          // Assign this slot to the armed mixer channel
          postAction('/api/mixer/assign', {
            channelIndex: assigningChannel,
            slotIndex: slot.index
          });
          assigningChannel = null;
          renderMixer(); // Update UI to remove arming state
        } else {
          postAction('/api/slot/select', { slotIndex: slot.index });
        }
      });

      grid.appendChild(card);
    });
  }

  function renderMixer() {
    if (!appState) return;
    const mixer = appState.mixer;
    if (!mixer) return;

    const container = document.getElementById('mixer-channels');
    container.innerHTML = '';

    mixer.channels.forEach((ch, i) => {
      const row = document.createElement('div');
      row.className = 'mixer-ch';

      const btn = document.createElement('button');
      btn.className = 'mixer-ch-btn';
      if (ch.hasShader) btn.classList.add('assigned');
      if (i === mixer.selectedChannel) btn.classList.add('selected');
      if (i === assigningChannel) btn.classList.add('selected');
      btn.textContent = ch.hasShader ? (ch.label || (ch.slotIndex !== null ? String(ch.slotIndex + 1) : 'M')) : '\u2014';

      btn.addEventListener('click', () => {
        if (ch.hasShader) {
          // Select for param editing
          postAction('/api/mixer/select', { channelIndex: i });
        } else {
          // Arm for assignment — next grid slot tap assigns here
          if (assigningChannel === i) {
            assigningChannel = null; // Toggle off
          } else {
            assigningChannel = i;
          }
          renderMixer();
        }
      });

      // Long press to clear
      let pressTimer;
      btn.addEventListener('touchstart', (e) => {
        pressTimer = setTimeout(() => {
          e.preventDefault();
          postAction('/api/mixer/clear', { channelIndex: i });
        }, 600);
      }, { passive: false });
      btn.addEventListener('touchend', () => clearTimeout(pressTimer));
      btn.addEventListener('touchmove', () => clearTimeout(pressTimer));

      const labelEl = document.createElement('span');
      labelEl.className = 'mixer-ch-label';
      labelEl.textContent = `${i + 1}`;

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'mixer-ch-slider';
      slider.min = '0';
      slider.max = '1';
      slider.step = '0.01';
      slider.value = String(ch.alpha);

      const alphaDisplay = document.createElement('span');
      alphaDisplay.className = 'mixer-ch-alpha';
      alphaDisplay.textContent = (ch.alpha * 100).toFixed(0) + '%';

      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        alphaDisplay.textContent = (val * 100).toFixed(0) + '%';
        wsSend('mixer-alpha', { channelIndex: i, value: val });
      });

      row.appendChild(btn);
      row.appendChild(labelEl);
      row.appendChild(slider);
      row.appendChild(alphaDisplay);
      container.appendChild(row);
    });

    // Blend mode
    const blendSelect = document.getElementById('remote-blend-mode');
    blendSelect.value = mixer.blendMode || 'lighter';

    // Toggle button
    const toggleBtn = document.getElementById('btn-mixer-toggle');
    toggleBtn.classList.toggle('active', mixer.enabled);
    toggleBtn.textContent = mixer.enabled ? 'Mixer ON' : 'Mixer OFF';

    // Mix presets
    renderMixPresets();
  }

  function renderMixPresets() {
    const container = document.getElementById('mix-presets');
    container.innerHTML = '';
    if (!appState) return;

    // Find mix tabs and list their presets
    const mixTabs = appState.tabs.filter(t => t.type === 'mix');
    if (mixTabs.length === 0) return;

    const h3 = document.createElement('h3');
    h3.textContent = 'Mix Presets';
    container.appendChild(h3);

    appState.tabs.forEach((tab, tabIdx) => {
      if (tab.type !== 'mix' || !tab.mixPresets) return;
      tab.mixPresets.forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'mix-preset-btn';
        btn.textContent = p.name || `Mix ${p.index + 1}`;
        btn.addEventListener('click', () => {
          postAction('/api/mixer/recall-preset', {
            tabIndex: tabIdx,
            presetIndex: p.index
          });
        });
        container.appendChild(btn);
      });
    });
  }

  function renderParams() {
    if (!appState) return;

    // Speed slider
    const speedSlider = document.getElementById('remote-speed');
    const speedValue = document.getElementById('remote-speed-value');
    if (appState.params && appState.params.speed !== undefined) {
      speedSlider.value = appState.params.speed;
      speedValue.textContent = parseFloat(appState.params.speed).toFixed(2);
    }

    // Custom params
    const container = document.getElementById('custom-params');
    container.innerHTML = '';

    const defs = appState.customParamDefs || [];
    if (defs.length === 0) return;

    defs.forEach(param => {
      if (param.isArray) {
        // Array params
        const title = document.createElement('div');
        title.className = 'param-section-title';
        title.textContent = param.description || param.name;
        container.appendChild(title);

        const values = appState.params[param.name];
        if (!Array.isArray(values)) return;
        for (let i = 0; i < param.arraySize; i++) {
          const val = values[i];
          const control = createParamControl(param, val, param.name, i);
          if (control) container.appendChild(control);
        }
      } else {
        const val = appState.params[param.name];
        const control = createParamControl(param, val, param.name, null);
        if (control) container.appendChild(control);
      }
    });

    // Presets
    renderPresets();
  }

  function createParamControl(def, value, paramName, arrayIndex) {
    const group = document.createElement('div');
    group.className = 'param-group';

    const label = document.createElement('label');
    label.textContent = arrayIndex !== null ? `${arrayIndex}` : def.name;
    if (def.description && arrayIndex === null) label.title = def.description;
    group.appendChild(label);

    switch (def.type) {
      case 'int':
      case 'float': {
        const isInt = def.type === 'int';
        const min = def.min !== null ? def.min : (isInt ? 0 : 0);
        const max = def.max !== null ? def.max : (isInt ? 10 : 1);
        const step = isInt ? 1 : 0.01;
        const current = value !== undefined ? value : def.default;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = min;
        slider.max = max;
        slider.step = step;
        slider.value = current;

        const display = document.createElement('span');
        display.textContent = isInt ? Math.round(current).toString() : parseFloat(current).toFixed(2);

        slider.addEventListener('input', () => {
          const v = isInt ? parseInt(slider.value, 10) : parseFloat(slider.value);
          display.textContent = isInt ? v.toString() : v.toFixed(2);
          sendParamValue(paramName, v, arrayIndex);
        });

        group.appendChild(slider);
        group.appendChild(display);
        break;
      }

      case 'color': {
        const rgb = Array.isArray(value) ? value : [1, 1, 1];
        const hex = rgbToHex(rgb[0], rgb[1], rgb[2]);

        const picker = document.createElement('input');
        picker.type = 'color';
        picker.value = hex;

        const slidersDiv = document.createElement('div');
        slidersDiv.className = 'color-sliders-group';

        const channels = ['R', 'G', 'B'];
        const sliders = [];

        channels.forEach((ch, ci) => {
          const row = document.createElement('div');
          row.className = 'color-slider-row';

          const lbl = document.createElement('label');
          lbl.textContent = ch;
          row.appendChild(lbl);

          const s = document.createElement('input');
          s.type = 'range';
          s.min = '0';
          s.max = '1';
          s.step = '0.01';
          s.value = rgb[ci];
          sliders.push(s);

          s.addEventListener('input', () => {
            const newRgb = sliders.map(sl => parseFloat(sl.value));
            picker.value = rgbToHex(newRgb[0], newRgb[1], newRgb[2]);
            sendParamValue(paramName, newRgb, arrayIndex);
          });

          row.appendChild(s);
          slidersDiv.appendChild(row);
        });

        picker.addEventListener('input', () => {
          const newRgb = hexToRgb(picker.value);
          sliders.forEach((s, ci) => { s.value = newRgb[ci]; });
          sendParamValue(paramName, newRgb, arrayIndex);
        });

        group.appendChild(picker);
        group.appendChild(slidersDiv);
        break;
      }

      case 'vec2': {
        const vec = Array.isArray(value) ? value : [0, 0];
        const min = def.min !== null ? def.min : 0;
        const max = def.max !== null ? def.max : 1;

        ['X', 'Y'].forEach((axis, ai) => {
          const s = document.createElement('input');
          s.type = 'range';
          s.min = min;
          s.max = max;
          s.step = '0.01';
          s.value = vec[ai];
          s.style.width = '60px';

          s.addEventListener('input', () => {
            const newVec = [...vec];
            newVec[ai] = parseFloat(s.value);
            sendParamValue(paramName, newVec, arrayIndex);
          });
          group.appendChild(s);
        });
        break;
      }

      case 'vec3': {
        const vec = Array.isArray(value) ? value : [0, 0, 0];
        const min = def.min !== null ? def.min : 0;
        const max = def.max !== null ? def.max : 1;

        ['R', 'G', 'B'].forEach((ch, ci) => {
          const lbl = document.createElement('label');
          lbl.textContent = ch;
          lbl.style.minWidth = '14px';
          group.appendChild(lbl);

          const s = document.createElement('input');
          s.type = 'range';
          s.min = min;
          s.max = max;
          s.step = '0.01';
          s.value = vec[ci];
          s.style.width = '50px';

          s.addEventListener('input', () => {
            const newVec = [...vec];
            newVec[ci] = parseFloat(s.value);
            sendParamValue(paramName, newVec, arrayIndex);
          });
          group.appendChild(s);
        });
        break;
      }

      case 'vec4': {
        const vec = Array.isArray(value) ? value : [0, 0, 0, 0];
        const min = def.min !== null ? def.min : 0;
        const max = def.max !== null ? def.max : 1;

        ['R', 'G', 'B', 'A'].forEach((ch, ci) => {
          const lbl = document.createElement('label');
          lbl.textContent = ch;
          lbl.style.minWidth = '14px';
          group.appendChild(lbl);

          const s = document.createElement('input');
          s.type = 'range';
          s.min = min;
          s.max = max;
          s.step = '0.01';
          s.value = vec[ci];
          s.style.width = '40px';

          s.addEventListener('input', () => {
            const newVec = [...vec];
            newVec[ci] = parseFloat(s.value);
            sendParamValue(paramName, newVec, arrayIndex);
          });
          group.appendChild(s);
        });
        break;
      }

      default:
        return null;
    }

    return group;
  }

  function sendParamValue(paramName, value, arrayIndex) {
    if (arrayIndex !== null) {
      // For array params, we need to send the full array
      // Update local state first
      if (appState.params[paramName] && Array.isArray(appState.params[paramName])) {
        appState.params[paramName][arrayIndex] = value;
        wsSend('set-param', { name: paramName, value: appState.params[paramName] });
      }
    } else {
      wsSend('set-param', { name: paramName, value });
    }
    scheduleActiveThumbnailRefresh();
  }

  function renderPresets() {
    const container = document.getElementById('preset-list');
    container.innerHTML = '';
    if (!appState || !appState.presets || appState.presets.length === 0) {
      container.innerHTML = '<span style="color:var(--text-secondary);font-size:13px">No presets for this shader</span>';
      return;
    }

    appState.presets.forEach((name, i) => {
      const btn = document.createElement('button');
      btn.className = 'preset-btn';
      btn.textContent = name;
      btn.addEventListener('click', () => {
        postAction('/api/preset/recall', { presetIndex: i });
        scheduleActiveThumbnailRefresh();
      });
      container.appendChild(btn);
    });
  }

  function renderVP() {
    if (!appState) return;

    const vpTabs = appState.vpTabs || [];
    const activeVpTab = appState.activeVpTab || 0;

    // Tab bar
    const tabBar = document.getElementById('vp-tab-bar');
    tabBar.innerHTML = '';
    vpTabs.forEach((tab, i) => {
      const btn = document.createElement('button');
      btn.className = 'tab-btn' + (i === activeVpTab ? ' active' : '');
      btn.textContent = tab.name;
      btn.addEventListener('click', () => {
        appState.activeVpTab = i;
        renderVP();
      });
      tabBar.appendChild(btn);
    });

    // Preset grid
    const grid = document.getElementById('vp-grid');
    grid.innerHTML = '';

    const tab = vpTabs[activeVpTab];
    if (!tab || !tab.presets || tab.presets.length === 0) {
      grid.innerHTML = '<div class="empty-message">No visual presets</div>';
      return;
    }

    tab.presets.forEach((preset, i) => {
      const card = document.createElement('div');
      card.className = 'vp-card';

      if (preset.thumbnail) {
        const img = document.createElement('img');
        img.className = 'vp-thumb';
        img.src = preset.thumbnail;
        img.alt = preset.name;
        img.onerror = function() { this.style.visibility = 'hidden'; };
        card.appendChild(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'vp-thumb-placeholder';
        card.appendChild(placeholder);
      }

      const label = document.createElement('div');
      label.className = 'vp-label';
      label.textContent = preset.name;
      card.appendChild(label);

      card.addEventListener('click', () => {
        postAction('/api/vp/recall', { vpTabIndex: activeVpTab, presetIndex: i });
      });

      grid.appendChild(card);
    });
  }

  function renderPlayback() {
    if (!appState) return;

    const playBtn = document.getElementById('btn-play');
    if (appState.playback) {
      playBtn.textContent = appState.playback.isPlaying ? '\u23F8' : '\u25B6';
    }

    const blackoutBtn = document.getElementById('btn-blackout');
    blackoutBtn.classList.toggle('active', appState.blackout);
  }

  // ---- Helpers ----
  function rgbToHex(r, g, b) {
    const toHex = (v) => {
      const h = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
      return h.length === 1 ? '0' + h : h;
    };
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }

  function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result) {
      return [
        parseInt(result[1], 16) / 255,
        parseInt(result[2], 16) / 255,
        parseInt(result[3], 16) / 255
      ];
    }
    return [1, 1, 1];
  }

  // ---- Event handlers ----
  function initEventHandlers() {
    // Bottom nav
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        switchView(view);
      });
    });

    // Speed slider
    const speedSlider = document.getElementById('remote-speed');
    const speedValue = document.getElementById('remote-speed-value');
    speedSlider.addEventListener('input', () => {
      const val = parseFloat(speedSlider.value);
      speedValue.textContent = val.toFixed(2);
      wsSend('set-param', { name: 'speed', value: val });
      scheduleActiveThumbnailRefresh();
    });
    speedSlider.addEventListener('dblclick', () => {
      speedSlider.value = 1;
      speedValue.textContent = '1.00';
      wsSend('set-param', { name: 'speed', value: 1 });
    });

    // Playback controls
    document.getElementById('btn-play').addEventListener('click', () => {
      postAction('/api/playback/toggle');
    });
    document.getElementById('btn-reset').addEventListener('click', () => {
      postAction('/api/playback/reset');
    });
    document.getElementById('btn-blackout').addEventListener('click', () => {
      const enabled = appState ? !appState.blackout : true;
      postAction('/api/blackout', { enabled });
    });

    // Mixer controls
    document.getElementById('remote-blend-mode').addEventListener('change', (e) => {
      postAction('/api/mixer/blend', { mode: e.target.value });
    });
    document.getElementById('btn-mixer-toggle').addEventListener('click', () => {
      postAction('/api/mixer/toggle');
    });
    document.getElementById('btn-mixer-reset').addEventListener('click', () => {
      postAction('/api/mixer/reset');
    });
  }

  function switchView(view) {
    currentView = view;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    document.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === view);
    });

  }

  // ---- Init ----
  initEventHandlers();
  connect();
})();
