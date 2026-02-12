// Shader Grid module
import { state, notifyRemoteStateChanged } from './state.js';
import { setStatus } from './utils.js';
import { loadParamsToSliders, generateCustomParamUI } from './params.js';
import { updateLocalPresetsUI } from './presets.js';
import { setRenderMode, ensureSceneRenderer, detectRenderMode } from './renderer.js';
import { setEditorMode } from './editor.js';
import { parseShaderParams, generateUniformDeclarations, parseTextureDirectives } from './param-parser.js';
import { openInTab } from './tabs.js';
import { tileState, assignTile } from './tile-state.js';
import { updateTileRenderer, refreshTileRenderers } from './controls.js';
import { assignShaderToMixer, recallMixState, resetMixer, isMixerActive, captureMixerThumbnail } from './mixer.js';

// Cache for file texture data URLs (avoids re-reading from disk for each grid slot)
const fileTextureCache = new Map();

// Load file textures for a MiniShaderRenderer after compile
async function loadFileTexturesForRenderer(renderer) {
  if (!renderer.fileTextureDirectives || renderer.fileTextureDirectives.length === 0) return;
  for (const { channel, textureName } of renderer.fileTextureDirectives) {
    try {
      let dataUrl = fileTextureCache.get(textureName);
      if (!dataUrl) {
        const result = await window.electronAPI.loadFileTexture(textureName);
        if (result.success) {
          dataUrl = result.dataUrl;
          fileTextureCache.set(textureName, dataUrl);
        } else {
          continue; // Texture not found, skip silently for grid
        }
      }
      await renderer.loadFileTexture(channel, dataUrl);
    } catch (err) {
      // Silently skip failed textures in grid thumbnails
    }
  }
}

// Track drag state
let dragSourceIndex = null;
let tabContextMenuHandler = null;

// Track max container height so the panel never shrinks when switching tabs
let maxContainerHeight = 0;

function applyMaxContainerHeight() {
  const container = document.getElementById('shader-grid-container');
  if (!container) return;
  // Temporarily remove min-height to measure natural height
  container.style.minHeight = '';
  requestAnimationFrame(() => {
    const h = container.scrollHeight;
    if (h > maxContainerHeight) maxContainerHeight = h;
    if (maxContainerHeight > 0) container.style.minHeight = `${maxContainerHeight}px`;
  });
}

// Reset max height tracking when panel width changes (grid reflows)
let _gridPanelWidth = 0;
const _gridResizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const w = entry.contentRect.width;
    if (_gridPanelWidth && Math.abs(w - _gridPanelWidth) > 1) {
      maxContainerHeight = 0;
      applyMaxContainerHeight();
    }
    _gridPanelWidth = w;
  }
});
requestAnimationFrame(() => {
  const panel = document.getElementById('grid-panel');
  if (panel) _gridResizeObserver.observe(panel);
});

// =============================================================================
// Tab Management
// =============================================================================

// Build the section switcher bar (Shaders / Composition)
function buildSectionBar() {
  const gridPanel = document.getElementById('grid-panel');
  let sectionBar = document.getElementById('grid-section-bar');

  if (!sectionBar) {
    sectionBar = document.createElement('div');
    sectionBar.id = 'grid-section-bar';
    sectionBar.className = 'grid-section-bar';
    gridPanel.insertBefore(sectionBar, gridPanel.firstChild);
  }

  sectionBar.innerHTML = '';
  const activeSection = state.activeSection || 'shaders';

  const sections = [
    { id: 'shaders', label: 'Shaders' },
    { id: 'mix', label: 'Composition' }
  ];

  for (const sec of sections) {
    const btn = document.createElement('div');
    btn.className = `grid-section-tab${sec.id === activeSection ? ' active' : ''}`;
    btn.textContent = sec.label;
    btn.addEventListener('click', () => switchSection(sec.id));
    sectionBar.appendChild(btn);
  }
}

// Switch between Shaders and Composition sections
function switchSection(section) {
  if (state.activeSection === section) return;
  state.activeSection = section;

  // Find the first tab matching this section
  const isMixSection = section === 'mix';
  const matchingIndex = state.shaderTabs.findIndex(t =>
    isMixSection ? t.type === 'mix' : t.type !== 'mix'
  );

  if (matchingIndex >= 0) {
    switchShaderTab(matchingIndex);
  } else {
    // No tabs of this type exist — create one
    if (isMixSection) {
      addNewMixTab();
    } else {
      addNewShaderTab();
    }
  }
}

// Build the shader grid tab bar
function buildTabBar() {
  const gridPanel = document.getElementById('grid-panel');

  // Build section bar above
  buildSectionBar();

  let tabBar = document.getElementById('shader-grid-tabs');

  if (!tabBar) {
    tabBar = document.createElement('div');
    tabBar.id = 'shader-grid-tabs';
    tabBar.className = 'shader-grid-tabs';
    // Insert after section bar
    const sectionBar = document.getElementById('grid-section-bar');
    if (sectionBar && sectionBar.nextSibling) {
      gridPanel.insertBefore(tabBar, sectionBar.nextSibling);
    } else {
      gridPanel.insertBefore(tabBar, gridPanel.firstChild);
    }
  }

  tabBar.innerHTML = '';

  // Filter tabs by active section
  const isMixSection = (state.activeSection || 'shaders') === 'mix';

  // Create tabs only for the active section
  state.shaderTabs.forEach((tab, index) => {
    const isMix = tab.type === 'mix';
    if (isMixSection !== isMix) return; // skip tabs from other section

    const tabEl = document.createElement('div');
    tabEl.className = `shader-grid-tab${index === state.activeShaderTab ? ' active' : ''}`;
    tabEl.dataset.tabIndex = index;
    tabEl.textContent = tab.name;
    const count = isMix ? (tab.mixPresets || []).length : tab.slots.filter(s => s).length;
    const countLabel = isMix ? 'mixes' : 'shaders';
    tabEl.title = `${tab.name} (${count} ${countLabel})`;

    // Click to switch tab
    tabEl.addEventListener('click', () => switchShaderTab(index));

    // Right-click for tab context menu
    tabEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showTabContextMenu(e.clientX, e.clientY, index);
    });

    // Double-click to rename
    tabEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      renameShaderTab(index);
    });

    tabBar.appendChild(tabEl);
  });

  // Add "+" button — creates tab of current section type
  const addTabBtn = document.createElement('div');
  addTabBtn.className = 'shader-grid-tab add-tab';
  addTabBtn.textContent = '+';
  addTabBtn.title = isMixSection ? 'Add new mix panel' : 'Add new shader tab';
  addTabBtn.addEventListener('click', () => {
    if (isMixSection) {
      addNewMixTab();
    } else {
      addNewShaderTab();
    }
  });
  tabBar.appendChild(addTabBtn);
}

// Switch to a different shader tab
export function switchShaderTab(tabIndex) {
  if (tabIndex < 0 || tabIndex >= state.shaderTabs.length) return;

  // Stop grid animation while switching
  stopGridAnimation();

  // Cleanup current tab's renderers from DOM
  cleanupGridVisibilityObserver();

  // Update active tab and section
  state.activeShaderTab = tabIndex;
  const tab = state.shaderTabs[tabIndex];
  state.activeSection = tab.type === 'mix' ? 'mix' : 'shaders';

  if (tab.type === 'mix') {
    state.gridSlots = [];
    state.activeGridSlot = null;
    rebuildMixPanelDOM();
  } else {
    state.gridSlots = tab.slots;
    state.activeGridSlot = null;
    rebuildGridDOM();
  }

  // Rebuild tab bar to update active state
  buildTabBar();

  // Restart animation if grid is visible (only for shader tabs)
  if (state.gridEnabled && tab.type !== 'mix') {
    startGridAnimation();
  }

  // Update presets UI
  updateLocalPresetsUI();
  updateSaveButtonState();

  setStatus(`Switched to "${tab.name}"`, 'success');
  notifyRemoteStateChanged();
}

// Add a new shader tab
function addNewShaderTab() {
  const newName = `Tab ${state.shaderTabs.length + 1}`;
  state.shaderTabs.push({ name: newName, slots: [] });

  // Switch to new tab
  switchShaderTab(state.shaderTabs.length - 1);

  // Save state
  saveGridState();

  setStatus(`Created new tab "${newName}"`, 'success');
}

// Rename a shader tab
function renameShaderTab(tabIndex) {
  const tab = state.shaderTabs[tabIndex];
  if (!tab) return;

  // Create inline input for renaming
  const tabBar = document.getElementById('shader-grid-tabs');
  const tabEl = tabBar.querySelector(`[data-tab-index="${tabIndex}"]`);
  if (!tabEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'shader-tab-rename-input';
  input.value = tab.name;

  const finishRename = () => {
    const newName = input.value.trim() || tab.name;
    tab.name = newName;
    buildTabBar();
    saveGridState();
  };

  input.addEventListener('blur', finishRename);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = tab.name;
      input.blur();
    }
  });

  tabEl.textContent = '';
  tabEl.appendChild(input);
  input.focus();
  input.select();
}

// Delete a shader tab
async function deleteShaderTab(tabIndex) {
  if (state.shaderTabs.length <= 1) {
    setStatus('Cannot delete the last tab', 'error');
    return;
  }

  const tab = state.shaderTabs[tabIndex];
  const isMix = tab.type === 'mix';
  const itemCount = isMix ? (tab.mixPresets || []).length : tab.slots.filter(s => s).length;
  const itemLabel = isMix ? 'mix preset(s)' : 'shader(s)';

  if (itemCount > 0) {
    if (!confirm(`Delete "${tab.name}" with ${itemCount} ${itemLabel}?`)) {
      return;
    }
  }

  // Dispose renderers in this tab (only for shader tabs)
  if (!isMix) {
    for (const slot of tab.slots) {
      if (slot && slot.renderer && slot.renderer.dispose) {
        slot.renderer.dispose();
      }
    }
  }

  // Remove the tab
  state.shaderTabs.splice(tabIndex, 1);

  // Try to find another tab in the same section
  const sameSection = state.shaderTabs.findIndex(t =>
    isMix ? t.type === 'mix' : t.type !== 'mix'
  );

  if (sameSection >= 0) {
    state.activeShaderTab = sameSection;
  } else {
    // No tabs left in this section — switch to the other section
    state.activeSection = isMix ? 'shaders' : 'mix';
    state.activeShaderTab = 0;
  }

  // Update gridSlots reference
  const newActiveTab = state.shaderTabs[state.activeShaderTab];
  state.gridSlots = newActiveTab.type === 'mix' ? [] : newActiveTab.slots;

  // Rebuild UI
  if (newActiveTab.type === 'mix') {
    rebuildMixPanelDOM();
  } else {
    rebuildGridDOM();
  }
  buildTabBar();
  saveGridState();

  setStatus(`Deleted tab "${tab.name}"`, 'success');
}

// Show tab context menu
function showTabContextMenu(x, y, tabIndex) {
  hideContextMenu();
  hideTabContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'tab-context-menu';

  // Rename option
  const renameItem = document.createElement('div');
  renameItem.className = 'context-menu-item';
  renameItem.textContent = 'Rename Tab';
  renameItem.addEventListener('click', () => {
    hideTabContextMenu();
    renameShaderTab(tabIndex);
  });
  menu.appendChild(renameItem);

  // Delete option (disabled if only one tab)
  const deleteItem = document.createElement('div');
  deleteItem.className = `context-menu-item${state.shaderTabs.length <= 1 ? ' disabled' : ''}`;
  deleteItem.textContent = 'Delete Tab';
  if (state.shaderTabs.length > 1) {
    deleteItem.addEventListener('click', () => {
      hideTabContextMenu();
      deleteShaderTab(tabIndex);
    });
  }
  menu.appendChild(deleteItem);

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Adjust position if off screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${window.innerWidth - rect.width - 5}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${window.innerHeight - rect.height - 5}px`;
  }

  // Close on click outside
  tabContextMenuHandler = (e) => {
    if (!menu.contains(e.target)) {
      hideTabContextMenu();
    }
  };
  setTimeout(() => document.addEventListener('click', tabContextMenuHandler), 0);
}

function hideTabContextMenu() {
  const menu = document.getElementById('tab-context-menu');
  if (menu) menu.remove();
  if (tabContextMenuHandler) {
    document.removeEventListener('click', tabContextMenuHandler);
    tabContextMenuHandler = null;
  }
}

// =============================================================================
// Add Tab Context Menu + Mix Panel
// =============================================================================

// Show context menu when right-clicking the "+" tab button
function showAddTabContextMenu(x, y) {
  hideContextMenu();
  hideTabContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'tab-context-menu';

  const shaderItem = document.createElement('div');
  shaderItem.className = 'context-menu-item';
  shaderItem.textContent = 'Add Shader Panel';
  shaderItem.addEventListener('click', () => {
    hideTabContextMenu();
    addNewShaderTab();
  });
  menu.appendChild(shaderItem);

  const mixItem = document.createElement('div');
  mixItem.className = 'context-menu-item';
  mixItem.textContent = 'Add Mix Panel';
  mixItem.addEventListener('click', () => {
    hideTabContextMenu();
    addNewMixTab();
  });
  menu.appendChild(mixItem);

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Adjust position if off screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${window.innerWidth - rect.width - 5}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${window.innerHeight - rect.height - 5}px`;
  }

  tabContextMenuHandler = (e) => {
    if (!menu.contains(e.target)) {
      hideTabContextMenu();
    }
  };
  setTimeout(() => document.addEventListener('click', tabContextMenuHandler), 0);
}

// Add a new mix tab
function addNewMixTab() {
  // Count existing mix tabs for naming
  const mixTabCount = state.shaderTabs.filter(t => t.type === 'mix').length;
  const newName = `Mixes ${mixTabCount + 1}`;
  state.shaderTabs.push({ name: newName, type: 'mix', mixPresets: [] });

  switchShaderTab(state.shaderTabs.length - 1);
  saveGridState();

  setStatus(`Created mix panel "${newName}"`, 'success');
}

// Build the mix preset panel DOM (replaces the shader grid when a mix tab is active)
function rebuildMixPanelDOM() {
  const container = document.getElementById('shader-grid-container');

  // Build tab bar first
  buildTabBar();

  // Cleanup grid-specific stuff
  slotEventListeners.forEach((listeners, slot) => {
    listeners.forEach(({ event, handler }) => {
      slot.removeEventListener(event, handler);
    });
  });
  slotEventListeners.clear();
  cleanupGridVisibilityObserver();

  // Clear container
  container.innerHTML = '';

  const tab = state.shaderTabs[state.activeShaderTab];
  if (!tab || tab.type !== 'mix') return;

  // Append mix preset buttons directly into container (same as shader grid slots)
  const presets = tab.mixPresets || [];
  for (let i = 0; i < presets.length; i++) {
    const preset = presets[i];
    const btn = document.createElement('div');
    btn.className = 'mix-preset-btn';
    btn.dataset.presetIndex = i;
    btn.title = buildMixPresetTooltip(preset);

    const thumb = document.createElement('div');
    thumb.className = 'mix-preset-thumb';
    if (preset.thumbnail) {
      thumb.style.backgroundImage = `url(${preset.thumbnail})`;
    }
    btn.appendChild(thumb);

    const label = document.createElement('span');
    label.className = 'mix-preset-label';
    label.textContent = preset.name || `Mix ${i + 1}`;
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      recallMixPresetFromTab(i);
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMixPresetContextMenu(e.clientX, e.clientY, i);
    });

    container.appendChild(btn);
  }

  // Add "+" button to save current mix state
  const addBtn = document.createElement('div');
  addBtn.className = 'mix-preset-btn mix-add-btn';
  addBtn.textContent = '+';
  addBtn.title = 'Save current mixer state as a preset';
  addBtn.addEventListener('click', () => {
    saveMixPreset();
  });
  container.appendChild(addBtn);

  // Maintain stable panel height across tab switches
  applyMaxContainerHeight();
}

// Build a tooltip string for a mix preset
function buildMixPresetTooltip(preset) {
  const channelCount = preset.channels.filter(ch => ch !== null).length;
  return `${preset.name} — ${channelCount} channel(s), blend: ${preset.blendMode || 'lighter'}`;
}

// Snapshot the current mixer state into a new mix preset
function saveMixPreset() {
  const tab = state.shaderTabs[state.activeShaderTab];
  if (!tab || tab.type !== 'mix') return;

  // Check that the mixer has at least one active channel
  if (!isMixerActive()) {
    setStatus('Mixer has no active channels to save', 'error');
    return;
  }

  const channels = state.mixerChannels.map(ch => {
    if (ch.slotIndex === null && ch.tabIndex === null && !ch.renderer) return null;

    // Get shader code: stored on channel (always set), or look up from tab
    let shaderCode = ch.shaderCode;
    if (!shaderCode && ch.slotIndex !== null && ch.tabIndex !== null) {
      const srcTab = state.shaderTabs[ch.tabIndex];
      shaderCode = srcTab?.slots?.[ch.slotIndex]?.shaderCode;
    }
    if (!shaderCode) return null;

    return {
      shaderCode,
      alpha: ch.alpha,
      params: { ...ch.params },
      customParams: { ...ch.customParams }
    };
  });

  const presetName = `Mix ${(tab.mixPresets || []).length + 1}`;
  const thumbnail = captureMixerThumbnail();
  const preset = {
    name: presetName,
    blendMode: state.mixerBlendMode,
    channels,
    thumbnail
  };

  if (!tab.mixPresets) tab.mixPresets = [];
  tab.mixPresets.push(preset);

  rebuildMixPanelDOM();
  saveGridState();

  setStatus(`Saved mix preset "${presetName}"`, 'success');
}

// Recall a mix preset and load it into the mixer
function recallMixPresetFromTab(presetIndex) {
  const tab = state.shaderTabs[state.activeShaderTab];
  if (!tab || tab.type !== 'mix') return;

  const preset = tab.mixPresets?.[presetIndex];
  if (!preset) return;

  recallMixState(preset);

  // Update active highlight on buttons
  const grid = document.getElementById('shader-grid-container');
  if (grid) {
    grid.querySelectorAll('.mix-preset-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    const activeBtn = grid.querySelector(`[data-preset-index="${presetIndex}"]`);
    if (activeBtn) activeBtn.classList.add('active');
  }
}

// Show context menu for a mix preset button
function showMixPresetContextMenu(x, y, presetIndex) {
  hideContextMenu();
  hideTabContextMenu();

  const tab = state.shaderTabs[state.activeShaderTab];
  if (!tab || tab.type !== 'mix') return;

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'tab-context-menu';

  // Update preset with current mixer state
  const updateItem = document.createElement('div');
  updateItem.className = 'context-menu-item';
  updateItem.textContent = 'Update with Current Mix';
  updateItem.addEventListener('click', () => {
    hideTabContextMenu();
    updateMixPreset(presetIndex);
  });
  menu.appendChild(updateItem);

  // Rename preset
  const renameItem = document.createElement('div');
  renameItem.className = 'context-menu-item';
  renameItem.textContent = 'Rename';
  renameItem.addEventListener('click', () => {
    hideTabContextMenu();
    renameMixPreset(presetIndex);
  });
  menu.appendChild(renameItem);

  // Delete preset
  const deleteItem = document.createElement('div');
  deleteItem.className = 'context-menu-item';
  deleteItem.textContent = 'Delete';
  deleteItem.addEventListener('click', () => {
    hideTabContextMenu();
    deleteMixPreset(presetIndex);
  });
  menu.appendChild(deleteItem);

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${window.innerWidth - rect.width - 5}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${window.innerHeight - rect.height - 5}px`;
  }

  tabContextMenuHandler = (e) => {
    if (!menu.contains(e.target)) {
      hideTabContextMenu();
    }
  };
  setTimeout(() => document.addEventListener('click', tabContextMenuHandler), 0);
}

// Update a mix preset with the current mixer state
function updateMixPreset(presetIndex) {
  const tab = state.shaderTabs[state.activeShaderTab];
  if (!tab || tab.type !== 'mix') return;

  if (!isMixerActive()) {
    setStatus('Mixer has no active channels to save', 'error');
    return;
  }

  const preset = tab.mixPresets?.[presetIndex];
  if (!preset) return;

  const channels = state.mixerChannels.map(ch => {
    if (ch.slotIndex === null && ch.tabIndex === null && !ch.renderer) return null;

    let shaderCode = ch.shaderCode;
    if (!shaderCode && ch.slotIndex !== null && ch.tabIndex !== null) {
      const srcTab = state.shaderTabs[ch.tabIndex];
      shaderCode = srcTab?.slots?.[ch.slotIndex]?.shaderCode;
    }
    if (!shaderCode) return null;

    return {
      shaderCode,
      alpha: ch.alpha,
      params: { ...ch.params },
      customParams: { ...ch.customParams }
    };
  });

  preset.blendMode = state.mixerBlendMode;
  preset.channels = channels;
  preset.thumbnail = captureMixerThumbnail();

  rebuildMixPanelDOM();
  saveGridState();
  setStatus(`Updated mix preset "${preset.name}"`, 'success');
}

// Rename a mix preset inline
function renameMixPreset(presetIndex) {
  const tab = state.shaderTabs[state.activeShaderTab];
  if (!tab || tab.type !== 'mix') return;

  const preset = tab.mixPresets?.[presetIndex];
  if (!preset) return;

  const grid = document.getElementById('shader-grid-container');
  const btn = grid?.querySelector(`[data-preset-index="${presetIndex}"]`);
  if (!btn) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'shader-tab-rename-input';
  input.value = preset.name;
  input.style.width = '90%';

  const finishRename = () => {
    const newName = input.value.trim() || preset.name;
    preset.name = newName;
    rebuildMixPanelDOM();
    saveGridState();
  };

  input.addEventListener('blur', finishRename);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = preset.name;
      input.blur();
    }
  });

  btn.innerHTML = '';
  btn.appendChild(input);
  input.focus();
  input.select();
}

// Delete a mix preset
function deleteMixPreset(presetIndex) {
  const tab = state.shaderTabs[state.activeShaderTab];
  if (!tab || tab.type !== 'mix') return;

  const preset = tab.mixPresets?.[presetIndex];
  if (!preset) return;

  tab.mixPresets.splice(presetIndex, 1);
  rebuildMixPanelDOM();
  saveGridState();

  setStatus(`Deleted mix preset "${preset.name}"`, 'success');
}

// Move a shader to another tab
async function moveShaderToTab(slotIndex, targetTabIndex) {
  if (targetTabIndex === state.activeShaderTab) return;
  if (targetTabIndex < 0 || targetTabIndex >= state.shaderTabs.length) return;

  const sourceTab = state.shaderTabs[state.activeShaderTab];
  const targetTab = state.shaderTabs[targetTabIndex];
  const slotData = sourceTab.slots[slotIndex];

  if (!slotData) {
    setStatus('No shader to move', 'error');
    return;
  }

  // Add to target tab
  targetTab.slots.push(slotData);

  // Remove from source tab (and dispose renderer)
  sourceTab.slots.splice(slotIndex, 1);

  // Fix activeGridSlot if needed
  if (state.activeGridSlot === slotIndex) {
    state.activeGridSlot = null;
  } else if (state.activeGridSlot > slotIndex) {
    state.activeGridSlot--;
  }

  // Update gridSlots reference
  state.gridSlots = sourceTab.slots;

  // Rebuild DOM
  rebuildGridDOM();
  saveGridState();

  // Re-save shader files with updated indices
  await resaveAllShaderFiles();

  setStatus(`Moved shader to "${targetTab.name}"`, 'success');
}

// Copy a shader from the current tab to another tab (keeps original)
async function copyShaderToTab(slotIndex, targetTabIndex) {
  if (targetTabIndex === state.activeShaderTab) return;
  if (targetTabIndex < 0 || targetTabIndex >= state.shaderTabs.length) return;

  const sourceTab = state.shaderTabs[state.activeShaderTab];
  const targetTab = state.shaderTabs[targetTabIndex];
  const slotData = sourceTab.slots[slotIndex];

  if (!slotData) {
    setStatus('No shader to copy', 'error');
    return;
  }

  // Deep copy the slot data (new renderer will be created when the target tab loads)
  const copy = {
    shaderCode: slotData.shaderCode,
    filePath: null, // New copy gets its own file on save
    type: slotData.type || 'shader',
    params: { ...(slotData.params || {}) },
    customParams: JSON.parse(JSON.stringify(slotData.customParams || {})),
    presets: JSON.parse(JSON.stringify(slotData.presets || [])),
    renderer: null
  };
  if (slotData.label) copy.label = slotData.label;

  targetTab.slots.push(copy);
  saveGridState();

  await resaveAllShaderFiles();

  setStatus(`Copied shader to "${targetTab.name}"`, 'success');
}

// Store event listeners for cleanup (to prevent memory leaks)
const slotEventListeners = new Map();
let documentClickHandler = null;

// Cleanup function for grid event listeners
export function cleanupShaderGrid() {
  // Remove slot event listeners
  slotEventListeners.forEach((listeners, slot) => {
    listeners.forEach(({ event, handler }) => {
      slot.removeEventListener(event, handler);
    });
  });
  slotEventListeners.clear();

  // Remove document click handler
  if (documentClickHandler) {
    document.removeEventListener('click', documentClickHandler);
    documentClickHandler = null;
  }

  // Disconnect intersection observer
  cleanupGridVisibilityObserver();

  // Stop grid animation
  stopGridAnimation();
}

// Create a grid slot DOM element and wire up event listeners
function createGridSlotElement(index) {
  const slot = document.createElement('div');
  slot.className = 'grid-slot';
  slot.dataset.slot = index;
  slot.setAttribute('draggable', 'true');

  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  slot.appendChild(canvas);

  const numberSpan = document.createElement('span');
  numberSpan.className = 'slot-number';
  numberSpan.textContent = index + 1;
  slot.appendChild(numberSpan);

  const labelSpan = document.createElement('span');
  labelSpan.className = 'slot-label';
  slot.appendChild(labelSpan);

  // Store listeners for this slot
  const listeners = [];

  // Drag start - store source index
  const dragstartHandler = (e) => {
    dragSourceIndex = index;
    slot.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
  };
  slot.addEventListener('dragstart', dragstartHandler);
  listeners.push({ event: 'dragstart', handler: dragstartHandler });

  // Drag end - cleanup
  const dragendHandler = () => {
    slot.classList.remove('dragging');
    dragSourceIndex = null;
    document.querySelectorAll('.grid-slot.drag-over').forEach(s => {
      s.classList.remove('drag-over');
    });
  };
  slot.addEventListener('dragend', dragendHandler);
  listeners.push({ event: 'dragend', handler: dragendHandler });

  // Drag over - allow drop
  const dragoverHandler = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  slot.addEventListener('dragover', dragoverHandler);
  listeners.push({ event: 'dragover', handler: dragoverHandler });

  // Drag enter - visual feedback
  const dragenterHandler = (e) => {
    e.preventDefault();
    if (dragSourceIndex !== null && dragSourceIndex !== index) {
      slot.classList.add('drag-over');
    }
  };
  slot.addEventListener('dragenter', dragenterHandler);
  listeners.push({ event: 'dragenter', handler: dragenterHandler });

  // Drag leave - remove visual feedback
  const dragleaveHandler = (e) => {
    if (!slot.contains(e.relatedTarget)) {
      slot.classList.remove('drag-over');
    }
  };
  slot.addEventListener('dragleave', dragleaveHandler);
  listeners.push({ event: 'dragleave', handler: dragleaveHandler });

  // Drop - swap slots
  const dropHandler = (e) => {
    e.preventDefault();
    slot.classList.remove('drag-over');
    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!isNaN(fromIndex) && fromIndex !== index) {
      swapGridSlots(fromIndex, index);
    }
  };
  slot.addEventListener('drop', dropHandler);
  listeners.push({ event: 'drop', handler: dropHandler });

  // Left click - select slot and load parameters (or assign to mixer if armed)
  const clickHandler = () => {
    if (state.gridSlots[index]) {
      if (state.mixerArmedChannel !== null) {
        assignShaderToMixer(state.mixerArmedChannel, index);
      } else {
        selectGridSlot(index);
      }
    }
  };
  slot.addEventListener('click', clickHandler);
  listeners.push({ event: 'click', handler: clickHandler });

  // Double click - open shader in editor tab
  const dblclickHandler = () => {
    if (state.gridSlots[index]) {
      loadGridShaderToEditor(index);
    }
  };
  slot.addEventListener('dblclick', dblclickHandler);
  listeners.push({ event: 'dblclick', handler: dblclickHandler });

  // Right click - context menu
  const contextmenuHandler = (e) => {
    e.preventDefault();
    showGridContextMenu(e.clientX, e.clientY, index);
  };
  slot.addEventListener('contextmenu', contextmenuHandler);
  listeners.push({ event: 'contextmenu', handler: contextmenuHandler });

  slotEventListeners.set(slot, listeners);

  return slot;
}

// Create the "Add Shader" button element
function createAddButton() {
  const btn = document.createElement('div');
  btn.className = 'grid-slot grid-add-btn';
  btn.title = 'Add shader to grid';

  const plusSign = document.createElement('span');
  plusSign.className = 'grid-add-plus';
  plusSign.textContent = '+';
  btn.appendChild(plusSign);

  btn.addEventListener('click', async () => {
    await addNewGridSlot();
  });

  return btn;
}

// Add a new empty slot and immediately prompt to load a shader
async function addNewGridSlot() {
  const newIndex = state.gridSlots.length;
  state.gridSlots.push(null);

  const container = document.getElementById('shader-grid-container');
  const addBtn = container.querySelector('.grid-add-btn');

  const slotEl = createGridSlotElement(newIndex);
  container.insertBefore(slotEl, addBtn);

  // Observe new slot for visibility
  if (gridIntersectionObserver) {
    gridIntersectionObserver.observe(slotEl);
  }

  // Prompt to load a shader
  await loadShaderToSlot(newIndex);

  // If user canceled, remove the empty slot
  if (!state.gridSlots[newIndex]) {
    removeGridSlotElement(newIndex);
  }
}

// Remove a grid slot DOM element and compact state
function removeGridSlotElement(index) {
  // Dispose renderer
  if (state.gridSlots[index] && state.gridSlots[index].renderer) {
    if (state.gridSlots[index].renderer.dispose) {
      state.gridSlots[index].renderer.dispose();
    }
  }

  // Remove from state
  state.gridSlots.splice(index, 1);

  // Fix activeGridSlot reference
  if (state.activeGridSlot === index) {
    state.activeGridSlot = null;
  } else if (state.activeGridSlot !== null && state.activeGridSlot > index) {
    state.activeGridSlot--;
  }

  // Rebuild DOM (simpler than re-indexing all elements + listeners)
  rebuildGridDOM();
}

// Rebuild all grid slot DOM elements from state
function rebuildGridDOM() {
  // If active tab is a mix panel, delegate to mix panel builder
  const activeTab = state.shaderTabs[state.activeShaderTab];
  if (activeTab && activeTab.type === 'mix') {
    rebuildMixPanelDOM();
    return;
  }

  const container = document.getElementById('shader-grid-container');

  // Build tab bar first
  buildTabBar();

  // Cleanup existing listeners
  slotEventListeners.forEach((listeners, slot) => {
    listeners.forEach(({ event, handler }) => {
      slot.removeEventListener(event, handler);
    });
  });
  slotEventListeners.clear();
  cleanupGridVisibilityObserver();

  // Clear container
  container.innerHTML = '';

  // Recreate slot elements for each state entry
  for (let i = 0; i < state.gridSlots.length; i++) {
    const slotEl = createGridSlotElement(i);
    container.appendChild(slotEl);

    const data = state.gridSlots[i];
    if (data) {
      slotEl.classList.add('has-shader');
      if (data.hasError) slotEl.classList.add('has-error');
      if (state.activeGridSlot === i) slotEl.classList.add('active');

      const fileName = data.filePath ? data.filePath.split('/').pop().split('\\').pop() : `Slot ${i + 1}`;
      const typeLabel = data.type === 'scene' ? ' (scene)' : '';
      slotEl.title = `Slot ${i + 1}: ${fileName}${typeLabel}`;

      // Set slot label
      const labelEl = slotEl.querySelector('.slot-label');
      if (labelEl) {
        labelEl.textContent = data.label || fileName.replace(/\.glsl$/i, '');
      }

      // Update renderer's canvas reference to the new DOM element
      if (data.renderer) {
        const newCanvas = slotEl.querySelector('canvas');
        data.renderer.canvas = newCanvas;
        data.renderer.ctx2d = newCanvas.getContext('2d');
      }
    }
  }

  // Add the "+" button at the end
  container.appendChild(createAddButton());

  // Reinitialize visibility observer
  initGridVisibilityObserver();

  // Maintain stable panel height across tab switches
  applyMaxContainerHeight();
}

export async function initShaderGrid() {
  // Cleanup any existing listeners first
  cleanupShaderGrid();

  // Close context menu when clicking elsewhere
  documentClickHandler = hideContextMenu;
  document.addEventListener('click', documentClickHandler);

  // Load saved grid state (this will create DOM slots dynamically)
  await loadGridState();

  // If no slots were loaded, rebuild DOM with just the add button
  if (state.gridSlots.length === 0) {
    rebuildGridDOM();
  }
}

function showGridContextMenu(x, y, slotIndex) {
  hideContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'grid-context-menu';

  const hasShader = state.gridSlots[slotIndex] !== null;

  // Load shader option
  const loadItem = document.createElement('div');
  loadItem.className = 'context-menu-item';
  loadItem.textContent = 'Load Shader...';
  loadItem.addEventListener('click', async () => {
    hideContextMenu();
    await loadShaderToSlot(slotIndex);
  });
  menu.appendChild(loadItem);

  // Assign current shader option
  const assignItem = document.createElement('div');
  assignItem.className = 'context-menu-item';
  assignItem.textContent = 'Assign Current Shader';
  assignItem.addEventListener('click', () => {
    hideContextMenu();
    assignCurrentShaderToSlot(slotIndex);
  });
  menu.appendChild(assignItem);

  // Set current params as default option (only if has shader)
  const setParamsItem = document.createElement('div');
  setParamsItem.className = `context-menu-item${hasShader ? '' : ' disabled'}`;
  setParamsItem.textContent = 'Set Current Params as Default';
  if (hasShader) {
    setParamsItem.addEventListener('click', () => {
      hideContextMenu();
      setCurrentParamsAsDefault(slotIndex);
    });
  }
  menu.appendChild(setParamsItem);

  // Rename label option (only if has shader)
  const renameItem = document.createElement('div');
  renameItem.className = `context-menu-item${hasShader ? '' : ' disabled'}`;
  renameItem.textContent = 'Rename';
  if (hasShader) {
    renameItem.addEventListener('click', () => {
      hideContextMenu();
      renameGridSlot(slotIndex);
    });
  }
  menu.appendChild(renameItem);

  // Clear option (only if has shader)
  const clearItem = document.createElement('div');
  clearItem.className = `context-menu-item${hasShader ? '' : ' disabled'}`;
  clearItem.textContent = 'Clear Slot';
  if (hasShader) {
    clearItem.addEventListener('click', () => {
      hideContextMenu();
      clearGridSlot(slotIndex);
    });
  }
  menu.appendChild(clearItem);

  // Remove slot option
  const removeItem = document.createElement('div');
  removeItem.className = 'context-menu-item';
  removeItem.textContent = 'Remove Slot';
  removeItem.addEventListener('click', async () => {
    hideContextMenu();
    // Delete the shader file first
    await window.electronAPI.deleteShaderFromSlot(slotIndex);
    removeGridSlotElement(slotIndex);
    saveGridState();
    // Re-save all shader files with updated indices
    await resaveAllShaderFiles();
    setStatus(`Removed slot ${slotIndex + 1}`, 'success');
  });
  menu.appendChild(removeItem);

  // Move/Copy to Tab submenus (only shader tabs, not mix tabs)
  if (hasShader) {
    const otherShaderTabs = [];
    for (let i = 0; i < state.shaderTabs.length; i++) {
      if (i === state.activeShaderTab) continue;
      if (state.shaderTabs[i].type === 'mix') continue;
      otherShaderTabs.push(i);
    }

    if (otherShaderTabs.length > 0) {
      const separator1 = document.createElement('div');
      separator1.className = 'context-menu-separator';
      menu.appendChild(separator1);

      // Move to Tab
      const moveSubmenu = document.createElement('div');
      moveSubmenu.className = 'context-menu-item has-submenu';
      moveSubmenu.textContent = 'Move to Tab';
      const moveArrow = document.createElement('span');
      moveArrow.className = 'submenu-arrow';
      moveArrow.textContent = '\u25b6';
      moveSubmenu.appendChild(moveArrow);

      const moveContent = document.createElement('div');
      moveContent.className = 'context-submenu';
      for (const i of otherShaderTabs) {
        const item = document.createElement('div');
        item.className = 'context-menu-item';
        item.textContent = state.shaderTabs[i].name;
        item.addEventListener('click', () => {
          hideContextMenu();
          moveShaderToTab(slotIndex, i);
        });
        moveContent.appendChild(item);
      }
      moveSubmenu.appendChild(moveContent);
      menu.appendChild(moveSubmenu);

      // Copy to Tab
      const copySubmenu = document.createElement('div');
      copySubmenu.className = 'context-menu-item has-submenu';
      copySubmenu.textContent = 'Copy to Tab';
      const copyArrow = document.createElement('span');
      copyArrow.className = 'submenu-arrow';
      copyArrow.textContent = '\u25b6';
      copySubmenu.appendChild(copyArrow);

      const copyContent = document.createElement('div');
      copyContent.className = 'context-submenu';
      for (const i of otherShaderTabs) {
        const item = document.createElement('div');
        item.className = 'context-menu-item';
        item.textContent = state.shaderTabs[i].name;
        item.addEventListener('click', () => {
          hideContextMenu();
          copyShaderToTab(slotIndex, i);
        });
        copyContent.appendChild(item);
      }
      copySubmenu.appendChild(copyContent);
      menu.appendChild(copySubmenu);
    }
  }

  // Send to Tile submenu (only if has shader and tiles are configured)
  if (hasShader && tileState.tiles.length > 0) {
    const separator = document.createElement('div');
    separator.className = 'context-menu-separator';
    menu.appendChild(separator);

    const { rows, cols } = tileState.layout;
    const tileCount = rows * cols;

    // Create "Send to Tile" submenu container
    const tileSubmenu = document.createElement('div');
    tileSubmenu.className = 'context-menu-item has-submenu';
    tileSubmenu.textContent = 'Send to Tile';

    const submenuArrow = document.createElement('span');
    submenuArrow.className = 'submenu-arrow';
    submenuArrow.textContent = '\u25b6';
    tileSubmenu.appendChild(submenuArrow);

    const submenuContent = document.createElement('div');
    submenuContent.className = 'context-submenu';

    for (let i = 0; i < tileCount; i++) {
      const tileItem = document.createElement('div');
      tileItem.className = 'context-menu-item';
      const currentSlot = tileState.tiles[i]?.gridSlotIndex;
      const tileLabel = currentSlot !== null ? `Tile ${i + 1} (Slot ${currentSlot + 1})` : `Tile ${i + 1} (Empty)`;
      tileItem.textContent = tileLabel;

      tileItem.addEventListener('click', () => {
        hideContextMenu();
        assignShaderToTile(slotIndex, i);
      });

      submenuContent.appendChild(tileItem);
    }

    tileSubmenu.appendChild(submenuContent);
    menu.appendChild(tileSubmenu);
  }

  // Send to Mix Channel submenu (only if has shader)
  if (hasShader) {
    const mixSeparator = document.createElement('div');
    mixSeparator.className = 'context-menu-separator';
    menu.appendChild(mixSeparator);

    const mixSubmenu = document.createElement('div');
    mixSubmenu.className = 'context-menu-item has-submenu';
    mixSubmenu.textContent = 'Send to Mix Channel';

    const mixArrow = document.createElement('span');
    mixArrow.className = 'submenu-arrow';
    mixArrow.textContent = '\u25b6';
    mixSubmenu.appendChild(mixArrow);

    const mixContent = document.createElement('div');
    mixContent.className = 'context-submenu';

    for (let i = 0; i < state.mixerChannels.length; i++) {
      const ch = state.mixerChannels[i];
      const mixItem = document.createElement('div');
      mixItem.className = 'context-menu-item';
      const chLabel = ch.slotIndex !== null ? `Ch ${i + 1} (Slot ${ch.slotIndex + 1})` : `Ch ${i + 1} (Empty)`;
      mixItem.textContent = chLabel;

      mixItem.addEventListener('click', () => {
        hideContextMenu();
        assignShaderToMixer(i, slotIndex);
      });
      mixContent.appendChild(mixItem);
    }

    mixSubmenu.appendChild(mixContent);
    menu.appendChild(mixSubmenu);
  }

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Adjust position if menu goes off screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${window.innerWidth - rect.width - 5}px`;
  }
  if (rect.bottom > window.innerHeight) {
    const newTop = Math.max(5, window.innerHeight - rect.height - 5);
    menu.style.top = `${newTop}px`;
    // If menu is taller than viewport, make it scrollable
    if (rect.height > window.innerHeight - 10) {
      menu.style.maxHeight = `${window.innerHeight - 10}px`;
      menu.style.overflowY = 'auto';
    }
  }

  // Reposition submenus on hover to stay within viewport
  menu.querySelectorAll('.has-submenu').forEach(item => {
    item.addEventListener('mouseenter', () => {
      const sub = item.querySelector('.context-submenu');
      if (!sub) return;
      // Reset positioning before measuring
      sub.style.left = '100%';
      sub.style.right = '';
      sub.style.top = '-4px';
      sub.style.maxHeight = '';
      sub.style.overflowY = '';

      const subRect = sub.getBoundingClientRect();
      // Flip to left side if overflowing right
      if (subRect.right > window.innerWidth) {
        sub.style.left = '';
        sub.style.right = '100%';
      }
      // Shift up if overflowing bottom
      if (subRect.bottom > window.innerHeight) {
        const shift = subRect.bottom - window.innerHeight + 5;
        sub.style.top = `${-4 - shift}px`;
      }
      // Make scrollable if taller than viewport
      if (subRect.height > window.innerHeight - 10) {
        sub.style.maxHeight = `${window.innerHeight - 10}px`;
        sub.style.overflowY = 'auto';
      }
    });
  });
}

function hideContextMenu() {
  const menu = document.getElementById('grid-context-menu');
  if (menu) {
    menu.remove();
  }
}

// Assign a shader slot to a tile
function assignShaderToTile(slotIndex, tileIndex) {
  const slotData = state.gridSlots[slotIndex];
  if (!slotData) {
    setStatus('No shader in slot', 'error');
    return;
  }

  // Update tile state with copies of slot's params
  // Tiles share the slot's renderer but have their own param copies
  assignTile(tileIndex, slotIndex, slotData.params, slotData.customParams);

  // Update tile renderer reference (points to slot's renderer)
  updateTileRenderer(tileIndex);

  // Sync to fullscreen if tiled mode is active
  if (state.tiledPreviewEnabled && slotData.shaderCode) {
    const allParams = {
      speed: slotData.params?.speed ?? 1,
      ...(slotData.customParams || {})
    };
    window.electronAPI.assignTileShader?.(tileIndex, slotData.shaderCode, allParams);
  }

  // Save tile state
  saveTileState();

  setStatus(`Assigned slot ${slotIndex + 1} to tile ${tileIndex + 1}`, 'success');
}

// Save tile state to file
function saveTileState() {
  const saveData = {
    layout: { ...tileState.layout },
    tiles: tileState.tiles.map(t => ({
      gridSlotIndex: t.gridSlotIndex,
      params: t.params ? { ...t.params } : null,
      customParams: t.customParams ? { ...t.customParams } : null,
      visible: t.visible
    }))
  };
  window.electronAPI.saveTileState?.(saveData);
}

// Set current parameters as default for a shader slot
function setCurrentParamsAsDefault(slotIndex) {
  const slotData = state.gridSlots[slotIndex];
  if (!slotData) return;

  // Get current params from the main renderer
  const currentParams = state.renderer.getParams();

  // Update the slot's params
  slotData.params = { ...currentParams };

  // Save grid state
  saveGridState();

  setStatus(`Saved current params as default for slot ${slotIndex + 1}`, 'success');
}

// Swap two grid slots
async function swapGridSlots(fromIndex, toIndex) {
  const fromSlot = document.querySelector(`.grid-slot[data-slot="${fromIndex}"]`);
  const toSlot = document.querySelector(`.grid-slot[data-slot="${toIndex}"]`);
  const fromCanvas = fromSlot.querySelector('canvas');
  const toCanvas = toSlot.querySelector('canvas');

  // Swap data in state
  const fromData = state.gridSlots[fromIndex];
  const toData = state.gridSlots[toIndex];
  state.gridSlots[fromIndex] = toData;
  state.gridSlots[toIndex] = fromData;

  // Update active slot reference if needed
  if (state.activeGridSlot === fromIndex) {
    state.activeGridSlot = toIndex;
  } else if (state.activeGridSlot === toIndex) {
    state.activeGridSlot = fromIndex;
  }

  // Recreate renderers for swapped slots (they need new canvas references)
  if (state.gridSlots[fromIndex]) {
    const data = state.gridSlots[fromIndex];
    if (data.type === 'scene') {
      // Re-render scene snapshot to new canvas position
      try {
        const sceneRenderer = await ensureSceneRenderer();
        if (sceneRenderer) {
          sceneRenderer.reinitialize();
          sceneRenderer.compile(data.shaderCode);
          sceneRenderer.resetTime();
          sceneRenderer.render();
          const mainCanvas = document.getElementById('shader-canvas');
          const ctx = fromCanvas.getContext('2d');
          ctx.drawImage(mainCanvas, 0, 0, mainCanvas.width, mainCanvas.height, 0, 0, fromCanvas.width, fromCanvas.height);
        }
      } catch (err) {
        console.warn(`Failed to re-render scene for slot ${fromIndex + 1}:`, err);
      }
    } else {
      // Dispose old renderer before creating new one
      if (data.renderer && data.renderer.dispose) {
        data.renderer.dispose();
      }
      const newRenderer = new MiniShaderRenderer(fromCanvas);
      try {
        newRenderer.compile(data.shaderCode);
        data.renderer = newRenderer;
      } catch (err) {
        console.warn(`Failed to recompile shader for slot ${fromIndex + 1}:`, err);
      }
    }
  }

  if (state.gridSlots[toIndex]) {
    const data = state.gridSlots[toIndex];
    if (data.type === 'scene') {
      // Re-render scene snapshot to new canvas position
      try {
        const sceneRenderer = await ensureSceneRenderer();
        if (sceneRenderer) {
          sceneRenderer.reinitialize();
          sceneRenderer.compile(data.shaderCode);
          sceneRenderer.resetTime();
          sceneRenderer.render();
          const mainCanvas = document.getElementById('shader-canvas');
          const ctx = toCanvas.getContext('2d');
          ctx.drawImage(mainCanvas, 0, 0, mainCanvas.width, mainCanvas.height, 0, 0, toCanvas.width, toCanvas.height);
        }
      } catch (err) {
        console.warn(`Failed to re-render scene for slot ${toIndex + 1}:`, err);
      }
    } else {
      // Dispose old renderer before creating new one
      if (data.renderer && data.renderer.dispose) {
        data.renderer.dispose();
      }
      const newRenderer = new MiniShaderRenderer(toCanvas);
      try {
        newRenderer.compile(data.shaderCode);
        data.renderer = newRenderer;
      } catch (err) {
        console.warn(`Failed to recompile shader for slot ${toIndex + 1}:`, err);
      }
    }
  }

  // Update visual state for fromSlot
  updateSlotVisualState(fromIndex, fromSlot);

  // Update visual state for toSlot
  updateSlotVisualState(toIndex, toSlot);

  // Clear canvases for empty slots
  if (!state.gridSlots[fromIndex]) {
    const ctx = fromCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, fromCanvas.width, fromCanvas.height);
  }
  if (!state.gridSlots[toIndex]) {
    const ctx = toCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, toCanvas.width, toCanvas.height);
  }

  // Save shader files to new locations
  if (state.gridSlots[fromIndex]) {
    await window.electronAPI.saveShaderToSlot(fromIndex, state.gridSlots[fromIndex].shaderCode);
  } else {
    await window.electronAPI.deleteShaderFromSlot(fromIndex);
  }

  if (state.gridSlots[toIndex]) {
    await window.electronAPI.saveShaderToSlot(toIndex, state.gridSlots[toIndex].shaderCode);
  } else {
    await window.electronAPI.deleteShaderFromSlot(toIndex);
  }

  // Save grid state
  saveGridState();

  setStatus(`Swapped slot ${fromIndex + 1} with slot ${toIndex + 1}`, 'success');
}

// Update visual state of a slot based on its data
function updateSlotVisualState(index, slot) {
  const data = state.gridSlots[index];

  if (data) {
    slot.classList.add('has-shader');
    const typeLabel = data.type === 'scene' ? ' (scene)' : '';
    slot.title = data.filePath
      ? `Slot ${index + 1}: ${data.filePath.split('/').pop().split('\\').pop()}${typeLabel}`
      : `Slot ${index + 1}: Current ${data.type === 'scene' ? 'scene' : 'shader'}`;
  } else {
    slot.classList.remove('has-shader');
    slot.title = `Slot ${index + 1} - Right-click for options`;
  }

  // Update active state
  if (state.activeGridSlot === index) {
    slot.classList.add('active');
  } else {
    slot.classList.remove('active');
  }
}

async function loadShaderToSlot(slotIndex) {
  const result = await window.electronAPI.loadShaderForGrid();
  if (result && result.content) {
    // Check if this is a Three.js scene file
    const isScene = result.filePath &&
      (result.filePath.endsWith('.jsx') || result.filePath.includes('.scene.js')) ||
      isSceneCode(result.content);

    if (isScene) {
      assignSceneToSlot(slotIndex, result.content, result.filePath);
    } else {
      assignShaderToSlot(slotIndex, result.content, result.filePath);
    }
  } else if (result && result.error) {
    setStatus(`Failed to load shader: ${result.error}`, 'error');
  }
}

function assignCurrentShaderToSlot(slotIndex) {
  const code = state.editor.getValue();
  const isScene = state.renderMode === 'scene' || isSceneCode(code);

  if (isScene) {
    assignSceneToSlot(slotIndex, code, null);
  } else {
    assignShaderToSlot(slotIndex, code, null);
  }
}

// Detect if code is a Three.js scene
function isSceneCode(code) {
  return code.includes('function setup') && (code.includes('THREE') || code.includes('scene'));
}

export async function assignShaderToSlot(slotIndex, shaderCode, filePath, skipSave = false, params = null, presets = null, customParams = null) {
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  const canvas = slot.querySelector('canvas');

  // Clean up existing renderer to prevent memory leaks
  if (state.gridSlots[slotIndex] && state.gridSlots[slotIndex].renderer) {
    if (state.gridSlots[slotIndex].renderer.dispose) {
      state.gridSlots[slotIndex].renderer.dispose();
    }
  }

  // Create mini renderer for this slot
  const miniRenderer = new MiniShaderRenderer(canvas);

  // Use provided params or capture current params for speed
  const slotParams = params || { speed: 1 };

  try {
    miniRenderer.compile(shaderCode);
    // Load file textures asynchronously (non-blocking for grid)
    loadFileTexturesForRenderer(miniRenderer);

    // Get custom params: start with defaults from the shader, then overlay any saved values
    // This ensures all params have values even if saved state is incomplete
    let slotCustomParams = {};

    // First, populate with defaults from shader's @param definitions
    for (const param of miniRenderer.customParams || []) {
      slotCustomParams[param.name] = Array.isArray(param.default)
        ? [...param.default]
        : param.default;
    }

    // Then overlay any provided/saved custom params
    if (customParams && Object.keys(customParams).length > 0) {
      Object.assign(slotCustomParams, customParams);
    }

    state.gridSlots[slotIndex] = {
      shaderCode,
      filePath,
      renderer: miniRenderer,
      type: 'shader',
      params: { ...slotParams },
      customParams: slotCustomParams,
      presets: presets || []
    };
    slot.classList.add('has-shader');
    slot.classList.remove('has-error');  // Clear any previous error state
    const displayName = filePath ? filePath.split('/').pop().split('\\').pop() : 'Current shader';
    slot.title = `Slot ${slotIndex + 1}: ${displayName}`;

    // Set label on the slot element
    const labelEl = slot.querySelector('.slot-label');
    if (labelEl) {
      labelEl.textContent = state.gridSlots[slotIndex].label || displayName.replace(/\.glsl$/i, '');
    }

    if (!skipSave) {
      // Save shader code to individual file
      await window.electronAPI.saveShaderToSlot(slotIndex, shaderCode);
      setStatus(`Shader assigned to slot ${slotIndex + 1}`, 'success');
      saveGridState();
    }
  } catch (err) {
    if (!skipSave) {
      setStatus(`Failed to compile shader for slot ${slotIndex + 1}: ${err.message}`, 'error');
    }
    throw err;
  }
}

// Draw a static scene placeholder on a mini canvas
function drawScenePlaceholder(ctx, width, height) {
  ctx.fillStyle = '#0a0a1a';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#6688cc';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Scene', width / 2, height / 2);
}

// Assign a Three.js scene to a grid slot with a static snapshot
async function assignSceneToSlot(slotIndex, sceneCode, filePath, skipSave = false, params = null, presets = null) {
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  const canvas = slot.querySelector('canvas');
  const ctx = canvas.getContext('2d');

  // Clean up existing slot data
  if (state.gridSlots[slotIndex]) {
    state.gridSlots[slotIndex] = null;
  }

  // Use provided params or capture current params
  const slotParams = params || { speed: 1 };

  if (skipSave) {
    // During initial load, don't render snapshots on the main canvas —
    // it would create a competing WebGL context and break ShaderRenderer
    drawScenePlaceholder(ctx, canvas.width, canvas.height);
  } else {
    // Interactive assignment: try to render a snapshot
    const sceneRenderer = await ensureSceneRenderer();
    if (sceneRenderer) {
      try {
        sceneRenderer.reinitialize();
        sceneRenderer.compile(sceneCode);
        sceneRenderer.resetTime();
        sceneRenderer.render();

        const mainCanvas = document.getElementById('shader-canvas');
        ctx.drawImage(mainCanvas, 0, 0, mainCanvas.width, mainCanvas.height, 0, 0, canvas.width, canvas.height);
      } catch (err) {
        console.warn(`Scene snapshot failed for slot ${slotIndex + 1}:`, err.message);
        drawScenePlaceholder(ctx, canvas.width, canvas.height);
      }
    } else {
      drawScenePlaceholder(ctx, canvas.width, canvas.height);
    }
  }

  // Store scene data (no mini renderer for scenes)
  state.gridSlots[slotIndex] = {
    shaderCode: sceneCode,
    filePath,
    renderer: null,
    type: 'scene',
    params: { ...slotParams },
    presets: presets || []
  };

  slot.classList.add('has-shader');
  slot.classList.remove('has-error');
  slot.title = filePath
    ? `Slot ${slotIndex + 1}: ${filePath.split('/').pop().split('\\').pop()} (scene)`
    : `Slot ${slotIndex + 1}: Current scene`;

  if (!skipSave) {
    await window.electronAPI.saveShaderToSlot(slotIndex, sceneCode);
    setStatus(`Scene assigned to slot ${slotIndex + 1}`, 'success');
    saveGridState();
  }
}

// Store a shader that failed to compile so user can still edit it
function assignFailedShaderToSlot(slotIndex, shaderCode, filePath, savedData = {}) {
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  const canvas = slot.querySelector('canvas');
  const ctx = canvas.getContext('2d');

  // Draw error indicator on canvas
  ctx.fillStyle = '#331111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ff4444';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ERROR', canvas.width / 2, canvas.height / 2 - 8);
  ctx.font = '10px sans-serif';
  ctx.fillText('Click to fix', canvas.width / 2, canvas.height / 2 + 8);

  // Store shader data (without renderer) so it can be edited
  state.gridSlots[slotIndex] = {
    shaderCode,
    filePath,
    renderer: null,  // No renderer - compilation failed
    type: savedData.type || 'shader',
    params: savedData.params || {},
    customParams: savedData.customParams || {},
    presets: savedData.presets || [],
    hasError: true  // Flag to indicate this slot has an error
  };

  slot.classList.add('has-shader');
  slot.classList.add('has-error');
  const fileName = filePath ? filePath.split('/').pop().split('\\').pop() : 'shader';
  slot.title = `Slot ${slotIndex + 1}: ${fileName} (ERROR - click to edit)`;
}

function renameGridSlot(slotIndex) {
  const data = state.gridSlots[slotIndex];
  if (!data) return;

  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  const labelEl = slot?.querySelector('.slot-label');
  if (!labelEl) return;

  const currentName = data.label || (data.filePath ? data.filePath.split('/').pop().split('\\').pop().replace(/\.glsl$/i, '') : `Slot ${slotIndex + 1}`);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'shader-tab-rename-input';
  input.value = currentName;
  input.style.width = '90%';

  const finishRename = () => {
    const newName = input.value.trim() || currentName;
    data.label = newName;
    labelEl.textContent = newName;
    if (input.parentNode === labelEl) {
      labelEl.removeChild(input);
    }
    labelEl.textContent = newName;
    saveGridState();
  };

  input.addEventListener('blur', finishRename);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = currentName;
      input.blur();
    }
  });

  labelEl.textContent = '';
  labelEl.appendChild(input);
  input.focus();
  input.select();
}

async function clearGridSlot(slotIndex) {
  // Dispose renderer
  if (state.gridSlots[slotIndex] && state.gridSlots[slotIndex].renderer) {
    if (state.gridSlots[slotIndex].renderer.dispose) {
      state.gridSlots[slotIndex].renderer.dispose();
    }
  }

  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  state.gridSlots[slotIndex] = null;
  if (slot) {
    slot.classList.remove('has-shader');
    slot.classList.remove('has-error');
    slot.title = `Slot ${slotIndex + 1} - Right-click to assign shader`;

    // Clear label
    const labelEl = slot.querySelector('.slot-label');
    if (labelEl) labelEl.textContent = '';

    // Clear canvas
    const canvas = slot.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  // Delete shader file
  await window.electronAPI.deleteShaderFromSlot(slotIndex);

  // Clear active slot if this was it
  if (state.activeGridSlot === slotIndex) {
    state.activeGridSlot = null;
    updateLocalPresetsUI();
    updateSaveButtonState();
  }

  setStatus(`Cleared slot ${slotIndex + 1}`, 'success');

  // Save grid state
  saveGridState();
}

export async function saveActiveSlotShader() {
  if (state.activeGridSlot === null) {
    setStatus('No slot selected', 'error');
    return;
  }

  const slotData = state.gridSlots[state.activeGridSlot];
  if (!slotData) {
    setStatus('No content in active slot', 'error');
    return;
  }

  const code = state.editor.getValue();
  const isScene = slotData.type === 'scene';

  // Update the slot's code
  slotData.shaderCode = code;

  // Also update the renderer/snapshot in the slot
  try {
    if (isScene) {
      // For scenes, re-render the snapshot
      const sceneRenderer = await ensureSceneRenderer();
      if (sceneRenderer) {
        sceneRenderer.reinitialize();
        sceneRenderer.compile(code);
        sceneRenderer.resetTime();
        sceneRenderer.render();

        // Update the slot canvas with new snapshot
        const slot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
        const canvas = slot.querySelector('canvas');
        const mainCanvas = document.getElementById('shader-canvas');
        const ctx = canvas.getContext('2d');
        ctx.drawImage(mainCanvas, 0, 0, mainCanvas.width, mainCanvas.height, 0, 0, canvas.width, canvas.height);
      }
    } else {
      // For shaders, recompile the mini renderer
      if (slotData.renderer) {
        slotData.renderer.compile(code);
      }
    }
  } catch (err) {
    // Don't fail the save if compilation fails
    console.warn(`${isScene ? 'Scene' : 'Shader'} compilation warning:`, err.message);
  }

  // Save to file
  const result = await window.electronAPI.saveShaderToSlot(state.activeGridSlot, code);
  const typeLabel = isScene ? 'Scene' : 'Shader';
  if (result.success) {
    setStatus(`${typeLabel} saved to slot ${state.activeGridSlot + 1}`, 'success');
  } else {
    setStatus(`Failed to save ${typeLabel.toLowerCase()}: ${result.error}`, 'error');
  }
}

export function updateSaveButtonState() {
  const btnSaveShader = document.getElementById('btn-save-shader');
  if (state.activeGridSlot !== null && state.gridSlots[state.activeGridSlot]) {
    btnSaveShader.disabled = false;
    btnSaveShader.title = `Save Shader to Slot ${state.activeGridSlot + 1} (Ctrl+S)`;
  } else {
    btnSaveShader.disabled = true;
    btnSaveShader.title = 'Save Shader to Active Slot (select a slot first)';
  }
}

export function saveGridState() {
  // Save all tabs with embedded shader code
  const tabsState = state.shaderTabs.map(tab => {
    if (tab.type === 'mix') {
      return {
        name: tab.name,
        type: 'mix',
        mixPresets: (tab.mixPresets || []).map(preset => ({
          name: preset.name,
          blendMode: preset.blendMode,
          thumbnail: preset.thumbnail || null,
          channels: preset.channels.map(ch => {
            if (!ch) return null;
            return {
              shaderCode: ch.shaderCode,
              alpha: ch.alpha,
              params: ch.params,
              customParams: ch.customParams || {}
            };
          })
        }))
      };
    }
    return {
      name: tab.name,
      type: tab.type || 'shaders',
      slots: tab.slots.map(slot => {
        if (!slot) return null;
        const saved = {
          shaderCode: slot.shaderCode,
          filePath: slot.filePath,
          params: slot.params,
          customParams: slot.customParams || {},
          presets: slot.presets || [],
          type: slot.type || 'shader'
        };
        if (slot.label) saved.label = slot.label;
        return saved;
      })
    };
  });

  const gridState = {
    version: 2,
    activeTab: state.activeShaderTab,
    activeSection: state.activeSection || 'shaders',
    tabs: tabsState
  };

  window.electronAPI.saveGridState(gridState);
}

export async function loadGridState() {
  const savedState = await window.electronAPI.loadGridState();

  // Handle empty state
  if (!savedState) {
    state.shaderTabs = [{ name: 'My Shaders', slots: [] }];
    state.activeShaderTab = 0;
    state.activeSection = 'shaders';
    state.gridSlots = state.shaderTabs[0].slots;
    rebuildGridDOM();
    return;
  }

  // Check if this is the new tabbed format (version 2) or old array format
  if (savedState.version === 2 && savedState.tabs) {
    // New tabbed format
    await loadTabbedGridState(savedState);
  } else if (Array.isArray(savedState)) {
    // Old format - migrate to new tabbed format
    state.activeSection = 'shaders';
    await loadLegacyGridState(savedState);
  } else {
    // Unknown format, start fresh
    state.shaderTabs = [{ name: 'My Shaders', slots: [] }];
    state.activeShaderTab = 0;
    state.activeSection = 'shaders';
    state.gridSlots = state.shaderTabs[0].slots;
    rebuildGridDOM();
  }
}

// Load new tabbed format
async function loadTabbedGridState(savedState) {
  state.shaderTabs = [];
  let totalLoaded = 0;
  const allFailedSlots = [];

  for (let tabIndex = 0; tabIndex < savedState.tabs.length; tabIndex++) {
    const tabData = savedState.tabs[tabIndex];

    // Handle mix tabs — just load preset data directly
    if (tabData.type === 'mix') {
      const tab = {
        name: tabData.name || `Mixes ${tabIndex + 1}`,
        type: 'mix',
        mixPresets: tabData.mixPresets || []
      };
      state.shaderTabs.push(tab);
      totalLoaded += tab.mixPresets.length;
      continue;
    }

    const tab = { name: tabData.name || `Tab ${tabIndex + 1}`, type: tabData.type || 'shaders', slots: [] };

    // Compact: only keep slots with shader data
    const compactSlots = (tabData.slots || []).filter(s => s && s.shaderCode);

    // Initialize slots array
    tab.slots = new Array(compactSlots.length).fill(null);
    state.shaderTabs.push(tab);

    // Temporarily set as active for loading (so assignShaderToSlot works)
    state.activeShaderTab = tabIndex;
    state.gridSlots = tab.slots;

    // Build DOM for this tab
    rebuildGridDOM();

    // Load shaders into this tab
    for (let i = 0; i < compactSlots.length; i++) {
      const slotData = compactSlots[i];
      try {
        // Detect type from content if not explicitly set (handles legacy data)
        const detectedType = detectRenderMode(slotData.filePath, slotData.shaderCode);
        const isScene = slotData.type === 'scene' || detectedType === 'scene';
        if (isScene) {
          await assignSceneToSlot(i, slotData.shaderCode, slotData.filePath, true, slotData.params, slotData.presets);
        } else {
          await assignShaderToSlot(i, slotData.shaderCode, slotData.filePath, true, slotData.params, slotData.presets, slotData.customParams);
        }
        // Restore custom label if saved
        if (slotData.label && state.gridSlots[i]) {
          state.gridSlots[i].label = slotData.label;
        }
        totalLoaded++;
      } catch (err) {
        assignFailedShaderToSlot(i, slotData.shaderCode, slotData.filePath, slotData);
        allFailedSlots.push(`${tab.name}:${i + 1}`);
        console.warn(`Failed to compile ${tab.name} slot ${i + 1}:`, err.message);
      }
    }
  }

  // If no tabs were loaded, create default
  if (state.shaderTabs.length === 0) {
    state.shaderTabs = [{ name: 'My Shaders', slots: [] }];
  }

  // Restore active section and tab
  state.activeSection = savedState.activeSection || 'shaders';
  state.activeShaderTab = Math.min(savedState.activeTab || 0, state.shaderTabs.length - 1);
  const restoredTab = state.shaderTabs[state.activeShaderTab];
  // Sync section with actual tab type
  state.activeSection = restoredTab.type === 'mix' ? 'mix' : 'shaders';
  state.gridSlots = restoredTab.type === 'mix' ? [] : restoredTab.slots;

  // Rebuild DOM for active tab
  if (restoredTab.type === 'mix') {
    rebuildMixPanelDOM();
  } else {
    rebuildGridDOM();
  }

  if (allFailedSlots.length > 0) {
    setStatus(`Restored ${totalLoaded} items, ${allFailedSlots.length} failed`, 'success');
  } else if (totalLoaded > 0) {
    setStatus(`Restored ${totalLoaded} item${totalLoaded > 1 ? 's' : ''} across ${state.shaderTabs.length} tab${state.shaderTabs.length > 1 ? 's' : ''}`, 'success');
  }
}

// Load old array format and migrate to tabs
async function loadLegacyGridState(gridState) {
  // Only load slots that have actual shader data (compact the array)
  const compactState = [];
  for (let i = 0; i < gridState.length; i++) {
    if (gridState[i] && gridState[i].shaderCode) {
      compactState.push(gridState[i]);
    }
  }

  // Create single "My Shaders" tab with all slots
  state.shaderTabs = [{ name: 'My Shaders', slots: new Array(compactState.length).fill(null) }];
  state.activeShaderTab = 0;
  state.gridSlots = state.shaderTabs[0].slots;

  // Build DOM first so assignShaderToSlot can find the elements
  rebuildGridDOM();

  let loadedCount = 0;
  const failedSlots = [];

  for (let i = 0; i < compactState.length; i++) {
    const slotData = compactState[i];
    try {
      const detectedType = detectRenderMode(slotData.filePath, slotData.shaderCode);
      const isScene = slotData.type === 'scene' || detectedType === 'scene';
      if (isScene) {
        await assignSceneToSlot(i, slotData.shaderCode, slotData.filePath, true, slotData.params, slotData.presets);
      } else {
        await assignShaderToSlot(i, slotData.shaderCode, slotData.filePath, true, slotData.params, slotData.presets, slotData.customParams);
      }
      loadedCount++;
    } catch (err) {
      // Store the shader anyway so user can edit it
      assignFailedShaderToSlot(i, slotData.shaderCode, slotData.filePath, slotData);
      failedSlots.push(i + 1);
      console.warn(`Failed to compile slot ${i + 1}:`, err.message);
    }
  }

  // Save in new format
  saveGridState();

  if (failedSlots.length > 0) {
    setStatus(`Migrated ${loadedCount} items, ${failedSlots.length} failed to compile (slots: ${failedSlots.join(', ')})`, 'success');
  } else if (loadedCount > 0) {
    setStatus(`Migrated ${loadedCount} item${loadedCount > 1 ? 's' : ''} to tabbed format`, 'success');
  }
}

export async function loadGridPresetsFromData(gridState, filePath) {
  if (!gridState || !Array.isArray(gridState)) {
    setStatus('Invalid grid presets file', 'error');
    return;
  }

  // Dispose all existing renderers
  for (let i = 0; i < state.gridSlots.length; i++) {
    if (state.gridSlots[i] && state.gridSlots[i].renderer) {
      if (state.gridSlots[i].renderer.dispose) {
        state.gridSlots[i].renderer.dispose();
      }
    }
  }

  // Compact: only keep entries with shader data
  const compactState = gridState.filter(s => s && s.shaderCode);

  // Reset state
  state.gridSlots = new Array(compactState.length).fill(null);
  state.activeGridSlot = null;
  rebuildGridDOM();

  // Load new presets
  let loadedCount = 0;
  for (let i = 0; i < compactState.length; i++) {
    const slotData = compactState[i];
    try {
      const detectedType = detectRenderMode(slotData.filePath, slotData.shaderCode);
      const isScene = slotData.type === 'scene' || detectedType === 'scene';
      if (isScene) {
        await assignSceneToSlot(i, slotData.shaderCode, slotData.filePath, true, slotData.params, slotData.presets);
      } else {
        await assignShaderToSlot(i, slotData.shaderCode, slotData.filePath, true, slotData.params, slotData.presets, slotData.customParams);
      }
      loadedCount++;
    } catch (err) {
      console.warn(`Failed to load ${slotData.type || 'shader'} in slot ${i + 1}:`, err);
    }
  }

  const fileName = filePath.split('/').pop().split('\\').pop();
  if (loadedCount > 0) {
    setStatus(`Loaded ${loadedCount} shader${loadedCount > 1 ? 's' : ''} from ${fileName}`, 'success');
    // Save as current state
    await resaveAllShaderFiles();
    saveGridState();
  } else {
    setStatus(`No valid shaders found in ${fileName}`, 'error');
  }
}

export async function loadGridShaderToEditor(slotIndex) {
  const slotData = state.gridSlots[slotIndex];
  if (!slotData) return;

  // Clear previous active slot highlight
  if (state.activeGridSlot !== null) {
    const prevSlot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
    if (prevSlot) prevSlot.classList.remove('active');
  }

  // Set new active slot
  state.activeGridSlot = slotIndex;
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  slot.classList.add('active');

  // Determine type and title (detect from content as fallback)
  const detectedType = detectRenderMode(slotData.filePath, slotData.shaderCode);
  const isScene = slotData.type === 'scene' || detectedType === 'scene';
  if (isScene && slotData.type !== 'scene') slotData.type = 'scene';
  const slotName = slotData.filePath ? slotData.filePath.split('/').pop().split('\\').pop() : `Slot ${slotIndex + 1}`;
  const typeLabel = isScene ? 'scene' : 'shader';

  // Open in a new tab (or activate existing tab for this slot)
  openInTab({
    content: slotData.shaderCode,
    filePath: slotData.filePath,
    type: isScene ? 'scene' : 'shader',
    title: slotName,
    slotIndex: slotIndex,
    activate: true
  });

  // Load saved custom param values if available (after tab is activated and compiled)
  setTimeout(() => {
    if (slotData.customParams && !isScene) {
      state.renderer.setCustomParamValues(slotData.customParams);
      generateCustomParamUI(); // Regenerate UI to reflect loaded values
    }
  }, 100);

  // Load speed to slider if present
  if (slotData.params) {
    loadParamsToSliders(slotData.params);
  }

  // Update local presets UI for this shader
  updateLocalPresetsUI();

  // Update save button state
  updateSaveButtonState();

  setStatus(`Editing ${slotName} (${typeLabel} slot ${slotIndex + 1})`, 'success');
}

// Select a grid slot: load shader into preview and show its parameters (single click behavior)
export async function selectGridSlot(slotIndex) {
  const slotData = state.gridSlots[slotIndex];
  if (!slotData) return;

  // If this slot is assigned to a mixer channel, select that channel instead of clearing
  const mixerBtns = document.querySelectorAll('#mixer-panel .mixer-btn');
  let foundMixerCh = false;
  for (let i = 0; i < state.mixerChannels.length; i++) {
    const ch = state.mixerChannels[i];
    if (ch.slotIndex === slotIndex && ch.tabIndex === state.activeShaderTab) {
      // Import selectMixerChannel via the exported function from mixer.js
      state.mixerSelectedChannel = i;
      mixerBtns.forEach(b => b.classList.remove('selected'));
      mixerBtns[i]?.classList.add('selected');
      foundMixerCh = true;
      break;
    }
  }
  if (!foundMixerCh) {
    state.mixerSelectedChannel = null;
    mixerBtns.forEach(b => b.classList.remove('selected'));
  }

  // Clear previous active slot highlight
  if (state.activeGridSlot !== null) {
    const prevSlot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
    if (prevSlot) prevSlot.classList.remove('active');
  }

  // Set active slot
  state.activeGridSlot = slotIndex;
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  if (slot) slot.classList.add('active');

  const isScene = slotData.type === 'scene';
  const slotName = slotData.filePath ? slotData.filePath.split('/').pop().split('\\').pop() : `Slot ${slotIndex + 1}`;

  // Switch render mode if needed
  if (isScene) {
    await setRenderMode('scene');
  } else {
    await setRenderMode('shader');
  }

  // Always compile the shader to state.renderer so we can read @param definitions
  // and generate the correct parameter UI
  try {
    state.renderer.compile(slotData.shaderCode);
  } catch (err) {
    console.warn(`Failed to compile for preview:`, err.message);
  }

  // If tiled preview is enabled, also assign shader to selected tile
  if (state.tiledPreviewEnabled) {
    assignShaderToTile(slotIndex, state.selectedTileIndex);
  }

  // Load params to sliders (works for both tiled and non-tiled mode)
  if (slotData.params) {
    loadParamsToSliders(slotData.params);
  }

  // Load custom params if available
  if (slotData.customParams && !isScene) {
    // Load to main renderer
    if (state.renderer?.setCustomParamValues) {
      state.renderer.setCustomParamValues(slotData.customParams);
    }
    // Also load to MiniShaderRenderer for tiled preview
    if (slotData.renderer?.setParams) {
      slotData.renderer.setParams(slotData.customParams);
    }
  }

  // Regenerate custom param UI based on the shader's @param definitions
  generateCustomParamUI();

  // Update local presets UI for this shader
  updateLocalPresetsUI();

  // Update save button state
  updateSaveButtonState();

  // Sync to fullscreen window if open
  const allParams = {
    ...(slotData.params || {}),
    ...(slotData.customParams || state.renderer.getCustomParamValues?.() || {})
  };

  if (state.tiledPreviewEnabled) {
    // In tiled mode, update the specific tile
    if (window.electronAPI.assignTileShader) {
      window.electronAPI.assignTileShader(state.selectedTileIndex, slotIndex, slotData.shaderCode, allParams);
    }
  } else {
    // In normal mode, update the main fullscreen
    window.electronAPI.sendShaderUpdate({
      shaderCode: slotData.shaderCode,
      renderMode: isScene ? 'scene' : 'shader',
      params: allParams
    });

    if (window.electronAPI.sendBatchParamUpdate) {
      window.electronAPI.sendBatchParamUpdate(allParams);
    }
  }

  const tileInfo = state.tiledPreviewEnabled ? ` -> tile ${state.selectedTileIndex + 1}` : '';
  setStatus(`Playing ${slotName} (slot ${slotIndex + 1}${tileInfo})`, 'success');
  notifyRemoteStateChanged();
}

export function playGridShader(slotIndex) {
  const slotData = state.gridSlots[slotIndex];
  if (!slotData) return;

  // If tiled preview is enabled, assign to selected tile instead
  if (state.tiledPreviewEnabled) {
    assignShaderToTile(slotIndex, state.selectedTileIndex);
    return;
  }

  // Clear previous active slot highlight
  if (state.activeGridSlot !== null) {
    const prevSlot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
    if (prevSlot) prevSlot.classList.remove('active');
  }

  // Set active slot
  state.activeGridSlot = slotIndex;
  const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
  if (slot) slot.classList.add('active');

  // Check if this is a scene (detect from content as fallback)
  const detectedType = detectRenderMode(slotData.filePath, slotData.shaderCode);
  const isScene = slotData.type === 'scene' || detectedType === 'scene';
  if (isScene && slotData.type !== 'scene') slotData.type = 'scene';
  const slotName = slotData.filePath ? slotData.filePath.split('/').pop().split('\\').pop() : `Slot ${slotIndex + 1}`;

  // Open in a new tab (or activate existing tab for this slot)
  openInTab({
    content: slotData.shaderCode,
    filePath: slotData.filePath,
    type: isScene ? 'scene' : 'shader',
    title: slotName,
    slotIndex: slotIndex,
    activate: true
  });

  // Load speed to slider if present
  if (slotData.params) {
    loadParamsToSliders(slotData.params);
  }

  // Update local presets UI for this shader
  updateLocalPresetsUI();

  // Update save button state
  updateSaveButtonState();

  // Load saved custom param values if available (after tab is activated)
  setTimeout(() => {
    if (slotData.customParams && !isScene) {
      state.renderer.setCustomParamValues(slotData.customParams);
      generateCustomParamUI(); // Regenerate to reflect loaded values
    }
  }, 100);

  // Batch all params for fullscreen to reduce IPC overhead
  const allParams = {
    ...(slotData.params || {}),
    ...(slotData.customParams || state.renderer.getCustomParamValues())
  };

  // Send to fullscreen window (if open) with all params included
  const fullscreenState = {
    shaderCode: slotData.shaderCode,
    time: 0,
    frame: 0,
    isPlaying: true,
    channels: state.channelState,
    params: allParams,
    renderMode: isScene ? 'scene' : 'shader'
  };
  window.electronAPI.sendShaderUpdate(fullscreenState);
  window.electronAPI.sendTimeSync({ time: 0, frame: 0, isPlaying: true });

  // Send batched params in single IPC call (fullscreen will apply them from the state above,
  // but we also send individually for any param listeners that expect per-param updates)
  // Use a single batch call if available, otherwise fall back to individual calls
  if (window.electronAPI.sendBatchParamUpdate) {
    window.electronAPI.sendBatchParamUpdate(allParams);
  } else {
    // Fall back to individual calls for backwards compatibility
    Object.entries(allParams).forEach(([name, value]) => {
      window.electronAPI.sendParamUpdate({ name, value });
    });
  }

  const typeLabel = isScene ? 'scene' : 'shader';
  setStatus(`Playing ${typeLabel}: ${slotName}`, 'success');
}

// Re-save all shader files with current indices (after removing/compacting slots)
async function resaveAllShaderFiles() {
  // Collect all slots across all tabs with their global indices
  let totalSlots = 0;
  const allSlots = [];
  for (const tab of (state.shaderTabs || [])) {
    for (let i = 0; i < (tab.slots || []).length; i++) {
      allSlots.push({ globalIndex: totalSlots, slot: tab.slots[i] });
      totalSlots++;
    }
  }

  // Delete files at all indices up to a generous upper bound
  const maxIndex = Math.max(totalSlots + 50, 100);
  const deletePromises = [];
  for (let i = 0; i < maxIndex; i++) {
    deletePromises.push(window.electronAPI.deleteShaderFromSlot(i));
  }
  await Promise.all(deletePromises);

  // Save all tabs' shader files in parallel using global indices
  const savePromises = [];
  for (const { globalIndex, slot } of allSlots) {
    if (slot && slot.shaderCode) {
      savePromises.push(window.electronAPI.saveShaderToSlot(globalIndex, slot.shaderCode));
    }
  }
  await Promise.all(savePromises);
}

// Grid animation frame rate limiting (10fps = 100ms interval)
const GRID_FRAME_INTERVAL = 100;

// Track which slots are visible using IntersectionObserver
const visibleSlots = new Set();
let gridIntersectionObserver = null;

// Cleanup IntersectionObserver
function cleanupGridVisibilityObserver() {
  if (gridIntersectionObserver) {
    gridIntersectionObserver.disconnect();
    gridIntersectionObserver = null;
  }
  visibleSlots.clear();
}

function initGridVisibilityObserver() {
  // Cleanup existing observer first
  cleanupGridVisibilityObserver();

  gridIntersectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const slotIndex = parseInt(entry.target.dataset.slot, 10);
      if (entry.isIntersecting) {
        visibleSlots.add(slotIndex);
      } else {
        visibleSlots.delete(slotIndex);
      }
    });
  }, {
    root: document.getElementById('grid-panel'),
    threshold: 0.1 // Consider visible if at least 10% is showing
  });

  // Observe all grid slots (exclude the add button)
  document.querySelectorAll('.grid-slot:not(.grid-add-btn)').forEach(slot => {
    gridIntersectionObserver.observe(slot);
  });
}

export function startGridAnimation() {
  if (state.gridAnimationId) return;

  // Initialize visibility observer if not already done
  initGridVisibilityObserver();

  // Use setTimeout instead of RAF for 10fps - more efficient since we don't need 60fps callbacks
  function animateGrid() {
    // Skip rendering if grid panel is not visible (hidden via UI toggle)
    // This prevents wasted GPU work when grid is collapsed
    if (!state.gridEnabled) {
      // Keep the timer running but don't render - will resume when grid shown
      state.gridAnimationId = setTimeout(animateGrid, GRID_FRAME_INTERVAL);
      return;
    }

    // Only render slots that are currently visible (via IntersectionObserver)
    for (const slotIndex of visibleSlots) {
      const slot = state.gridSlots[slotIndex];
      if (slot && slot.renderer) {
        slot.renderer.setSpeed(slot.params?.speed ?? 1);
        slot.renderer.render();
      }
    }

    // Schedule next frame at 10fps interval
    state.gridAnimationId = setTimeout(animateGrid, GRID_FRAME_INTERVAL);
  }

  // Start the animation loop
  animateGrid();
}

export function stopGridAnimation() {
  if (state.gridAnimationId) {
    clearTimeout(state.gridAnimationId);
    state.gridAnimationId = null;
  }
}

// Shared WebGL context for all MiniShaderRenderers
// This avoids the "too many WebGL contexts" browser limit
let sharedGLCanvas = null;
let sharedGL = null;
let sharedVAO = null;

function getSharedGL() {
  if (!sharedGL) {
    sharedGLCanvas = document.createElement('canvas');
    sharedGLCanvas.width = 160;
    sharedGLCanvas.height = 90;
    sharedGL = sharedGLCanvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true
    });

    if (!sharedGL) {
      console.error('Failed to create shared WebGL2 context');
      return null;
    }

    // Setup shared geometry (full-screen quad)
    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const vbo = sharedGL.createBuffer();
    sharedGL.bindBuffer(sharedGL.ARRAY_BUFFER, vbo);
    sharedGL.bufferData(sharedGL.ARRAY_BUFFER, vertices, sharedGL.STATIC_DRAW);

    sharedVAO = sharedGL.createVertexArray();
    sharedGL.bindVertexArray(sharedVAO);
    sharedGL.enableVertexAttribArray(0);
    sharedGL.vertexAttribPointer(0, 2, sharedGL.FLOAT, false, 0, 0);

    // Handle context loss on shared canvas
    sharedGLCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('Shared WebGL context lost');
    });

    sharedGLCanvas.addEventListener('webglcontextrestored', () => {
      console.log('Shared WebGL context restored');
      // Reinitialize geometry
      const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
      const vbo = sharedGL.createBuffer();
      sharedGL.bindBuffer(sharedGL.ARRAY_BUFFER, vbo);
      sharedGL.bufferData(sharedGL.ARRAY_BUFFER, vertices, sharedGL.STATIC_DRAW);
      sharedVAO = sharedGL.createVertexArray();
      sharedGL.bindVertexArray(sharedVAO);
      sharedGL.enableVertexAttribArray(0);
      sharedGL.vertexAttribPointer(0, 2, sharedGL.FLOAT, false, 0, 0);
    });
  }
  return sharedGL;
}

// Built-in noise texture specs for @texture directives
const MINI_BUILTIN_TEXTURES = {
  RGBANoise:      { width: 256, height: 256, gray: false },
  RGBANoiseSmall: { width: 64,  height: 64,  gray: false },
  GrayNoise:      { width: 256, height: 256, gray: true },
  GrayNoiseSmall: { width: 64,  height: 64,  gray: true }
};

// Create a new GL texture with unique random noise data (each shader gets its own)
function createMiniBuiltinTexture(gl, name) {
  const spec = MINI_BUILTIN_TEXTURES[name];
  if (!spec) return null;

  const { width, height, gray } = spec;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const off = i * 4;
    if (gray) {
      const v = Math.floor(Math.random() * 256);
      data[off] = data[off + 1] = data[off + 2] = v;
    } else {
      data[off]     = Math.floor(Math.random() * 256);
      data[off + 1] = Math.floor(Math.random() * 256);
      data[off + 2] = Math.floor(Math.random() * 256);
    }
    data[off + 3] = 255;
  }

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

  return { texture, width, height };
}

// Mini shader renderer for grid previews - uses shared WebGL context
export class MiniShaderRenderer {
  constructor(canvas) {
    this.canvas = canvas;  // Display canvas (will use 2D context to copy from shared)
    this.ctx2d = canvas.getContext('2d');  // 2D context for copying rendered result
    this.gl = getSharedGL();  // Use shared WebGL context
    this.contextValid = !!this.gl;

    if (!this.gl) {
      console.warn('Shared WebGL context not available');
      return;
    }

    this.program = null;
    this.startTime = performance.now();
    this.uniforms = {};
    this.speed = 1.0;

    // Built-in texture assignments (from @texture directives)
    this.channelTextures = [null, null, null, null];
    this.channelResolutions = [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]];
    this._channelResArray = new Float32Array(12);

    // Pre-allocated buffers with default values (for backward compatibility)
    this._colorArray = new Float32Array(30).fill(1.0);  // 10 colors * 3 components, all white
    this._paramsArray = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5]);  // 5 params at 0.5

    // Custom param values storage
    this.customParamValues = {};
  }

  setSpeed(speed) {
    this.speed = speed;
  }

  // Set resolution (resize display canvas)
  setResolution(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      // Update 2D context after resize
      this.ctx2d = this.canvas.getContext('2d');
    }
  }

  // Get current resolution
  getResolution() {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  // Resize shared canvas to match target resolution for rendering
  _resizeSharedCanvas(width, height) {
    if (sharedGLCanvas && (sharedGLCanvas.width !== width || sharedGLCanvas.height !== height)) {
      sharedGLCanvas.width = width;
      sharedGLCanvas.height = height;
    }
  }

  // Ensure shared canvas is at least the given size (for tiled preview batching)
  static ensureSharedCanvasSize(width, height) {
    if (!sharedGLCanvas) {
      getSharedGL();  // Initialize if needed
    }
    if (sharedGLCanvas) {
      // Only resize if current size is smaller (avoid thrashing)
      if (sharedGLCanvas.width < width || sharedGLCanvas.height < height) {
        sharedGLCanvas.width = Math.max(sharedGLCanvas.width, width);
        sharedGLCanvas.height = Math.max(sharedGLCanvas.height, height);
      }
    }
  }

  // Get the shared canvas for direct access
  static getSharedCanvas() {
    if (!sharedGLCanvas) {
      getSharedGL();
    }
    return sharedGLCanvas;
  }

  // Set a custom parameter value
  setParam(name, value) {
    if (name === 'speed') {
      this.setSpeed(value);
    } else {
      this.customParamValues[name] = value;
    }
  }

  // Set multiple parameters at once
  setParams(params) {
    if (!params) return;
    Object.entries(params).forEach(([name, value]) => {
      this.setParam(name, value);
    });
  }

  // Reset custom params to shader defaults (call before applying tile-specific params)
  resetCustomParams() {
    this.customParamValues = {};
  }

  compile(fragmentSource) {
    // Check if context is valid
    if (!this.contextValid || !this.gl) {
      throw new Error('WebGL context not available');
    }

    const gl = this.gl;

    // Parse custom @param comments and generate uniform declarations
    const customParams = parseShaderParams(fragmentSource);
    const customUniformDecls = generateUniformDeclarations(customParams);

    const vertexSource = `#version 300 es
      layout(location = 0) in vec2 position;
      void main() { gl_Position = vec4(position, 0.0, 1.0); }
    `;

    const wrappedFragment = `#version 300 es
      precision highp float;
      uniform vec3 iResolution;
      uniform float iTime;
      uniform vec4 iMouse;
      uniform sampler2D iChannel0, iChannel1, iChannel2, iChannel3;
      uniform vec3 iChannelResolution[4];
      uniform float iTimeDelta;
      uniform int iFrame;
      uniform vec4 iDate;
      uniform vec3 iColorRGB[10];
      uniform float iParams[5];
      uniform float iSpeed;
      ${customUniformDecls}
      out vec4 outColor;
      ${fragmentSource}
      void main() { mainImage(outColor, gl_FragCoord.xy); }
    `;

    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    if (!vertexShader) {
      throw new Error('Failed to create vertex shader - WebGL context may be lost');
    }
    gl.shaderSource(vertexShader, vertexSource);
    gl.compileShader(vertexShader);

    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(vertexShader);
      gl.deleteShader(vertexShader);
      throw new Error(error);
    }

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    if (!fragmentShader) {
      gl.deleteShader(vertexShader);
      throw new Error('Failed to create fragment shader - WebGL context may be lost');
    }
    gl.shaderSource(fragmentShader, wrappedFragment);
    gl.compileShader(fragmentShader);

    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(fragmentShader);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      throw new Error(error);
    }

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const err = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(err);
    }

    if (this.program) gl.deleteProgram(this.program);
    this.program = program;

    this.uniforms = {
      iResolution: gl.getUniformLocation(program, 'iResolution'),
      iTime: gl.getUniformLocation(program, 'iTime'),
      iColorRGB: gl.getUniformLocation(program, 'iColorRGB'),
      iParams: gl.getUniformLocation(program, 'iParams'),
      iSpeed: gl.getUniformLocation(program, 'iSpeed'),
      iChannel0: gl.getUniformLocation(program, 'iChannel0'),
      iChannel1: gl.getUniformLocation(program, 'iChannel1'),
      iChannel2: gl.getUniformLocation(program, 'iChannel2'),
      iChannel3: gl.getUniformLocation(program, 'iChannel3'),
      iChannelResolution: gl.getUniformLocation(program, 'iChannelResolution')
    };

    // Store custom params and their uniform locations
    this.customParams = customParams;
    this.customUniformLocations = {};
    for (const param of customParams) {
      if (param.isArray) {
        this.customUniformLocations[param.name] = [];
        for (let i = 0; i < param.arraySize; i++) {
          this.customUniformLocations[param.name][i] = gl.getUniformLocation(program, `${param.name}[${i}]`);
        }
      } else {
        this.customUniformLocations[param.name] = gl.getUniformLocation(program, param.name);
      }
    }

    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    // Clean up old builtin textures before creating new ones
    for (let i = 0; i < 4; i++) {
      if (this.channelTextures[i]) {
        gl.deleteTexture(this.channelTextures[i]);
        this.channelTextures[i] = null;
        this.channelResolutions[i] = [0, 0, 1];
      }
    }

    // Parse @texture directives and separate builtin vs file
    const allDirectives = parseTextureDirectives(fragmentSource);
    const builtinDirectives = allDirectives.filter(d => d.type === 'builtin');
    this.fileTextureDirectives = allDirectives.filter(d => d.type === 'file');

    // Apply builtin noise textures (each shader gets unique noise)
    for (const { channel, textureName } of builtinDirectives) {
      const entry = createMiniBuiltinTexture(gl, textureName);
      if (entry) {
        this.channelTextures[channel] = entry.texture;
        this.channelResolutions[channel] = [entry.width, entry.height, 1];
      }
    }
  }

  // Load a file texture into a channel from a data URL
  loadFileTexture(channel, dataUrl) {
    return new Promise((resolve, reject) => {
      const gl = this.gl;
      if (!gl || !this.contextValid) {
        reject(new Error('WebGL context not available'));
        return;
      }
      const img = new Image();
      img.onload = () => {
        // Delete old texture for this channel
        if (this.channelTextures[channel]) {
          gl.deleteTexture(this.channelTextures[channel]);
        }
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        this.channelTextures[channel] = texture;
        this.channelResolutions[channel] = [img.width, img.height, 1];
        resolve({ width: img.width, height: img.height });
      };
      img.onerror = () => reject(new Error('Failed to load texture image'));
      img.src = dataUrl;
    });
  }

  render() {
    if (!this.program || !this.contextValid || !this.gl || !sharedGLCanvas) return;

    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;

    // Resize shared canvas to match display canvas
    this._resizeSharedCanvas(width, height);

    // Render using internal method
    this._renderInternal(gl, width, height);

    // Copy rendered result from shared canvas to display canvas
    if (this.ctx2d) {
      this.ctx2d.drawImage(sharedGLCanvas, 0, 0, width, height);
    }
  }

  // Render directly to a target 2D context at specified position
  // This avoids canvas resizing and reduces GPU->CPU syncs for tiled preview
  renderDirect(targetCtx, destX, destY, destWidth, destHeight) {
    if (!this.program || !this.contextValid || !this.gl || !sharedGLCanvas) return;

    const gl = this.gl;

    // Use viewport to render at destination size without resizing shared canvas
    // The shared canvas should already be sized large enough
    gl.viewport(0, 0, destWidth, destHeight);

    // Render using internal method
    this._renderInternal(gl, destWidth, destHeight);

    // Copy from shared canvas to target context at destination position
    // Source rect is bottom-left of shared canvas at destWidth x destHeight
    targetCtx.drawImage(
      sharedGLCanvas,
      0, sharedGLCanvas.height - destHeight, destWidth, destHeight,  // Source rect
      destX, destY, destWidth, destHeight  // Dest rect
    );
  }

  // Internal render method - sets uniforms and draws
  _renderInternal(gl, width, height) {
    const time = (performance.now() - this.startTime) / 1000 * this.speed;

    gl.useProgram(this.program);

    gl.uniform3f(this.uniforms.iResolution, width, height, 1);
    gl.uniform1f(this.uniforms.iTime, time);

    // Use pre-allocated arrays with default values (for backward compatibility)
    gl.uniform3fv(this.uniforms.iColorRGB, this._colorArray);
    gl.uniform1fv(this.uniforms.iParams, this._paramsArray);
    gl.uniform1f(this.uniforms.iSpeed, this.speed);

    // Set custom param uniforms (use stored value or default)
    for (const param of this.customParams || []) {
      const loc = this.customUniformLocations[param.name];
      if (loc === null || loc === undefined) continue;

      // Use stored value if available, otherwise use default
      const value = this.customParamValues[param.name] !== undefined
        ? this.customParamValues[param.name]
        : param.default;

      if (param.isArray) {
        for (let i = 0; i < param.arraySize; i++) {
          const elemLoc = loc[i];
          if (elemLoc === null) continue;
          const elemValue = value[i];
          switch (param.glslBaseType) {
            case 'float':
              gl.uniform1f(elemLoc, elemValue);
              break;
            case 'int':
              gl.uniform1i(elemLoc, elemValue);
              break;
            case 'vec2':
              gl.uniform2fv(elemLoc, Array.isArray(elemValue) ? elemValue : [elemValue, elemValue]);
              break;
            case 'vec3':
              gl.uniform3fv(elemLoc, Array.isArray(elemValue) ? elemValue : [elemValue, elemValue, elemValue]);
              break;
            case 'vec4':
              gl.uniform4fv(elemLoc, Array.isArray(elemValue) ? elemValue : [elemValue, elemValue, elemValue, elemValue]);
              break;
          }
        }
      } else {
        switch (param.glslBaseType) {
          case 'float':
            gl.uniform1f(loc, value);
            break;
          case 'int':
            gl.uniform1i(loc, value);
            break;
          case 'vec2':
            gl.uniform2fv(loc, Array.isArray(value) ? value : [value, value]);
            break;
          case 'vec3':
            gl.uniform3fv(loc, Array.isArray(value) ? value : [value, value, value]);
            break;
          case 'vec4':
            gl.uniform4fv(loc, Array.isArray(value) ? value : [value, value, value, value]);
            break;
        }
      }
    }

    // Bind built-in textures from @texture directives
    let hasTextures = false;
    for (let i = 0; i < 4; i++) {
      if (this.channelTextures[i]) {
        hasTextures = true;
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, this.channelTextures[i]);
        gl.uniform1i(this.uniforms[`iChannel${i}`], i);
      }
    }
    if (hasTextures && this.uniforms.iChannelResolution) {
      for (let i = 0; i < 4; i++) {
        this._channelResArray[i * 3]     = this.channelResolutions[i][0];
        this._channelResArray[i * 3 + 1] = this.channelResolutions[i][1];
        this._channelResArray[i * 3 + 2] = this.channelResolutions[i][2];
      }
      gl.uniform3fv(this.uniforms.iChannelResolution, this._channelResArray);
    }

    // Use shared VAO and draw
    gl.bindVertexArray(sharedVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Dispose WebGL resources to prevent memory leaks
  dispose() {
    const gl = this.gl;
    if (!gl) return;

    // Only delete the program, not the shared VAO
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }

    this.contextValid = false;
    // Note: VAO is shared, don't delete it

    this.uniforms = {};
    this.customUniformLocations = {};
    this.customParams = [];
    // Delete per-instance builtin textures
    for (let i = 0; i < 4; i++) {
      if (this.channelTextures[i] && gl) {
        gl.deleteTexture(this.channelTextures[i]);
      }
    }
    this.channelTextures = [null, null, null, null];
    this.channelResolutions = [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]];
  }
}
