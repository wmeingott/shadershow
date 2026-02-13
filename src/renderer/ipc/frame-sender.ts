// FrameSender — Unified frame capture and sending for NDI, Syphon, and Recording.
// Merges js/ndi.js, js/syphon.js, and js/recording.js into a single class.

import { state } from '../core/state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

declare const window: Window & {
  electronAPI: {
    sendNDIFrame: (data: FrameData) => void;
    sendSyphonFrame: (data: FrameData) => void;
    sendRecordingFrame: (data: FrameData) => void;
    startRecording: () => Promise<RecordingResult>;
    stopRecording: () => void;
  };
};

interface FrameData {
  data: Uint8Array;
  width: number;
  height: number;
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

let ndiBuffer: Uint8Array | null = null;
let ndiLastW = 0;
let ndiLastH = 0;

let syphonBuffer: Uint8Array | null = null;
let syphonLastW = 0;
let syphonLastH = 0;

let recordingBuffer: Uint8Array | null = null;
let recordingLastW = 0;
let recordingLastH = 0;

// Recording state
let savedPreviewWidth = 0;
let savedPreviewHeight = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCanvasPixels(
  buffer: Uint8Array | null,
  lastW: number,
  lastH: number,
): { buffer: Uint8Array; width: number; height: number; lastW: number; lastH: number } | null {
  const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement | null;
  if (!canvas) return null;
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) return null;

  const width = canvas.width;
  const height = canvas.height;

  if (width !== lastW || height !== lastH) {
    buffer = new Uint8Array(width * height * 4);
  }

  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer!);
  return { buffer: buffer!, width, height, lastW: width, lastH: height };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function sendNDIFrame(): void {
  try {
    const result = readCanvasPixels(ndiBuffer, ndiLastW, ndiLastH);
    if (!result) return;
    ndiBuffer = result.buffer;
    ndiLastW = result.lastW;
    ndiLastH = result.lastH;
    window.electronAPI.sendNDIFrame({ data: result.buffer, width: result.width, height: result.height });
  } catch (err) {
    console.warn('Failed to send NDI frame:', err);
  }
}

export function sendSyphonFrame(): void {
  try {
    const result = readCanvasPixels(syphonBuffer, syphonLastW, syphonLastH);
    if (!result) return;
    syphonBuffer = result.buffer;
    syphonLastW = result.lastW;
    syphonLastH = result.lastH;
    window.electronAPI.sendSyphonFrame({ data: result.buffer, width: result.width, height: result.height });
  } catch (err) {
    console.warn('Failed to send Syphon frame:', err);
  }
}

export function sendRecordingFrame(): void {
  try {
    const result = readCanvasPixels(recordingBuffer, recordingLastW, recordingLastH);
    if (!result) return;
    recordingBuffer = result.buffer;
    recordingLastW = result.lastW;
    recordingLastH = result.lastH;
    window.electronAPI.sendRecordingFrame({ data: result.buffer, width: result.width, height: result.height });
  } catch (err) {
    console.warn('Failed to send recording frame:', err);
  }
}

export async function toggleRecording(setStatus: (msg: string, type: string) => void): Promise<void> {
  if (state.recordingEnabled) {
    await stopRecordingCapture(setStatus);
  } else {
    await startRecordingCapture(setStatus);
  }
}

async function startRecordingCapture(setStatus: (msg: string, type: string) => void): Promise<void> {
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

async function stopRecordingCapture(setStatus: (msg: string, type: string) => void): Promise<void> {
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
