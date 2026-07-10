// AI Assistant module — manages the AI assistant dialog overlay.
// Typed version of js/claude-ai.js.

import { state } from '../core/state.js';
import type { AISettings, AIProvider, ClaudeModel } from '@shared/types/settings.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AIAttachment {
  dataUrl: string;      // data:image/png;base64,...
  name: string;         // filename or "Preview Capture"
  mediaType: string;    // image/png, image/jpeg, etc.
}

interface ClaudePromptData {
  prompt: string;
  context: {
    currentCode: string;
    customParams: string;
    compileError?: string;
    channels?: string;
    paramValues?: string;
  };
  renderMode: string;
  attachments?: AIAttachment[];
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** Minimal electronAPI surface used by this module */
declare const window: Window & {
  electronAPI: {
    hasClaudeKey(): Promise<boolean>;
    getClaudeSettings(): Promise<AISettings>;
    sendClaudePrompt(data: ClaudePromptData): void;
    cancelClaudeRequest(): void;
    onClaudeStreamChunk(cb: (data: { text: string }) => void): void;
    onClaudeStreamEnd(cb: (data: unknown) => void): void;
    onClaudeError(cb: (data: { error: string }) => void): void;
    setAIProvider(provider: string): Promise<void>;
    setAIModel(provider: string, model: string): Promise<void>;
    getAIModels(provider: string): Promise<ClaudeModel[]>;
  };
};

import { setStatus } from './utils.js';
import { compileShader } from './editor.js';

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

interface ChatTurn { role: 'user' | 'assistant'; content: string; }

let aiDialogKeyHandler: ((e: KeyboardEvent) => void) | null = null;
let streamingResponse: string = '';
let isStreaming: boolean = false;
let ipcListenersSetup: boolean = false;
let attachments: AIAttachment[] = [];
let renderScheduled: boolean = false;
let chatHistory: ChatTurn[] = [];
let pendingUserPrompt: string | null = null;
const MAX_HISTORY_TURNS = 12; // ponytail: hard cap, oldest dropped; token budgeting if it ever matters

const MAX_ATTACHMENTS = 5;
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const ACCEPTED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Show the AI assistant dialog */
export async function showAIAssistantDialog(prefill?: string | Event): Promise<void> {
  // Check if API key is configured
  const hasKey: boolean = await window.electronAPI.hasClaudeKey();
  if (!hasKey) {
    setStatus('Please configure an AI API key in Settings first', 'error');
    return;
  }

  // Load AI settings for provider/model dropdowns
  const aiSettings: AISettings = await window.electronAPI.getClaudeSettings();

  // Get current code context
  const editor = state.editor as EditorLike;
  const currentCode: string = editor.getValue();
  const renderMode: string = state.renderMode;

  // Extract custom param definitions
  const customParams: string = extractParamComments(currentCode);

  // Build model options for the active provider
  const activeModels = aiSettings.provider === 'anthropic' ? aiSettings.models : aiSettings.openrouterModels;
  const activeModel = aiSettings.provider === 'anthropic' ? aiSettings.model : aiSettings.openrouterModel;
  const modelOptionsHtml = buildModelOptions(activeModels, activeModel);

  // Reset attachments and conversation history
  attachments = [];
  chatHistory = [];
  pendingUserPrompt = null;

  // Create dialog overlay
  const overlay: HTMLDivElement = document.createElement('div');
  overlay.id = 'claude-ai-overlay';
  overlay.innerHTML = `
    <div class="claude-ai-dialog">
      <div class="claude-ai-header">
        <h2>AI Assistant</h2>
        <div class="claude-ai-header-controls">
          <select class="ai-header-select" id="ai-provider-select" title="AI Provider">
            <option value="anthropic" ${aiSettings.provider === 'anthropic' ? 'selected' : ''}>Anthropic</option>
            <option value="openrouter" ${aiSettings.provider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
          </select>
          <select class="ai-header-select ai-model-select" id="ai-model-select" title="Model">
            ${modelOptionsHtml}
          </select>
        </div>
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
            ${state.lastAIError ? `<span class="context-error" style="color:var(--error-color,#e66)">&#9888; ${escapeHtml(state.lastAIError.message)}</span>` : ''}
          </div>
          <div class="context-body hidden" id="context-body">
            <pre>${escapeHtml(truncateCode(currentCode, 50))}</pre>
          </div>
        </div>

        <!-- Chat area -->
        <div class="claude-ai-chat" id="claude-ai-chat">
          <div class="chat-welcome">
            <p>Ask the AI to help with your ${renderMode === 'shader' ? 'shader' : 'scene'}:</p>
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
            <span>Response</span>
            <button class="btn-small" id="claude-copy-btn" title="Copy response">Copy</button>
          </div>
          <div class="response-content" id="response-content"></div>
          <div class="response-actions" id="response-actions">
            <button class="btn-primary hidden" id="claude-apply-edits-btn">Apply Edits</button>
            <button class="btn-primary" id="claude-replace-btn">Replace All Code</button>
            <button class="btn-secondary" id="claude-insert-btn">Insert at Cursor</button>
          </div>
        </div>
      </div>

      <div class="claude-ai-input-area">
        <div class="ai-attachments hidden" id="ai-attachments"></div>
        <textarea
          id="claude-prompt-input"
          placeholder="Describe what you want the AI to do with your ${renderMode}... (Ctrl+Enter to send)"
          rows="3"
        ></textarea>
        <div class="input-actions">
          <div class="input-actions-left">
            <button class="btn-icon" id="ai-attach-btn" title="Attach image or video frame">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4.5 3a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 2.5 2.5h7a2.5 2.5 0 0 0 2.5-2.5v-5a2.5 2.5 0 0 0-2.5-2.5h-7zm0 1h7a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-7a1.5 1.5 0 0 1-1.5-1.5v-5a1.5 1.5 0 0 1 1.5-1.5z"/>
                <circle cx="5.5" cy="6.5" r="1"/>
                <path d="M2.5 11l2.5-3 2 2 3-4 3.5 5h-11z"/>
              </svg>
            </button>
            <button class="btn-icon" id="ai-capture-btn" title="Capture current preview">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M10.5 2l1.09 1.5H13a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h1.41L5.5 2h5zM8 5.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8 7a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/>
              </svg>
            </button>
          </div>
          <div class="input-actions-right">
            <button class="btn-secondary" id="claude-cancel-btn" disabled>Cancel</button>
            <button class="btn-primary" id="claude-send-btn">
              <span class="send-icon">&#9658;</span> Send
            </button>
          </div>
        </div>
        <input type="file" id="ai-file-input" accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,video/ogg" multiple style="display:none">
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
  const promptInput = document.getElementById('claude-prompt-input') as HTMLTextAreaElement;
  promptInput.focus();
  if (typeof prefill === 'string') {
    promptInput.value = prefill;
  }
}

/** Close and clean up the AI assistant dialog */
export function closeAIAssistantDialog(): void {
  if (isStreaming) {
    window.electronAPI.cancelClaudeRequest();
  }

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
  attachments = [];
  chatHistory = [];
  pendingUserPrompt = null;
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
// Internal — build model <option> elements
// ---------------------------------------------------------------------------

function buildModelOptions(models: ClaudeModel[], selectedModel: string): string {
  if (!models || models.length === 0) {
    return `<option value="${escapeAttr(selectedModel)}" selected>${escapeHtml(selectedModel)}</option>`;
  }
  return models.map(m =>
    `<option value="${escapeAttr(m.id)}" ${m.id === selectedModel ? 'selected' : ''}>${escapeHtml(m.display_name)}</option>`
  ).join('');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
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

  // Apply Edits button
  (document.getElementById('claude-apply-edits-btn') as HTMLElement).addEventListener('click', applyEdits);

  // Replace button
  (document.getElementById('claude-replace-btn') as HTMLElement).addEventListener('click', replaceCode);

  // Insert button
  (document.getElementById('claude-insert-btn') as HTMLElement).addEventListener('click', insertCode);

  // Provider dropdown
  const providerSelect = document.getElementById('ai-provider-select') as HTMLSelectElement;
  providerSelect.addEventListener('change', handleProviderChange);

  // Model dropdown
  const modelSelect = document.getElementById('ai-model-select') as HTMLSelectElement;
  modelSelect.addEventListener('change', handleModelChange);

  // Attachment buttons
  (document.getElementById('ai-attach-btn') as HTMLElement).addEventListener('click', () => {
    (document.getElementById('ai-file-input') as HTMLInputElement).click();
  });
  (document.getElementById('ai-capture-btn') as HTMLElement).addEventListener('click', capturePreview);
  (document.getElementById('ai-file-input') as HTMLInputElement).addEventListener('change', handleFileSelect);

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
// Internal — attachment handling
// ---------------------------------------------------------------------------

function handleFileSelect(): void {
  const fileInput = document.getElementById('ai-file-input') as HTMLInputElement;
  const files = fileInput.files;
  if (!files || files.length === 0) return;

  for (let i = 0; i < files.length; i++) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      setStatus(`Maximum ${MAX_ATTACHMENTS} attachments allowed`, 'error');
      break;
    }
    const file = files[i];
    if (ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      readImageFile(file);
    } else if (ACCEPTED_VIDEO_TYPES.includes(file.type)) {
      extractVideoFrame(file);
    }
  }

  // Reset the input so the same file can be re-selected
  fileInput.value = '';
}

function readImageFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result as string;
    addAttachment({ dataUrl, name: file.name, mediaType: file.type });
  };
  reader.readAsDataURL(file);
}

function extractVideoFrame(file: File): void {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';

  video.onloadeddata = () => {
    // Seek to 1 second or midpoint for a representative frame
    video.currentTime = Math.min(1, video.duration / 2);
  };

  video.onseeked = () => {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    addAttachment({ dataUrl, name: `${file.name} (frame)`, mediaType: 'image/png' });
    URL.revokeObjectURL(url);
  };

  video.onerror = () => {
    setStatus(`Failed to extract frame from ${file.name}`, 'error');
    URL.revokeObjectURL(url);
  };

  video.src = url;
}

function capturePreview(): void {
  if (attachments.length >= MAX_ATTACHMENTS) {
    setStatus(`Maximum ${MAX_ATTACHMENTS} attachments allowed`, 'error');
    return;
  }

  const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    setStatus('No preview canvas found', 'error');
    return;
  }

  const dataUrl = canvas.toDataURL('image/png');
  addAttachment({ dataUrl, name: 'Preview Capture', mediaType: 'image/png' });
}

const MAX_ATTACHMENT_DIM = 1568; // Anthropic vision sweet spot — larger is downsized server-side anyway

function normalizeAttachment(att: AIAttachment): Promise<AIAttachment> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = MAX_ATTACHMENT_DIM / Math.max(img.width, img.height);
      if (scale >= 1) { resolve(att); return; }
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.85), name: att.name, mediaType: 'image/jpeg' });
    };
    img.onerror = () => resolve(att); // ponytail: on decode failure send the original
    img.src = att.dataUrl;
  });
}

function addAttachment(att: AIAttachment): void {
  void normalizeAttachment(att).then((normalized) => {
    attachments.push(normalized);
    renderAttachments();
  });
}

function removeAttachment(index: number): void {
  attachments.splice(index, 1);
  renderAttachments();
}

function renderAttachments(): void {
  const container = document.getElementById('ai-attachments') as HTMLElement;
  if (!container) return;

  if (attachments.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = attachments.map((att, i) => `
    <div class="ai-attachment-item" title="${escapeAttr(att.name)}">
      <img src="${att.dataUrl}" alt="${escapeAttr(att.name)}">
      <span class="ai-attachment-name">${escapeHtml(att.name)}</span>
      <button class="ai-attachment-remove" data-index="${i}" title="Remove">&times;</button>
    </div>
  `).join('');

  // Wire up remove buttons
  container.querySelectorAll('.ai-attachment-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt((e.currentTarget as HTMLElement).dataset.index!, 10);
      removeAttachment(idx);
    });
  });
}

// ---------------------------------------------------------------------------
// Internal — provider / model switching
// ---------------------------------------------------------------------------

async function handleProviderChange(): Promise<void> {
  const providerSelect = document.getElementById('ai-provider-select') as HTMLSelectElement;
  const modelSelect = document.getElementById('ai-model-select') as HTMLSelectElement;
  const provider = providerSelect.value as AIProvider;

  // Persist provider choice
  await window.electronAPI.setAIProvider(provider);

  // Show loading state
  modelSelect.innerHTML = '<option>Loading models...</option>';
  modelSelect.disabled = true;

  // Fetch models for the new provider
  const models = await window.electronAPI.getAIModels(provider);

  // Get current settings to know selected model
  const settings = await window.electronAPI.getClaudeSettings();
  const activeModel = provider === 'anthropic' ? settings.model : settings.openrouterModel;

  modelSelect.innerHTML = buildModelOptions(models, activeModel);
  modelSelect.disabled = false;
}

async function handleModelChange(): Promise<void> {
  const providerSelect = document.getElementById('ai-provider-select') as HTMLSelectElement;
  const modelSelect = document.getElementById('ai-model-select') as HTMLSelectElement;
  const provider = providerSelect.value;
  const model = modelSelect.value;

  await window.electronAPI.setAIModel(provider, model);
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
  const currentCode: string = (state.editor as EditorLike).getValue();
  const renderMode: string = overlay.dataset.renderMode ?? '';
  const customParams: string = extractParamComments(currentCode);

  // Archive previous streaming response into the chat log before appending the new user
  // message — must run BEFORE streamingResponse is reset below
  const chat = document.getElementById('claude-ai-chat') as HTMLElement;
  if (streamingResponse) {
    const aiMsg = document.createElement('div');
    aiMsg.className = 'chat-message assistant';
    aiMsg.innerHTML = `<div class="message-content">${renderMarkdown(streamingResponse)}</div>`;
    chat.appendChild(aiMsg);
  }

  // Update UI for streaming
  isStreaming = true;
  streamingResponse = '';

  (document.getElementById('claude-send-btn') as HTMLButtonElement).disabled = true;
  (document.getElementById('claude-cancel-btn') as HTMLButtonElement).disabled = false;

  // Show response area
  const responseArea = document.getElementById('claude-ai-response') as HTMLElement;
  responseArea.classList.remove('hidden');

  const responseContent = document.getElementById('response-content') as HTMLElement;
  responseContent.innerHTML = '<div class="streaming-indicator">Thinking...</div>';

  // Hide actions until complete
  (document.getElementById('response-actions') as HTMLElement).classList.add('hidden');

  // Add user message to chat (with attachment indicators)
  const welcomeMsg: Element | null = chat.querySelector('.chat-welcome');
  if (welcomeMsg) welcomeMsg.remove();

  const userMsg: HTMLDivElement = document.createElement('div');
  userMsg.className = 'chat-message user';
  const attachHtml = attachments.length > 0
    ? `<div class="chat-attachments">${attachments.map(a => `<img src="${a.dataUrl}" alt="${escapeAttr(a.name)}" class="chat-attachment-thumb" title="${escapeAttr(a.name)}">`).join('')}</div>`
    : '';
  userMsg.innerHTML = `<div class="message-content">${attachHtml}${escapeHtml(prompt)}</div>`;
  chat.appendChild(userMsg);

  // Clear input
  input.value = '';

  // Grab current attachments and clear them
  const currentAttachments = attachments.length > 0 ? [...attachments] : undefined;
  attachments = [];
  renderAttachments();

  // Record the outgoing prompt so handleStreamEnd can commit the pair
  pendingUserPrompt = prompt;

  // Send to main process
  window.electronAPI.sendClaudePrompt({
    prompt,
    context: {
      currentCode,
      customParams,
      compileError: state.lastAIError
        ? `${state.lastAIError.message}${state.lastAIError.line ? ` (line ${state.lastAIError.line})` : ''}${state.lastAIError.raw ? `\nRaw log:\n${state.lastAIError.raw}` : ''}`
        : undefined,
      channels: describeChannels(),
      paramValues: describeParamValues() || undefined,
    },
    renderMode,
    attachments: currentAttachments,
    history: chatHistory,
  });
}

function handleStreamChunk(data: { text: string }): void {
  if (!isStreaming) return;
  streamingResponse += data.text;
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (!isStreaming) return; // a terminal handler already did the final render
    const responseContent: HTMLElement | null = document.getElementById('response-content');
    if (responseContent) {
      responseContent.innerHTML = renderMarkdown(streamingResponse);
      responseContent.scrollTop = responseContent.scrollHeight;
    }
  });
}

function handleStreamEnd(rawData: unknown): void {
  const data = rawData as { truncated?: boolean };
  if (!isStreaming) return;

  isStreaming = false;

  // Guaranteed final render — a pending rAF may not have fired yet
  const responseContent: HTMLElement | null = document.getElementById('response-content');
  if (responseContent) {
    responseContent.innerHTML = renderMarkdown(streamingResponse);
    responseContent.scrollTop = responseContent.scrollHeight;
  }

  if (data?.truncated) {
    setStatus('Response was truncated at the length limit — code may be incomplete', 'error');
    if (responseContent) {
      responseContent.insertAdjacentHTML('afterbegin', '<div class="error-message">⚠ Response truncated — do not Replace All without checking</div>');
    }
  }

  const sendBtn = document.getElementById('claude-send-btn') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('claude-cancel-btn') as HTMLButtonElement | null;
  if (sendBtn) sendBtn.disabled = false;
  if (cancelBtn) cancelBtn.disabled = true;

  const edits = extractEdits(streamingResponse);
  const codeBlocks = extractCodeBlocks(streamingResponse);
  const applyBtn = document.getElementById('claude-apply-edits-btn');
  const replaceBtn = document.getElementById('claude-replace-btn');
  const insertBtn = document.getElementById('claude-insert-btn');
  if (edits.length > 0) {
    applyBtn?.classList.remove('hidden');
    replaceBtn?.classList.add('hidden');   // a response of edit blocks is not a valid whole file
    insertBtn?.classList.add('hidden');
  } else {
    applyBtn?.classList.add('hidden');
    replaceBtn?.classList.remove('hidden');
    insertBtn?.classList.remove('hidden');
  }
  if (edits.length > 0 || codeBlocks.length > 0) {
    document.getElementById('response-actions')?.classList.remove('hidden');
  }

  // Commit this exchange to history (only successful completions enter history)
  if (pendingUserPrompt !== null) {
    chatHistory.push({ role: 'user', content: pendingUserPrompt });
    chatHistory.push({ role: 'assistant', content: streamingResponse });
    pendingUserPrompt = null;
    while (chatHistory.length > MAX_HISTORY_TURNS * 2) chatHistory.splice(0, 2);
  }

  if (!data?.truncated) setStatus('Response complete', 'success');
}

function handleError(data: { error: string }): void {
  isStreaming = false;
  pendingUserPrompt = null; // discard dangling turn — must not enter history

  const sendBtn = document.getElementById('claude-send-btn') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('claude-cancel-btn') as HTMLButtonElement | null;
  if (sendBtn) sendBtn.disabled = false;
  if (cancelBtn) cancelBtn.disabled = true;

  const responseContent: HTMLElement | null = document.getElementById('response-content');
  if (responseContent) {
    responseContent.innerHTML = `<div class="error-message">Error: ${escapeHtml(data.error)}</div>`;
  }

  setStatus(`AI error: ${data.error}`, 'error');
}

function cancelRequest(): void {
  if (isStreaming) {
    window.electronAPI.cancelClaudeRequest();
    isStreaming = false;
    pendingUserPrompt = null; // discard dangling turn — must not enter history

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
  if (extractEdits(streamingResponse).length > 0) {
    setStatus('This response contains edits — use Apply Edits', 'error');
    return;
  }
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

function applyEdits(): void {
  const edits = extractEdits(streamingResponse);
  if (edits.length === 0) return;

  const editor = state.editor as EditorLike;
  let code = editor.getValue();

  // Validate every edit before touching the editor (all-or-nothing)
  for (let i = 0; i < edits.length; i++) {
    const first = code.indexOf(edits[i].search);
    if (first === -1) {
      setStatus(`Edit ${i + 1}/${edits.length} does not match the current code — not applied. Ask the AI to regenerate, or use a full rewrite.`, 'error');
      return;
    }
    if (code.indexOf(edits[i].search, first + 1) !== -1) {
      setStatus(`Edit ${i + 1}/${edits.length} matches more than once — not applied. Ask the AI for a more specific edit.`, 'error');
      return;
    }
    code = code.replace(edits[i].search, edits[i].replace);
  }

  editor.setValue(code, -1);
  compileShader();
  closeAIAssistantDialog();
  setStatus(`Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} and compiled`, 'success');
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

function describeChannels(): string {
  const parts = state.channelState.map((ch, i) => {
    if (!ch) return `iChannel${i}: empty`;
    const src = (ch as { source?: string; filePath?: string }).filePath
      ?? (typeof ch.source === 'string' && !ch.source.startsWith('data:') ? ch.source : '');
    return `iChannel${i}: ${ch.type}${src ? ` (${src})` : ''}`;
  });
  return parts.join('\n');
}

function describeParamValues(): string {
  const renderer = state.renderer as { getCustomParamValues?: () => Record<string, unknown> } | null;
  const values = renderer?.getCustomParamValues?.();
  if (!values || Object.keys(values).length === 0) return '';
  return JSON.stringify(values);
}

interface SearchReplaceEdit { search: string; replace: string; }

function extractEdits(markdown: string): SearchReplaceEdit[] {
  const editRegex = /<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g;
  const edits: SearchReplaceEdit[] = [];
  let m: RegExpExecArray | null;
  while ((m = editRegex.exec(markdown)) !== null) {
    edits.push({ search: m[1], replace: m[2] });
  }
  return edits;
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
