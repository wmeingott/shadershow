// Utility functions

export function setStatus(message, type = '') {
  const statusBar = document.getElementById('status-bar');
  const statusMessage = document.getElementById('status-message');

  statusBar.className = type;
  statusMessage.textContent = message;

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

export function updateChannelSlot(channel, type, source = '', width = 0, height = 0, dataUrl = null) {
  const slot = document.getElementById(`channel-${channel}`);

  // Reset classes
  slot.classList.remove('has-texture', 'has-video', 'has-camera', 'has-audio');
  slot.style.backgroundImage = '';

  const fileName = source ? source.split('/').pop().split('\\').pop() : '';

  switch (type) {
    case 'image':
      slot.classList.add('has-texture');
      if (dataUrl) {
        slot.style.backgroundImage = `url(${dataUrl})`;
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
    default:
      slot.title = `iChannel${channel} - Click File > Load Texture/Video/Camera`;
      slot.textContent = channel;
  }
}
