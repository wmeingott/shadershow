// Syphon output sender — macOS only
// Uses node-syphon for GPU texture sharing with Resolume and other Syphon clients

import { Logger } from '@shared/logger.js';

const log = new Logger('Syphon');

// Only load on macOS
let SyphonServer: any = null;
if (process.platform === 'darwin') {
  try {
    const nodeSyphon = require('node-syphon');
    SyphonServer = nodeSyphon.SyphonMetalServer || nodeSyphon.SyphonOpenGLServer;
  } catch (err: any) {
    log.warn(`Syphon library not available: ${err.message}`);
  }
}

export interface SyphonSenderStats {
  name: string;
  running: boolean;
  frameCount: number;
  width: number;
  height: number;
}

export class SyphonSender {
  private name: string;
  private server: any = null;
  private frameCount = 0;
  private width = 1920;
  private height = 1080;

  constructor(name = 'ShaderShow') {
    this.name = name;
  }

  async start(options: { width?: number; height?: number } = {}): Promise<boolean> {
    if (!SyphonServer) {
      log.error('Syphon not available (macOS only or node-syphon not installed)');
      return false;
    }

    if (this.server) {
      log.info('Syphon server already started');
      return true;
    }

    try {
      this.width = options.width || 1920;
      this.height = options.height || 1080;

      this.server = new SyphonServer(this.name);
      this.frameCount = 0;

      log.info(`Server "${this.name}" started at ${this.width}x${this.height}`);
      return true;
    } catch (err: any) {
      log.error(`Failed to start server: ${err.message}`);
      this.server = null;
      return false;
    }
  }

  stop(): void {
    if (this.server) {
      try {
        this.server.stop();
      } catch {
        // Server may not have stop method
      }
      this.server = null;
      log.info(`Server "${this.name}" stopped after ${this.frameCount} frames`);
    }
  }

  async sendFrame(rgbaBuffer: Buffer, width?: number, height?: number): Promise<boolean> {
    if (!this.server) return false;

    try {
      const w = width || this.width;
      const h = height || this.height;

      const data = new Uint8ClampedArray(
        rgbaBuffer.buffer, rgbaBuffer.byteOffset, rgbaBuffer.length
      );

      const region = { x: 0, y: 0, width: w, height: h };
      const dimensions = { width: w, height: h };

      this.server.publishImageData(data, region, dimensions, false);
      this.frameCount++;
      return true;
    } catch (err: any) {
      log.error(`Failed to send frame: ${err.message}`);
      return false;
    }
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  getStats(): SyphonSenderStats {
    return {
      name: this.name,
      running: this.isRunning(),
      frameCount: this.frameCount,
      width: this.width,
      height: this.height,
    };
  }
}
