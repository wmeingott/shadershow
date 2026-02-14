// =============================================================================
// Shader Parameter Parser
// Parses @param comments from shader source to define custom uniforms
//
// Format: // @param name type [default] [range] ["description"]
//
// Supported types:
//   int, int[N]       - Integer or integer array
//   float, float[N]   - Float or float array
//   vec2, vec2[N]     - 2D vector or array
//   vec3, vec3[N]     - 3D vector or array (also used for colors)
//   vec4, vec4[N]     - 4D vector or array
//   color             - RGB color with color picker (alias for vec3)
// =============================================================================

// Logger for shader-renderer (non-module script)
const _srLog = {
  _level: 2, // default WARN, set higher by renderer module if --dev
  debug(msg, ...a) { if (this._level >= 4) console.debug('[Shader]', msg, ...a); },
  info(msg, ...a)  { if (this._level >= 3) console.info('[Shader]', msg, ...a); },
  warn(msg, ...a)  { if (this._level >= 2) console.warn('[Shader]', msg, ...a); },
  error(msg, ...a) { if (this._level >= 1) console.error('[Shader]', msg, ...a); },
};

// Pre-compiled regex for shader error parsing (avoid recompiling on each error)
const SHADER_ERROR_REGEX = /ERROR:\s*\d+:(\d+):\s*(.+)/;

// BUILTIN_TEXTURES, generateNoiseData, createBuiltinTexture -> now in GLUtils (gl-utils.js)
const BUILTIN_TEXTURES = GLUtils.BUILTIN_TEXTURES;
function createBuiltinTexture(gl, name) { return GLUtils.createBuiltinTexture(gl, name); }

const TEXTURE_DIRECTIVE_REGEX = /^\s*\/\/\s*@texture\s+(iChannel[0-3])\s+(texture:(\w+)|(\w+)(?:\((\d+)\))?)/;
const FILE_TEXTURE_NAME_REGEX = /^[\w-]+$/;

const ShaderParamParser = {
  PARAM_REGEX: /^\s*\/\/\s*@param\s+(\w+)\s+(int|float|vec[234]|color)(\[(\d+)\])?\s*(.*)/,

  parseValue(valueStr, baseType) {
    const parts = valueStr.split(',').map(s => s.trim());
    switch (baseType) {
      case 'int': return parseInt(parts[0], 10) || 0;
      case 'float': return parseFloat(parts[0]) || 0.0;
      case 'vec2': return [parseFloat(parts[0]) || 0, parseFloat(parts[1]) || 0];
      case 'color':
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
      case 'color':
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

    // Extract description (quoted string at the end)
    const descMatch = remaining.match(/"([^"]*)"$/);
    if (descMatch) {
      description = descMatch[1];
      remaining = remaining.slice(0, -descMatch[0].length).trim();
    }

    // For vector/color types, check if [x,y,z] is a default value (not a range)
    const vecComponents = { vec2: 2, vec3: 3, color: 3, vec4: 4 };
    const expectedComponents = vecComponents[baseType];
    if (expectedComponents) {
      // Per-element array defaults: [[x,y,z],[a,b,c]]
      if (arraySize) {
        const nestedMatch = remaining.match(/^\s*\[((?:\s*\[[^\]]+\]\s*,?\s*)+)\]\s*$/);
        if (nestedMatch) {
          const innerBrackets = [];
          const innerRegex = /\[([^\]]+)\]/g;
          let m;
          while ((m = innerRegex.exec(nestedMatch[1])) !== null) {
            const parts = m[1].split(',').map(s => s.trim());
            if (parts.length === expectedComponents) {
              innerBrackets.push(this.parseValue(parts.join(', '), baseType));
            }
          }
          if (innerBrackets.length === arraySize) {
            defaultValue = innerBrackets;
            return { defaultValue, min, max, description };
          }
        }
      }
      // Single vec default: [x,y,z]
      const bracketMatch = remaining.match(/^\s*\[([^\]]+)\]\s*$/);
      if (bracketMatch) {
        const parts = bracketMatch[1].split(',').map(s => s.trim());
        if (parts.length === expectedComponents) {
          defaultValue = this.parseValue(parts.join(', '), baseType);
          if (arraySize) {
            defaultValue = Array(arraySize).fill(null).map(() => [...defaultValue]);
          }
          return { defaultValue, min, max, description };
        }
      }
    }

    // Extract range [min, max]
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

    // Remaining is the default value
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

    // "color" is an alias for vec3 in GLSL
    const isColor = baseType === 'color';
    const glslBaseType = isColor ? 'vec3' : baseType;

    return {
      name,
      type: baseType,
      glslBaseType,
      arraySize,
      isArray: arraySize !== null,
      isColor,
      default: defaultValue,
      min,
      max,
      description,
      glslType: arraySize ? `${glslBaseType}[${arraySize}]` : glslBaseType,
      uniformDecl: arraySize ? `uniform ${glslBaseType} ${name}[${arraySize}];` : `uniform ${glslBaseType} ${name};`
    };
  },

  parse(shaderSource) {
    const params = [];
    const lines = shaderSource.split('\n');

    // Parse all lines looking for @param comments
    // Don't stop early - @param can appear anywhere in the file
    for (const line of lines) {
      const param = this.parseParamLine(line);
      if (param) params.push(param);
    }
    return params;
  },

  generateUniformDeclarations(params) {
    return params.map(p => p.uniformDecl).join('\n');
  },

  createParamValues(params) {
    const values = {};
    for (const param of params) {
      values[param.name] = param.isArray
        ? param.default.map(v => Array.isArray(v) ? [...v] : v)
        : (Array.isArray(param.default) ? [...param.default] : param.default);
    }
    return values;
  },

  parseTextureDirectives(shaderSource) {
    const directives = [];
    const lines = shaderSource.split('\n');
    for (const line of lines) {
      const match = line.match(TEXTURE_DIRECTIVE_REGEX);
      if (match) {
        const channel = parseInt(match[1].charAt(8), 10);
        if (match[3]) {
          // texture:filename syntax
          const fileName = match[3];
          if (FILE_TEXTURE_NAME_REGEX.test(fileName)) {
            directives.push({ channel, textureName: fileName, type: 'file' });
          }
        } else {
          // Built-in texture name or AudioFFT
          const textureName = match[4];
          const sizeArg = match[5] ? parseInt(match[5], 10) : null;
          if (textureName === 'AudioFFT' && sizeArg !== null) {
            // AudioFFT(size) — validate power of 2, 64..4096
            const VALID_FFT = [64, 128, 256, 512, 1024, 2048, 4096];
            if (VALID_FFT.includes(sizeArg)) {
              directives.push({ channel, textureName: `AudioFFT(${sizeArg})`, type: 'audio', fftSize: sizeArg });
            }
          } else if (textureName === 'AudioFFT') {
            directives.push({ channel, textureName, type: 'audio', fftSize: 1024 });
          } else if (textureName === 'AudioFFTBig') {
            directives.push({ channel, textureName, type: 'audio', fftSize: 2048 });
          } else if (BUILTIN_TEXTURES[textureName]) {
            directives.push({ channel, textureName, type: 'builtin' });
          }
        }
      }
    }
    return directives;
  }
};

// =============================================================================
// ShaderRenderer Class
// =============================================================================

// Shared constant for 1x1 black pixel (avoids allocating new Uint8Array each time)
const BLACK_PIXEL = new Uint8Array([0, 0, 0, 255]);

class ShaderRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true
    });

    if (!this.gl) {
      throw new Error('WebGL 2 not supported');
    }

    // Track context loss
    this.contextLost = false;
    this._lastShaderSource = null;

    // Handle context loss events
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      _srLog.warn('WebGL context lost');
    });

    canvas.addEventListener('webglcontextrestored', () => {
      _srLog.info('WebGL context restored, reinitializing');
      this.contextLost = false;
      this.reinitialize();
    });

    // State
    this.program = null;
    this.isPlaying = true;
    this.startTime = performance.now();
    this.pausedTime = 0;
    this.lastFrameTime = performance.now();
    this.frameCount = 0;
    this.fps = 0;
    this.fpsFrames = 0;
    this.fpsLastTime = performance.now();

    // Mouse state
    this.mouse = { x: 0, y: 0, clickX: 0, clickY: 0, isDown: false };

    // Store mouse event handlers for cleanup
    this._mouseHandlers = {};

    // Textures for iChannel0-3
    this.channelTextures = [null, null, null, null];
    this.channelResolutions = [
      [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]
    ];

    // Video/Camera sources for channels (HTMLVideoElement)
    this.channelVideoSources = [null, null, null, null];
    this.channelTypes = ['empty', 'empty', 'empty', 'empty'];

    // Audio sources for channels
    this.channelAudioSources = [null, null, null, null];

    // NDI sources for channels
    this.channelNDIData = [null, null, null, null];

    // Custom parameters - now dynamic per shader
    this.customParams = [];      // Parsed param definitions from shader
    this.customParamValues = {}; // Current values { paramName: value }
    this.customParamUniforms = {}; // Uniform locations { paramName: location }

    // Beat detector for BPM estimation from audio
    this.beatDetector = new BeatDetector();

    // Legacy fixed params for Shadertoy compatibility (always available)
    this.params = { speed: 1.0 };

    // Uniform locations cache
    this.uniforms = {};

    // Pre-allocated buffers for render loop
    this._resolutionsArray = new Float32Array(12);
    this._audioBuffer = new Uint8Array(512 * 2);
    this._dateObject = new Date();  // Reused Date object to avoid allocation per frame
    this._cachedParams = null;      // Cached params result
    this._paramsDirty = true;       // Flag to invalidate cache

    // Track texture dimensions for texSubImage2D optimization
    this._channelTexSizes = [[0, 0], [0, 0], [0, 0], [0, 0]];

    // Setup
    this.setupGeometry();
    this.setupMouseEvents();
    this.createDefaultTextures();
  }

  setupGeometry() {
    this.vao = GLUtils.setupFullscreenQuad(this.gl);
  }

  // Reinitialize after context restore or after another renderer (e.g. Three.js)
  // has used the shared WebGL context
  reinitialize() {
    const gl = this.gl;

    // Reset GL state that Three.js may have changed
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    this.program = null;
    this.setupGeometry();
    this.createDefaultTextures();

    // Recompile last shader if available
    if (this._lastShaderSource) {
      try {
        this.compile(this._lastShaderSource);
      } catch (err) {
        _srLog.error('Failed to recompile after context restore:', err);
      }
    }
  }

  // Check if context is valid and try to recover if lost
  ensureContext() {
    if (this.contextLost) {
      return false;
    }

    // Check if context is actually working
    if (this.gl.isContextLost()) {
      this.contextLost = true;
      return false;
    }

    return true;
  }

  setupMouseEvents() {
    // Store handlers for cleanup
    this._mouseHandlers.mousedown = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      this.mouse.clickX = (e.clientX - rect.left) * scaleX;
      this.mouse.clickY = this.canvas.height - (e.clientY - rect.top) * scaleY;
      this.mouse.isDown = true;
    };

    this._mouseHandlers.mouseup = () => {
      this.mouse.isDown = false;
    };

    this._mouseHandlers.mousemove = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      this.mouse.x = (e.clientX - rect.left) * scaleX;
      this.mouse.y = this.canvas.height - (e.clientY - rect.top) * scaleY;
    };

    this._mouseHandlers.mouseleave = () => {
      this.mouse.isDown = false;
    };

    // Add listeners
    this.canvas.addEventListener('mousedown', this._mouseHandlers.mousedown);
    this.canvas.addEventListener('mouseup', this._mouseHandlers.mouseup);
    this.canvas.addEventListener('mousemove', this._mouseHandlers.mousemove);
    this.canvas.addEventListener('mouseleave', this._mouseHandlers.mouseleave);
  }

  // Cleanup mouse event listeners
  cleanupMouseEvents() {
    if (this._mouseHandlers.mousedown) {
      this.canvas.removeEventListener('mousedown', this._mouseHandlers.mousedown);
    }
    if (this._mouseHandlers.mouseup) {
      this.canvas.removeEventListener('mouseup', this._mouseHandlers.mouseup);
    }
    if (this._mouseHandlers.mousemove) {
      this.canvas.removeEventListener('mousemove', this._mouseHandlers.mousemove);
    }
    if (this._mouseHandlers.mouseleave) {
      this.canvas.removeEventListener('mouseleave', this._mouseHandlers.mouseleave);
    }
    this._mouseHandlers = {};
  }

  createDefaultTextures() {
    const gl = this.gl;

    // Create default black textures for all channels
    for (let i = 0; i < 4; i++) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        BLACK_PIXEL);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      this.channelTextures[i] = texture;
    }
  }

  loadTexture(channel, dataUrl) {
    // Clean up any existing video source for this channel
    this.cleanupChannel(channel);

    // Delete old texture if exists
    if (this.channelTextures[channel]) {
      this.gl.deleteTexture(this.channelTextures[channel]);
    }

    return GLUtils.loadTextureFromDataUrl(this.gl, dataUrl).then(({ texture, width, height }) => {
      this.channelTextures[channel] = texture;
      this.channelResolutions[channel] = [width, height, 1];
      this.channelTypes[channel] = 'image';

      _srLog.debug('Texture loaded ch' + channel, width + 'x' + height);
      return { width, height };
    });
  }

  loadVideo(channel, filePath) {
    return new Promise((resolve, reject) => {
      const gl = this.gl;

      // Clean up any existing source for this channel
      this.cleanupChannel(channel);

      const video = document.createElement('video');
      // Convert file path to proper file:// URL (handles Windows paths)
      const fileUrl = filePath.startsWith('/')
        ? `file://${filePath}`
        : `file:///${filePath.replace(/\\/g, '/')}`;
      video.src = fileUrl;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';

      video.onloadedmetadata = () => {
        // Create texture for video
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // Initialize with empty data
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, video.videoWidth, video.videoHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

        this.channelTextures[channel] = texture;
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
    const gl = this.gl;

    // Clean up any existing source for this channel
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

      // Create texture for camera
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // Initialize with empty data
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, video.videoWidth, video.videoHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

      this.channelTextures[channel] = texture;
      this.channelVideoSources[channel] = video;
      this.channelResolutions[channel] = [video.videoWidth, video.videoHeight, 1];
      this.channelTypes[channel] = 'camera';

      return { width: video.videoWidth, height: video.videoHeight, type: 'camera' };
    } catch (err) {
      throw new Error(`Camera access denied: ${err.message}`);
    }
  }

  async loadAudio(channel, fftSize = 1024) {
    const gl = this.gl;
    const bins = fftSize / 2; // frequency bins = fftSize / 2

    // Clean up any existing source for this channel
    this.cleanupChannel(channel);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });

      // Create audio context and analyser
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = fftSize;
      analyser.smoothingTimeConstant = 0.8;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      // Create data arrays for FFT and waveform
      const frequencyData = new Uint8Array(bins);
      const timeDomainData = new Uint8Array(bins);

      // Create texture (bins x 2: row 0 = FFT, row 1 = waveform)
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // Initialize with empty data
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, bins, 2, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, null);

      this.channelTextures[channel] = texture;
      this.channelAudioSources[channel] = {
        audioContext,
        analyser,
        stream,
        source,
        frequencyData,
        timeDomainData,
        bins
      };
      this.channelResolutions[channel] = [bins, 2, 1];
      this.channelTypes[channel] = 'audio';

      // Ensure shared audio buffer is large enough
      if (this._audioBuffer.length < bins * 2) {
        this._audioBuffer = new Uint8Array(bins * 2);
      }

      return { width: bins, height: 2, type: 'audio' };
    } catch (err) {
      throw new Error(`Audio access denied: ${err.message}`);
    }
  }

  cleanupChannel(channel) {
    const gl = this.gl;

    // Stop and cleanup video/camera source
    if (this.channelVideoSources[channel]) {
      const video = this.channelVideoSources[channel];
      video.pause();

      // Stop camera stream if it's a camera
      if (video.srcObject) {
        const tracks = video.srcObject.getTracks();
        tracks.forEach(track => track.stop());
        video.srcObject = null;
      }

      video.src = '';
      video.load();
      this.channelVideoSources[channel] = null;
    }

    // Stop and cleanup audio source
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

    // Cleanup NDI source
    if (this.channelNDIData[channel]) {
      this.channelNDIData[channel] = null;
    }

    // Reset to default black texture
    if (this.channelTextures[channel]) {
      gl.deleteTexture(this.channelTextures[channel]);
    }

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      BLACK_PIXEL);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    this.channelTextures[channel] = texture;
    this.channelResolutions[channel] = [0, 0, 1];
    this.channelTypes[channel] = 'empty';
  }

  clearChannel(channel) {
    this.cleanupChannel(channel);
    return { type: 'empty' };
  }

  // Initialize channel for NDI source
  initNDIChannel(channel, sourceName) {
    const gl = this.gl;

    // Cleanup any existing source on this channel
    this.cleanupChannel(channel);

    // Create texture for NDI
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Initialize with 1x1 black texture until first frame arrives
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, BLACK_PIXEL);

    this.channelTextures[channel] = texture;
    this.channelResolutions[channel] = [1, 1, 1];
    this.channelTypes[channel] = 'ndi';
    this.channelNDIData[channel] = { width: 1, height: 1, data: null, needsUpdate: false, sourceName };

    return { type: 'ndi', source: sourceName };
  }

  // Update NDI frame data for a channel
  setNDIFrame(channel, width, height, rgbaData) {
    if (this.channelTypes[channel] !== 'ndi') {
      return;
    }

    // Update resolution if changed
    if (this.channelResolutions[channel][0] !== width || this.channelResolutions[channel][1] !== height) {
      this.channelResolutions[channel] = [width, height, 1];
    }

    // Mutate in place to avoid object spread allocation per frame
    const ndiData = this.channelNDIData[channel];
    ndiData.width = width;
    ndiData.height = height;
    ndiData.data = rgbaData;
    ndiData.needsUpdate = true;
  }

  updateVideoTextures() {
    const gl = this.gl;

    for (let i = 0; i < 4; i++) {
      // Skip empty channels early to avoid unnecessary checks
      const channelType = this.channelTypes[i];
      if (channelType === 'empty' || channelType === 'image' || channelType === 'builtin') {
        continue;  // Static textures don't need per-frame updates
      }

      // Update video/camera textures
      if (channelType === 'video' || channelType === 'camera') {
        const video = this.channelVideoSources[i];
        if (video && video.readyState >= 2) {
          gl.bindTexture(gl.TEXTURE_2D, this.channelTextures[i]);
          const sz = this._channelTexSizes[i];
          if (sz[0] === video.videoWidth && sz[1] === video.videoHeight) {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
          } else {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
            sz[0] = video.videoWidth;
            sz[1] = video.videoHeight;
          }
        }
        continue;
      }

      // Update audio textures with FFT data
      if (channelType === 'audio') {
        const audio = this.channelAudioSources[i];
        if (audio) {
          const bins = audio.bins;
          // Get frequency data (FFT)
          audio.analyser.getByteFrequencyData(audio.frequencyData);

          // Get time domain data (waveform)
          audio.analyser.getByteTimeDomainData(audio.timeDomainData);

          // Combine into pre-allocated buffer (2 rows: FFT on row 0, waveform on row 1)
          this._audioBuffer.set(audio.frequencyData, 0);       // Row 0: FFT
          this._audioBuffer.set(audio.timeDomainData, bins);   // Row 1: Waveform

          // Update texture (bins x 2, use texSubImage2D after first upload)
          gl.bindTexture(gl.TEXTURE_2D, this.channelTextures[i]);
          const sz = this._channelTexSizes[i];
          const buf = new Uint8Array(this._audioBuffer.buffer, 0, bins * 2);
          if (sz[0] === bins && sz[1] === 2) {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, bins, 2, gl.LUMINANCE, gl.UNSIGNED_BYTE, buf);
          } else {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, bins, 2, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, buf);
            sz[0] = bins;
            sz[1] = 2;
          }
        }
        continue;
      }

      // Update NDI textures
      if (channelType === 'ndi') {
        const ndi = this.channelNDIData[i];
        if (ndi && ndi.needsUpdate) {
          gl.bindTexture(gl.TEXTURE_2D, this.channelTextures[i]);
          const sz = this._channelTexSizes[i];
          if (sz[0] === ndi.width && sz[1] === ndi.height) {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ndi.width, ndi.height, gl.RGBA, gl.UNSIGNED_BYTE, ndi.data);
          } else {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ndi.width, ndi.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, ndi.data);
            sz[0] = ndi.width;
            sz[1] = ndi.height;
          }
          ndi.needsUpdate = false;
        }
      }
    }
  }

  getChannelType(channel) {
    return this.channelTypes[channel];
  }

  setParam(name, value) {
    // Check custom params first
    if (this.customParamValues.hasOwnProperty(name)) {
      this.customParamValues[name] = value;
      this._paramsDirty = true;
    } else if (this.params.hasOwnProperty(name)) {
      this.params[name] = value;
      this._paramsDirty = true;
    }
  }

  getParams() {
    // Return cached params if not dirty
    if (!this._paramsDirty && this._cachedParams) {
      return this._cachedParams;
    }
    this._cachedParams = { ...this.params, ...this.customParamValues };
    this._paramsDirty = false;
    return this._cachedParams;
  }

  // Get the current shader's custom parameter definitions
  getCustomParamDefs() {
    return this.customParams;
  }

  // Get custom parameter values only
  getCustomParamValues() {
    return { ...this.customParamValues };
  }

  // Set all custom param values at once (e.g., when loading a preset)
  setCustomParamValues(values) {
    for (const [name, value] of Object.entries(values)) {
      if (this.customParamValues.hasOwnProperty(name)) {
        this.customParamValues[name] = value;
      }
    }
    this._paramsDirty = true;
  }

  // Set params including custom params (for loading slot params)
  setParams(params) {
    if (!params) return;
    for (const [name, value] of Object.entries(params)) {
      this.setParam(name, value);
    }
  }

  // Set all custom uniform values to the GPU
  setCustomUniforms() {
    GLUtils.setCustomUniforms(this.gl, this.customParams, this.customParamValues, this.customParamUniforms);
  }

  applyTextureDirectives(directives) {
    const gl = this.gl;
    for (const { channel, textureName } of directives) {
      const entry = createBuiltinTexture(gl, textureName);
      if (!entry) continue;

      // Delete old texture for this channel
      if (this.channelTextures[channel]) {
        gl.deleteTexture(this.channelTextures[channel]);
      }

      this.channelTextures[channel] = entry.texture;
      this.channelResolutions[channel] = [entry.width, entry.height, 1];
      this.channelTypes[channel] = 'builtin';
      // Clear any video/audio/NDI source on this channel
      this.channelVideoSources[channel] = null;
      this.channelAudioSources[channel] = null;
      this.channelNDIData[channel] = null;
    }
  }

  setResolution(width, height) {
    _srLog.debug('Resolution', width + 'x' + height);
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  compile(fragmentSource) {
    const gl = this.gl;
    _srLog.info('Compiling', fragmentSource.length, 'chars');

    // Store for potential recompile after context restore
    this._lastShaderSource = fragmentSource;

    // Parse custom parameters from shader source
    this.customParams = ShaderParamParser.parse(fragmentSource);
    this.customParamValues = ShaderParamParser.createParamValues(this.customParams);
    this.customParamUniforms = {};
    this._paramsDirty = true;  // Invalidate params cache on recompile

    // Generate uniform declarations for custom params
    const customUniformDecls = ShaderParamParser.generateUniformDeclarations(this.customParams);

    // Build wrapped fragment shader
    const wrappedFragment = GLUtils.buildFragmentWrapper(fragmentSource, customUniformDecls);

    // Compile and link
    let program;
    try {
      program = GLUtils.compileProgram(gl, GLUtils.VERTEX_SHADER_SOURCE, wrappedFragment);
    } catch (err) {
      if (err._isCompileError) {
        // Parse error to extract line number (adjust for wrapper lines)
        const parsed = this.parseShaderError(err.raw);
        _srLog.error('Compile failed at line', parsed.line, parsed.message);
        throw { message: parsed.message, line: parsed.line, raw: err.raw };
      }
      throw err;
    }

    // Clean up old program
    if (this.program) {
      gl.deleteProgram(this.program);
    }

    this.program = program;

    // Cache uniform locations
    this.uniforms = GLUtils.cacheStandardUniforms(gl, program);
    this.customParamUniforms = GLUtils.cacheCustomParamUniforms(gl, program, this.customParams);

    // Parse @texture directives and separate builtin vs file vs audio
    const allDirectives = ShaderParamParser.parseTextureDirectives(fragmentSource);
    this.textureDirectives = allDirectives.filter(d => d.type === 'builtin');
    this.fileTextureDirectives = allDirectives.filter(d => d.type === 'file');
    this.audioDirectives = allDirectives.filter(d => d.type === 'audio');
    this.applyTextureDirectives(this.textureDirectives);

    // Apply audio directives (async, non-blocking)
    for (const { channel, fftSize } of this.audioDirectives) {
      this.loadAudio(channel, fftSize).catch(err => _srLog.warn('AudioFFT directive failed:', err.message));
    }

    _srLog.debug('Compiled', fragmentSource.length, 'chars,', this.customParams.length, 'params');
    return { success: true };
  }

  parseShaderError(error) {
    // WebGL error format: ERROR: 0:LINE: message (using pre-compiled regex)
    const match = error.match(SHADER_ERROR_REGEX);
    if (match) {
      // Subtract wrapper lines (header before user code)
      // Count: #version + precision*2 + standard uniforms (13) + custom uniforms comment + out + empty lines
      const baseWrapperLines = 18; // Lines before ${customUniformDecls} (includes iBPM uniform)
      const customUniformLines = this.customParams ? this.customParams.length : 0;
      const wrapperLines = baseWrapperLines + customUniformLines + 3; // +3 for out, empty line, fragment source marker
      const line = Math.max(1, parseInt(match[1]) - wrapperLines);
      return { line, message: match[2] };
    }
    return { line: null, message: error };
  }

  render() {
    if (!this.program) return null;

    const gl = this.gl;
    const now = performance.now();

    // Update video/camera textures each frame
    this.updateVideoTextures();

    // Update beat detector from first active audio channel
    let bpmValue = 1.0;
    for (let i = 0; i < 4; i++) {
      if (this.channelAudioSources[i]) {
        this.beatDetector.update(this.channelAudioSources[i].frequencyData);
        bpmValue = this.beatDetector.getBPM() / 100;
        break;
      }
    }

    // Calculate time (with speed multiplier applied)
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

    // Date uniform (reuse Date object to avoid allocation per frame)
    const date = this._dateObject;
    date.setTime(Date.now());
    const dateValues = [
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds() + date.getMilliseconds() / 1000
    ];

    // Set uniforms
    gl.useProgram(this.program);

    gl.uniform3f(this.uniforms.iResolution, this.canvas.width, this.canvas.height, 1);
    gl.uniform1f(this.uniforms.iTime, currentTime);
    gl.uniform1f(this.uniforms.iTimeDelta, timeDelta);
    gl.uniform1i(this.uniforms.iFrame, this.frameCount);
    gl.uniform4f(this.uniforms.iDate, dateValues[0], dateValues[1], dateValues[2], dateValues[3]);

    // Mouse: xy = current pos, zw = click pos (z negative if not pressed)
    const mouseZ = this.mouse.isDown ? this.mouse.clickX : -this.mouse.clickX;
    const mouseW = this.mouse.isDown ? this.mouse.clickY : -this.mouse.clickY;
    gl.uniform4f(this.uniforms.iMouse, this.mouse.x, this.mouse.y, mouseZ, mouseW);
    gl.uniform1f(this.uniforms.iBPM, bpmValue);

    // Set custom parameter uniforms
    this.setCustomUniforms();

    // Bind textures
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.channelTextures[i]);
      gl.uniform1i(this.uniforms[`iChannel${i}`], i);
    }

    // Set channel resolutions (use pre-allocated array)
    for (let i = 0; i < 4; i++) {
      this._resolutionsArray[i * 3] = this.channelResolutions[i][0];
      this._resolutionsArray[i * 3 + 1] = this.channelResolutions[i][1];
      this._resolutionsArray[i * 3 + 2] = this.channelResolutions[i][2];
    }
    gl.uniform3fv(this.uniforms.iChannelResolution, this._resolutionsArray);

    // Draw
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

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

  // Update time without rendering (for when preview is disabled)
  updateTime() {
    const now = performance.now();
    this.lastFrameTime = now;

    if (this.isPlaying) {
      this.frameCount++;
    }

    // Still update video/camera/audio textures so fullscreen stays synced
    this.updateVideoTextures();
  }
}
