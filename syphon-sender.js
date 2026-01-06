// Syphon output sender - macOS only
// Uses node-syphon for GPU texture sharing with Resolume and other Syphon clients

let SyphonServer = null;

// Only load on macOS
if (process.platform === 'darwin') {
  try {
    const nodeSyphon = require('node-syphon');
    SyphonServer = nodeSyphon.SyphonMetalServer || nodeSyphon.SyphonOpenGLServer;
  } catch (err) {
    console.warn('Syphon library not available:', err.message);
  }
}

class SyphonSender {
  constructor(name = 'ShaderShow') {
    this.name = name;
    this.server = null;
    this.frameCount = 0;
    this.width = 1920;
    this.height = 1080;
  }

  async start(options = {}) {
    if (!SyphonServer) {
      console.error('Syphon not available (macOS only or node-syphon not installed)');
      return false;
    }

    if (this.server) {
      console.log('Syphon server already started');
      return true;
    }

    try {
      this.width = options.width || 1920;
      this.height = options.height || 1080;

      this.server = new SyphonServer(this.name);
      this.frameCount = 0;

      console.log(`Syphon server "${this.name}" started at ${this.width}x${this.height}`);
      return true;
    } catch (err) {
      console.error('Failed to start Syphon server:', err.message);
      this.server = null;
      return false;
    }
  }

  stop() {
    if (this.server) {
      try {
        this.server.stop();
      } catch (err) {
        // Server may not have stop method, just null it
      }
      this.server = null;
      console.log(`Syphon server "${this.name}" stopped after ${this.frameCount} frames`);
    }
  }

  async sendFrame(rgbaBuffer, width, height) {
    if (!this.server) {
      return false;
    }

    try {
      const w = width || this.width;
      const h = height || this.height;

      // Convert Buffer to Uint8ClampedArray for node-syphon
      const data = new Uint8ClampedArray(rgbaBuffer.buffer, rgbaBuffer.byteOffset, rgbaBuffer.length);

      // Define the region and texture dimensions
      const region = { x: 0, y: 0, width: w, height: h };
      const dimensions = { width: w, height: h };

      // Publish frame - flipped=false since we already flip in capture
      this.server.publishImageData(data, region, dimensions, false);

      this.frameCount++;
      return true;
    } catch (err) {
      console.error('Failed to send Syphon frame:', err.message);
      return false;
    }
  }

  isRunning() {
    return this.server !== null;
  }

  getStats() {
    return {
      name: this.name,
      running: this.isRunning(),
      frameCount: this.frameCount,
      width: this.width,
      height: this.height
    };
  }
}

module.exports = SyphonSender;
