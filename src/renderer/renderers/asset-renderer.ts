// AssetRenderer — renders images and videos for grid thumbnails and mixer compositing.
// Shares the same interface as MiniShaderRenderer so it plugs into the mixer seamlessly.

import { computeCropDraw, updateVideoLoop } from './gl-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssetParamDef {
  name: string;
  type: 'float' | 'int';
  default: number;
  min: number;
  max: number;
  step: number;
  description: string;
}

export interface AssetParamValues {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  keepAR: number;
  cropL: number;
  cropT: number;
  cropR: number;
  cropB: number;
  repeatX: number;
  repeatY: number;
  speedX: number;
  speedY: number;
  loop?: number;
  start?: number;
  end?: number;
  [key: string]: number | undefined;
}

interface LoadResult {
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Static parameter definitions shared by all asset instances
// ---------------------------------------------------------------------------

const ASSET_PARAM_DEFS: AssetParamDef[] = [
  { name: 'x',      type: 'float', default: 0,   min: -4096, max: 4096, step: 1, description: 'X position (px)' },
  { name: 'y',      type: 'float', default: 0,   min: -4096, max: 4096, step: 1, description: 'Y position (px)' },
  { name: 'width',  type: 'float', default: 0,   min: 0,     max: 8192, step: 1, description: 'Width (px, 0=canvas)' },
  { name: 'height', type: 'float', default: 0,   min: 0,     max: 8192, step: 1, description: 'Height (px, 0=canvas)' },
  { name: 'scale',  type: 'float', default: 1.0, min: 0.01,  max: 10,   step: 0.01, description: 'Scale factor' },
  { name: 'keepAR', type: 'int',   default: 1,   min: 0,     max: 1,    step: 1,    description: 'Keep aspect ratio (0/1)' },
  { name: 'cropL',  type: 'float', default: 0,   min: 0,     max: 1,    step: 0.001, description: 'Crop left (0-1)' },
  { name: 'cropT',  type: 'float', default: 0,   min: 0,     max: 1,    step: 0.001, description: 'Crop top (0-1)' },
  { name: 'cropR',  type: 'float', default: 1,   min: 0,     max: 1,    step: 0.001, description: 'Crop right (0-1)' },
  { name: 'cropB',  type: 'float', default: 1,   min: 0,     max: 1,    step: 0.001, description: 'Crop bottom (0-1)' },
  { name: 'repeatX', type: 'int',   default: 1, min: 1, max: 16,     step: 1,   description: 'Repeat horizontal' },
  { name: 'repeatY', type: 'int',   default: 1, min: 1, max: 16,     step: 1,   description: 'Repeat vertical' },
  { name: 'speedX',  type: 'float', default: 0, min: -2000, max: 2000, step: 1, description: 'Translation speed X (px/s)' },
  { name: 'speedY',  type: 'float', default: 0, min: -2000, max: 2000, step: 1, description: 'Translation speed Y (px/s)' },
];

const VIDEO_PARAM_DEFS: AssetParamDef[] = [
  { name: 'loop',  type: 'int',   default: 1, min: 0, max: 1, step: 1, description: 'Loop playback (0/1)' },
  { name: 'start', type: 'float', default: 0, min: 0, max: 3600, step: 0.1, description: 'Loop start (seconds)' },
  { name: 'end',   type: 'float', default: 0, min: 0, max: 3600, step: 0.1, description: 'Loop end (seconds, 0=full)' },
];

// ---------------------------------------------------------------------------
// AssetRenderer
// ---------------------------------------------------------------------------

export class AssetRenderer {
  canvas: HTMLCanvasElement | null;
  private ctx2d: CanvasRenderingContext2D | null;
  assetType: 'image' | 'video' | null;
  private image: HTMLImageElement | null;
  private video: HTMLVideoElement | null;
  mediaPath: string | null;
  customParamValues: AssetParamValues;
  naturalWidth: number;
  naturalHeight: number;
  private _startTime: number;

  constructor(canvas: HTMLCanvasElement | null) {
    this.canvas = canvas;
    this.ctx2d = canvas ? canvas.getContext('2d') : null;
    this.assetType = null;
    this.image = null;
    this.video = null;
    this.mediaPath = null;
    this.customParamValues = { x: 0, y: 0, width: 0, height: 0, scale: 1.0, keepAR: 1, cropL: 0, cropT: 0, cropR: 1, cropB: 1, repeatX: 1, repeatY: 1, speedX: 0, speedY: 0 };
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this._startTime = performance.now();
  }

  // Load an image from a data URL
  async loadImage(dataUrl: string): Promise<LoadResult> {
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
  async loadVideo(filePath: string): Promise<LoadResult> {
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
  private _getSource(): HTMLImageElement | HTMLVideoElement | null {
    if (this.assetType === 'video' && this.video) return this.video;
    if (this.assetType === 'image' && this.image) return this.image;
    return null;
  }

  // Handle video loop logic: seek to start if currentTime >= end
  private _updateVideoLoop(): void {
    if (this.assetType !== 'video' || !this.video) return;
    updateVideoLoop(this.video, {
      loop: this.customParamValues.loop !== undefined ? !!this.customParamValues.loop : undefined,
      start: this.customParamValues.start,
      end: this.customParamValues.end,
    });
  }

  // Render directly to an external 2D context at the given destination.
  // This is the primary method used by the mixer for compositing.
  renderDirect(ctx: CanvasRenderingContext2D, dx: number, dy: number, dw: number, dh: number): void {
    const source = this._getSource();
    if (!source) return;

    this._updateVideoLoop();

    const crop = computeCropDraw(this.naturalWidth, this.naturalHeight, this.customParamValues as unknown as Record<string, number>, dw, dh);
    if (!crop) return;
    const { x = 0, y = 0, repeatX = 1, repeatY = 1, speedX = 0, speedY = 0 } = this.customParamValues;

    if (repeatX <= 1 && repeatY <= 1 && speedX === 0 && speedY === 0) {
      // Fast path: single draw, no tiling/scrolling
      ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, x + dx, y + dy, crop.drawW, crop.drawH);
    } else {
      const tileW = crop.drawW / repeatX;
      const tileH = crop.drawH / repeatY;
      const elapsed = (performance.now() - this._startTime) / 1000;
      const offX = tileW > 0 ? ((speedX * elapsed) % tileW + tileW) % tileW : 0;
      const offY = tileH > 0 ? ((speedY * elapsed) % tileH + tileH) % tileH : 0;
      const bx = x + dx;
      const by = y + dy;
      ctx.save();
      ctx.beginPath();
      ctx.rect(bx, by, crop.drawW, crop.drawH);
      ctx.clip();
      for (let row = -1; row <= repeatY; row++) {
        for (let col = -1; col <= repeatX; col++) {
          ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh,
            bx + col * tileW + offX, by + row * tileH + offY, tileW, tileH);
        }
      }
      ctx.restore();
    }
  }

  // Render to own canvas (for grid thumbnail)
  render(): void {
    const source = this._getSource();
    if (!source || !this.canvas || !this.ctx2d) return;

    this._updateVideoLoop();

    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.ctx2d.clearRect(0, 0, cw, ch);

    // Apply crop for thumbnail
    const { cropL, cropT, cropR, cropB, repeatX = 1, repeatY = 1, speedX = 0, speedY = 0 } = this.customParamValues;
    const srcW = this.naturalWidth;
    const srcH = this.naturalHeight;
    const sx = (cropL || 0) * srcW;
    const sy = (cropT || 0) * srcH;
    const sw = ((cropR ?? 1) - (cropL || 0)) * srcW;
    const sh = ((cropB ?? 1) - (cropT || 0)) * srcH;

    if (sw > 0 && sh > 0) {
      if (repeatX <= 1 && repeatY <= 1 && speedX === 0 && speedY === 0) {
        this.ctx2d.drawImage(source, sx, sy, sw, sh, 0, 0, cw, ch);
      } else {
        const tileW = cw / repeatX;
        const tileH = ch / repeatY;
        const elapsed = (performance.now() - this._startTime) / 1000;
        const offX = tileW > 0 ? ((speedX * elapsed) % tileW + tileW) % tileW : 0;
        const offY = tileH > 0 ? ((speedY * elapsed) % tileH + tileH) % tileH : 0;
        this.ctx2d.save();
        this.ctx2d.beginPath();
        this.ctx2d.rect(0, 0, cw, ch);
        this.ctx2d.clip();
        for (let row = -1; row <= repeatY; row++) {
          for (let col = -1; col <= repeatX; col++) {
            this.ctx2d.drawImage(source, sx, sy, sw, sh,
              col * tileW + offX, row * tileH + offY, tileW, tileH);
          }
        }
        this.ctx2d.restore();
      }
    }
  }

  // Set a single parameter value
  setParam(name: string, value: number): void {
    this.customParamValues[name] = value;
  }

  // Set multiple parameters
  setParams(params: Record<string, number> | null): void {
    if (!params) return;
    for (const [name, value] of Object.entries(params)) {
      this.customParamValues[name] = value;
    }
  }

  // Return the parameter definitions for this asset type
  getCustomParamDefs(): AssetParamDef[] {
    if (this.assetType === 'video') {
      return [...ASSET_PARAM_DEFS, ...VIDEO_PARAM_DEFS];
    }
    return [...ASSET_PARAM_DEFS];
  }

  // Return current parameter values
  getCustomParamValues(): AssetParamValues {
    return { ...this.customParamValues };
  }

  // No-op — assets don't have a speed concept
  setSpeed(): void {}

  // No-op — assets don't compile
  compile(): void {}

  // Dispose resources
  dispose(): void {
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
