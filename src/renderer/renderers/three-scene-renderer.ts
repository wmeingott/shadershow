// =============================================================================
// Three.js Scene Renderer (TypeScript)
// Renders Three.js scenes with the same interface as ShaderRenderer
//
// Scene files use .scene.js or .jsx extension and export setup/animate/cleanup functions
// Parameters are defined via @param comments like shaders
// JSX files are automatically compiled using Babel
// =============================================================================

import type {
  ParamDef, ParamValue, ParamValues, ParamArrayValue,
} from '@shared/types/params.js';
import type {
  IRenderer, CompileResult, RenderStats, ChannelType,
} from '@shared/types/renderer.js';
import { parseShaderParams, createParamValues } from '@shared/param-parser.js';
import { BeatDetector } from './beat-detector.js';

// Three.js is loaded dynamically via script tag -- use `any` for all THREE types
type THREE = any;
// Babel is loaded dynamically via script tag
type Babel = any;

// ---------------------------------------------------------------------------
// Logger (non-module compatible)
// ---------------------------------------------------------------------------

interface Logger {
  _level: number;
  debug(msg: string, ...a: unknown[]): void;
  info(msg: string, ...a: unknown[]): void;
  warn(msg: string, ...a: unknown[]): void;
  error(msg: string, ...a: unknown[]): void;
}

const _tsrLog: Logger = {
  _level: 2, // default WARN, set higher by renderer module if --dev
  debug(msg: string, ...a: unknown[]) { if (this._level >= 4) console.debug('[Scene]', msg, ...a); },
  info(msg: string, ...a: unknown[])  { if (this._level >= 3) console.info('[Scene]', msg, ...a); },
  warn(msg: string, ...a: unknown[])  { if (this._level >= 2) console.warn('[Scene]', msg, ...a); },
  error(msg: string, ...a: unknown[]) { if (this._level >= 1) console.error('[Scene]', msg, ...a); },
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Mouse state compatible with ShaderRenderer */
interface MouseState {
  x: number;
  y: number;
  clickX: number;
  clickY: number;
  isDown: boolean;
}

/** Result of a scene setup() call */
interface SceneSetupResult {
  scene?: any;
  camera?: any;
  renderer?: any;
  objects?: any;
  [key: string]: any;
}

/** The module object returned by evaluating scene source */
interface SceneModule {
  setup: ((THREE: any, canvas: HTMLCanvasElement, params: ParamValues, channels: any[], mouse: MouseState) => SceneSetupResult | void) | null;
  animate: ((...args: any[]) => void) | null;
  cleanup: ((objects: any) => void) | null;
}

/** Audio source tracking for a channel */
interface AudioSource {
  audioContext: AudioContext;
  analyser: AnalyserNode;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  frequencyData: Uint8Array<ArrayBuffer>;
  timeDomainData: Uint8Array<ArrayBuffer>;
}

/** NDI channel data */
interface NDIChannelData {
  width: number;
  height: number;
  data: Uint8Array | null;
  needsUpdate: boolean;
  sourceName: string;
}

/** Extended render stats returned by ThreeSceneRenderer */
interface SceneRenderStats extends RenderStats {
  time: number;
  frame: number;
  bpm: number;
}

/** Stats snapshot */
interface SceneStats {
  fps: number;
  time: number;
  frame: number;
  isPlaying: boolean;
}

type AnimateSignature = 'time-first' | 'objects-first';

// =============================================================================
// ThreeSceneRenderer Class
// =============================================================================

export class ThreeSceneRenderer implements IRenderer {
  private canvas: HTMLCanvasElement;
  private THREE: any;

  // Scene state
  private scene: any | null = null;
  private camera: any | null = null;
  private threeRenderer: any | null = null;
  private sceneModule: SceneModule | null = null;
  private sceneObjects: any | null = null;
  private sceneSource: string | null = null;
  private animateSignature: AnimateSignature = 'time-first';

  // Playback state
  private isPlaying: boolean = true;
  private startTime: number = performance.now();
  private pausedTime: number = 0;
  private lastFrameTime: number = performance.now();
  private frameCount: number = 0;
  private fps: number = 0;
  private fpsFrames: number = 0;
  private fpsLastTime: number = performance.now();

  // Mouse state (compatible with ShaderRenderer)
  private mouse: MouseState = { x: 0, y: 0, clickX: 0, clickY: 0, isDown: false };

  // Channel textures (for compatibility - scenes can use these)
  private channelTextures: Array<any | null> = [null, null, null, null];
  private channelThreeTextures: Array<any | null> = [null, null, null, null];
  private channelResolutions: Array<[number, number, number]> = [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]];
  private channelVideoSources: Array<HTMLVideoElement | null> = [null, null, null, null];
  private channelTypes: ChannelType[] = ['empty', 'empty', 'empty', 'empty'];
  private channelAudioSources: Array<AudioSource | null> = [null, null, null, null];
  private channelNDIData: Array<NDIChannelData | null> = [null, null, null, null];

  // Custom parameters
  private customParams: ParamDef[] = [];
  private customParamValues: ParamValues = {};

  // Beat detector for BPM estimation from audio
  private beatDetector: BeatDetector = new BeatDetector();

  // Legacy params for compatibility
  private params: { speed: number; [key: string]: number } = { speed: 1.0 };

  // Bound mouse event handlers (for cleanup in dispose)
  private _onMouseDown: ((e: MouseEvent) => void) | null = null;
  private _onMouseUp: (() => void) | null = null;
  private _onMouseMove: ((e: MouseEvent) => void) | null = null;
  private _onMouseLeave: (() => void) | null = null;

  // Throttle runtime error reporting
  private _lastRuntimeError: number = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.THREE = (window as any).THREE;

    if (!this.THREE) {
      throw new Error('Three.js not loaded. Include THREE library before using ThreeSceneRenderer.');
    }

    // Initialize Three.js renderer
    this.initThreeRenderer();
    this.setupMouseEvents();
  }

  private initThreeRenderer(): void {
    _tsrLog.debug('Initializing Three.js renderer');
    const THREE = this.THREE;

    this.threeRenderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      preserveDrawingBuffer: true, // Required for readPixels (NDI/Syphon)
      alpha: false
    });

    this.threeRenderer.setPixelRatio(1); // Use 1:1 for consistent resolution
    this.threeRenderer.shadowMap.enabled = true;
    this.threeRenderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Create default scene and camera
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);

    this.camera = new THREE.PerspectiveCamera(
      60,
      this.canvas.width / this.canvas.height,
      0.1,
      1000
    );
    this.camera.position.set(0, 5, 10);
    this.camera.lookAt(0, 0, 0);
  }

  private setupMouseEvents(): void {
    // Store bound handlers for cleanup in dispose()
    this._onMouseDown = (e: MouseEvent): void => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      this.mouse.clickX = (e.clientX - rect.left) * scaleX;
      this.mouse.clickY = this.canvas.height - (e.clientY - rect.top) * scaleY;
      this.mouse.isDown = true;
    };

    this._onMouseUp = (): void => {
      this.mouse.isDown = false;
    };

    this._onMouseMove = (e: MouseEvent): void => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      this.mouse.x = (e.clientX - rect.left) * scaleX;
      this.mouse.y = this.canvas.height - (e.clientY - rect.top) * scaleY;
    };

    this._onMouseLeave = (): void => {
      this.mouse.isDown = false;
    };

    this.canvas.addEventListener('mousedown', this._onMouseDown);
    this.canvas.addEventListener('mouseup', this._onMouseUp);
    this.canvas.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('mouseleave', this._onMouseLeave);
  }

  setResolution(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.threeRenderer.setSize(width, height, false);

    if (this.camera) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
  }

  // Compile/load a scene from source code
  // Supports both plain JS and JSX (automatically compiled via Babel)
  compile(sceneSource: string, isJSX: boolean = false): CompileResult {
    const THREE = this.THREE;
    _tsrLog.info('Compiling scene', sceneSource.length, 'chars');

    // Store source for reference
    this.sceneSource = sceneSource;

    // Parse custom parameters from comments
    this.customParams = parseShaderParams(sceneSource);
    this.customParamValues = createParamValues(this.customParams);

    // Cleanup previous scene
    this.cleanup();

    try {
      let compiledSource = sceneSource;

      // Compile JSX if needed
      if (isJSX || this.detectJSX(sceneSource)) {
        compiledSource = this.compileJSX(sceneSource);
      }

      // Extract scene functions from the source
      // Support both module exports and direct function definitions
      const moduleCode = `
        // Prevent React hooks from erroring (provide stubs)
        const useEffect = (fn) => fn();
        const useRef = (init) => ({ current: init });
        const useState = (init) => [init, () => {}];

        ${compiledSource}

        // Return the scene functions
        return {
          setup: typeof setup !== 'undefined' ? setup : null,
          animate: typeof animate !== 'undefined' ? animate : null,
          cleanup: typeof cleanup !== 'undefined' ? cleanup : null
        };
      `;

      // Create the module function
      const createModule = new Function('THREE', 'canvas', 'params', 'channels', 'mouse', moduleCode) as
        (THREE: any, canvas: HTMLCanvasElement, params: ParamValues, channels: any[], mouse: MouseState) => SceneModule;

      // Execute to get the module exports
      this.sceneModule = createModule(THREE, this.canvas, this.customParamValues, this.channelThreeTextures, this.mouse);
      this.animateSignature = this.detectAnimateSignature(this.sceneModule.animate);

      // Call setup to initialize the scene
      if (this.sceneModule.setup) {
        const result = this.sceneModule.setup(THREE, this.canvas, this.customParamValues, this.channelThreeTextures, this.mouse);

        if (result) {
          if (result.scene) this.scene = result.scene;
          if (result.camera) this.camera = result.camera;
          if (result.renderer) {
            // Scene provided its own renderer - use it but ensure preserveDrawingBuffer
            this.threeRenderer.dispose();
            this.threeRenderer = result.renderer;
            this.threeRenderer.preserveDrawingBuffer = true;
          }
          this.sceneObjects = result.objects || result;
        }
      }

      // Update camera aspect ratio
      if (this.camera) {
        this.camera.aspect = this.canvas.width / this.canvas.height;
        this.camera.updateProjectionMatrix();
      }

      _tsrLog.debug('Compiled', sceneSource.length, 'chars,', this.customParams.length, 'params');
      return { success: true };
    } catch (err: any) {
      // Try to extract line number from error
      const lineMatch = err.stack?.match(/<anonymous>:(\d+)/);
      const line = lineMatch ? parseInt(lineMatch[1], 10) - 6 : null; // Adjust for wrapper

      _tsrLog.error('Compile failed:', err.message);
      throw {
        message: err.message,
        line: line,
        raw: err.stack || err.message
      };
    }
  }

  // Detect if source contains JSX syntax
  private detectJSX(source: string): boolean {
    // Look for JSX patterns: <Component, <div, etc.
    return /<[A-Za-z][^>]*>/.test(source) || /className=/.test(source);
  }

  // Parse parameter names from function source for compatibility heuristics
  private getFunctionParamNames(fn: unknown): string[] {
    if (typeof fn !== 'function') return [];
    const source = fn.toString().trim();
    const listMatch = source.match(/^[^(]*\(([^)]*)\)/);
    if (listMatch) {
      const raw = listMatch[1].trim();
      return raw ? raw.split(',').map((p: string) => p.trim()) : [];
    }

    const arrowMatch = source.match(/^([A-Za-z_$][\w$]*)\s*=>/);
    if (arrowMatch) {
      return [arrowMatch[1]];
    }

    return [];
  }

  // Support both animate signatures:
  // 1) animate(time, delta, params, objects, mouse, channels)
  // 2) animate(objects, time, delta, params, mouse, channels)
  private detectAnimateSignature(animateFn: unknown): AnimateSignature {
    const params = this.getFunctionParamNames(animateFn);
    if (params.length === 0) return 'time-first';

    const firstParam = params[0].toLowerCase();
    if (firstParam === 'context' || firstParam === 'ctx' || firstParam === 'objects' || firstParam === 'sceneobjects') {
      return 'objects-first';
    }

    return 'time-first';
  }

  // Compile JSX to JavaScript using Babel
  private compileJSX(source: string): string {
    const BabelRef: Babel = (window as any).Babel;

    if (!BabelRef) {
      _tsrLog.warn('Babel not loaded, JSX compilation skipped');
      return source;
    }

    try {
      const result = BabelRef.transform(source, {
        presets: ['react'],
        plugins: [],
        filename: 'scene.jsx'
      });
      return result.code;
    } catch (err: any) {
      throw new Error(`JSX compilation error: ${err.message}`);
    }
  }

  private cleanup(): void {
    // Call scene's cleanup function if available
    if (this.sceneModule?.cleanup && this.sceneObjects) {
      try {
        this.sceneModule.cleanup(this.sceneObjects);
      } catch (e: any) {
        _tsrLog.error('Scene cleanup error:', e);
        window.dispatchEvent(new CustomEvent('scene-runtime-error', {
          detail: { message: e.message || String(e), source: 'cleanup' }
        }));
      }
    }

    // Dispose of scene objects
    if (this.scene) {
      this.scene.traverse((object: any) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
          if (Array.isArray(object.material)) {
            object.material.forEach((m: any) => {
              // Dispose textures attached to materials
              if (m.map) m.map.dispose();
              if (m.normalMap) m.normalMap.dispose();
              if (m.envMap) m.envMap.dispose();
              m.dispose();
            });
          } else {
            if (object.material.map) object.material.map.dispose();
            if (object.material.normalMap) object.material.normalMap.dispose();
            if (object.material.envMap) object.material.envMap.dispose();
            object.material.dispose();
          }
        }
      });
      this.scene.clear();
    }

    this.sceneModule = null;
    this.sceneObjects = null;
  }

  render(): SceneRenderStats {
    const now = performance.now();

    // Calculate time
    let currentTime: number;
    if (this.isPlaying) {
      currentTime = (now - this.startTime) / 1000 * this.params.speed;
    } else {
      currentTime = this.pausedTime / 1000 * this.params.speed;
    }

    const timeDelta = (now - this.lastFrameTime) / 1000 * this.params.speed;
    this.lastFrameTime = now;

    // FPS calculation
    this.fpsFrames++;
    if (now - this.fpsLastTime >= 1000) {
      this.fps = this.fpsFrames;
      this.fpsFrames = 0;
      this.fpsLastTime = now;
    }

    // Update video/audio textures
    this.updateChannelTextures();

    // Update beat detector from first active audio channel
    let bpmValue = 1.0;
    for (let i = 0; i < 4; i++) {
      const audio = this.channelAudioSources[i];
      if (audio) {
        audio.analyser.getByteFrequencyData(audio.frequencyData);
        this.beatDetector.update(audio.frequencyData);
        bpmValue = this.beatDetector.getBPM() / 100;
        break;
      }
    }
    this.customParamValues.bpm = bpmValue;

    // Call scene's animate function
    if (this.sceneModule?.animate) {
      try {
        if (this.animateSignature === 'objects-first') {
          this.sceneModule.animate(
            this.sceneObjects,
            currentTime,
            timeDelta,
            this.customParamValues,
            this.mouse,
            this.channelThreeTextures
          );
        } else {
          this.sceneModule.animate(
            currentTime,
            timeDelta,
            this.customParamValues,
            this.sceneObjects,
            this.mouse,
            this.channelThreeTextures
          );
        }
      } catch (e: any) {
        console.warn('Scene animate error:', e);
        // Throttle runtime error reporting to avoid flooding (animate runs every frame)
        if (!this._lastRuntimeError || Date.now() - this._lastRuntimeError > 2000) {
          this._lastRuntimeError = Date.now();
          window.dispatchEvent(new CustomEvent('scene-runtime-error', {
            detail: { message: e.message || String(e), source: 'animate' }
          }));
        }
      }
    }

    // Render the scene
    if (this.threeRenderer && this.scene && this.camera) {
      this.threeRenderer.render(this.scene, this.camera);
    }

    if (this.isPlaying) {
      this.frameCount++;
    }

    return {
      time: currentTime,
      fps: this.fps,
      frame: this.frameCount,
      bpm: bpmValue
    };
  }

  private updateChannelTextures(): void {
    for (let i = 0; i < 4; i++) {
      // Update video/camera textures
      if (this.channelVideoSources[i] && this.channelVideoSources[i]!.readyState >= 2) {
        if (this.channelThreeTextures[i]) {
          this.channelThreeTextures[i].needsUpdate = true;
        }
      }

      // Update audio textures (would need special handling for Three.js)
      // Audio data could be passed to scene via params or separate mechanism
    }
  }

  // Parameter methods (same interface as ShaderRenderer)
  setParam(name: string, value: ParamValue | ParamArrayValue): void {
    if (Object.prototype.hasOwnProperty.call(this.customParamValues, name)) {
      this.customParamValues[name] = value;
    } else if (Object.prototype.hasOwnProperty.call(this.params, name)) {
      this.params[name] = value as number;
    }
  }

  getParams(): ParamValues {
    return { ...this.params, ...this.customParamValues };
  }

  getCustomParamDefs(): ParamDef[] {
    return this.customParams;
  }

  getCustomParamValues(): ParamValues {
    return { ...this.customParamValues };
  }

  setCustomParamValues(values: ParamValues): void {
    for (const [name, value] of Object.entries(values)) {
      if (Object.prototype.hasOwnProperty.call(this.customParamValues, name)) {
        this.customParamValues[name] = value;
      }
    }
  }

  setParams(params: ParamValues): void {
    if (!params) return;
    for (const [name, value] of Object.entries(params)) {
      this.setParam(name, value);
    }
  }

  // Playback control
  play(): void {
    if (!this.isPlaying) {
      this.startTime = performance.now() - this.pausedTime;
      this.isPlaying = true;
    }
  }

  pause(): void {
    if (this.isPlaying) {
      this.pausedTime = performance.now() - this.startTime;
      this.isPlaying = false;
    }
  }

  togglePlayback(): boolean {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
    return this.isPlaying;
  }

  resetTime(): void {
    this.startTime = performance.now();
    this.pausedTime = 0;
    this.frameCount = 0;
  }

  getStats(): SceneStats {
    return {
      fps: this.fps,
      time: this.isPlaying ?
        (performance.now() - this.startTime) / 1000 :
        this.pausedTime / 1000,
      frame: this.frameCount,
      isPlaying: this.isPlaying
    };
  }

  updateTime(): void {
    const now = performance.now();
    this.lastFrameTime = now;
    if (this.isPlaying) {
      this.frameCount++;
    }
  }

  // Channel management (for texture inputs)
  loadTexture(channel: number, dataUrl: string): Promise<{ width: number; height: number }> {
    const THREE = this.THREE;

    return new Promise((resolve, reject) => {
      const loader = new THREE.TextureLoader();
      loader.load(
        dataUrl,
        (texture: any) => {
          this.cleanupChannel(channel);
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          this.channelThreeTextures[channel] = texture;
          this.channelResolutions[channel] = [texture.image.width, texture.image.height, 1];
          this.channelTypes[channel] = 'image';
          resolve({ width: texture.image.width, height: texture.image.height });
        },
        undefined,
        (_err: any) => reject(new Error('Failed to load texture'))
      );
    });
  }

  loadVideo(channel: number, filePath: string): Promise<{ width: number; height: number; type: string }> {
    const THREE = this.THREE;

    return new Promise((resolve, reject) => {
      this.cleanupChannel(channel);

      const video = document.createElement('video');
      const fileUrl = filePath.startsWith('/')
        ? `file://${filePath}`
        : `file:///${filePath.replace(/\\/g, '/')}`;
      video.src = fileUrl;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';

      video.onloadedmetadata = () => {
        const texture = new THREE.VideoTexture(video);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;

        this.channelThreeTextures[channel] = texture;
        this.channelVideoSources[channel] = video;
        this.channelResolutions[channel] = [video.videoWidth, video.videoHeight, 1];
        this.channelTypes[channel] = 'video';

        video.play().catch((err: Error) => console.warn('Video autoplay blocked:', err));
        resolve({ width: video.videoWidth, height: video.videoHeight, type: 'video' });
      };

      video.onerror = () => reject(new Error('Failed to load video'));
    });
  }

  async loadCamera(channel: number): Promise<{ width: number; height: number; type: string }> {
    const THREE = this.THREE;

    this.cleanupChannel(channel);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });

      const video = document.createElement('video');
      video.srcObject = stream;
      video.playsInline = true;

      await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => resolve();
      });

      await video.play();

      const texture = new THREE.VideoTexture(video);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;

      this.channelThreeTextures[channel] = texture;
      this.channelVideoSources[channel] = video;
      this.channelResolutions[channel] = [video.videoWidth, video.videoHeight, 1];
      this.channelTypes[channel] = 'camera';

      return { width: video.videoWidth, height: video.videoHeight, type: 'camera' };
    } catch (err: any) {
      throw new Error(`Camera access denied: ${err.message}`);
    }
  }

  async loadAudio(channel: number): Promise<{ width: number; height: number; type: string }> {
    // Audio FFT for Three.js scenes would need custom handling
    // For now, just set up the audio analyser and make data available
    this.cleanupChannel(channel);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const frequencyData = new Uint8Array(512);
      const timeDomainData = new Uint8Array(512);

      this.channelAudioSources[channel] = {
        audioContext,
        analyser,
        stream,
        source,
        frequencyData,
        timeDomainData
      };
      this.channelResolutions[channel] = [512, 2, 1];
      this.channelTypes[channel] = 'audio';

      return { width: 512, height: 2, type: 'audio' };
    } catch (err: any) {
      throw new Error(`Audio access denied: ${err.message}`);
    }
  }

  cleanupChannel(channel: number): void {
    // Stop and cleanup video/camera source
    if (this.channelVideoSources[channel]) {
      const video = this.channelVideoSources[channel]!;
      video.pause();
      if (video.srcObject) {
        const tracks = (video.srcObject as MediaStream).getTracks();
        tracks.forEach(track => track.stop());
        video.srcObject = null;
      }
      video.src = '';
      video.load();
      this.channelVideoSources[channel] = null;
    }

    // Cleanup audio source
    if (this.channelAudioSources[channel]) {
      const audio = this.channelAudioSources[channel]!;
      if (audio.stream) {
        const tracks = audio.stream.getTracks();
        tracks.forEach(track => track.stop());
      }
      if (audio.audioContext && audio.audioContext.state !== 'closed') {
        audio.audioContext.close();
      }
      this.channelAudioSources[channel] = null;
    }

    // Dispose Three.js texture
    if (this.channelThreeTextures[channel]) {
      this.channelThreeTextures[channel].dispose();
      this.channelThreeTextures[channel] = null;
    }

    this.channelResolutions[channel] = [0, 0, 1];
    this.channelTypes[channel] = 'empty';
  }

  clearChannel(channel: number): { type: string } {
    this.cleanupChannel(channel);
    return { type: 'empty' };
  }

  getChannelType(channel: number): ChannelType {
    return this.channelTypes[channel];
  }

  // NDI channel support
  initNDIChannel(channel: number, sourceName: string): { type: string; source: string } {
    const THREE = this.THREE;

    this.cleanupChannel(channel);

    // Create a data texture for NDI frames
    const texture = new THREE.DataTexture(
      new Uint8Array(4), // 1x1 black
      1, 1,
      THREE.RGBAFormat
    );
    texture.needsUpdate = true;

    this.channelThreeTextures[channel] = texture;
    this.channelResolutions[channel] = [1, 1, 1];
    this.channelTypes[channel] = 'ndi';
    this.channelNDIData[channel] = { width: 1, height: 1, data: null, needsUpdate: false, sourceName };

    return { type: 'ndi', source: sourceName };
  }

  setNDIFrame(channel: number, width: number, height: number, rgbaData: Uint8Array): void {
    if (this.channelTypes[channel] !== 'ndi') return;

    const THREE = this.THREE;

    // Update or recreate texture if size changed
    if (this.channelResolutions[channel][0] !== width || this.channelResolutions[channel][1] !== height) {
      if (this.channelThreeTextures[channel]) {
        this.channelThreeTextures[channel].dispose();
      }
      const texture = new THREE.DataTexture(
        rgbaData,
        width, height,
        THREE.RGBAFormat
      );
      texture.needsUpdate = true;
      this.channelThreeTextures[channel] = texture;
      this.channelResolutions[channel] = [width, height, 1];
    } else {
      // Update existing texture data
      const texture = this.channelThreeTextures[channel];
      texture.image.data = rgbaData;
      texture.needsUpdate = true;
    }
  }

  // Reset GL state after ShaderRenderer has used the shared WebGL context.
  // Three.js tracks GL state internally and skips redundant calls; if another
  // renderer changed the actual GL state behind its back, the tracking becomes
  // stale and rendering silently fails (black screen). Disposing and recreating
  // the WebGLRenderer forces Three.js to re-query and re-initialize all state.
  reinitialize(): void {
    _tsrLog.debug('Reinitializing renderer');
    if (this.threeRenderer) {
      this.threeRenderer.dispose();
    }
    this.initThreeRenderer();
    // Re-apply resolution
    this.threeRenderer.setSize(this.canvas.width, this.canvas.height, false);
    if (this.camera) {
      this.camera.aspect = this.canvas.width / this.canvas.height;
      this.camera.updateProjectionMatrix();
    }
  }

  // Dispose of all resources
  dispose(): void {
    _tsrLog.debug('Disposing scene renderer');
    this.cleanup();

    for (let i = 0; i < 4; i++) {
      this.cleanupChannel(i);
    }

    // Remove mouse event listeners to prevent leaks
    if (this._onMouseDown) {
      this.canvas.removeEventListener('mousedown', this._onMouseDown);
      this.canvas.removeEventListener('mouseup', this._onMouseUp!);
      this.canvas.removeEventListener('mousemove', this._onMouseMove!);
      this.canvas.removeEventListener('mouseleave', this._onMouseLeave!);
    }

    if (this.threeRenderer) {
      this.threeRenderer.dispose();
    }
  }
}
