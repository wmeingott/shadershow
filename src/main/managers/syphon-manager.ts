// SyphonManager — macOS-only Syphon video output
// Manages a SyphonSender instance for GPU texture sharing with Resolume
// and other Syphon-compatible clients. Handles vertical flip of WebGL frames.

import { Logger } from '@shared/logger.js';
import { SyphonSender } from '../syphon-sender.js';

const log = new Logger('Syphon');

/** Frame data received from the renderer process */
export interface SyphonFrameData {
  data: Uint8Array | Buffer;
  width: number;
  height: number;
  /** Legacy base64 fallback field */
  rgbaData?: string;
}

/** Status payload sent to the renderer */
export interface SyphonStatus {
  enabled: boolean;
  error?: string;
}

/** Callbacks provided by the caller (main process wiring) */
export interface SyphonManagerCallbacks {
  onStatusUpdate: (status: SyphonStatus) => void;
  onMenuUpdate: () => void;
}

export class SyphonManager {
  private sender: SyphonSender | null = null;
  private enabled = false;

  // Pre-allocated buffers for vertical frame flipping
  private flipBuffer: Buffer | null = null;
  private lastWidth = 0;
  private lastHeight = 0;

  private readonly callbacks: SyphonManagerCallbacks;

  constructor(callbacks: SyphonManagerCallbacks) {
    this.callbacks = callbacks;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Whether Syphon output is currently active */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Toggle Syphon output on/off */
  async toggle(): Promise<void> {
    if (this.enabled) {
      this.stop();
    } else {
      await this.start();
    }
  }

  /**
   * Create a SyphonSender (if needed) and start output at 1920x1080.
   * Returns early on non-macOS platforms.
   */
  async start(): Promise<void> {
    if (process.platform !== 'darwin') {
      log.info('Syphon is only available on macOS');
      return;
    }

    if (!this.sender) {
      this.sender = new SyphonSender('ShaderShow');
    }

    const success = await this.sender.start({
      width: 1920,
      height: 1080,
    });

    if (success) {
      this.enabled = true;
      this.callbacks.onStatusUpdate({ enabled: true });
      this.updateMenu();
      log.info('Syphon output started');
    } else {
      this.callbacks.onStatusUpdate({
        enabled: false,
        error: 'Failed to start Syphon',
      });
    }
  }

  /** Stop the Syphon sender and notify the renderer */
  stop(): void {
    if (this.sender) {
      this.sender.stop();
    }

    this.enabled = false;
    this.callbacks.onStatusUpdate({ enabled: false });
    this.updateMenu();
    log.info('Syphon output stopped');
  }

  /**
   * Send a single RGBA frame to the Syphon server.
   *
   * The frame is vertically flipped (WebGL readPixels produces bottom-to-top
   * scanlines, while Syphon expects top-to-bottom) using a pre-allocated
   * buffer that is only reallocated when the resolution changes.
   *
   * Accepts raw Uint8Array / Buffer data as well as a legacy base64 fallback
   * via the `rgbaData` field.
   */
  async sendFrame(frameData: SyphonFrameData): Promise<void> {
    if (!this.sender || !this.enabled) return;

    try {
      const { data, width, height } = frameData;

      // Handle both raw Uint8Array and legacy base64 format
      let sourceBuffer: Buffer;
      if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
        sourceBuffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      } else if (frameData.rgbaData) {
        // Legacy base64 format fallback
        sourceBuffer = Buffer.from(frameData.rgbaData, 'base64');
      } else {
        log.warn('Syphon frame: invalid data format');
        return;
      }

      const rowSize = width * 4;
      const bufferSize = width * height * 4;

      // Reallocate flip buffer only if resolution changed
      if (width !== this.lastWidth || height !== this.lastHeight) {
        this.flipBuffer = Buffer.allocUnsafe(bufferSize);
        this.lastWidth = width;
        this.lastHeight = height;
      }

      // Flip vertically using Buffer.copy (native, much faster than JS loops)
      for (let y = 0; y < height; y++) {
        const srcOffset = (height - 1 - y) * rowSize;
        const dstOffset = y * rowSize;
        sourceBuffer.copy(this.flipBuffer!, dstOffset, srcOffset, srcOffset + rowSize);
      }

      await this.sender.sendFrame(this.flipBuffer!, width, height);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Syphon frame send error:', message);
    }
  }

  /** Notify the caller that the application menu needs updating */
  updateMenu(): void {
    this.callbacks.onMenuUpdate();
  }
}
