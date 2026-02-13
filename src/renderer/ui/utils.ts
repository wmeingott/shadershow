// Utility functions
// Typed version of js/utils.js.

import { logMessage } from './console-panel.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StatusType = 'success' | 'error' | 'info' | '';

type ChannelType = 'image' | 'video' | 'camera' | 'audio' | 'ndi' | 'builtin' | 'empty';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function setStatus(message: string, type: StatusType = ''): void {
  const statusBar: HTMLElement | null = document.getElementById('status-bar');
  const statusMessage: HTMLElement | null = document.getElementById('status-message');

  if (!statusBar || !statusMessage) return;

  statusBar.className = type;
  statusMessage.textContent = message;

  // Log to console panel
  logMessage(message, type || 'info');

  // Auto-clear success messages after 3 seconds
  if (type === 'success') {
    setTimeout(() => {
      if (statusMessage.textContent === message) {
        statusBar.className = '';
        statusMessage.textContent = 'Ready';
      }
    }, 3000);
  }
}

export function updateChannelSlot(
  channel: number,
  type: ChannelType,
  source: string = '',
  width: number = 0,
  height: number = 0,
  dataUrl: string | null = null,
): void {
  const slot: HTMLElement | null = document.getElementById(`channel-${channel}`);
  if (!slot) return;

  // Reset classes
  slot.classList.remove('has-texture', 'has-video', 'has-camera', 'has-audio', 'has-ndi');
  (slot as HTMLElement).style.backgroundImage = '';

  const fileName: string = source ? source.split('/').pop()!.split('\\').pop()! : '';

  switch (type) {
    case 'image':
      slot.classList.add('has-texture');
      if (dataUrl) {
        (slot as HTMLElement).style.backgroundImage = `url(${dataUrl})`;
      }
      slot.title = `iChannel${channel}: ${fileName} (${width}x${height}) [Image]`;
      slot.textContent = '';
      break;
    case 'video':
      slot.classList.add('has-video');
      slot.title = `iChannel${channel}: ${fileName} (${width}x${height}) [Video]`;
      slot.textContent = 'V';
      break;
    case 'camera':
      slot.classList.add('has-camera');
      slot.title = `iChannel${channel}: Camera (${width}x${height}) [Camera]`;
      slot.textContent = 'C';
      break;
    case 'audio':
      slot.classList.add('has-audio');
      slot.title = `iChannel${channel}: Audio FFT (${width}x${height}) [Audio]\nRow 0: Frequency spectrum, Row 1: Waveform`;
      slot.textContent = 'A';
      break;
    case 'ndi':
      slot.classList.add('has-ndi');
      slot.title = `iChannel${channel}: ${source} (${width}x${height}) [NDI]`;
      slot.textContent = 'N';
      break;
    case 'builtin':
      slot.classList.add('has-texture');
      slot.title = `iChannel${channel}: ${source} (${width}x${height}) [Built-in]`;
      slot.textContent = 'T';
      break;
    default:
      slot.title = `iChannel${channel} - Click File > Load Texture/Video/Camera`;
      slot.textContent = String(channel);
  }
}
