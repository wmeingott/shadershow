// NDIManager — manages NDI output (sender) and input (receivers)
// Extracted from main.js NDI-related code

import { Logger } from '@shared/logger.js';
import { NDISender } from '../ndi-sender.js';
import { NDIReceiver } from '../ndi-receiver.js';
import type { Resolution } from '@shared/types/settings.js';

const log = new Logger('NDI');

/** Status payload sent to the renderer */
export interface NDIStatus {
  enabled: boolean;
  native?: boolean;
  width?: number;
  height?: number;
  error?: string;
}

/** Frame data received from an NDI input source */
export interface NDIInputFrame {
  channel: number;
  width: number;
  height: number;
  data: Buffer;
}

/** Data sent when an NDI source is connected to a channel */
export interface NDISourceSetData {
  channel: number;
  source: string;
  width: number;
  height: number;
}

/** Frame data received from the renderer for NDI output */
export interface NDIOutputFrameData {
  data: Uint8Array | Buffer;
  width: number;
  height: number;
  flipped?: boolean;
  rgbaData?: string; // Legacy base64 format
}

/** Callbacks for communicating with the main window and menu system */
export interface NDIManagerCallbacks {
  onStatusUpdate: (status: NDIStatus) => void;
  onFrameCallback: (channel: number, frame: { width: number; height: number; data: Buffer }) => void;
  onSourceSet: (data: NDISourceSetData) => void;
  onMenuRebuild: () => void;
  onShowCustomDialog: () => void;
  onRequestPreviewResolution: () => void;
}

/**
 * Manages NDI output (sender) and input (receivers).
 *
 * Holds the NDI sender, per-channel receivers, source cache, and
 * pre-allocated flip buffers. Delegates UI updates to the host
 * via the callback interface supplied at construction time.
 */
export class NDIManager {
  // ── State ────────────────────────────────────────────────────────────
  private ndiEnabled = false;
  private ndiSender: NDISender | null = null;
  private ndiResolution: Resolution = { width: 1920, height: 1080, label: '1920x1080 (1080p)' };
  private ndiFrameSkip = 4;
  private ndiReceivers: (NDIReceiver | null)[] = [null, null, null, null];
  private ndiSourceCache: Array<{ name: string; urlAddress: string }> = [];

  // Pre-allocated buffers for NDI frame flipping (avoid allocation per frame)
  private ndiFlipBuffer: Buffer | null = null;
  private ndiLastWidth = 0;
  private ndiLastHeight = 0;

  // ── Callbacks ────────────────────────────────────────────────────────
  private readonly callbacks: NDIManagerCallbacks;

  constructor(callbacks: NDIManagerCallbacks) {
    this.callbacks = callbacks;
  }

  // ── Accessors ────────────────────────────────────────────────────────

  isEnabled(): boolean {
    return this.ndiEnabled;
  }

  getResolution(): Resolution {
    return this.ndiResolution;
  }

  getFrameSkip(): number {
    return this.ndiFrameSkip;
  }

  setFrameSkip(value: number): void {
    if (typeof value === 'number' && value >= 1) {
      this.ndiFrameSkip = value;
    }
  }

  getSourceCache(): Array<{ name: string; urlAddress: string }> {
    return this.ndiSourceCache;
  }

  getReceiver(channel: number): NDIReceiver | null {
    return this.ndiReceivers[channel] ?? null;
  }

  // ── Resolution management ───────────────────────────────────────────

  /**
   * Set NDI output resolution.
   *
   * Special sentinel values:
   *   - `width === -1` triggers the custom resolution dialog callback
   *   - `width === 0`  triggers the match-preview-resolution callback
   *
   * Otherwise sets the resolution directly and restarts output if running.
   */
  async setNDIResolution(res: Resolution): Promise<void> {
    if (res.width === -1) {
      // Custom resolution -- delegate to the host to show a dialog
      this.callbacks.onShowCustomDialog();
      return;
    }

    if (res.width === 0) {
      // Match preview -- ask renderer for its current size
      this.callbacks.onRequestPreviewResolution();
      return;
    }

    this.ndiResolution = res;
    log.debug(`Resolution set to ${res.label}`);

    // If NDI is running, restart with new resolution
    if (this.ndiEnabled) {
      await this.restartNDIWithNewResolution();
    }

    // Rebuild menu to update radio buttons
    this.callbacks.onMenuRebuild();
  }

  /**
   * Set a custom resolution from the dialog.
   * Validates dimensions and applies the new resolution.
   */
  async setCustomResolution(width: number, height: number): Promise<void> {
    if (width < 128 || height < 128 || width > 7680 || height > 4320) {
      log.warn(`Invalid custom resolution: ${width}x${height}`);
      return;
    }

    const res: Resolution = {
      width,
      height,
      label: `${width}x${height} (Custom)`,
    };

    await this.setNDIResolution(res);
  }

  // ── Output control ──────────────────────────────────────────────────

  /** Toggle NDI output on or off. */
  toggleNDIOutput(): void {
    if (this.ndiEnabled) {
      this.stopNDIOutput();
    } else {
      void this.startNDIOutput();
    }
  }

  /** Create NDI sender (if needed) and start output at the current resolution. */
  async startNDIOutput(): Promise<void> {
    if (!this.ndiSender) {
      this.ndiSender = new NDISender('ShaderShow');
    }

    // Use selected NDI resolution
    const success = await this.ndiSender.start({
      width: this.ndiResolution.width,
      height: this.ndiResolution.height,
      frameRateN: 60,
      frameRateD: 1,
    });

    if (success) {
      this.ndiEnabled = true;
      this.callbacks.onStatusUpdate({
        enabled: true,
        native: true,
        width: this.ndiResolution.width,
        height: this.ndiResolution.height,
      });
      this.callbacks.onMenuRebuild();
      log.info(`Output started (${this.ndiResolution.width}x${this.ndiResolution.height})`);
    } else {
      this.callbacks.onStatusUpdate({ enabled: false, error: 'Failed to start NDI' });
    }
  }

  /** Stop NDI output. */
  stopNDIOutput(): void {
    if (this.ndiSender) {
      this.ndiSender.stop();
    }

    this.ndiEnabled = false;
    this.callbacks.onStatusUpdate({ enabled: false });
    this.callbacks.onMenuRebuild();
    log.info('Output stopped');
  }

  /** Stop and restart NDI output with the current resolution. */
  async restartNDIWithNewResolution(): Promise<void> {
    if (this.ndiSender) {
      this.ndiSender.stop();
    }
    await this.startNDIOutput();
  }

  // ── Frame sending ───────────────────────────────────────────────────

  /**
   * Send a single frame to the NDI output.
   *
   * Accepts raw RGBA data from the renderer. If `flipped` is true the data
   * is already vertically flipped and is sent directly. Otherwise the frame
   * is flipped in-place using a pre-allocated buffer before sending.
   */
  async sendNDIFrame(frameData: NDIOutputFrameData): Promise<void> {
    if (!this.ndiSender || !this.ndiEnabled) return;

    try {
      const { data, width, height, flipped } = frameData;

      // Handle both raw Uint8Array and legacy base64 format
      let sourceBuffer: Buffer;
      if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
        sourceBuffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      } else if (frameData.rgbaData) {
        // Legacy base64 format fallback
        sourceBuffer = Buffer.from(frameData.rgbaData, 'base64');
      } else {
        log.warn('Frame: invalid data format');
        return;
      }

      // If already flipped by renderer (async PBO readback), send directly
      if (flipped) {
        await this.ndiSender.sendFrame(sourceBuffer, width, height);
        return;
      }

      // Otherwise flip vertically (sync readback path)
      const rowSize = width * 4;
      const bufferSize = width * height * 4;

      // Reallocate flip buffer only if resolution changed
      if (width !== this.ndiLastWidth || height !== this.ndiLastHeight) {
        this.ndiFlipBuffer = Buffer.allocUnsafe(bufferSize);
        this.ndiLastWidth = width;
        this.ndiLastHeight = height;
      }

      // Flip vertically using Buffer.copy (native, much faster than JS loops)
      // WebGL readPixels gives bottom-to-top, NDI expects top-to-bottom
      for (let y = 0; y < height; y++) {
        const srcOffset = (height - 1 - y) * rowSize;
        const dstOffset = y * rowSize;
        sourceBuffer.copy(this.ndiFlipBuffer!, dstOffset, srcOffset, srcOffset + rowSize);
      }

      await this.ndiSender.sendFrame(this.ndiFlipBuffer!, width, height);
    } catch (e: any) {
      log.warn('Frame send error:', e.message);
    }
  }

  // ── Source discovery & input ─────────────────────────────────────────

  /** Scan the network for available NDI sources. */
  async refreshNDISources(): Promise<Array<{ name: string; urlAddress: string }>> {
    log.debug('Searching for NDI sources...');
    this.ndiSourceCache = await NDIReceiver.findSources(3000);
    log.debug(`Found ${this.ndiSourceCache.length} NDI sources`, this.ndiSourceCache.map(s => s.name));
    return this.ndiSourceCache;
  }

  /**
   * Connect a channel to an NDI input source.
   *
   * Disconnects any existing receiver on the channel, creates a new one,
   * sets up the frame callback, and notifies the host on success.
   */
  async useNDISource(channel: number, source: { name: string; urlAddress: string }): Promise<void> {
    log.info(`Connecting channel ${channel} to NDI source "${source.name}"`);

    // Disconnect existing receiver on this channel
    if (this.ndiReceivers[channel]) {
      await this.ndiReceivers[channel]!.disconnect();
    }

    // Create new receiver
    const receiver = new NDIReceiver(channel);

    // Set up frame callback to forward frames to the host
    receiver.onFrame = (ch: number, frame: { width: number; height: number; data: Buffer }) => {
      const frameBuffer = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
      this.callbacks.onFrameCallback(ch, {
        width: frame.width,
        height: frame.height,
        data: frameBuffer,
      });
    };

    const success = await receiver.connect(source);

    if (success) {
      this.ndiReceivers[channel] = receiver;
      const lastFrame = receiver.getLastFrame();
      this.callbacks.onSourceSet({
        channel,
        source: source.name,
        width: lastFrame?.width ?? 0,
        height: lastFrame?.height ?? 0,
      });
      this.callbacks.onMenuRebuild(); // Update menu to show checked state
    } else {
      log.error(`Failed to connect to NDI source "${source.name}"`);
    }
  }

  /**
   * Disconnect the NDI receiver on the given channel.
   */
  clearChannelNDI(channel: number): void {
    if (!Number.isInteger(channel) || channel < 0 || channel >= this.ndiReceivers.length) {
      return;
    }

    const receiver = this.ndiReceivers[channel];
    if (receiver) {
      void receiver.disconnect();
      this.ndiReceivers[channel] = null;
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────

  /** Stop all NDI activity (sender + all receivers). Call on app quit. */
  dispose(): void {
    this.stopNDIOutput();

    for (let i = 0; i < this.ndiReceivers.length; i++) {
      this.clearChannelNDI(i);
    }
  }
}
