// Editor Tabs Module — manages shader/scene tabs in the Ace editor.
// Typed version of js/tabs.js.

import { state } from '../core/state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Ambient type for the Ace editor library (loaded globally). */
declare const ace: {
  createEditSession(content: string, mode: string): AceEditSession;
};

/** Minimal Ace EditSession surface used by this module. */
interface AceEditSession {
  getValue(): string;
  setValue(content: string): void;
  setUseWrapMode(wrap: boolean): void;
  setTabSize(size: number): void;
  setUseSoftTabs(soft: boolean): void;
  setMode(mode: string): void;
}

/** Minimal Ace Editor surface used by this module. */
interface AceEditor {
  setSession(session: AceEditSession): void;
  on(event: string, handler: () => void): void;
}

declare const window: Window & {
  electronAPI: {
    getDefaultShader: () => Promise<string>;
  };
  _tabRenderTimeout?: ReturnType<typeof setTimeout>;
};

export type TabType = 'shader' | 'scene';

export interface Tab {
  id: string;
  title: string;
  filePath: string | null;
  type: TabType;
  slotIndex: number | null;
  session: AceEditSession;
  savedContent: string;
}

export interface CreateTabOptions {
  content?: string;
  filePath?: string | null;
  type?: TabType;
  title?: string | null;
  slotIndex?: number | null;
  activate?: boolean;
}

export interface OpenInTabOptions extends CreateTabOptions {
  filePath?: string | null;
  slotIndex?: number | null;
  content?: string;
  type?: TabType;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let tabs: Tab[] = [];
let activeTabId: string | null = null;
let tabIdCounter = 0;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Get the tabs container element. */
function getTabsContainer(): HTMLElement {
  return document.getElementById('editor-tabs')!;
}

/** Generate a unique tab ID. */
function generateTabId(): string {
  return `tab-${++tabIdCounter}`;
}

/** Extract filename from a file path. */
function getFileName(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  return filePath.split('/').pop()!.split('\\').pop()!;
}

/** Return an icon string for a given tab type. */
function getTabIcon(type: TabType): string {
  return type === 'scene' ? '\uD83C\uDFB2' : '\uD83D\uDCC4';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Create a new editor tab and optionally activate it. */
export function createTab(options: CreateTabOptions = {}): Tab {
  const {
    content = '',
    filePath = null,
    type = 'shader',
    title = null,
    slotIndex = null,
    activate = true,
  } = options;

  const id = generateTabId();
  const fileName = getFileName(filePath);
  const displayTitle =
    title || fileName || (type === 'scene' ? 'Untitled Scene' : 'Untitled Shader');

  // Create Ace EditSession for this tab
  const session = ace.createEditSession(
    content,
    type === 'scene' ? 'ace/mode/javascript' : 'ace/mode/glsl',
  );
  session.setUseWrapMode(false);
  session.setTabSize(2);
  session.setUseSoftTabs(true);

  const tab: Tab = {
    id,
    title: displayTitle,
    filePath,
    type,
    slotIndex,
    session,
    savedContent: content,
  };

  tabs.push(tab);
  renderTabs();

  if (activate) {
    activateTab(id);
  }

  return tab;
}

/** Render all tabs into the DOM container. */
function renderTabs(): void {
  const container = getTabsContainer();
  container.innerHTML = '';

  tabs.forEach((tab) => {
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
    closeEl.innerHTML = '\u00D7';
    closeEl.title = 'Close tab';
    closeEl.addEventListener('click', (e: MouseEvent) => {
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

/** Activate a tab by its ID, switching the editor session. */
export function activateTab(tabId: string): void {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;

  activeTabId = tabId;

  // Set the editor session
  (state.editor as AceEditor).setSession(tab.session);

  // Store the tab type in state for other modules to use
  (state as Record<string, unknown>).activeTabType = tab.type;

  // Dispatch event for other modules to handle mode switching and compilation
  window.dispatchEvent(
    new CustomEvent('tab-activated', {
      detail: { tabId, type: tab.type },
    }),
  );

  // Update tab styling
  renderTabs();
}

/** Close a tab by its ID, activating an adjacent tab or creating a new one. */
export function closeTab(tabId: string): void {
  const tabIndex = tabs.findIndex((t) => t.id === tabId);
  if (tabIndex === -1) return;

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

/** Get the currently active tab, or undefined if none. */
export function getActiveTab(): Tab | undefined {
  return tabs.find((t) => t.id === activeTabId);
}

/** Update the display title of a tab. */
export function updateTabTitle(tabId: string, title: string): void {
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) {
    tab.title = title;
    renderTabs();
  }
}

/** Update the file path (and derived title) of a tab. */
export function updateTabFilePath(tabId: string, filePath: string): void {
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) {
    tab.filePath = filePath;
    tab.title = getFileName(filePath) || tab.title;
    renderTabs();
  }
}

/** Mark a tab as saved (snapshot current content as the saved baseline). */
export function markTabSaved(tabId: string): void {
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) {
    tab.savedContent = tab.session.getValue();
    renderTabs();
  }
}

/** Check whether the active tab has unsaved changes. */
export function activeTabHasChanges(): boolean {
  const tab = getActiveTab();
  if (!tab) return false;
  return tab.session.getValue() !== tab.savedContent;
}

/** Find a tab by its file path. */
export function findTabByFilePath(filePath: string): Tab | undefined {
  return tabs.find((t) => t.filePath === filePath);
}

/** Find a tab by its grid slot index. */
export function findTabBySlotIndex(slotIndex: number): Tab | undefined {
  return tabs.find((t) => t.slotIndex === slotIndex);
}

/** Open a file in a new tab, or activate an existing tab for the same file/slot. */
export function openInTab(options: OpenInTabOptions): Tab {
  const { filePath, slotIndex } = options;

  // Check if already open
  let existingTab: Tab | undefined;
  if (filePath) {
    existingTab = findTabByFilePath(filePath);
  } else if (slotIndex !== undefined && slotIndex !== null) {
    existingTab = findTabBySlotIndex(slotIndex);
  }

  if (existingTab) {
    // Update content if needed
    if (options.content !== undefined) {
      existingTab.session.setValue(options.content);
      existingTab.savedContent = options.content;
    }
    // Update type and session mode if changed
    const newType: TabType = options.type || existingTab.type;
    if (newType !== existingTab.type) {
      existingTab.type = newType;
      existingTab.session.setMode(
        newType === 'scene' ? 'ace/mode/javascript' : 'ace/mode/glsl',
      );
    }
    activateTab(existingTab.id);
    return existingTab;
  }

  // Create new tab
  return createTab(options);
}

/** Initialize the tabs system: wire up the change listener and create the first tab. */
export async function initTabs(): Promise<void> {
  // Listen for content changes to update modified indicator
  (state.editor as AceEditor).on('change', () => {
    // Debounce the render
    clearTimeout(window._tabRenderTimeout);
    window._tabRenderTimeout = setTimeout(() => {
      renderTabs();
    }, 100);
  });

  // Create initial tab with default shader
  const defaultShader: string = await window.electronAPI.getDefaultShader();
  createTab({
    content: defaultShader,
    type: 'shader',
    title: 'Untitled Shader',
  });
}

/** Get all tabs (for debugging / state inspection). */
export function getAllTabs(): Tab[] {
  return tabs;
}
