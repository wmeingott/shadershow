// NDI module - optimized for performance
// Sends raw pixel data to main process (no base64 encoding)
// Flip is done in main process using native Buffer operations
import { state } from './state.js';

// Reusable buffer to avoid allocation overhead
let pixelBuffer = null;
let lastWidth = 0;
let lastHeight = 0;

export function sendNDIFrame() {
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
    window.electronAPI.sendNDIFrame({
      data: pixelBuffer,
      width: width,
      height: height
    });
  } catch (err) {
    console.warn('Failed to send NDI frame:', err);
  }
}
