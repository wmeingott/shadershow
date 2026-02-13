// =============================================================================
// TileRenderer Class
// Lightweight renderer for individual tiles in tiled fullscreen mode
// Uses viewport scissoring to render to a specific region of a shared canvas
//
// Reuses the same shader param parsing logic as ShaderRenderer
// Uses GLUtils (gl-utils.ts) for shared WebGL utilities
// =============================================================================

import type { ParamDef, ParamValues, TextureDirective } from '@shared/types/params.js';
import type { CompileResult } from '@shared/types/renderer.js';
import { parseShaderParams, generateUniformDeclarations, createParamValues, parseTextureDirectives } from '@shared/param-parser.js';
import {
  setupFullscreenQuad,
  buildFragmentWrapper,
  compileProgram,
  VERTEX_SHADER_SOURCE,
  cacheStandardUniforms,
  cacheCustomParamUniforms,
  setCustomUniforms,
  loadTextureFromDataUrl,
  parseShaderError,
} from './gl-utils.js';
import type { StandardUniforms, CustomParamUniforms, ShaderErrorInfo } from './gl-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tile bounds within the shared canvas */
export interface TileBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  tileIndex?: number;
}

/** Mouse state passed from the main renderer */
export interface MouseState {
  x: number;
  y: number;
  isDown: boolean;
  clickX: number;
  clickY: number;
}

/** Shared state passed to render() from the fullscreen renderer */
export interface TileSharedState {
  time: number;
  timeDelta: number;
  frame: number;
  mouse: MouseState;
  date: [number, number, number, number];
  channelTextures: (WebGLTexture | null)[];
  channelResolutions: Float32Array | number[];
}

/** Extended uniforms for tile renderer (standard + iTileOffset) */
interface TileUniforms extends StandardUniforms {
  iTileOffset: WebGLUniformLocation | null;
}

/** Compile error thrown by GLUtils.compileProgram */
interface CompileError {
  message: string;
  raw: string;
  _isCompileError: true;
}

// ---------------------------------------------------------------------------
// TileRenderer
// ---------------------------------------------------------------------------

export class TileRenderer {
  private gl: WebGL2RenderingContext;
  private bounds: TileBounds;
  private program: WebGLProgram | null = null;
  private uniforms: TileUniforms = {} as TileUniforms;

  // Custom parameters
  private customParams: ParamDef[] = [];
  private customParamValues: ParamValues = {};
  private customParamUniforms: CustomParamUniforms = {};

  // Legacy fixed params
  private params: { speed: number; [key: string]: number } = { speed: 1.0 };

  // Shader source
  private shaderSource: string | null = null;

  // File texture directives (populated on compile)
  fileTextureDirectives: TextureDirective[] = [];

  // Per-tile channel textures (overrides shared textures when set)
  private channelTextures: (WebGLTexture | null)[] = [null, null, null, null];
  private channelResolutions: number[][] = [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]];
  private _resArray: Float32Array = new Float32Array(12);  // Pre-allocated for render loop

  // Setup geometry (shared quad vertices)
  private vao: WebGLVertexArrayObject | null;

  constructor(gl: WebGL2RenderingContext, bounds: TileBounds) {
    this.gl = gl;
    this.bounds = bounds;
    this.vao = setupFullscreenQuad(gl);
  }

  // Update bounds (when layout changes)
  setBounds(bounds: TileBounds): void {
    this.bounds = bounds;
  }

  // Parse shader parameters
  private parseParams(source: string): void {
    this.customParams = parseShaderParams(source);
    this.customParamValues = createParamValues(this.customParams);
  }

  // Compile a shader for this tile
  compile(fragmentSource: string): CompileResult {
    const gl = this.gl;

    this.shaderSource = fragmentSource;

    // Parse custom parameters
    this.parseParams(fragmentSource);

    // Generate uniform declarations for custom params
    const customUniformDecls = generateUniformDeclarations(this.customParams);

    // Build wrapped fragment shader with tile offset support
    const wrappedFragment = buildFragmentWrapper(fragmentSource, customUniformDecls, {
      extraUniforms: '// Tile offset for coordinate adjustment\nuniform vec2 iTileOffset;',
      mainBody: '// Adjust gl_FragCoord to be relative to tile, not window\nvec2 fragCoord = gl_FragCoord.xy - iTileOffset;\nmainImage(outColor, fragCoord);'
    });

    // Compile and link
    let program: WebGLProgram;
    try {
      program = compileProgram(gl, VERTEX_SHADER_SOURCE, wrappedFragment);
    } catch (err: unknown) {
      const compileErr = err as CompileError;
      if (compileErr._isCompileError) {
        const parsed = this.parseShaderError(compileErr.raw);
        throw { message: parsed.message, line: parsed.line, raw: compileErr.raw };
      }
      throw err;
    }

    // Clean up old program
    if (this.program) {
      gl.deleteProgram(this.program);
    }

    this.program = program;

    // Cache uniform locations
    const stdUniforms = cacheStandardUniforms(gl, program);
    this.uniforms = {
      ...stdUniforms,
      iTileOffset: gl.getUniformLocation(program, 'iTileOffset'),
    };

    // Cache uniform locations for custom parameters
    this.customParamUniforms = cacheCustomParamUniforms(gl, program, this.customParams);

    // Parse @texture directives for file textures
    this.fileTextureDirectives = [];
    const allDirectives = parseTextureDirectives(fragmentSource);
    this.fileTextureDirectives = allDirectives.filter(d => d.type === 'file');

    return { success: true };
  }

  private parseShaderError(error: string): ShaderErrorInfo {
    const baseWrapperLines = 17;
    const customUniformLines = this.customParams ? this.customParams.length : 0;
    const wrapperLines = baseWrapperLines + customUniformLines + 3;
    return parseShaderError(error, wrapperLines);
  }

  // Set a parameter value
  setParam(name: string, value: number): void {
    if (Object.prototype.hasOwnProperty.call(this.customParamValues, name)) {
      this.customParamValues[name] = value;
    } else if (Object.prototype.hasOwnProperty.call(this.params, name)) {
      this.params[name] = value;
    }
  }

  // Set all parameters at once
  setParams(params: Record<string, number> | null | undefined): void {
    if (!params) return;
    for (const [name, value] of Object.entries(params)) {
      this.setParam(name, value);
    }
  }

  // Get all parameters
  getParams(): ParamValues {
    return { ...this.params, ...this.customParamValues };
  }

  // Set custom uniforms to GPU
  private setCustomUniforms(): void {
    setCustomUniforms(this.gl, this.customParams, this.customParamValues as Record<string, number | number[]>, this.customParamUniforms);
  }

  // Load a texture into a per-tile channel from a data URL
  loadTexture(channel: number, dataUrl: string): Promise<{ width: number; height: number }> {
    if (this.channelTextures[channel]) {
      this.gl.deleteTexture(this.channelTextures[channel]);
    }
    return loadTextureFromDataUrl(this.gl, dataUrl).then(({ texture, width, height }) => {
      this.channelTextures[channel] = texture;
      this.channelResolutions[channel] = [width, height, 1];
      return { width, height };
    });
  }

  // Render this tile to its viewport region
  // Uses shared time, textures, and channel resolutions passed from the main renderer
  render(sharedState: TileSharedState): void {
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
      gl.uniform1i(this.uniforms[`iChannel${i}` as keyof StandardUniforms] as WebGLUniformLocation | null, i);
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
  dispose(): void {
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
