// =============================================================================
// TileRenderer Class
// Lightweight renderer for individual tiles in tiled fullscreen mode
// Uses viewport scissoring to render to a specific region of a shared canvas
//
// Reuses the same shader param parsing logic as ShaderRenderer
// Uses GLUtils (gl-utils.js) for shared WebGL utilities
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

    // File texture directives (populated on compile)
    this.fileTextureDirectives = [];

    // Per-tile channel textures (overrides shared textures when set)
    this.channelTextures = [null, null, null, null];
    this.channelResolutions = [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]];
    this._resArray = new Float32Array(12);  // Pre-allocated for render loop

    // Setup geometry (shared quad vertices)
    this.vao = GLUtils.setupFullscreenQuad(gl);
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

    // Build wrapped fragment shader with tile offset support
    const wrappedFragment = GLUtils.buildFragmentWrapper(fragmentSource, customUniformDecls, {
      extraUniforms: '// Tile offset for coordinate adjustment\nuniform vec2 iTileOffset;',
      mainBody: '// Adjust gl_FragCoord to be relative to tile, not window\nvec2 fragCoord = gl_FragCoord.xy - iTileOffset;\nmainImage(outColor, fragCoord);'
    });

    // Compile and link
    let program;
    try {
      program = GLUtils.compileProgram(gl, GLUtils.VERTEX_SHADER_SOURCE, wrappedFragment);
    } catch (err) {
      if (err._isCompileError) {
        const parsed = this.parseShaderError(err.raw);
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
    this.uniforms.iTileOffset = gl.getUniformLocation(program, 'iTileOffset');

    // Cache uniform locations for custom parameters
    this.customParamUniforms = GLUtils.cacheCustomParamUniforms(gl, program, this.customParams);

    // Parse @texture directives for file textures
    this.fileTextureDirectives = [];
    if (typeof ShaderParamParser !== 'undefined') {
      const allDirectives = ShaderParamParser.parseTextureDirectives(fragmentSource);
      this.fileTextureDirectives = allDirectives.filter(d => d.type === 'file');
    }

    return { success: true };
  }

  parseShaderError(error) {
    const baseWrapperLines = 17;
    const customUniformLines = this.customParams ? this.customParams.length : 0;
    const wrapperLines = baseWrapperLines + customUniformLines + 3;
    return GLUtils.parseShaderError(error, wrapperLines);
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
    GLUtils.setCustomUniforms(this.gl, this.customParams, this.customParamValues, this.customParamUniforms);
  }

  // Load a texture into a per-tile channel from a data URL
  loadTexture(channel, dataUrl) {
    if (this.channelTextures[channel]) {
      this.gl.deleteTexture(this.channelTextures[channel]);
    }
    return GLUtils.loadTextureFromDataUrl(this.gl, dataUrl).then(({ texture, width, height }) => {
      this.channelTextures[channel] = texture;
      this.channelResolutions[channel] = [width, height, 1];
      return { width, height };
    });
  }

  // Render this tile to its viewport region
  // Uses shared time, textures, and channel resolutions passed from the main renderer
  render(sharedState) {
    if (!this.program) return;

    const gl = this.gl;
    const { x, y, width, height } = this.bounds;

    // Skip if bounds are invalid
    if (!width || !height || width < 10 || height < 10) {
      console.warn('TileRenderer: Invalid bounds, skipping render', this.bounds);
      return;
    }
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
    const mouseZ = mouse.isDown ? mouse.clickX : -mouse.clickX;
    const mouseW = mouse.isDown ? mouse.clickY : -mouse.clickY;
    gl.uniform4f(this.uniforms.iMouse, mouse.x, mouse.y, mouseZ, mouseW);

    // Set tile offset for coordinate adjustment (gl_FragCoord is in window coords)
    gl.uniform2f(this.uniforms.iTileOffset, x, y);

    // Set custom parameter uniforms
    this.setCustomUniforms();

    // Bind textures (per-tile overrides shared when available)
    const resArray = this._resArray;
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      const tex = this.channelTextures[i] || channelTextures[i];
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(this.uniforms[`iChannel${i}`], i);
      if (this.channelTextures[i]) {
        resArray[i * 3] = this.channelResolutions[i][0];
        resArray[i * 3 + 1] = this.channelResolutions[i][1];
        resArray[i * 3 + 2] = this.channelResolutions[i][2];
      } else {
        resArray[i * 3] = channelResolutions[i * 3];
        resArray[i * 3 + 1] = channelResolutions[i * 3 + 1];
        resArray[i * 3 + 2] = channelResolutions[i * 3 + 2];
      }
    }

    // Set channel resolutions
    gl.uniform3fv(this.uniforms.iChannelResolution, resArray);

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

    // Clean up per-tile textures
    for (let i = 0; i < 4; i++) {
      if (this.channelTextures[i]) {
        gl.deleteTexture(this.channelTextures[i]);
        this.channelTextures[i] = null;
      }
    }
  }
}

// Export for use in fullscreen-renderer.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TileRenderer;
}
