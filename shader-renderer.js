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
    this.channelTypes = ['empty', 'empty', 'empty', 'empty']; // 'empty', 'image', 'video', 'camera', 'audio', 'ndi'

    // Audio sources for channels
    this.channelAudioSources = [null, null, null, null]; // { audioContext, analyser, stream, frequencyData, timeDomainData }

    // NDI sources for channels
    this.channelNDIData = [null, null, null, null]; // { width, height, data (Uint8Array) }

    // Custom parameters (sliders)
    this.params = {
      speed: 1.0
    };

    // Params array (5 parameters)
    for (let i = 0; i < 5; i++) {
      this.params[`p${i}`] = 0.5;
    }

    // Color array (10 RGB colors)
    for (let i = 0; i < 10; i++) {
      this.params[`r${i}`] = 1.0;
      this.params[`g${i}`] = 1.0;
      this.params[`b${i}`] = 1.0;
    }

    // Uniform locations cache
    this.uniforms = {};

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
      video.src = `file://${filePath}`;
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

        // Combine into a single buffer (2 rows: FFT on row 0, waveform on row 1)
        const combinedData = new Uint8Array(512 * 2);
        combinedData.set(audio.frequencyData, 0);      // Row 0: FFT
        combinedData.set(audio.timeDomainData, 512);   // Row 1: Waveform

        // Update texture
        gl.bindTexture(gl.TEXTURE_2D, this.channelTextures[i]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 512, 2, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, combinedData);
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
    if (this.params.hasOwnProperty(name)) {
      this.params[name] = value;
    }
  }

  getParams() {
    return { ...this.params };
  }

  setResolution(width, height) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  compile(fragmentSource) {
    const gl = this.gl;

    // Vertex shader (simple pass-through)
    const vertexSource = `#version 300 es
      layout(location = 0) in vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    // Wrap fragment shader with Shadertoy compatibility
    const wrappedFragment = `#version 300 es
      precision highp float;
      precision highp int;

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

      // Custom parameters
      uniform vec3 iColorRGB[10];  // 10 RGB color slots (0-1 each)
      uniform float iParams[5];    // 5 custom parameters (0-1 each)
      uniform float iSpeed;        // Speed multiplier

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

    // Cache uniform locations
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
      iChannelResolution: gl.getUniformLocation(program, 'iChannelResolution'),
      iColorRGB: gl.getUniformLocation(program, 'iColorRGB'),
      iParams: gl.getUniformLocation(program, 'iParams'),
      iSpeed: gl.getUniformLocation(program, 'iSpeed')
    };

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
      const wrapperLines = 18; // Count of lines before user code in wrappedFragment
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

    // Custom parameters - build color array
    const colorArray = new Float32Array(30); // 10 colors * 3 components
    for (let i = 0; i < 10; i++) {
      colorArray[i * 3] = this.params[`r${i}`];
      colorArray[i * 3 + 1] = this.params[`g${i}`];
      colorArray[i * 3 + 2] = this.params[`b${i}`];
    }
    gl.uniform3fv(this.uniforms.iColorRGB, colorArray);

    // Build params array
    const paramsArray = new Float32Array(5);
    for (let i = 0; i < 5; i++) {
      paramsArray[i] = this.params[`p${i}`];
    }
    gl.uniform1fv(this.uniforms.iParams, paramsArray);
    gl.uniform1f(this.uniforms.iSpeed, this.params.speed);

    // Mouse: xy = current pos, zw = click pos (z negative if not pressed)
    const mouseZ = this.mouse.isDown ? this.mouse.clickX : -this.mouse.clickX;
    const mouseW = this.mouse.isDown ? this.mouse.clickY : -this.mouse.clickY;
    gl.uniform4f(this.uniforms.iMouse, this.mouse.x, this.mouse.y, mouseZ, mouseW);

    // Bind textures
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.channelTextures[i]);
      gl.uniform1i(this.uniforms[`iChannel${i}`], i);
    }

    // Set channel resolutions
    const resolutions = new Float32Array(12);
    for (let i = 0; i < 4; i++) {
      resolutions[i * 3] = this.channelResolutions[i][0];
      resolutions[i * 3 + 1] = this.channelResolutions[i][1];
      resolutions[i * 3 + 2] = this.channelResolutions[i][2];
    }
    gl.uniform3fv(this.uniforms.iChannelResolution, resolutions);

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
