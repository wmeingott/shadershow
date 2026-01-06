const grandiose = require('grandiose-mac');

class NDIReceiver {
  constructor(channel) {
    this.channel = channel;
    this.receiver = null;
    this.source = null;
    this.running = false;
    this.frameCount = 0;
    this.lastFrame = null;
    this.onFrame = null; // Callback for new frames
  }

  // Find available NDI sources on the network
  static async findSources(timeout = 3000) {
    try {
      const sources = await grandiose.find({
        showLocalSources: true
      }, timeout);
      return sources || [];
    } catch (err) {
      console.error('Failed to find NDI sources:', err.message);
      return [];
    }
  }

  async connect(source) {
    if (this.receiver) {
      await this.disconnect();
    }

    try {
      this.source = source;

      // Create receiver with RGBA color format for WebGL compatibility
      this.receiver = await grandiose.receive({
        source: source,
        colorFormat: grandiose.COLOR_FORMAT_RGBX_RGBA,
        bandwidth: grandiose.BANDWIDTH_HIGHEST,
        allowVideoFields: false, // Progressive only
        name: `ShaderShow-Ch${this.channel}`
      });

      this.running = true;
      this.frameCount = 0;
      console.log(`NDI receiver channel ${this.channel} connected to "${source.name}"`);

      // Start receiving frames
      this.receiveLoop();

      return true;
    } catch (err) {
      console.error(`Failed to connect to NDI source "${source.name}":`, err.message);
      this.receiver = null;
      this.source = null;
      return false;
    }
  }

  async disconnect() {
    this.running = false;

    if (this.receiver) {
      // Receiver will be garbage collected
      this.receiver = null;
      console.log(`NDI receiver channel ${this.channel} disconnected after ${this.frameCount} frames`);
    }

    this.source = null;
    this.lastFrame = null;
  }

  async receiveLoop() {
    while (this.running && this.receiver) {
      try {
        // Get video frame with 100ms timeout
        const frame = await this.receiver.video(100);

        if (frame && frame.data) {
          this.frameCount++;
          this.lastFrame = {
            width: frame.xres,
            height: frame.yres,
            data: frame.data,
            lineStrideBytes: frame.lineStrideBytes
          };

          // Call frame callback if set
          if (this.onFrame) {
            this.onFrame(this.channel, this.lastFrame);
          }
        }
      } catch (err) {
        // Timeout is expected, only log actual errors
        if (!err.message.includes('timeout') && !err.message.includes('Timeout')) {
          console.error(`NDI receive error on channel ${this.channel}:`, err.message);
        }
      }
    }
  }

  getLastFrame() {
    return this.lastFrame;
  }

  isConnected() {
    return this.running && this.receiver !== null;
  }

  getSource() {
    return this.source;
  }

  getStats() {
    return {
      channel: this.channel,
      connected: this.isConnected(),
      source: this.source ? this.source.name : null,
      frameCount: this.frameCount,
      hasFrame: this.lastFrame !== null,
      resolution: this.lastFrame ? `${this.lastFrame.width}x${this.lastFrame.height}` : null
    };
  }
}

module.exports = NDIReceiver;
