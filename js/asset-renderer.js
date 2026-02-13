// AssetRenderer — renders images and videos for grid thumbnails and mixer compositing.
// Shares the same interface as MiniShaderRenderer so it plugs into the mixer seamlessly.

// Static parameter definitions shared by all asset instances
const ASSET_PARAM_DEFS = [
  { name: 'x',      type: 'float', default: 0,   min: -4096, max: 4096, step: 1, description: 'X position (px)' },
  { name: 'y',      type: 'float', default: 0,   min: -4096, max: 4096, step: 1, description: 'Y position (px)' },
  { name: 'width',  type: 'float', default: 0,   min: 0,     max: 8192, step: 1, description: 'Width (px, 0=canvas)' },
  { name: 'height', type: 'float', default: 0,   min: 0,     max: 8192, step: 1, description: 'Height (px, 0=canvas)' },
  { name: 'scale',  type: 'float', default: 1.0, min: 0.01,  max: 10,   step: 0.01, description: 'Scale factor' },
];

const VIDEO_PARAM_DEFS = [
  { name: 'loop',  type: 'int',   default: 1, min: 0, max: 1, step: 1, description: 'Loop playback (0/1)' },
  { name: 'start', type: 'float', default: 0, min: 0, max: 3600, step: 0.1, description: 'Loop start (seconds)' },
  { name: 'end',   type: 'float', default: 0, min: 0, max: 3600, step: 0.1, description: 'Loop end (seconds, 0=full)' },
];

export class AssetRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx2d = canvas ? canvas.getContext('2d') : null;
    this.assetType = null;   // 'image' | 'video'
    this.image = null;
    this.video = null;
    this.mediaPath = null;   // relative path inside data/media/
    this.customParamValues = { x: 0, y: 0, width: 0, height: 0, scale: 1.0 };
    this.naturalWidth = 0;
    this.naturalHeight = 0;
  }

  // Load an image from a data URL
  async loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.image = img;
        this.video = null;
        this.assetType = 'image';
        this.naturalWidth = img.naturalWidth;
        this.naturalHeight = img.naturalHeight;
        // Set default dimensions to natural size
        if (!this.customParamValues.width) this.customParamValues.width = img.naturalWidth;
        if (!this.customParamValues.height) this.customParamValues.height = img.naturalHeight;
        this.render();
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = dataUrl;
    });
  }

  // Load a video from an absolute file path (or file:// URL)
  async loadVideo(filePath) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.loop = true;

      video.onloadedmetadata = () => {
        this.video = video;
        this.image = null;
        this.assetType = 'video';
        this.naturalWidth = video.videoWidth;
        this.naturalHeight = video.videoHeight;
        // Set default dimensions to natural size
        if (!this.customParamValues.width) this.customParamValues.width = video.videoWidth;
        if (!this.customParamValues.height) this.customParamValues.height = video.videoHeight;
        // Add video-specific defaults
        if (this.customParamValues.loop === undefined) this.customParamValues.loop = 1;
        if (this.customParamValues.start === undefined) this.customParamValues.start = 0;
        if (this.customParamValues.end === undefined) this.customParamValues.end = 0;
        video.play().catch(() => {});
        this.render();
        resolve({ width: video.videoWidth, height: video.videoHeight });
      };
      video.onerror = () => reject(new Error('Failed to load video'));
      // Convert file path to proper file:// URL (handles Windows paths)
      const fileUrl = filePath.startsWith('file://') ? filePath
        : filePath.startsWith('/') ? `file://${filePath}`
        : `file:///${filePath.replace(/\\/g, '/')}`;
      video.src = fileUrl;
    });
  }

  // Get the source element (image or video) or null
  _getSource() {
    if (this.assetType === 'video' && this.video) return this.video;
    if (this.assetType === 'image' && this.image) return this.image;
    return null;
  }

  // Handle video loop logic: seek to start if currentTime >= end
  _updateVideoLoop() {
    if (this.assetType !== 'video' || !this.video) return;
    const { loop, start, end } = this.customParamValues;
    if (loop && end > start && start >= 0) {
      if (this.video.currentTime >= end || this.video.currentTime < start) {
        this.video.currentTime = start;
      }
    }
  }

  // Render directly to an external 2D context at the given destination.
  // This is the primary method used by the mixer for compositing.
  renderDirect(ctx, dx, dy, dw, dh) {
    const source = this._getSource();
    if (!source) return;

    this._updateVideoLoop();

    const { x, y, width, height, scale } = this.customParamValues;
    const drawW = (width || dw) * scale;
    const drawH = (height || dh) * scale;

    ctx.drawImage(source, x + dx, y + dy, drawW, drawH);
  }

  // Render to own canvas (for grid thumbnail)
  render() {
    const source = this._getSource();
    if (!source || !this.canvas || !this.ctx2d) return;

    this._updateVideoLoop();

    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.ctx2d.clearRect(0, 0, cw, ch);

    // For thumbnails, scale to fit the canvas
    this.ctx2d.drawImage(source, 0, 0, cw, ch);
  }

  // Set a single parameter value
  setParam(name, value) {
    this.customParamValues[name] = value;
  }

  // Set multiple parameters
  setParams(params) {
    if (!params) return;
    for (const [name, value] of Object.entries(params)) {
      this.customParamValues[name] = value;
    }
  }

  // Return the parameter definitions for this asset type
  getCustomParamDefs() {
    if (this.assetType === 'video') {
      return [...ASSET_PARAM_DEFS, ...VIDEO_PARAM_DEFS];
    }
    return [...ASSET_PARAM_DEFS];
  }

  // Return current parameter values
  getCustomParamValues() {
    return { ...this.customParamValues };
  }

  // No-op — assets don't have a speed concept
  setSpeed() {}

  // No-op — assets don't compile
  compile() {}

  // Dispose resources
  dispose() {
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.video = null;
    }
    this.image = null;
    this.assetType = null;
    this.ctx2d = null;
  }
}

export { ASSET_PARAM_DEFS, VIDEO_PARAM_DEFS };
