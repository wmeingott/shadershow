// Syphon module (macOS only) - optimized for performance
import { state } from './state.js';

// Reusable buffers to avoid allocation overhead
let pixelBuffer = null;
let flippedBuffer = null;
let lastWidth = 0;
let lastHeight = 0;

const CHUNK_SIZE = 65536;

export function sendSyphonFrame() {
  try {
    const canvas = document.getElementById('shader-canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');

    if (!gl) return;

    const width = canvas.width;
    const height = canvas.height;
    const bufferSize = width * height * 4;

    // Reallocate buffers only if resolution changed
    if (width !== lastWidth || height !== lastHeight) {
      pixelBuffer = new Uint8Array(bufferSize);
      flippedBuffer = new Uint8Array(bufferSize);
      lastWidth = width;
      lastHeight = height;
    }

    // Read pixels from WebGL canvas (RGBA format)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixelBuffer);

    // Flip vertically (reusing buffer)
    const rowSize = width * 4;
    for (let y = 0; y < height; y++) {
      const srcRow = (height - 1 - y) * rowSize;
      const dstRow = y * rowSize;
      flippedBuffer.set(pixelBuffer.subarray(srcRow, srcRow + rowSize), dstRow);
    }

    // Convert to base64
    const base64 = uint8ArrayToBase64(flippedBuffer);

    window.electronAPI.sendSyphonFrame({
      rgbaData: base64,
      width: width,
      height: height
    });
  } catch (err) {
    console.warn('Failed to send Syphon frame:', err);
  }
}

function uint8ArrayToBase64(bytes) {
  let binary = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, len);
    const chunk = bytes.subarray(i, end);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}
