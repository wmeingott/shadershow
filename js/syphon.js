// Syphon module (macOS only)
import { state } from './state.js';

export function sendSyphonFrame() {
  try {
    const canvas = document.getElementById('shader-canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');

    if (!gl) {
      console.warn('No WebGL context for Syphon frame');
      return;
    }

    const width = canvas.width;
    const height = canvas.height;

    // Read pixels from WebGL canvas (RGBA format)
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // WebGL reads pixels bottom-to-top, so we need to flip vertically
    const flippedPixels = new Uint8Array(width * height * 4);
    const rowSize = width * 4;
    for (let y = 0; y < height; y++) {
      const srcRow = (height - 1 - y) * rowSize;
      const dstRow = y * rowSize;
      flippedPixels.set(pixels.subarray(srcRow, srcRow + rowSize), dstRow);
    }

    // Convert to base64 in chunks to avoid stack overflow
    const chunkSize = 65536;
    let base64 = '';
    for (let i = 0; i < flippedPixels.length; i += chunkSize) {
      const chunk = flippedPixels.subarray(i, Math.min(i + chunkSize, flippedPixels.length));
      base64 += String.fromCharCode.apply(null, chunk);
    }
    base64 = btoa(base64);

    window.electronAPI.sendSyphonFrame({
      rgbaData: base64,
      width: width,
      height: height
    });
  } catch (err) {
    console.warn('Failed to send Syphon frame:', err);
  }
}
