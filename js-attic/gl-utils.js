// =============================================================================
// GLUtils — Shared WebGL utility functions used by ShaderRenderer, TileRenderer,
// and MiniShaderRenderer. Loaded as a plain <script> before the renderers.
// =============================================================================

const GLUtils = {
  // Standard passthrough vertex shader source (version 300 es)
  VERTEX_SHADER_SOURCE: `#version 300 es
    layout(location = 0) in vec2 position;
    void main() {
      gl_Position = vec4(position, 0.0, 1.0);
    }
  `,

  // Fullscreen quad vertex data
  QUAD_VERTICES: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),

  // Set up a fullscreen quad VBO + VAO and return the VAO
  setupFullscreenQuad(gl) {
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.QUAD_VERTICES, gl.STATIC_DRAW);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    return vao;
  },

  // Build a Shadertoy-compatible fragment shader wrapper.
  // customDecls: extra uniform declarations (e.g. from @param)
  // extras: object with optional extra uniform lines and main body adjustments
  buildFragmentWrapper(fragmentSource, customDecls, extras) {
    const extraUniforms = extras?.extraUniforms || '';
    const mainBody = extras?.mainBody || 'mainImage(outColor, gl_FragCoord.xy);';

    return `#version 300 es
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
      uniform float iBPM;

      ${extraUniforms}

      // Custom shader parameters (parsed from @param comments)
      ${customDecls}

      out vec4 outColor;

      ${fragmentSource}

      void main() {
        ${mainBody}
      }
    `;
  },

  // Compile a vertex + fragment shader and link into a program.
  // Returns the linked program, or throws with error details.
  compileProgram(gl, vertSrc, fragSrc) {
    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    if (!vertexShader) {
      throw new Error('Failed to create vertex shader - WebGL context may be lost');
    }
    gl.shaderSource(vertexShader, vertSrc);
    gl.compileShader(vertexShader);

    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(vertexShader);
      gl.deleteShader(vertexShader);
      throw new Error(`Vertex shader error: ${error}`);
    }

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    if (!fragmentShader) {
      gl.deleteShader(vertexShader);
      throw new Error('Failed to create fragment shader - WebGL context may be lost');
    }
    gl.shaderSource(fragmentShader, fragSrc);
    gl.compileShader(fragmentShader);

    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(fragmentShader);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      throw { message: error, raw: error, _isCompileError: true };
    }

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

    // Shaders are now part of program, clean up
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    return program;
  },

  // Cache standard Shadertoy uniform locations on a program.
  // Returns an object with uniform locations.
  cacheStandardUniforms(gl, program) {
    return {
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
      iBPM: gl.getUniformLocation(program, 'iBPM')
    };
  },

  // Cache uniform locations for custom @param parameters.
  // Returns { paramName: location | location[] }
  cacheCustomParamUniforms(gl, program, params) {
    const uniforms = {};
    for (const param of params) {
      if (param.isArray) {
        uniforms[param.name] = [];
        for (let i = 0; i < param.arraySize; i++) {
          uniforms[param.name][i] = gl.getUniformLocation(program, `${param.name}[${i}]`);
        }
      } else {
        uniforms[param.name] = gl.getUniformLocation(program, param.name);
      }
    }
    return uniforms;
  },

  // Set a single uniform value by type (int/float/vec2/vec3/vec4/color)
  setUniformByType(gl, type, location, value) {
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
      case 'color':
      case 'vec3':
        gl.uniform3f(location, value[0], value[1], value[2]);
        break;
      case 'vec4':
        gl.uniform4f(location, value[0], value[1], value[2], value[3]);
        break;
    }
  },

  // Set all custom param uniforms from param definitions, values, and cached locations
  setCustomUniforms(gl, params, values, locations) {
    for (const param of params) {
      const value = values[param.name];
      const location = locations[param.name];

      if (location === null || location === undefined) continue;

      if (param.isArray) {
        for (let i = 0; i < param.arraySize; i++) {
          const elemLocation = location[i];
          if (elemLocation === null) continue;
          this.setUniformByType(gl, param.type, elemLocation, value[i]);
        }
      } else {
        this.setUniformByType(gl, param.type, location, value);
      }
    }
  },

  // Load a texture from a data URL. Returns a Promise that resolves with
  // { texture, width, height } or rejects on error.
  loadTextureFromDataUrl(gl, dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        resolve({ texture, width: img.width, height: img.height });
      };
      img.onerror = () => reject(new Error('Failed to load texture image'));
      img.src = dataUrl;
    });
  },

  // Built-in noise texture specs
  BUILTIN_TEXTURES: {
    RGBANoise:      { width: 256, height: 256, gray: false },
    RGBANoiseBig:   { width: 1024, height: 1024, gray: false },
    RGBANoiseSmall: { width: 64,  height: 64,  gray: false },
    GrayNoise:      { width: 256, height: 256, gray: true },
    GrayNoiseBig:   { width: 1024, height: 1024, gray: true },
    GrayNoiseSmall: { width: 64,  height: 64,  gray: true }
  },

  // Generate random noise pixel data
  generateNoiseData(width, height, gray) {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const off = i * 4;
      if (gray) {
        const v = Math.floor(Math.random() * 256);
        data[off] = data[off + 1] = data[off + 2] = v;
      } else {
        data[off]     = Math.floor(Math.random() * 256);
        data[off + 1] = Math.floor(Math.random() * 256);
        data[off + 2] = Math.floor(Math.random() * 256);
      }
      data[off + 3] = 255;
    }
    return data;
  },

  // Create a GL texture filled with unique random noise.
  // Returns { texture, width, height } or null if name is unknown.
  createBuiltinTexture(gl, name) {
    const spec = this.BUILTIN_TEXTURES[name];
    if (!spec) return null;

    const { width, height, gray } = spec;
    const data = this.generateNoiseData(width, height, gray);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    return { texture, width, height };
  },

  // Parse a shader error message and adjust line number for wrapper offset
  parseShaderError(error, wrapperLineCount) {
    const match = error.match(/ERROR:\s*\d+:(\d+):\s*(.+)/);
    if (match) {
      const line = Math.max(1, parseInt(match[1]) - wrapperLineCount);
      return { line, message: match[2] };
    }
    return { line: null, message: error };
  }
};

// =============================================================================
// Asset Utilities — shared crop/draw and video loop helpers
// =============================================================================

const AssetUtils = {
  // Compute crop source rect and draw destination size from asset params.
  // Returns { sx, sy, sw, sh, drawW, drawH } or null if crop region is empty.
  computeCropDraw(srcW, srcH, params, destW, destH) {
    const { x = 0, y = 0, width = 0, height = 0, scale = 1, keepAR = 1, cropL = 0, cropT = 0, cropR = 1, cropB = 1 } = params;
    const sx = cropL * srcW;
    const sy = cropT * srcH;
    const sw = (cropR - cropL) * srcW;
    const sh = (cropB - cropT) * srcH;
    if (sw <= 0 || sh <= 0) return null;

    let drawW = (width || destW) * scale;
    let drawH = (height || destH) * scale;
    if (keepAR && sw > 0 && sh > 0) {
      drawH = drawW / (sw / sh);
    }
    return { sx, sy, sw, sh, drawW, drawH };
  },

  // Handle video loop: seek to start if currentTime >= end or < start.
  updateVideoLoop(video, params) {
    if (!video || !(video instanceof HTMLVideoElement)) return;
    const { loop, start, end } = params;
    if (loop && end > start && start >= 0) {
      if (video.currentTime >= end || video.currentTime < start) {
        video.currentTime = start;
      }
    }
  }
};
