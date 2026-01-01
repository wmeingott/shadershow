const grandiose = require('grandiose-mac');

class NDISender {
  constructor(name = 'ShaderShow') {
    this.name = name;
    this.sender = null;
    this.frameCount = 0;
    this.startTime = null;
    this.width = 1920;
    this.height = 1080;
    this.frameRateN = 60;
    this.frameRateD = 1;
  }

  async start(options = {}) {
    if (this.sender) {
      console.log('NDI sender already started');
      return true;
    }

    try {
      this.width = options.width || 1920;
      this.height = options.height || 1080;
      this.frameRateN = options.frameRateN || 60;
      this.frameRateD = options.frameRateD || 1;

      // Note: grandiose.send() returns a Promise
      this.sender = await grandiose.send({
        name: this.name,
        clockVideo: true,
        clockAudio: false
      });

      this.startTime = process.hrtime.bigint();
      this.frameCount = 0;

      console.log(`NDI sender "${this.name}" started at ${this.width}x${this.height} @ ${this.frameRateN}/${this.frameRateD} fps`);
      return true;
    } catch (err) {
      console.error('Failed to start NDI sender:', err.message);
      this.sender = null;
      return false;
    }
  }

  stop() {
    if (this.sender) {
      this.sender = null;
      console.log(`NDI sender "${this.name}" stopped after ${this.frameCount} frames`);
    }
  }

  async sendFrame(rgbaBuffer, width, height) {
    if (!this.sender) {
      return false;
    }

    try {
      // Calculate timestamp
      const now = process.hrtime.bigint();
      const elapsed = now - this.startTime;
      const seconds = Number(elapsed / 1000000000n);
      const nanoseconds = Number(elapsed % 1000000000n);

      // Create video frame
      const frame = {
        type: 'video',
        xres: width || this.width,
        yres: height || this.height,
        frameRateN: this.frameRateN,
        frameRateD: this.frameRateD,
        fourCC: 1094862674, // RGBA
        pictureAspectRatio: (width || this.width) / (height || this.height),
        timestamp: [seconds, nanoseconds],
        frameFormatType: 1, // Progressive
        timecode: [seconds, nanoseconds],
        lineStrideBytes: (width || this.width) * 4,
        data: rgbaBuffer
      };

      await this.sender.video(frame);
      this.frameCount++;
      return true;
    } catch (err) {
      console.error('Failed to send NDI frame:', err.message);
      return false;
    }
  }

  // Send frame from base64-encoded RGBA data
  async sendFrameBase64(base64Data, width, height) {
    const buffer = Buffer.from(base64Data, 'base64');
    return this.sendFrame(buffer, width, height);
  }

  // Convert JPEG to RGBA and send (for compatibility with existing code)
  async sendFrameFromCanvas(canvasDataUrl) {
    // This would require sharp or jimp to decode JPEG
    // For now, we expect raw RGBA data
    console.warn('sendFrameFromCanvas requires raw RGBA data, not JPEG');
    return false;
  }

  isRunning() {
    return this.sender !== null;
  }

  getStats() {
    return {
      name: this.name,
      running: this.isRunning(),
      frameCount: this.frameCount,
      width: this.width,
      height: this.height,
      frameRate: this.frameRateN / this.frameRateD
    };
  }
}

module.exports = NDISender;
