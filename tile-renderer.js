// =============================================================================
// TileRenderer Class
// Lightweight renderer for individual tiles in tiled fullscreen mode
// Uses viewport scissoring to render to a specific region of a shared canvas
//
// Reuses the same shader param parsing logic as ShaderRenderer
// =============================================================================

class TileRenderer {
  constructor(gl, bounds) {
    this.gl = gl;
    this.bounds = bounds;  // { x, y, width, height, tileIndex }
    this.program = null;
    this.uniforms = {};

    // Custom parameters
    this.customParams = [];
    this.customParamValues = {};
    this.customParamUniforms = {};

    // Legacy fixed params
    this.params = { speed: 1.0 };

    // Shader source
    this.shaderSource = null;

    // Setup geometry (shared quad vertices)
    this.setupGeometry();
  }

  setupGeometry() {
    const gl = this.gl;

    // Full-screen quad vertices
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

  // Update bounds (when layout changes)
  setBounds(bounds) {
    this.bounds = bounds;
  }

  // Parse shader parameters (reuses ShaderParamParser from shader-renderer.js)
  parseParams(source) {
    // ShaderParamParser should be available globally
    if (typeof ShaderParamParser !== 'undefined') {
      this.customParams = ShaderParamParser.parse(source);
      this.customParamValues = ShaderParamParser.createParamValues(this.customParams);
    } else {
      this.customParams = [];
      this.customParamValues = {};
    }
  }

  // Compile a shader for this tile
  compile(fragmentSource) {
    const gl = this.gl;

    this.shaderSource = fragmentSource;

    // Parse custom parameters
    this.parseParams(fragmentSource);

    // Generate uniform declarations for custom params
    let customUniformDecls = '';
    if (typeof ShaderParamParser !== 'undefined') {
      customUniformDecls = ShaderParamParser.generateUniformDeclarations(this.customParams);
    }

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

      // Parse error to extract line number
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
      iChannelResolution: gl.getUniformLocation(program, 'iChannelResolution')
    };

    // Cache uniform locations for custom parameters
    this.customParamUniforms = {};
    for (const param of this.customParams) {
      if (param.isArray) {
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
    const match = error.match(/ERROR:\s*\d+:(\d+):\s*(.+)/);
    if (match) {
      const baseWrapperLines = 17;
      const customUniformLines = this.customParams ? this.customParams.length : 0;
      const wrapperLines = baseWrapperLines + customUniformLines + 3;
      const line = Math.max(1, parseInt(match[1]) - wrapperLines);
      return { line, message: match[2] };
    }
    return { line: null, message: error };
  }

  // Set a parameter value
  setParam(name, value) {
    if (this.customParamValues.hasOwnProperty(name)) {
      this.customParamValues[name] = value;
    } else if (this.params.hasOwnProperty(name)) {
      this.params[name] = value;
    }
  }

  // Set all parameters at once
  setParams(params) {
    if (!params) return;
    for (const [name, value] of Object.entries(params)) {
      this.setParam(name, value);
    }
  }

  // Get all parameters
  getParams() {
    return { ...this.params, ...this.customParamValues };
  }

  // Set custom uniforms to GPU
  setCustomUniforms() {
    const gl = this.gl;

    for (const param of this.customParams) {
      const value = this.customParamValues[param.name];
      const location = this.customParamUniforms[param.name];

      if (location === null || location === undefined) continue;

      if (param.isArray) {
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

  // Render this tile to its viewport region
  // Uses shared time, textures, and channel resolutions passed from the main renderer
  render(sharedState) {
    if (!this.program) return;

    const gl = this.gl;
    const { x, y, width, height } = this.bounds;
    const {
      time,
      timeDelta,
      frame,
      mouse,
      date,
      channelTextures,
      channelResolutions
    } = sharedState;

    // Set viewport and scissor to this tile's region
    gl.viewport(x, y, width, height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, width, height);

    // Use this tile's shader program
    gl.useProgram(this.program);

    // Set standard uniforms (resolution is tile size, not canvas size)
    gl.uniform3f(this.uniforms.iResolution, width, height, 1);
    gl.uniform1f(this.uniforms.iTime, time * this.params.speed);
    gl.uniform1f(this.uniforms.iTimeDelta, timeDelta * this.params.speed);
    gl.uniform1i(this.uniforms.iFrame, frame);
    gl.uniform4f(this.uniforms.iDate, date[0], date[1], date[2], date[3]);

    // Mouse coords scaled to tile (relative to tile bounds)
    // For simplicity, we can pass normalized mouse or tile-relative coords
    const mouseZ = mouse.isDown ? mouse.clickX : -mouse.clickX;
    const mouseW = mouse.isDown ? mouse.clickY : -mouse.clickY;
    gl.uniform4f(this.uniforms.iMouse, mouse.x, mouse.y, mouseZ, mouseW);

    // Set custom parameter uniforms
    this.setCustomUniforms();

    // Bind shared textures
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, channelTextures[i]);
      gl.uniform1i(this.uniforms[`iChannel${i}`], i);
    }

    // Set channel resolutions
    gl.uniform3fv(this.uniforms.iChannelResolution, channelResolutions);

    // Draw
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Disable scissor test after rendering
    gl.disable(gl.SCISSOR_TEST);
  }

  // Clean up resources
  dispose() {
    const gl = this.gl;

    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }

    if (this.vao) {
      gl.deleteVertexArray(this.vao);
      this.vao = null;
    }
  }
}

// Export for use in fullscreen-renderer.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TileRenderer;
}
