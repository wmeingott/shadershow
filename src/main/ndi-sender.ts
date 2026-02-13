// NDI output sender — wraps grandiose/grandiose-mac
// Handles platform detection and graceful degradation

import { Logger, LOG_LEVEL } from '@shared/logger.js';

const log = new Logger('NDI-Send');

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

export interface NDISenderOptions {
  width?: number;
  height?: number;
  frameRateN?: number;
  frameRateD?: number;
}

export interface NDISenderStats {
  name: string;
  running: boolean;
  frameCount: number;
  width: number;
  height: number;
  frameRate: number;
}

export class NDISender {
  private name: string;
  private sender: any = null;
  private frameCount = 0;
  private startTime: bigint | null = null;
  private width = 1920;
  private height = 1080;
  private frameRateN = 60;
  private frameRateD = 1;

  constructor(name = 'ShaderShow') {
    this.name = name;
  }

  async start(options: NDISenderOptions = {}): Promise<boolean> {
    if (!grandiose) {
      log.error('NDI library not available on this platform');
      return false;
    }

    if (this.sender) {
      log.info('NDI sender already started');
      return true;
    }

    try {
      this.width = options.width || 1920;
      this.height = options.height || 1080;
      this.frameRateN = options.frameRateN || 60;
      this.frameRateD = options.frameRateD || 1;

      this.sender = await grandiose.send({
        name: this.name,
        clockVideo: true,
        clockAudio: false,
      });

      this.startTime = process.hrtime.bigint();
      this.frameCount = 0;

      log.info(`Sender "${this.name}" started at ${this.width}x${this.height} @ ${this.frameRateN}/${this.frameRateD} fps`);
      return true;
    } catch (err: any) {
      log.error(`Failed to start sender: ${err.message}`);
      this.sender = null;
      return false;
    }
  }

  stop(): void {
    if (this.sender) {
      this.sender = null;
      log.info(`Sender "${this.name}" stopped after ${this.frameCount} frames`);
    }
  }

  async sendFrame(rgbaBuffer: Buffer, width?: number, height?: number): Promise<boolean> {
    if (!this.sender) return false;

    try {
      const now = process.hrtime.bigint();
      const elapsed = now - this.startTime!;
      const seconds = Number(elapsed / 1000000000n);
      const nanoseconds = Number(elapsed % 1000000000n);

      const w = width || this.width;
      const h = height || this.height;

      const frame = {
        type: 'video',
        xres: w,
        yres: h,
        frameRateN: this.frameRateN,
        frameRateD: this.frameRateD,
        fourCC: 1094862674, // RGBA
        pictureAspectRatio: w / h,
        timestamp: [seconds, nanoseconds],
        frameFormatType: 1, // Progressive
        timecode: [seconds, nanoseconds],
        lineStrideBytes: w * 4,
        data: rgbaBuffer,
      };

      await this.sender.video(frame);
      this.frameCount++;
      return true;
    } catch (err: any) {
      log.error(`Failed to send frame: ${err.message}`);
      return false;
    }
  }

  async sendFrameBase64(base64Data: string, width: number, height: number): Promise<boolean> {
    const buffer = Buffer.from(base64Data, 'base64');
    return this.sendFrame(buffer, width, height);
  }

  isRunning(): boolean {
    return this.sender !== null;
  }

  getStats(): NDISenderStats {
    return {
      name: this.name,
      running: this.isRunning(),
      frameCount: this.frameCount,
      width: this.width,
      height: this.height,
      frameRate: this.frameRateN / this.frameRateD,
    };
  }
}
