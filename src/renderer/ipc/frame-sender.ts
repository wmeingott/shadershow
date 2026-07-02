// FrameSender — Unified frame capture and sending for NDI, Syphon, and Recording.
// Merges js/ndi.js, js/syphon.js, and js/recording.js into a single class.

import { state } from '../core/state.js';
import { getABOverlayCanvas } from '../ui/ab-preview.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

declare const window: Window & {
  electronAPI: {
    sendOutputFrame: (data: OutputFrameMessage) => void;
    startRecording: () => Promise<RecordingResult>;
    stopRecording: () => void;
  };
};

interface FrameData {
  data: Uint8Array;
  width: number;
  height: number;
  flipped?: boolean;
}

interface OutputFrameMessage extends FrameData {
  flipped: true;
  targets: { ndi: boolean; syphon: boolean; recording: boolean };
}

interface RecordingResult {
  canceled?: boolean;
  error?: string;
  width?: number;
  height?: number;
  filePath?: string;
}

// ---------------------------------------------------------------------------
// Per-channel reusable buffers (avoid per-frame allocation)
// ---------------------------------------------------------------------------

let outputBuffer: Uint8Array | null = null;
let outputLastW = 0;
let outputLastH = 0;

// Renderer-side vertical-flip buffer: shared across all sinks, reallocated only on resolution change.
// The IPC send structured-clones the buffer synchronously, so this is safe to reuse frame-to-frame.
let flipBuffer: Uint8Array | null = null;

// Recording state
let savedPreviewWidth = 0;
let savedPreviewHeight = 0;

// Cached canvas + GL context (avoid DOM lookup per output frame)
let _cachedCanvas: HTMLCanvasElement | null = null;
let _cachedGL: WebGL2RenderingContext | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCanvasPixels(
  buffer: Uint8Array | null,
  lastW: number,
  lastH: number,
): { buffer: Uint8Array; width: number; height: number; lastW: number; lastH: number; flipped: boolean } | null {
  // When A/B mode is active, read from the composite 2D overlay canvas.
  // getImageData returns a fresh Uint8ClampedArray each call (top-to-bottom),
  // so we return a Uint8Array view of it directly — no extra copy needed.
  if (state.abEnabled) {
    const abCanvas = getABOverlayCanvas();
    if (abCanvas && abCanvas.width > 0 && abCanvas.height > 0) {
      const ctx = abCanvas.getContext('2d');
      if (ctx) {
        const width = abCanvas.width;
        const height = abCanvas.height;
        const imageData = ctx.getImageData(0, 0, width, height);
        // getImageData returns top-to-bottom (already correct orientation)
        return { buffer: new Uint8Array(imageData.data.buffer), width, height, lastW: width, lastH: height, flipped: true };
      }
    }
  }

  if (!_cachedCanvas) {
    _cachedCanvas = document.getElementById('shader-canvas') as HTMLCanvasElement | null;
  }
  const canvas = _cachedCanvas;
  if (!canvas) return null;
  if (!_cachedGL) {
    _cachedGL = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGL2RenderingContext | null;
  }
  const gl = _cachedGL;
  if (!gl) return null;

  const width = canvas.width;
  const height = canvas.height;

  if (width !== lastW || height !== lastH) {
    buffer = new Uint8Array(width * height * 4);
  }

  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer!);
  // gl.readPixels returns bottom-to-top (needs flipping by receiver)
  return { buffer: buffer!, width, height, lastW: width, lastH: height, flipped: false };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function sendOutputFrames(targets: { ndi?: boolean; syphon?: boolean; recording?: boolean }): void {
  if (!targets.ndi && !targets.syphon && !targets.recording) return;

  try {
    const result = readCanvasPixels(outputBuffer, outputLastW, outputLastH);
    if (!result) return;

    outputBuffer = result.buffer;
    outputLastW = result.lastW;
    outputLastH = result.lastH;

    let sendBuffer: Uint8Array;
    if (result.flipped) {
      // A/B path: getImageData already returns top-to-bottom
      sendBuffer = result.buffer;
    } else {
      // WebGL readPixels path: flip vertically into the shared flip buffer.
      // The IPC send structured-clones the data synchronously, so this
      // buffer is safe to reuse on the next frame.
      const { width, height } = result;
      const needed = width * height * 4;
      if (!flipBuffer || flipBuffer.byteLength !== needed) {
        flipBuffer = new Uint8Array(needed);
      }
      const rowSize = width * 4;
      for (let y = 0; y < height; y++) {
        flipBuffer.set(
          result.buffer.subarray((height - 1 - y) * rowSize, (height - y) * rowSize),
          y * rowSize,
        );
      }
      sendBuffer = flipBuffer;
    }

    window.electronAPI.sendOutputFrame({
      data: sendBuffer,
      width: result.width,
      height: result.height,
      flipped: true,
      targets: { ndi: !!targets.ndi, syphon: !!targets.syphon, recording: !!targets.recording },
    });
  } catch (err) {
    console.warn('Failed to send output frame:', err);
  }
}

export async function toggleRecording(setStatus: (msg: string, type: 'success' | 'error') => void): Promise<void> {
  if (state.recordingEnabled) {
    await stopRecordingCapture(setStatus);
  } else {
    await startRecordingCapture(setStatus);
  }
}

async function startRecordingCapture(setStatus: (msg: string, type: 'success' | 'error') => void): Promise<void> {
  try {
    const result = await window.electronAPI.startRecording();

    if (!result || result.canceled) return;

    if (result.error) {
      setStatus(`Recording error: ${result.error}`, 'error');
      return;
    }

    // Save current preview resolution
    const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement;
    savedPreviewWidth = canvas.width;
    savedPreviewHeight = canvas.height;

    // Switch canvas to recording resolution
    if (result.width && result.height) {
      if (result.width !== canvas.width || result.height !== canvas.height) {
        (state.renderer as { setResolution: (w: number, h: number) => void }).setResolution(result.width, result.height);
      }
    }

    state.recordingEnabled = true;
    state.recordingFrameCounter = 0;

    const btnRecord = document.getElementById('btn-record');
    if (btnRecord) {
      btnRecord.classList.add('active');
      btnRecord.title = 'Stop Recording (Cmd+Shift+R)';
    }

    const fileName = result.filePath!.split('/').pop()!.split('\\').pop();
    setStatus(`Recording to ${fileName} (${result.width}x${result.height})`, 'success');
  } catch (err: unknown) {
    setStatus(`Recording failed: ${(err as Error).message}`, 'error');
  }
}

async function stopRecordingCapture(setStatus: (msg: string, type: 'success' | 'error') => void): Promise<void> {
  state.recordingEnabled = false;
  window.electronAPI.stopRecording();

  // Restore preview resolution
  if (savedPreviewWidth && savedPreviewHeight) {
    const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement;
    if (canvas.width !== savedPreviewWidth || canvas.height !== savedPreviewHeight) {
      (state.renderer as { setResolution: (w: number, h: number) => void }).setResolution(savedPreviewWidth, savedPreviewHeight);
    }
    savedPreviewWidth = 0;
    savedPreviewHeight = 0;
  }

  const btnRecord = document.getElementById('btn-record');
  if (btnRecord) {
    btnRecord.classList.remove('active');
    btnRecord.title = 'Start Recording (Cmd+Shift+R)';
  }

  setStatus('Recording stopped, finalizing MP4...', 'success');
}
