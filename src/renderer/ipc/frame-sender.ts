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

type OutputTargets = { ndi: boolean; syphon: boolean; recording: boolean };

interface OutputFrameMessage extends FrameData {
  flipped: true;
  targets: OutputTargets;
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
// Async PBO readback ring (WebGL2 only)
//
// A plain gl.readPixels into CPU memory blocks until the GPU has drained all
// queued draw calls. Instead we read into a PIXEL_PACK_BUFFER (returns
// immediately), insert a fence, and copy the pixels out on a later call once
// the fence has signaled. Output frames arrive one call late — irrelevant for
// NDI/Syphon/recording — and the render loop never stalls.
// 2 slots: one in flight, one collectable.
// ---------------------------------------------------------------------------

interface PboSlot {
  pbo: WebGLBuffer;
  fence: WebGLSync | null;
  width: number;
  height: number;
  targets: OutputTargets;
  pending: boolean;
}

let pboSlots: PboSlot[] | null = null; // lazily created, 2 entries
let pboWriteIndex = 0;
let pboUnsupported = false; // latched: non-WebGL2 context or PBO alloc failure → sync path
let pboReadbackBuffer: Uint8Array | null = null; // reused CPU-side target for getBufferSubData

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cached lookup of the shader canvas and its GL context. The typed return is
 *  WebGL2RenderingContext but may actually be a WebGL1 context ('webgl'
 *  fallback) — use `instanceof WebGL2RenderingContext` for feature checks. */
function getGL(): WebGL2RenderingContext | null {
  if (!_cachedCanvas) {
    _cachedCanvas = document.getElementById('shader-canvas') as HTMLCanvasElement | null;
  }
  if (!_cachedCanvas) return null;
  if (!_cachedGL) {
    _cachedGL = (_cachedCanvas.getContext('webgl2') || _cachedCanvas.getContext('webgl')) as WebGL2RenderingContext | null;
  }
  return _cachedGL;
}

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

  const gl = getGL();
  const canvas = _cachedCanvas;
  if (!gl || !canvas) return null;

  const width = canvas.width;
  const height = canvas.height;

  if (width !== lastW || height !== lastH) {
    buffer = new Uint8Array(width * height * 4);
  }

  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer!);
  // gl.readPixels returns bottom-to-top (needs flipping by receiver)
  return { buffer: buffer!, width, height, lastW: width, lastH: height, flipped: false };
}

/** Flip bottom-to-top pixels into the shared flipBuffer and send one output-frame message. */
function flipAndSend(bottomUp: Uint8Array, width: number, height: number, targets: OutputTargets): void {
  const needed = width * height * 4;
  if (!flipBuffer || flipBuffer.byteLength !== needed) {
    flipBuffer = new Uint8Array(needed);
  }
  const rowSize = width * 4;
  for (let y = 0; y < height; y++) {
    flipBuffer.set(
      bottomUp.subarray((height - 1 - y) * rowSize, (height - y) * rowSize),
      y * rowSize,
    );
  }
  window.electronAPI.sendOutputFrame({ data: flipBuffer, width, height, flipped: true, targets });
}

/**
 * (Re)create the two PBO slots at the given size. Returns false (and latches
 * pboUnsupported) if buffer allocation fails. Slots at a different size are
 * destroyed first — in-flight frames at the old size are dropped.
 */
function ensurePboSlots(gl: WebGL2RenderingContext, width: number, height: number): boolean {
  if (pboSlots && pboSlots[0].width === width && pboSlots[0].height === height) return true;
  destroyPboSlots(gl);

  const slots: PboSlot[] = [];
  for (let i = 0; i < 2; i++) {
    const pbo = gl.createBuffer();
    if (!pbo) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      for (const s of slots) gl.deleteBuffer(s.pbo);
      pboUnsupported = true;
      return false;
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 4, gl.STREAM_READ);
    slots.push({
      pbo,
      fence: null,
      width,
      height,
      targets: { ndi: false, syphon: false, recording: false },
      pending: false,
    });
  }
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  pboSlots = slots;
  pboWriteIndex = 0;
  return true;
}

/** Delete both PBOs and any live fences; pending frames are dropped. */
function destroyPboSlots(gl: WebGL2RenderingContext): void {
  if (!pboSlots) return;
  for (const slot of pboSlots) {
    if (slot.fence) gl.deleteSync(slot.fence);
    gl.deleteBuffer(slot.pbo);
  }
  pboSlots = null;
  pboWriteIndex = 0;
}

/**
 * Async capture: collect the oldest finished readback (if any) and send that
 * frame, then issue a non-blocking readback of the current frame into a free
 * slot. Returns false when PBOs are unavailable (caller uses the sync path).
 */
function pboCapture(gl: WebGL2RenderingContext, width: number, height: number, targets: OutputTargets): boolean {
  if (!ensurePboSlots(gl, width, height)) return false;
  const slots = pboSlots!;

  // ── Collect phase: oldest pending slot first (when both are pending, the
  // next write target is the older one). Fences signal in issue order, so if
  // the oldest hasn't signaled the newer one hasn't either — stop looking.
  for (let k = 0; k < 2; k++) {
    const slot = slots[(pboWriteIndex + k) & 1];
    if (!slot.pending) continue;
    if (slot.fence) {
      const status = gl.clientWaitSync(slot.fence, 0, 0); // timeout 0: poll, never block
      if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) break;
      gl.deleteSync(slot.fence);
      slot.fence = null;
    }
    const byteLen = slot.width * slot.height * 4;
    if (!pboReadbackBuffer || pboReadbackBuffer.byteLength !== byteLen) {
      pboReadbackBuffer = new Uint8Array(byteLen);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pboReadbackBuffer);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    slot.pending = false;
    // Send to the sinks that were due when this frame was captured — not this
    // call's targets. Managers no-op for sinks disabled since then.
    flipAndSend(pboReadbackBuffer, slot.width, slot.height, slot.targets);
    break; // at most one collect per call (matches at most one issue per call)
  }

  // ── Issue phase: async readback of the current frame into the next slot.
  const slot = slots[pboWriteIndex];
  if (slot.pending) return true; // both slots in flight, none signaled → drop this frame, never wait
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0); // offset 0 → into PBO, returns immediately
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  slot.targets = targets;
  slot.pending = true;
  pboWriteIndex ^= 1;
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function sendOutputFrames(targets: { ndi?: boolean; syphon?: boolean; recording?: boolean }): void {
  if (!targets.ndi && !targets.syphon && !targets.recording) return;

  try {
    const due: OutputTargets = { ndi: !!targets.ndi, syphon: !!targets.syphon, recording: !!targets.recording };

    if (!state.abEnabled && !pboUnsupported) {
      // Async PBO path (WebGL2 only). Never used for the A/B overlay canvas.
      const gl = getGL();
      const canvas = _cachedCanvas;
      if (gl instanceof WebGL2RenderingContext && canvas) {
        if (pboCapture(gl, canvas.width, canvas.height, due)) return;
      } else if (gl) {
        pboUnsupported = true; // WebGL1 context — use the sync path from now on
      }
    } else if (state.abEnabled && pboSlots) {
      // Entering A/B mode with readbacks in flight: drop them, or they would
      // be collected (stale, pre-A/B content) after A/B mode ends.
      const gl = getGL();
      if (gl instanceof WebGL2RenderingContext) destroyPboSlots(gl);
    }

    // Sync path: A/B overlay (getImageData) or non-WebGL2 readPixels fallback.
    const result = readCanvasPixels(outputBuffer, outputLastW, outputLastH);
    if (!result) return;

    outputBuffer = result.buffer;
    outputLastW = result.lastW;
    outputLastH = result.lastH;

    if (result.flipped) {
      // A/B path: getImageData already returns top-to-bottom
      window.electronAPI.sendOutputFrame({
        data: result.buffer,
        width: result.width,
        height: result.height,
        flipped: true,
        targets: due,
      });
    } else {
      // The IPC send structured-clones the data synchronously, so the shared
      // flipBuffer is safe to reuse on the next frame.
      flipAndSend(result.buffer, result.width, result.height, due);
    }
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
