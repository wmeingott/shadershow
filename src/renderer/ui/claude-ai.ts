// Claude AI Assistant module — manages the AI assistant dialog overlay.
// Typed version of js/claude-ai.js.

import { state } from '../core/state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaudePromptData {
  prompt: string;
  context: {
    currentCode: string;
    customParams: string;
  };
  renderMode: string;
}

/** Minimal electronAPI surface used by this module */
declare const window: Window & {
  electronAPI: {
    hasClaudeKey(): Promise<boolean>;
    sendClaudePrompt(data: ClaudePromptData): void;
    cancelClaudeRequest(): void;
    onClaudeStreamChunk(cb: (data: { text: string }) => void): void;
    onClaudeStreamEnd(cb: (data: unknown) => void): void;
    onClaudeError(cb: (data: { error: string }) => void): void;
  };
};

// ---------------------------------------------------------------------------
// External module stubs (not yet converted to TS)
// ---------------------------------------------------------------------------

declare function setStatus(msg: string, type?: string): void;
declare function compileShader(): void;

// ---------------------------------------------------------------------------
// Editor type used via state.editor
// ---------------------------------------------------------------------------

interface EditorLike {
  getValue(): string;
  setValue(v: string, cursor?: number): void;
  insert(s: string): void;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let aiDialogKeyHandler: ((e: KeyboardEvent) => void) | null = null;
let streamingResponse: string = '';
let isStreaming: boolean = false;
let ipcListenersSetup: boolean = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Show the AI assistant dialog */
export async function showAIAssistantDialog(): Promise<void> {
  // Check if API key is configured
  const hasKey: boolean = await window.electronAPI.hasClaudeKey();
  if (!hasKey) {
    setStatus('Please configure Claude API key in Settings first', 'error');
    return;
  }

  // Get current code context
  const editor = state.editor as EditorLike;
  const currentCode: string = editor.getValue();
  const renderMode: string = state.renderMode;

  // Extract custom param definitions
  const customParams: string = extractParamComments(currentCode);

  // Create dialog overlay
  const overlay: HTMLDivElement = document.createElement('div');
  overlay.id = 'claude-ai-overlay';
  overlay.innerHTML = `
    <div class="claude-ai-dialog">
      <div class="claude-ai-header">
        <h2>Claude AI Assistant</h2>
        <div class="claude-ai-mode-badge ${renderMode}">${renderMode === 'shader' ? 'GLSL Shader' : 'Three.js Scene'}</div>
        <button class="close-btn" id="claude-ai-close">&times;</button>
      </div>

      <div class="claude-ai-content">
        <!-- Context panel -->
        <div class="claude-ai-context">
          <div class="context-header" id="context-toggle">
            <span class="context-arrow">&#9658;</span>
            <span>Current Code Context</span>
            <span class="context-lines">${currentCode.split('\n').length} lines</span>
          </div>
          <div class="context-body hidden" id="context-body">
            <pre>${escapeHtml(truncateCode(currentCode, 50))}</pre>
          </div>
        </div>

        <!-- Chat area -->
        <div class="claude-ai-chat" id="claude-ai-chat">
          <div class="chat-welcome">
            <p>Ask Claude to help with your ${renderMode === 'shader' ? 'shader' : 'scene'}:</p>
            <ul>
              <li>"Add a color cycling effect based on time"</li>
              <li>"Make the pattern react to mouse position"</li>
              <li>"Add a @param for controlling the speed"</li>
              <li>"Convert this to use polar coordinates"</li>
            </ul>
          </div>
        </div>

        <!-- Response area -->
        <div class="claude-ai-response hidden" id="claude-ai-response">
          <div class="response-header">
            <span>Claude's Response</span>
            <button class="btn-small" id="claude-copy-btn" title="Copy response">Copy</button>
          </div>
          <div class="response-content" id="response-content"></div>
          <div class="response-actions" id="response-actions">
            <button class="btn-primary" id="claude-replace-btn">Replace All Code</button>
            <button class="btn-secondary" id="claude-insert-btn">Insert at Cursor</button>
          </div>
        </div>
      </div>

      <div class="claude-ai-input-area">
        <textarea
          id="claude-prompt-input"
          placeholder="Describe what you want Claude to do with your ${renderMode}... (Ctrl+Enter to send)"
          rows="3"
        ></textarea>
        <div class="input-actions">
          <button class="btn-secondary" id="claude-cancel-btn" disabled>Cancel</button>
          <button class="btn-primary" id="claude-send-btn">
            <span class="send-icon">&#9658;</span> Send
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Store context for later use
  overlay.dataset.currentCode = currentCode;
  overlay.dataset.renderMode = renderMode;
  overlay.dataset.customParams = customParams;

  // Set up event listeners
  setupDialogEventListeners(overlay);

  // Focus the input
  (document.getElementById('claude-prompt-input') as HTMLTextAreaElement).focus();
}

/** Close and clean up the AI assistant dialog */
export function closeAIAssistantDialog(): void {
  const overlay: HTMLElement | null = document.getElementById('claude-ai-overlay');
  if (overlay) {
    overlay.remove();
  }

  if (aiDialogKeyHandler) {
    document.removeEventListener('keydown', aiDialogKeyHandler);
    aiDialogKeyHandler = null;
  }

  isStreaming = false;
  streamingResponse = '';
}

/** Register the global keyboard shortcut to open the AI dialog */
export function initAIShortcut(): void {
  document.addEventListener('keydown', (e: KeyboardEvent): void => {
    // Ctrl+Shift+A to open AI assistant
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
      e.preventDefault();
      showAIAssistantDialog();
    }
  });
}

// ---------------------------------------------------------------------------
// Internal — dialog event wiring
// ---------------------------------------------------------------------------

function setupDialogEventListeners(overlay: HTMLDivElement): void {
  // Close button
  (document.getElementById('claude-ai-close') as HTMLElement).addEventListener('click', closeAIAssistantDialog);

  // Context toggle
  (document.getElementById('context-toggle') as HTMLElement).addEventListener('click', (): void => {
    const body = document.getElementById('context-body') as HTMLElement;
    const arrow = document.querySelector('.context-arrow') as HTMLElement;
    body.classList.toggle('hidden');
    arrow.innerHTML = body.classList.contains('hidden') ? '&#9658;' : '&#9660;';
  });

  // Send button
  (document.getElementById('claude-send-btn') as HTMLElement).addEventListener('click', sendPrompt);

  // Cancel button
  (document.getElementById('claude-cancel-btn') as HTMLElement).addEventListener('click', cancelRequest);

  // Copy button
  (document.getElementById('claude-copy-btn') as HTMLElement).addEventListener('click', copyResponse);

  // Replace button
  (document.getElementById('claude-replace-btn') as HTMLElement).addEventListener('click', replaceCode);

  // Insert button
  (document.getElementById('claude-insert-btn') as HTMLElement).addEventListener('click', insertCode);

  // Keyboard shortcuts
  aiDialogKeyHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (isStreaming) {
        cancelRequest();
      } else {
        closeAIAssistantDialog();
      }
    } else if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      sendPrompt();
    }
  };
  document.addEventListener('keydown', aiDialogKeyHandler);

  // Close on overlay click
  overlay.addEventListener('click', (e: MouseEvent): void => {
    if (e.target === overlay && !isStreaming) {
      closeAIAssistantDialog();
    }
  });

  // Set up streaming event listeners (only once)
  if (!ipcListenersSetup) {
    window.electronAPI.onClaudeStreamChunk(handleStreamChunk);
    window.electronAPI.onClaudeStreamEnd(handleStreamEnd);
    window.electronAPI.onClaudeError(handleError);
    ipcListenersSetup = true;
  }
}

// ---------------------------------------------------------------------------
// Internal — prompt sending & streaming
// ---------------------------------------------------------------------------

function sendPrompt(): void {
  const input = document.getElementById('claude-prompt-input') as HTMLTextAreaElement;
  const prompt: string = input.value.trim();

  if (!prompt) {
    setStatus('Please enter a prompt', 'error');
    return;
  }

  const overlay = document.getElementById('claude-ai-overlay') as HTMLElement;
  const currentCode: string = overlay.dataset.currentCode ?? '';
  const renderMode: string = overlay.dataset.renderMode ?? '';
  const customParams: string = overlay.dataset.customParams ?? '';

  // Update UI for streaming
  isStreaming = true;
  streamingResponse = '';

  (document.getElementById('claude-send-btn') as HTMLButtonElement).disabled = true;
  (document.getElementById('claude-cancel-btn') as HTMLButtonElement).disabled = false;

  // Show response area
  const responseArea = document.getElementById('claude-ai-response') as HTMLElement;
  responseArea.classList.remove('hidden');

  const responseContent = document.getElementById('response-content') as HTMLElement;
  responseContent.innerHTML = '<div class="streaming-indicator">Claude is thinking...</div>';

  // Hide actions until complete
  (document.getElementById('response-actions') as HTMLElement).classList.add('hidden');

  // Add user message to chat
  const chat = document.getElementById('claude-ai-chat') as HTMLElement;
  const welcomeMsg: Element | null = chat.querySelector('.chat-welcome');
  if (welcomeMsg) welcomeMsg.remove();

  const userMsg: HTMLDivElement = document.createElement('div');
  userMsg.className = 'chat-message user';
  userMsg.innerHTML = `<div class="message-content">${escapeHtml(prompt)}</div>`;
  chat.appendChild(userMsg);

  // Clear input
  input.value = '';

  // Send to main process
  window.electronAPI.sendClaudePrompt({
    prompt,
    context: {
      currentCode,
      customParams,
    },
    renderMode,
  });
}

function handleStreamChunk(data: { text: string }): void {
  if (!isStreaming) return;

  streamingResponse += data.text;

  const responseContent: HTMLElement | null = document.getElementById('response-content');
  if (responseContent) {
    // Render with syntax highlighting for code blocks
    responseContent.innerHTML = renderMarkdown(streamingResponse);
    responseContent.scrollTop = responseContent.scrollHeight;
  }
}

function handleStreamEnd(_data: unknown): void {
  if (!isStreaming) return;

  isStreaming = false;

  const sendBtn = document.getElementById('claude-send-btn') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('claude-cancel-btn') as HTMLButtonElement | null;
  if (sendBtn) sendBtn.disabled = false;
  if (cancelBtn) cancelBtn.disabled = true;

  // Show action buttons if code was detected
  const codeBlocks: string[] = extractCodeBlocks(streamingResponse);
  if (codeBlocks.length > 0) {
    const actions: HTMLElement | null = document.getElementById('response-actions');
    if (actions) actions.classList.remove('hidden');
  }

  setStatus('Response complete', 'success');
}

function handleError(data: { error: string }): void {
  isStreaming = false;

  const sendBtn = document.getElementById('claude-send-btn') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('claude-cancel-btn') as HTMLButtonElement | null;
  if (sendBtn) sendBtn.disabled = false;
  if (cancelBtn) cancelBtn.disabled = true;

  const responseContent: HTMLElement | null = document.getElementById('response-content');
  if (responseContent) {
    responseContent.innerHTML = `<div class="error-message">Error: ${escapeHtml(data.error)}</div>`;
  }

  setStatus(`Claude error: ${data.error}`, 'error');
}

function cancelRequest(): void {
  if (isStreaming) {
    window.electronAPI.cancelClaudeRequest();
    isStreaming = false;

    const sendBtn = document.getElementById('claude-send-btn') as HTMLButtonElement | null;
    const cancelBtn = document.getElementById('claude-cancel-btn') as HTMLButtonElement | null;
    if (sendBtn) sendBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = true;

    setStatus('Request cancelled', 'error');
  }
}

// ---------------------------------------------------------------------------
// Internal — response actions
// ---------------------------------------------------------------------------

function copyResponse(): void {
  const codeBlocks: string[] = extractCodeBlocks(streamingResponse);
  const textToCopy: string = codeBlocks.length > 0 ? codeBlocks[0] : streamingResponse;

  navigator.clipboard.writeText(textToCopy).then((): void => {
    setStatus('Copied to clipboard', 'success');
  }).catch((): void => {
    setStatus('Failed to copy', 'error');
  });
}

function replaceCode(): void {
  const codeBlocks: string[] = extractCodeBlocks(streamingResponse);
  if (codeBlocks.length === 0) {
    setStatus('No code block found in response', 'error');
    return;
  }

  const code: string = codeBlocks[0];
  (state.editor as EditorLike).setValue(code, -1);

  // Compile immediately
  compileShader();

  closeAIAssistantDialog();
  setStatus('Code replaced and compiled', 'success');
}

function insertCode(): void {
  const codeBlocks: string[] = extractCodeBlocks(streamingResponse);
  if (codeBlocks.length === 0) {
    setStatus('No code block found in response', 'error');
    return;
  }

  const code: string = codeBlocks[0];
  (state.editor as EditorLike).insert(code);

  closeAIAssistantDialog();
  setStatus('Code inserted at cursor', 'success');
}

// ---------------------------------------------------------------------------
// Internal — helper / utility functions
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  const div: HTMLDivElement = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function truncateCode(code: string, maxLines: number): string {
  const lines: string[] = code.split('\n');
  if (lines.length <= maxLines) return code;
  return lines.slice(0, maxLines).join('\n') + '\n// ... (' + (lines.length - maxLines) + ' more lines)';
}

function extractParamComments(code: string): string {
  const paramRegex: RegExp = /\/\/\s*@param\s+.+/g;
  const matches: RegExpMatchArray | null = code.match(paramRegex);
  return matches ? matches.join('\n') : '';
}

function extractCodeBlocks(markdown: string): string[] {
  const codeBlockRegex: RegExp = /```(?:glsl|javascript|js|jsx)?\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    blocks.push(match[1].trim());
  }

  // If no code blocks found, try to extract any code-like content
  if (blocks.length === 0) {
    // Check if the entire response looks like code
    const trimmed: string = markdown.trim();
    if (trimmed.includes('void mainImage') ||
        trimmed.includes('function setup') ||
        trimmed.includes('function animate')) {
      blocks.push(trimmed);
    }
  }

  return blocks;
}

function renderMarkdown(text: string): string {
  // Simple markdown rendering for code blocks
  let html: string = escapeHtml(text);

  // Code blocks
  html = html.replace(/```(glsl|javascript|js|jsx)?\n([\s\S]*?)```/g, (_match: string, lang: string | undefined, code: string): string => {
    return `<pre class="code-block ${lang ?? ''}"><code>${code}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}
