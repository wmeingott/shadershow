// Recording module - sends raw pixel data to main process for H.265 MP4 encoding
// Follows the same pattern as ndi.js and syphon.js
import { state } from './state.js';
import { setStatus } from './utils.js';

// Reusable buffer to avoid allocation overhead
let pixelBuffer = null;
let lastWidth = 0;
let lastHeight = 0;

// Saved preview resolution for restore after recording
let savedPreviewWidth = 0;
let savedPreviewHeight = 0;

export function sendRecordingFrame() {
  try {
    const canvas = document.getElementById('shader-canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');

    if (!gl) return;

    const width = canvas.width;
    const height = canvas.height;
    const bufferSize = width * height * 4;

    // Reallocate buffer only if resolution changed
    if (width !== lastWidth || height !== lastHeight) {
      pixelBuffer = new Uint8Array(bufferSize);
      lastWidth = width;
      lastHeight = height;
    }

    // Read pixels from WebGL canvas (RGBA format, bottom-to-top)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixelBuffer);

    // Send raw Uint8Array - Electron IPC handles serialization efficiently
    // Flip is done in main process using native Buffer operations
    window.electronAPI.sendRecordingFrame({
      data: pixelBuffer,
      width: width,
      height: height
    });
  } catch (err) {
    console.warn('Failed to send recording frame:', err);
  }
}

export async function toggleRecording() {
  if (state.recordingEnabled) {
    await stopRecordingCapture();
  } else {
    await startRecordingCapture();
  }
}

async function startRecordingCapture() {
  try {
    const result = await window.electronAPI.startRecording();

    if (!result || result.canceled) {
      return; // User canceled save dialog
    }

    if (result.error) {
      setStatus(`Recording error: ${result.error}`, 'error');
      return;
    }

    // Save current preview resolution
    const canvas = document.getElementById('shader-canvas');
    savedPreviewWidth = canvas.width;
    savedPreviewHeight = canvas.height;

    // Switch canvas to recording resolution
    if (result.width && result.height) {
      if (result.width !== canvas.width || result.height !== canvas.height) {
        state.renderer.setResolution(result.width, result.height);
      }
    }

    state.recordingEnabled = true;
    state.recordingFrameCounter = 0;

    // Update button state
    const btnRecord = document.getElementById('btn-record');
    if (btnRecord) {
      btnRecord.classList.add('active');
      btnRecord.title = 'Stop Recording (Cmd+Shift+R)';
    }

    const fileName = result.filePath.split('/').pop().split('\\').pop();
    setStatus(`Recording to ${fileName} (${result.width}x${result.height})`, 'success');
  } catch (err) {
    setStatus(`Recording failed: ${err.message}`, 'error');
  }
}

async function stopRecordingCapture() {
  state.recordingEnabled = false;

  window.electronAPI.stopRecording();

  // Restore preview resolution
  if (savedPreviewWidth && savedPreviewHeight) {
    const canvas = document.getElementById('shader-canvas');
    if (canvas.width !== savedPreviewWidth || canvas.height !== savedPreviewHeight) {
      state.renderer.setResolution(savedPreviewWidth, savedPreviewHeight);
    }
    savedPreviewWidth = 0;
    savedPreviewHeight = 0;
  }

  // Update button state
  const btnRecord = document.getElementById('btn-record');
  if (btnRecord) {
    btnRecord.classList.remove('active');
    btnRecord.title = 'Start Recording (Cmd+Shift+R)';
  }

  setStatus('Recording stopped, finalizing MP4...', 'success');
}
