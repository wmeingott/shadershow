// Editor Tabs Module
import { state } from './state.js';

// Tab state
let tabs = [];
let activeTabId = null;
let tabIdCounter = 0;

// Get tabs container
function getTabsContainer() {
  return document.getElementById('editor-tabs');
}

// Generate unique tab ID
function generateTabId() {
  return `tab-${++tabIdCounter}`;
}

// Get file name from path
function getFileName(filePath) {
  if (!filePath) return null;
  return filePath.split('/').pop().split('\\').pop();
}

// Determine icon for tab based on type
function getTabIcon(type) {
  return type === 'scene' ? '🎲' : '📄';
}

// Create a new tab
export function createTab(options = {}) {
  const {
    content = '',
    filePath = null,
    type = 'shader',  // 'shader' or 'scene'
    title = null,
    slotIndex = null,  // If loaded from a grid slot
    activate = true
  } = options;

  const id = generateTabId();
  const fileName = getFileName(filePath);
  const displayTitle = title || fileName || (type === 'scene' ? 'Untitled Scene' : 'Untitled Shader');

  // Create Ace EditSession for this tab
  const session = ace.createEditSession(content, type === 'scene' ? 'ace/mode/javascript' : 'ace/mode/glsl');
  session.setUseWrapMode(false);
  session.setTabSize(2);
  session.setUseSoftTabs(true);

  const tab = {
    id,
    title: displayTitle,
    filePath,
    type,
    slotIndex,
    session,
    savedContent: content,  // Track saved state for modified indicator
  };

  tabs.push(tab);
  renderTabs();

  if (activate) {
    activateTab(id);
  }

  return tab;
}

// Render all tabs
function renderTabs() {
  const container = getTabsContainer();
  container.innerHTML = '';

  tabs.forEach(tab => {
    const tabEl = document.createElement('div');
    tabEl.className = 'editor-tab';
    tabEl.dataset.tabId = tab.id;

    if (tab.id === activeTabId) {
      tabEl.classList.add('active');
    }

    // Check if modified
    const currentContent = tab.session.getValue();
    if (currentContent !== tab.savedContent) {
      tabEl.classList.add('modified');
    }

    // Icon
    const iconEl = document.createElement('span');
    iconEl.className = 'tab-icon';
    iconEl.textContent = getTabIcon(tab.type);
    tabEl.appendChild(iconEl);

    // Title
    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = tab.title;
    titleEl.title = tab.filePath || tab.title;
    tabEl.appendChild(titleEl);

    // Close button
    const closeEl = document.createElement('button');
    closeEl.className = 'tab-close';
    closeEl.innerHTML = '×';
    closeEl.title = 'Close tab';
    closeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    tabEl.appendChild(closeEl);

    // Click to activate
    tabEl.addEventListener('click', () => {
      activateTab(tab.id);
    });

    container.appendChild(tabEl);
  });
}

// Activate a tab
export function activateTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  activeTabId = tabId;

  // Set the editor session
  state.editor.setSession(tab.session);

  // Store the tab type in state for other modules to use
  state.activeTabType = tab.type;

  // Dispatch event for other modules to handle mode switching and compilation
  window.dispatchEvent(new CustomEvent('tab-activated', {
    detail: { tabId, type: tab.type }
  }));

  // Update tab styling
  renderTabs();
}

// Close a tab
export function closeTab(tabId) {
  const tabIndex = tabs.findIndex(t => t.id === tabId);
  if (tabIndex === -1) return;

  const tab = tabs[tabIndex];

  // Check for unsaved changes
  const currentContent = tab.session.getValue();
  if (currentContent !== tab.savedContent) {
    // For now, just close without prompting
    // Could add a confirmation dialog here
  }

  // Remove the tab
  tabs.splice(tabIndex, 1);

  // If this was the active tab, activate another
  if (activeTabId === tabId) {
    if (tabs.length > 0) {
      // Activate the tab to the left, or the first tab
      const newIndex = Math.max(0, tabIndex - 1);
      activateTab(tabs[newIndex].id);
    } else {
      // No tabs left, create a new empty one
      createTab({ type: 'shader' });
    }
  } else {
    renderTabs();
  }
}

// Get the active tab
export function getActiveTab() {
  return tabs.find(t => t.id === activeTabId);
}

// Update tab title
export function updateTabTitle(tabId, title) {
  const tab = tabs.find(t => t.id === tabId);
  if (tab) {
    tab.title = title;
    renderTabs();
  }
}

// Update tab file path
export function updateTabFilePath(tabId, filePath) {
  const tab = tabs.find(t => t.id === tabId);
  if (tab) {
    tab.filePath = filePath;
    tab.title = getFileName(filePath) || tab.title;
    renderTabs();
  }
}

// Mark tab as saved
export function markTabSaved(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (tab) {
    tab.savedContent = tab.session.getValue();
    renderTabs();
  }
}

// Check if active tab has unsaved changes
export function activeTabHasChanges() {
  const tab = getActiveTab();
  if (!tab) return false;
  return tab.session.getValue() !== tab.savedContent;
}

// Find tab by file path
export function findTabByFilePath(filePath) {
  return tabs.find(t => t.filePath === filePath);
}

// Find tab by slot index
export function findTabBySlotIndex(slotIndex) {
  return tabs.find(t => t.slotIndex === slotIndex);
}

// Open file in new tab or activate existing
export function openInTab(options) {
  const { filePath, slotIndex } = options;

  // Check if already open
  let existingTab = null;
  if (filePath) {
    existingTab = findTabByFilePath(filePath);
  } else if (slotIndex !== undefined && slotIndex !== null) {
    existingTab = findTabBySlotIndex(slotIndex);
  }

  if (existingTab) {
    // Update content if needed and activate
    if (options.content !== undefined) {
      existingTab.session.setValue(options.content);
      existingTab.savedContent = options.content;
      existingTab.type = options.type || existingTab.type;
    }
    activateTab(existingTab.id);
    return existingTab;
  }

  // Create new tab
  return createTab(options);
}

// Initialize tabs system
export async function initTabs() {
  // Listen for content changes to update modified indicator
  state.editor.on('change', () => {
    // Debounce the render
    clearTimeout(window._tabRenderTimeout);
    window._tabRenderTimeout = setTimeout(() => {
      renderTabs();
    }, 100);
  });

  // Create initial tab with default shader
  const defaultShader = await window.electronAPI.getDefaultShader();
  createTab({
    content: defaultShader,
    type: 'shader',
    title: 'Untitled Shader'
  });
}

// Get all tabs (for debugging/state inspection)
export function getAllTabs() {
  return tabs;
}
