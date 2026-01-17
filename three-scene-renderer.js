// =============================================================================
// Three.js Scene Renderer
// Renders Three.js scenes with the same interface as ShaderRenderer
//
// Scene files use .scene.js or .jsx extension and export setup/animate/cleanup functions
// Parameters are defined via @param comments like shaders
// JSX files are automatically compiled using Babel
// =============================================================================

// THREE and Babel are loaded via script tags in HTML
// const THREE = window.THREE;
// const Babel = window.Babel;

// =============================================================================
// Scene Parameter Parser (reuses same @param syntax as shaders)
// =============================================================================

const SceneParamParser = {
  PARAM_REGEX: /^\s*\/\/\s*@param\s+(\w+)\s+(int|float|vec[234])(\[(\d+)\])?\s*(.*)/,

  parseValue(valueStr, baseType) {
    const parts = valueStr.split(',').map(s => s.trim());
    switch (baseType) {
      case 'int': return parseInt(parts[0], 10) || 0;
      case 'float': return parseFloat(parts[0]) || 0.0;
      case 'vec2': return [parseFloat(parts[0]) || 0, parseFloat(parts[1]) || 0];
      case 'vec3': return [parseFloat(parts[0]) || 0, parseFloat(parts[1]) || 0, parseFloat(parts[2]) || 0];
      case 'vec4': return [parseFloat(parts[0]) || 0, parseFloat(parts[1]) || 0, parseFloat(parts[2]) || 0, parseFloat(parts[3]) || 0];
      default: return 0;
    }
  },

  getDefaultValue(baseType, arraySize = null) {
    let defaultVal;
    switch (baseType) {
      case 'int': defaultVal = 0; break;
      case 'float': defaultVal = 0.5; break;
      case 'vec2': defaultVal = [0.5, 0.5]; break;
      case 'vec3': defaultVal = [1.0, 1.0, 1.0]; break;
      case 'vec4': defaultVal = [0.0, 0.0, 0.0, 1.0]; break;
      default: defaultVal = 0;
    }
    if (arraySize) {
      return Array(arraySize).fill(null).map(() => Array.isArray(defaultVal) ? [...defaultVal] : defaultVal);
    }
    return defaultVal;
  },

  parseRest(restStr, baseType, arraySize) {
    let defaultValue = this.getDefaultValue(baseType, arraySize);
    let min = null, max = null, description = '';
    let remaining = restStr.trim();

    const descMatch = remaining.match(/"([^"]*)"$/);
    if (descMatch) {
      description = descMatch[1];
      remaining = remaining.slice(0, -descMatch[0].length).trim();
    }

    const rangeMatch = remaining.match(/\[([^\]]+)\]\s*$/);
    if (rangeMatch) {
      const rangeParts = rangeMatch[1].split(',').map(s => s.trim());
      if (rangeParts.length >= 2) {
        min = parseFloat(rangeParts[0]);
        max = parseFloat(rangeParts[1]);
        if (isNaN(min)) min = null;
        if (isNaN(max)) max = null;
      }
      remaining = remaining.slice(0, -rangeMatch[0].length).trim();
    }

    if (remaining.length > 0) {
      if (arraySize) {
        const singleDefault = this.parseValue(remaining, baseType);
        defaultValue = Array(arraySize).fill(null).map(() => Array.isArray(singleDefault) ? [...singleDefault] : singleDefault);
      } else {
        defaultValue = this.parseValue(remaining, baseType);
      }
    }

    return { defaultValue, min, max, description };
  },

  parseParamLine(line) {
    const match = line.match(this.PARAM_REGEX);
    if (!match) return null;

    const name = match[1];
    const baseType = match[2];
    const arraySize = match[4] ? parseInt(match[4], 10) : null;
    const rest = match[5] || '';
    const { defaultValue, min, max, description } = this.parseRest(rest, baseType, arraySize);

    return {
      name,
      type: baseType,
      arraySize,
      isArray: arraySize !== null,
      default: defaultValue,
      min,
      max,
      description,
      glslType: arraySize ? `${baseType}[${arraySize}]` : baseType
    };
  },

  parse(sceneSource) {
    const params = [];
    const lines = sceneSource.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // Stop parsing at first non-comment line that's not empty
      if (trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*')) {
        break;
      }
      const param = this.parseParamLine(line);
      if (param) params.push(param);
    }
    return params;
  },

  createParamValues(params) {
    const values = {};
    for (const param of params) {
      values[param.name] = param.isArray
        ? param.default.map(v => Array.isArray(v) ? [...v] : v)
        : (Array.isArray(param.default) ? [...param.default] : param.default);
    }
    return values;
  }
};

// =============================================================================
// ThreeSceneRenderer Class
// =============================================================================

class ThreeSceneRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.THREE = window.THREE;

    if (!this.THREE) {
      throw new Error('Three.js not loaded. Include THREE library before using ThreeSceneRenderer.');
    }

    // Scene state
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.sceneModule = null;
    this.sceneObjects = null;
    this.sceneSource = null;

    // Playback state
    this.isPlaying = true;
    this.startTime = performance.now();
    this.pausedTime = 0;
    this.lastFrameTime = performance.now();
    this.frameCount = 0;
    this.fps = 0;
    this.fpsFrames = 0;
    this.fpsLastTime = performance.now();

    // Mouse state (compatible with ShaderRenderer)
    this.mouse = { x: 0, y: 0, clickX: 0, clickY: 0, isDown: false };

    // Channel textures (for compatibility - scenes can use these)
    this.channelTextures = [null, null, null, null];
    this.channelThreeTextures = [null, null, null, null];
    this.channelResolutions = [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]];
    this.channelVideoSources = [null, null, null, null];
    this.channelTypes = ['empty', 'empty', 'empty', 'empty'];
    this.channelAudioSources = [null, null, null, null];
    this.channelNDIData = [null, null, null, null];

    // Custom parameters
    this.customParams = [];
    this.customParamValues = {};

    // Legacy params for compatibility
    this.params = { speed: 1.0 };

    // Initialize Three.js renderer
    this.initThreeRenderer();
    this.setupMouseEvents();
  }

  initThreeRenderer() {
    const THREE = this.THREE;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      preserveDrawingBuffer: true, // Required for readPixels (NDI/Syphon)
      alpha: false
    });

    this.renderer.setPixelRatio(1); // Use 1:1 for consistent resolution
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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

  setupMouseEvents() {
    this.canvas.addEventListener('mousedown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      this.mouse.clickX = (e.clientX - rect.left) * scaleX;
      this.mouse.clickY = this.canvas.height - (e.clientY - rect.top) * scaleY;
      this.mouse.isDown = true;
    });

    this.canvas.addEventListener('mouseup', () => {
      this.mouse.isDown = false;
    });

    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      this.mouse.x = (e.clientX - rect.left) * scaleX;
      this.mouse.y = this.canvas.height - (e.clientY - rect.top) * scaleY;
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.mouse.isDown = false;
    });
  }

  setResolution(width, height) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.renderer.setSize(width, height, false);

    if (this.camera) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
  }

  // Compile/load a scene from source code
  // Supports both plain JS and JSX (automatically compiled via Babel)
  compile(sceneSource, isJSX = false) {
    const THREE = this.THREE;

    // Store source for reference
    this.sceneSource = sceneSource;

    // Parse custom parameters from comments
    this.customParams = SceneParamParser.parse(sceneSource);
    this.customParamValues = SceneParamParser.createParamValues(this.customParams);

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
      const createModule = new Function('THREE', 'canvas', 'params', 'channels', 'mouse', moduleCode);

      // Execute to get the module exports
      this.sceneModule = createModule(THREE, this.canvas, this.customParamValues, this.channelThreeTextures, this.mouse);

      // Call setup to initialize the scene
      if (this.sceneModule.setup) {
        const result = this.sceneModule.setup(THREE, this.canvas, this.customParamValues, this.channelThreeTextures, this.mouse);

        if (result) {
          if (result.scene) this.scene = result.scene;
          if (result.camera) this.camera = result.camera;
          if (result.renderer) {
            // Scene provided its own renderer - use it but ensure preserveDrawingBuffer
            this.renderer.dispose();
            this.renderer = result.renderer;
            this.renderer.preserveDrawingBuffer = true;
          }
          this.sceneObjects = result.objects || result;
        }
      }

      // Update camera aspect ratio
      if (this.camera) {
        this.camera.aspect = this.canvas.width / this.canvas.height;
        this.camera.updateProjectionMatrix();
      }

      return { success: true };
    } catch (err) {
      // Try to extract line number from error
      const lineMatch = err.stack?.match(/<anonymous>:(\d+)/);
      const line = lineMatch ? parseInt(lineMatch[1], 10) - 6 : null; // Adjust for wrapper

      throw {
        message: err.message,
        line: line,
        raw: err.stack || err.message
      };
    }
  }

  // Detect if source contains JSX syntax
  detectJSX(source) {
    // Look for JSX patterns: <Component, <div, etc.
    return /<[A-Za-z][^>]*>/.test(source) || /className=/.test(source);
  }

  // Compile JSX to JavaScript using Babel
  compileJSX(source) {
    const Babel = window.Babel;

    if (!Babel) {
      console.warn('Babel not loaded, JSX compilation skipped');
      return source;
    }

    try {
      const result = Babel.transform(source, {
        presets: ['react'],
        plugins: [],
        filename: 'scene.jsx'
      });
      return result.code;
    } catch (err) {
      throw new Error(`JSX compilation error: ${err.message}`);
    }
  }

  cleanup() {
    // Call scene's cleanup function if available
    if (this.sceneModule?.cleanup && this.sceneObjects) {
      try {
        this.sceneModule.cleanup(this.sceneObjects);
      } catch (e) {
        console.warn('Scene cleanup error:', e);
      }
    }

    // Dispose of scene objects
    if (this.scene) {
      this.scene.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
          if (Array.isArray(object.material)) {
            object.material.forEach(m => m.dispose());
          } else {
            object.material.dispose();
          }
        }
      });
      this.scene.clear();
    }

    this.sceneModule = null;
    this.sceneObjects = null;
  }

  render() {
    const now = performance.now();

    // Calculate time
    let currentTime;
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

    // Call scene's animate function
    if (this.sceneModule?.animate) {
      try {
        this.sceneModule.animate(
          currentTime,
          timeDelta,
          this.customParamValues,
          this.sceneObjects,
          this.mouse,
          this.channelThreeTextures
        );
      } catch (e) {
        console.warn('Scene animate error:', e);
      }
    }

    // Render the scene
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }

    if (this.isPlaying) {
      this.frameCount++;
    }

    return {
      time: currentTime,
      fps: this.fps,
      frame: this.frameCount
    };
  }

  updateChannelTextures() {
    const THREE = this.THREE;

    for (let i = 0; i < 4; i++) {
      // Update video/camera textures
      if (this.channelVideoSources[i] && this.channelVideoSources[i].readyState >= 2) {
        if (this.channelThreeTextures[i]) {
          this.channelThreeTextures[i].needsUpdate = true;
        }
      }

      // Update audio textures (would need special handling for Three.js)
      // Audio data could be passed to scene via params or separate mechanism
    }
  }

  // Parameter methods (same interface as ShaderRenderer)
  setParam(name, value) {
    if (this.customParamValues.hasOwnProperty(name)) {
      this.customParamValues[name] = value;
    } else if (this.params.hasOwnProperty(name)) {
      this.params[name] = value;
    }
  }

  getParams() {
    return { ...this.params, ...this.customParamValues };
  }

  getCustomParamDefs() {
    return this.customParams;
  }

  getCustomParamValues() {
    return { ...this.customParamValues };
  }

  setCustomParamValues(values) {
    for (const [name, value] of Object.entries(values)) {
      if (this.customParamValues.hasOwnProperty(name)) {
        this.customParamValues[name] = value;
      }
    }
  }

  setParams(params) {
    if (!params) return;
    for (const [name, value] of Object.entries(params)) {
      this.setParam(name, value);
    }
  }

  // Playback control
  play() {
    if (!this.isPlaying) {
      this.startTime = performance.now() - this.pausedTime;
      this.isPlaying = true;
    }
  }

  pause() {
    if (this.isPlaying) {
      this.pausedTime = performance.now() - this.startTime;
      this.isPlaying = false;
    }
  }

  togglePlayback() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
    return this.isPlaying;
  }

  resetTime() {
    this.startTime = performance.now();
    this.pausedTime = 0;
    this.frameCount = 0;
  }

  getStats() {
    return {
      fps: this.fps,
      time: this.isPlaying ?
        (performance.now() - this.startTime) / 1000 :
        this.pausedTime / 1000,
      frame: this.frameCount,
      isPlaying: this.isPlaying
    };
  }

  updateTime() {
    const now = performance.now();
    this.lastFrameTime = now;
    if (this.isPlaying) {
      this.frameCount++;
    }
  }

  // Channel management (for texture inputs)
  loadTexture(channel, dataUrl) {
    const THREE = this.THREE;

    return new Promise((resolve, reject) => {
      const loader = new THREE.TextureLoader();
      loader.load(
        dataUrl,
        (texture) => {
          this.cleanupChannel(channel);
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          this.channelThreeTextures[channel] = texture;
          this.channelResolutions[channel] = [texture.image.width, texture.image.height, 1];
          this.channelTypes[channel] = 'image';
          resolve({ width: texture.image.width, height: texture.image.height });
        },
        undefined,
        (err) => reject(new Error('Failed to load texture'))
      );
    });
  }

  loadVideo(channel, filePath) {
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

        video.play().catch(err => console.warn('Video autoplay blocked:', err));
        resolve({ width: video.videoWidth, height: video.videoHeight, type: 'video' });
      };

      video.onerror = () => reject(new Error('Failed to load video'));
    });
  }

  async loadCamera(channel) {
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

      await new Promise((resolve) => {
        video.onloadedmetadata = resolve;
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
    } catch (err) {
      throw new Error(`Camera access denied: ${err.message}`);
    }
  }

  async loadAudio(channel) {
    // Audio FFT for Three.js scenes would need custom handling
    // For now, just set up the audio analyser and make data available
    this.cleanupChannel(channel);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });

      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
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
    } catch (err) {
      throw new Error(`Audio access denied: ${err.message}`);
    }
  }

  cleanupChannel(channel) {
    // Stop and cleanup video/camera source
    if (this.channelVideoSources[channel]) {
      const video = this.channelVideoSources[channel];
      video.pause();
      if (video.srcObject) {
        const tracks = video.srcObject.getTracks();
        tracks.forEach(track => track.stop());
        video.srcObject = null;
      }
      video.src = '';
      video.load();
      this.channelVideoSources[channel] = null;
    }

    // Cleanup audio source
    if (this.channelAudioSources[channel]) {
      const audio = this.channelAudioSources[channel];
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

  clearChannel(channel) {
    this.cleanupChannel(channel);
    return { type: 'empty' };
  }

  getChannelType(channel) {
    return this.channelTypes[channel];
  }

  // NDI channel support
  initNDIChannel(channel, sourceName) {
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

  setNDIFrame(channel, width, height, rgbaData) {
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

  // Dispose of all resources
  dispose() {
    this.cleanup();

    for (let i = 0; i < 4; i++) {
      this.cleanupChannel(i);
    }

    if (this.renderer) {
      this.renderer.dispose();
    }
  }
}

// Export for use in modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ThreeSceneRenderer, SceneParamParser };
}
