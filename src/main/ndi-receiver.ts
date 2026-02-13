// NDI input receiver — receives video frames from NDI sources on the network

import { Logger } from '@shared/logger.js';

const log = new Logger('NDI-Recv');

// Load platform-appropriate NDI library
let grandiose: any = null;
try {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    grandiose = require('grandiose-mac');
  } else {
    grandiose = require('grandiose');
  }
} catch (err: any) {
  log.warn(`NDI library not available: ${err.message}`);
}

export interface NDISource {
  name: string;
  urlAddress: string;
}

export interface NDIFrame {
  width: number;
  height: number;
  data: Buffer;
  lineStrideBytes: number;
}

export type FrameCallback = (channel: number, frame: NDIFrame) => void;

export interface NDIReceiverStats {
  channel: number;
  connected: boolean;
  source: string | null;
  frameCount: number;
  hasFrame: boolean;
  resolution: string | null;
}

export class NDIReceiver {
  private channel: number;
  private receiver: any = null;
  private source: NDISource | null = null;
  private running = false;
  private frameCount = 0;
  private lastFrame: NDIFrame | null = null;
  onFrame: FrameCallback | null = null;

  constructor(channel: number) {
    this.channel = channel;
  }

  /** Find available NDI sources on the network */
  static async findSources(timeout = 3000): Promise<NDISource[]> {
    if (!grandiose) {
      log.error('NDI library not available on this platform');
      return [];
    }

    try {
      const sources = await grandiose.find({ showLocalSources: true }, timeout);
      return sources || [];
    } catch (err: any) {
      log.error(`Failed to find NDI sources: ${err.message}`);
      return [];
    }
  }

  async connect(source: NDISource): Promise<boolean> {
    if (!grandiose) {
      log.error('NDI library not available on this platform');
      return false;
    }

    if (this.receiver) {
      await this.disconnect();
    }

    try {
      this.source = source;

      this.receiver = await grandiose.receive({
        source,
        colorFormat: grandiose.COLOR_FORMAT_RGBX_RGBA,
        bandwidth: grandiose.BANDWIDTH_HIGHEST,
        allowVideoFields: false,
        name: `ShaderShow-Ch${this.channel}`,
      });

      this.running = true;
      this.frameCount = 0;
      log.info(`Channel ${this.channel} connected to "${source.name}"`);

      this.receiveLoop();
      return true;
    } catch (err: any) {
      log.error(`Failed to connect to "${source.name}": ${err.message}`);
      this.receiver = null;
      this.source = null;
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.running = false;

    if (this.receiver) {
      this.receiver = null;
      log.info(`Channel ${this.channel} disconnected after ${this.frameCount} frames`);
    }

    this.source = null;
    this.lastFrame = null;
  }

  private async receiveLoop(): Promise<void> {
    while (this.running && this.receiver) {
      try {
        const frame = await this.receiver.video(100);

        if (frame && frame.data) {
          this.frameCount++;
          this.lastFrame = {
            width: frame.xres,
            height: frame.yres,
            data: frame.data,
            lineStrideBytes: frame.lineStrideBytes,
          };

          if (this.onFrame) {
            this.onFrame(this.channel, this.lastFrame);
          }
        }
      } catch (err: any) {
        if (!err.message.includes('timeout') && !err.message.includes('Timeout')) {
          log.error(`Receive error on channel ${this.channel}: ${err.message}`);
        }
      }
    }
  }

  getLastFrame(): NDIFrame | null {
    return this.lastFrame;
  }

  isConnected(): boolean {
    return this.running && this.receiver !== null;
  }

  getSource(): NDISource | null {
    return this.source;
  }

  getStats(): NDIReceiverStats {
    return {
      channel: this.channel,
      connected: this.isConnected(),
      source: this.source ? this.source.name : null,
      frameCount: this.frameCount,
      hasFrame: this.lastFrame !== null,
      resolution: this.lastFrame ? `${this.lastFrame.width}x${this.lastFrame.height}` : null,
    };
  }
}
