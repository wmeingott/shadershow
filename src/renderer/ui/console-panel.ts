// ConsolePanel — Persistent message log displayed below the editor.
// Typed version of js/console-panel.js.

import { state } from '@renderer/core/state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MessageType = 'error' | 'warning' | 'success' | 'info';

interface TypeBadge {
  text: string;
  class: string;
}

interface ConsoleMessage {
  message: string;
  type: MessageType;
  timestamp: Date;
}

export interface ConsolePanelState {
  height: number;
  collapsed: boolean;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let messages: ConsoleMessage[] = [];
let panelElement: HTMLDivElement | null = null;
let messagesElement: HTMLDivElement | null = null;
let resizerElement: HTMLDivElement | null = null;
let toggleButton: HTMLButtonElement | null = null;
let isCollapsed = false;
let panelHeight = 150;

const MAX_MESSAGES = 500;

const TYPE_BADGES: Record<MessageType, TypeBadge> = {
  error: { text: 'E', class: 'error' },
  warning: { text: 'W', class: 'warning' },
  success: { text: 'OK', class: 'success' },
  info: { text: 'i', class: 'info' },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function createPanelDOM(): void {
  const editorPanel = document.getElementById('editor-panel');
  if (!editorPanel) return;

  // Resizer
  resizerElement = document.createElement('div') as HTMLDivElement;
  resizerElement.id = 'console-resizer';
  editorPanel.appendChild(resizerElement);

  // Panel
  panelElement = document.createElement('div') as HTMLDivElement;
  panelElement.id = 'console-panel';
  panelElement.style.height = `${panelHeight}px`;

  // Header
  const header = document.createElement('div');
  header.id = 'console-header';
  header.addEventListener('click', (e: MouseEvent) => {
    // Don't toggle if clicking a button
    if ((e.target as HTMLElement).closest('.console-actions')) return;
    toggleConsolePanel();
  });

  const title = document.createElement('span');
  title.className = 'console-title';
  title.textContent = 'Console';

  const actions = document.createElement('div');
  actions.className = 'console-actions';

  const clearBtn = document.createElement('button');
  clearBtn.id = 'console-clear';
  clearBtn.title = 'Clear console';
  clearBtn.innerHTML = '&#10005;';
  clearBtn.addEventListener('click', clearMessages);

  toggleButton = document.createElement('button');
  toggleButton.id = 'console-toggle';
  toggleButton.title = 'Toggle console';
  toggleButton.innerHTML = '&#9660;';
  toggleButton.addEventListener('click', toggleConsolePanel);

  actions.appendChild(clearBtn);
  actions.appendChild(toggleButton);
  header.appendChild(title);
  header.appendChild(actions);

  // Messages container
  messagesElement = document.createElement('div') as HTMLDivElement;
  messagesElement.id = 'console-messages';

  panelElement.appendChild(header);
  panelElement.appendChild(messagesElement);
  editorPanel.appendChild(panelElement);

  // Resizer drag handling
  initResizer();

  if (isCollapsed) {
    panelElement.classList.add('collapsed');
    toggleButton.innerHTML = '&#9650;';
  }
}

function initResizer(): void {
  if (!resizerElement) return;

  let isDragging = false;

  resizerElement.addEventListener('mousedown', (e: MouseEvent) => {
    isDragging = true;
    resizerElement!.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDragging) return;

    const editorPanel = document.getElementById('editor-panel');
    if (!editorPanel) return;

    const editorPanelRect = editorPanel.getBoundingClientRect();
    const tabsHeight =
      (document.getElementById('editor-tabs') as HTMLElement | null)?.offsetHeight ?? 32;
    const resizerHeight = 4;
    const minEditorHeight = 100;
    const minConsoleHeight = 60;

    const consoleHeight = editorPanelRect.bottom - e.clientY - resizerHeight;
    const editorAvailable = editorPanelRect.height - tabsHeight - resizerHeight - consoleHeight;

    if (consoleHeight >= minConsoleHeight && editorAvailable >= minEditorHeight) {
      panelHeight = consoleHeight;
      if (panelElement) {
        panelElement.style.height = `${consoleHeight}px`;
      }
      if (state.editor && typeof (state.editor as { resize?: () => void }).resize === 'function') {
        (state.editor as { resize: () => void }).resize();
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      if (resizerElement) {
        resizerElement.classList.remove('dragging');
      }
      // View state is saved by the existing mouseup handler in controls.js
    }
  });
}

function renderMessage(entry: ConsoleMessage): void {
  if (!messagesElement) return;

  const badge: TypeBadge = TYPE_BADGES[entry.type] ?? TYPE_BADGES.info;

  const row = document.createElement('div');
  row.className = `console-message ${badge.class}`;

  const ts = document.createElement('span');
  ts.className = 'console-timestamp';
  ts.textContent = formatTime(entry.timestamp);

  const type = document.createElement('span');
  type.className = 'console-type';
  type.textContent = badge.text;

  const text = document.createElement('span');
  text.className = 'console-text';
  text.textContent = entry.message;

  row.appendChild(ts);
  row.appendChild(type);
  row.appendChild(text);
  messagesElement.appendChild(row);
}

function autoScroll(): void {
  if (!messagesElement) return;
  messagesElement.scrollTop = messagesElement.scrollHeight;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initConsolePanel(): void {
  createPanelDOM();

  // Listen for runtime errors dispatched as custom events
  window.addEventListener('scene-runtime-error', ((e: CustomEvent<{ message: string; source: string }>) => {
    const { message, source } = e.detail;
    logMessage(`Scene ${source} error: ${message}`, 'warning');
  }) as EventListener);
}

export function logMessage(message: string, type: MessageType = 'info'): void {
  if (!messagesElement) return;

  const entry: ConsoleMessage = { message, type, timestamp: new Date() };
  messages.push(entry);

  if (messages.length > MAX_MESSAGES) {
    messages.shift();
    if (messagesElement.firstChild) {
      messagesElement.removeChild(messagesElement.firstChild);
    }
  }

  renderMessage(entry);
  autoScroll();
}

export function clearMessages(): void {
  messages = [];
  if (messagesElement) {
    messagesElement.innerHTML = '';
  }
}

export function toggleConsolePanel(): void {
  isCollapsed = !isCollapsed;
  if (panelElement) {
    panelElement.classList.toggle('collapsed', isCollapsed);
  }
  if (toggleButton) {
    toggleButton.innerHTML = isCollapsed ? '&#9650;' : '&#9660;';
  }
  if (state.editor && typeof (state.editor as { resize?: () => void }).resize === 'function') {
    (state.editor as { resize: () => void }).resize();
  }
}

export function getConsolePanelState(): ConsolePanelState {
  return { height: panelHeight, collapsed: isCollapsed };
}

export function restoreConsolePanelState(saved: Partial<ConsolePanelState>): void {
  if (saved.height !== undefined) {
    panelHeight = saved.height;
    if (panelElement) panelElement.style.height = `${panelHeight}px`;
  }
  if (saved.collapsed !== undefined) {
    isCollapsed = saved.collapsed;
    if (panelElement) panelElement.classList.toggle('collapsed', isCollapsed);
    if (toggleButton) toggleButton.innerHTML = isCollapsed ? '&#9650;' : '&#9660;';
  }
  if (state.editor && typeof (state.editor as { resize?: () => void }).resize === 'function') {
    (state.editor as { resize: () => void }).resize();
  }
}
