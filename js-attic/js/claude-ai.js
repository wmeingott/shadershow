// Claude AI Assistant module
import { state } from './state.js';
import { setStatus } from './utils.js';
import { compileShader } from './editor.js';

let aiDialogKeyHandler = null;
let streamingResponse = '';
let isStreaming = false;
let ipcListenersSetup = false;

// Show the AI assistant dialog
export async function showAIAssistantDialog() {
  // Check if API key is configured
  const hasKey = await window.electronAPI.hasClaudeKey();
  if (!hasKey) {
    setStatus('Please configure Claude API key in Settings first', 'error');
    return;
  }

  // Get current code context
  const currentCode = state.editor.getValue();
  const renderMode = state.renderMode;

  // Extract custom param definitions
  const customParams = extractParamComments(currentCode);

  // Create dialog overlay
  const overlay = document.createElement('div');
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
  document.getElementById('claude-prompt-input').focus();
}

function setupDialogEventListeners(overlay) {
  // Close button
  document.getElementById('claude-ai-close').addEventListener('click', closeAIAssistantDialog);

  // Context toggle
  document.getElementById('context-toggle').addEventListener('click', () => {
    const body = document.getElementById('context-body');
    const arrow = document.querySelector('.context-arrow');
    body.classList.toggle('hidden');
    arrow.innerHTML = body.classList.contains('hidden') ? '&#9658;' : '&#9660;';
  });

  // Send button
  document.getElementById('claude-send-btn').addEventListener('click', sendPrompt);

  // Cancel button
  document.getElementById('claude-cancel-btn').addEventListener('click', cancelRequest);

  // Copy button
  document.getElementById('claude-copy-btn').addEventListener('click', copyResponse);

  // Replace button
  document.getElementById('claude-replace-btn').addEventListener('click', replaceCode);

  // Insert button
  document.getElementById('claude-insert-btn').addEventListener('click', insertCode);

  // Keyboard shortcuts
  aiDialogKeyHandler = (e) => {
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
  overlay.addEventListener('click', (e) => {
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

function sendPrompt() {
  const input = document.getElementById('claude-prompt-input');
  const prompt = input.value.trim();

  if (!prompt) {
    setStatus('Please enter a prompt', 'error');
    return;
  }

  const overlay = document.getElementById('claude-ai-overlay');
  const currentCode = overlay.dataset.currentCode;
  const renderMode = overlay.dataset.renderMode;
  const customParams = overlay.dataset.customParams;

  // Update UI for streaming
  isStreaming = true;
  streamingResponse = '';

  document.getElementById('claude-send-btn').disabled = true;
  document.getElementById('claude-cancel-btn').disabled = false;

  // Show response area
  const responseArea = document.getElementById('claude-ai-response');
  responseArea.classList.remove('hidden');

  const responseContent = document.getElementById('response-content');
  responseContent.innerHTML = '<div class="streaming-indicator">Claude is thinking...</div>';

  // Hide actions until complete
  document.getElementById('response-actions').classList.add('hidden');

  // Add user message to chat
  const chat = document.getElementById('claude-ai-chat');
  const welcomeMsg = chat.querySelector('.chat-welcome');
  if (welcomeMsg) welcomeMsg.remove();

  const userMsg = document.createElement('div');
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
      customParams
    },
    renderMode
  });
}

function handleStreamChunk(data) {
  if (!isStreaming) return;

  streamingResponse += data.text;

  const responseContent = document.getElementById('response-content');
  if (responseContent) {
    // Render with syntax highlighting for code blocks
    responseContent.innerHTML = renderMarkdown(streamingResponse);
    responseContent.scrollTop = responseContent.scrollHeight;
  }
}

function handleStreamEnd(data) {
  if (!isStreaming) return;

  isStreaming = false;

  const sendBtn = document.getElementById('claude-send-btn');
  const cancelBtn = document.getElementById('claude-cancel-btn');
  if (sendBtn) sendBtn.disabled = false;
  if (cancelBtn) cancelBtn.disabled = true;

  // Show action buttons if code was detected
  const codeBlocks = extractCodeBlocks(streamingResponse);
  if (codeBlocks.length > 0) {
    const actions = document.getElementById('response-actions');
    if (actions) actions.classList.remove('hidden');
  }

  setStatus('Response complete', 'success');
}

function handleError(data) {
  isStreaming = false;

  const sendBtn = document.getElementById('claude-send-btn');
  const cancelBtn = document.getElementById('claude-cancel-btn');
  if (sendBtn) sendBtn.disabled = false;
  if (cancelBtn) cancelBtn.disabled = true;

  const responseContent = document.getElementById('response-content');
  if (responseContent) {
    responseContent.innerHTML = `<div class="error-message">Error: ${escapeHtml(data.error)}</div>`;
  }

  setStatus(`Claude error: ${data.error}`, 'error');
}

function cancelRequest() {
  if (isStreaming) {
    window.electronAPI.cancelClaudeRequest();
    isStreaming = false;

    const sendBtn = document.getElementById('claude-send-btn');
    const cancelBtn = document.getElementById('claude-cancel-btn');
    if (sendBtn) sendBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = true;

    setStatus('Request cancelled', 'error');
  }
}

function copyResponse() {
  const codeBlocks = extractCodeBlocks(streamingResponse);
  const textToCopy = codeBlocks.length > 0 ? codeBlocks[0] : streamingResponse;

  navigator.clipboard.writeText(textToCopy).then(() => {
    setStatus('Copied to clipboard', 'success');
  }).catch(() => {
    setStatus('Failed to copy', 'error');
  });
}

function replaceCode() {
  const codeBlocks = extractCodeBlocks(streamingResponse);
  if (codeBlocks.length === 0) {
    setStatus('No code block found in response', 'error');
    return;
  }

  const code = codeBlocks[0];
  state.editor.setValue(code, -1);

  // Compile immediately
  compileShader();

  closeAIAssistantDialog();
  setStatus('Code replaced and compiled', 'success');
}

function insertCode() {
  const codeBlocks = extractCodeBlocks(streamingResponse);
  if (codeBlocks.length === 0) {
    setStatus('No code block found in response', 'error');
    return;
  }

  const code = codeBlocks[0];
  state.editor.insert(code);

  closeAIAssistantDialog();
  setStatus('Code inserted at cursor', 'success');
}

export function closeAIAssistantDialog() {
  const overlay = document.getElementById('claude-ai-overlay');
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

// Helper functions
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function truncateCode(code, maxLines) {
  const lines = code.split('\n');
  if (lines.length <= maxLines) return code;
  return lines.slice(0, maxLines).join('\n') + '\n// ... (' + (lines.length - maxLines) + ' more lines)';
}

function extractParamComments(code) {
  const paramRegex = /\/\/\s*@param\s+.+/g;
  const matches = code.match(paramRegex);
  return matches ? matches.join('\n') : '';
}

function extractCodeBlocks(markdown) {
  const codeBlockRegex = /```(?:glsl|javascript|js|jsx)?\n([\s\S]*?)```/g;
  const blocks = [];
  let match;

  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    blocks.push(match[1].trim());
  }

  // If no code blocks found, try to extract any code-like content
  if (blocks.length === 0) {
    // Check if the entire response looks like code
    const trimmed = markdown.trim();
    if (trimmed.includes('void mainImage') ||
        trimmed.includes('function setup') ||
        trimmed.includes('function animate')) {
      blocks.push(trimmed);
    }
  }

  return blocks;
}

function renderMarkdown(text) {
  // Simple markdown rendering for code blocks
  let html = escapeHtml(text);

  // Code blocks
  html = html.replace(/```(glsl|javascript|js|jsx)?\n([\s\S]*?)```/g, (match, lang, code) => {
    return `<pre class="code-block ${lang || ''}"><code>${code}</code></pre>`;
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

// Keyboard shortcut handler - call this from controls.js
export function initAIShortcut() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+A to open AI assistant
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
      e.preventDefault();
      showAIAssistantDialog();
    }
  });
}
