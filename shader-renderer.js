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
// =============================================================================

const ShaderParamParser = {
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

    // Extract description (quoted string at the end)
    const descMatch = remaining.match(/"([^"]*)"$/);
    if (descMatch) {
      description = descMatch[1];
      remaining = remaining.slice(0, -descMatch[0].length).trim();
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

    return {
      name,
      type: baseType,
      arraySize,
      isArray: arraySize !== null,
      default: defaultValue,
      min,
      max,
      description,
      glslType: arraySize ? `${baseType}[${arraySize}]` : baseType,
      uniformDecl: arraySize ? `uniform ${baseType} ${name}[${arraySize}];` : `uniform ${baseType} ${name};`
    };
  },

  parse(shaderSource) {
    const params = [];
    const lines = shaderSource.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*')) {
        if (!trimmed.startsWith('*/')) break;
      }
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
  }
};

// =============================================================================
// ShaderRenderer Class
// =============================================================================

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

    // Legacy fixed params for Shadertoy compatibility (always available)
    this.params = { speed: 1.0 };

    // Uniform locations cache
    this.uniforms = {};

    // Pre-allocated buffers for render loop
    this._resolutionsArray = new Float32Array(12);
    this._audioBuffer = new Uint8Array(512 * 2);

    // Setup
    this.setupGeometry();
    this.setupMouseEvents();
    this.createDefaultTextures();
  }

  setupGeometry() {
    const gl = this.gl;

    // Full-screen quad
    const vertices = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
       1,  1
    ]);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
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

  createDefaultTextures() {
    const gl = this.gl;

    // Create default black textures for all channels
    for (let i = 0; i < 4; i++) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      this.channelTextures[i] = texture;
    }
  }

  loadTexture(channel, dataUrl) {
    return new Promise((resolve, reject) => {
      const gl = this.gl;
      const img = new Image();

      img.onload = () => {
        // Clean up any existing video source for this channel
        this.cleanupChannel(channel);

        // Delete old texture if exists
        if (this.channelTextures[channel]) {
          gl.deleteTexture(this.channelTextures[channel]);
        }

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

        this.channelTextures[channel] = texture;
        this.channelResolutions[channel] = [img.width, img.height, 1];
        this.channelTypes[channel] = 'image';

        resolve({ width: img.width, height: img.height });
      };

      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = dataUrl;
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

  async loadAudio(channel) {
    const gl = this.gl;

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
      analyser.fftSize = 1024; // 512 frequency bins
      analyser.smoothingTimeConstant = 0.8;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      // Create data arrays for FFT and waveform
      const frequencyData = new Uint8Array(512);
      const timeDomainData = new Uint8Array(512);

      // Create texture (512x2: row 0 = FFT, row 1 = waveform)
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // Initialize with empty data
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 512, 2, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, null);

      this.channelTextures[channel] = texture;
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
      new Uint8Array([0, 0, 0, 255]));
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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

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

    // Store frame data for texture update in render loop
    this.channelNDIData[channel] = {
      ...this.channelNDIData[channel],
      width,
      height,
      data: rgbaData,
      needsUpdate: true
    };
  }

  updateVideoTextures() {
    const gl = this.gl;

    for (let i = 0; i < 4; i++) {
      // Update video/camera textures
      if (this.channelVideoSources[i] && this.channelVideoSources[i].readyState >= 2) {
        const video = this.channelVideoSources[i];
        gl.bindTexture(gl.TEXTURE_2D, this.channelTextures[i]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      }

      // Update audio textures with FFT data
      if (this.channelAudioSources[i]) {
        const audio = this.channelAudioSources[i];

        // Get frequency data (FFT)
        audio.analyser.getByteFrequencyData(audio.frequencyData);

        // Get time domain data (waveform)
        audio.analyser.getByteTimeDomainData(audio.timeDomainData);

        // Combine into pre-allocated buffer (2 rows: FFT on row 0, waveform on row 1)
        this._audioBuffer.set(audio.frequencyData, 0);      // Row 0: FFT
        this._audioBuffer.set(audio.timeDomainData, 512);   // Row 1: Waveform

        // Update texture
        gl.bindTexture(gl.TEXTURE_2D, this.channelTextures[i]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 512, 2, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, this._audioBuffer);
      }

      // Update NDI textures
      if (this.channelNDIData[i] && this.channelNDIData[i].needsUpdate) {
        const ndi = this.channelNDIData[i];
        gl.bindTexture(gl.TEXTURE_2D, this.channelTextures[i]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ndi.width, ndi.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, ndi.data);
        ndi.needsUpdate = false;
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
    } else if (this.params.hasOwnProperty(name)) {
      this.params[name] = value;
    }
  }

  getParams() {
    return { ...this.params, ...this.customParamValues };
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
    const gl = this.gl;

    for (const param of this.customParams) {
      const value = this.customParamValues[param.name];
      const location = this.customParamUniforms[param.name];

      if (location === null || location === undefined) continue;

      if (param.isArray) {
        // Handle arrays
        for (let i = 0; i < param.arraySize; i++) {
          const elemLocation = location[i];
          if (elemLocation === null) continue;

          const elemValue = value[i];
          this.setUniformValue(gl, param.type, elemLocation, elemValue);
        }
      } else {
        this.setUniformValue(gl, param.type, location, value);
      }
    }
  }

  // Helper to set a single uniform value based on type
  setUniformValue(gl, type, location, value) {
    switch (type) {
      case 'int':
        gl.uniform1i(location, value);
        break;
      case 'float':
        gl.uniform1f(location, value);
        break;
      case 'vec2':
        gl.uniform2f(location, value[0], value[1]);
        break;
      case 'vec3':
        gl.uniform3f(location, value[0], value[1], value[2]);
        break;
      case 'vec4':
        gl.uniform4f(location, value[0], value[1], value[2], value[3]);
        break;
    }
  }

  setResolution(width, height) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  compile(fragmentSource) {
    const gl = this.gl;

    // Parse custom parameters from shader source
    this.customParams = ShaderParamParser.parse(fragmentSource);
    this.customParamValues = ShaderParamParser.createParamValues(this.customParams);
    this.customParamUniforms = {};

    // Generate uniform declarations for custom params
    const customUniformDecls = ShaderParamParser.generateUniformDeclarations(this.customParams);

    // Vertex shader (simple pass-through)
    const vertexSource = `#version 300 es
      layout(location = 0) in vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    // Wrap fragment shader with Shadertoy compatibility + custom params
    const wrappedFragment = `#version 300 es
      precision highp float;
      precision highp int;

      // Shadertoy standard uniforms
      uniform vec3 iResolution;
      uniform float iTime;
      uniform float iTimeDelta;
      uniform int iFrame;
      uniform vec4 iMouse;
      uniform vec4 iDate;
      uniform sampler2D iChannel0;
      uniform sampler2D iChannel1;
      uniform sampler2D iChannel2;
      uniform sampler2D iChannel3;
      uniform vec3 iChannelResolution[4];

      // Custom shader parameters (parsed from @param comments)
      ${customUniformDecls}

      out vec4 outColor;

      ${fragmentSource}

      void main() {
        mainImage(outColor, gl_FragCoord.xy);
      }
    `;

    // Compile vertex shader
    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertexShader, vertexSource);
    gl.compileShader(vertexShader);

    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(vertexShader);
      gl.deleteShader(vertexShader);
      throw new Error(`Vertex shader error: ${error}`);
    }

    // Compile fragment shader
    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragmentShader, wrappedFragment);
    gl.compileShader(fragmentShader);

    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(fragmentShader);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);

      // Parse error to extract line number (adjust for wrapper lines)
      const parsed = this.parseShaderError(error);
      throw { message: parsed.message, line: parsed.line, raw: error };
    }

    // Link program
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      throw new Error(`Link error: ${error}`);
    }

    // Clean up old program
    if (this.program) {
      gl.deleteProgram(this.program);
    }

    this.program = program;

    // Cache uniform locations for Shadertoy standard uniforms
    this.uniforms = {
      iResolution: gl.getUniformLocation(program, 'iResolution'),
      iTime: gl.getUniformLocation(program, 'iTime'),
      iTimeDelta: gl.getUniformLocation(program, 'iTimeDelta'),
      iFrame: gl.getUniformLocation(program, 'iFrame'),
      iMouse: gl.getUniformLocation(program, 'iMouse'),
      iDate: gl.getUniformLocation(program, 'iDate'),
      iChannel0: gl.getUniformLocation(program, 'iChannel0'),
      iChannel1: gl.getUniformLocation(program, 'iChannel1'),
      iChannel2: gl.getUniformLocation(program, 'iChannel2'),
      iChannel3: gl.getUniformLocation(program, 'iChannel3'),
      iChannelResolution: gl.getUniformLocation(program, 'iChannelResolution')
    };

    // Cache uniform locations for custom parameters
    this.customParamUniforms = {};
    for (const param of this.customParams) {
      if (param.isArray) {
        // For arrays, get location for each element
        this.customParamUniforms[param.name] = [];
        for (let i = 0; i < param.arraySize; i++) {
          this.customParamUniforms[param.name][i] = gl.getUniformLocation(program, `${param.name}[${i}]`);
        }
      } else {
        this.customParamUniforms[param.name] = gl.getUniformLocation(program, param.name);
      }
    }

    // Clean up shaders (they're now part of program)
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    return { success: true };
  }

  parseShaderError(error) {
    // WebGL error format: ERROR: 0:LINE: message
    const match = error.match(/ERROR:\s*\d+:(\d+):\s*(.+)/);
    if (match) {
      // Subtract wrapper lines (header before user code)
      // Count: #version + precision*2 + standard uniforms (13) + custom uniforms comment + out + empty lines
      const baseWrapperLines = 17; // Lines before ${customUniformDecls}
      const customUniformLines = this.customParams ? this.customParams.length : 0;
      const wrapperLines = baseWrapperLines + customUniformLines + 3; // +3 for out, empty line, fragment source marker
      const line = Math.max(1, parseInt(match[1]) - wrapperLines);
      return { line, message: match[2] };
    }
    return { line: null, message: error };
  }

  render() {
    if (!this.program) return;

    const gl = this.gl;
    const now = performance.now();

    // Update video/camera textures each frame
    this.updateVideoTextures();

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

    // Date uniform
    const date = new Date();
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
      frame: this.frameCount
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
