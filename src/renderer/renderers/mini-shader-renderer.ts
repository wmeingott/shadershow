// MiniShaderRenderer — Lightweight shader renderer for grid thumbnails.
// Uses a shared offscreen WebGL2 context to render mini previews,
// then copies the result to individual display canvases via 2D context.

import type { ParamDef, ParamValue, ParamArrayValue, GLSLType, TextureDirective } from '@shared/types/params.js';
import type { CustomParamUniforms, StandardUniforms } from './gl-utils.js';
import {
  setupFullscreenQuad,
  buildFragmentWrapper,
  compileProgram,
  VERTEX_SHADER_SOURCE,
  cacheStandardUniforms,
  cacheCustomParamUniforms,
  loadTextureFromDataUrl,
  createBuiltinTexture,
} from './gl-utils.js';
import { parseShaderParams, generateUniformDeclarations, parseTextureDirectives } from '@shared/param-parser.js';

// ---------------------------------------------------------------------------
// Shared WebGL context (one context for all MiniShaderRenderer instances)
// ---------------------------------------------------------------------------

let sharedGLCanvas: HTMLCanvasElement | null = null;
let sharedGL: WebGL2RenderingContext | null = null;
let sharedVAO: WebGLVertexArrayObject | null = null;

function getSharedGL(): WebGL2RenderingContext | null {
  if (!sharedGL) {
    sharedGLCanvas = document.createElement('canvas');
    sharedGLCanvas.width = 160;
    sharedGLCanvas.height = 90;
    sharedGL = sharedGLCanvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    });

    if (!sharedGL) {
      console.error('Failed to create shared WebGL2 context');
      return null;
    }

    sharedVAO = setupFullscreenQuad(sharedGL);

    sharedGLCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('Shared WebGL context lost');
    });

    sharedGLCanvas.addEventListener('webglcontextrestored', () => {
      console.log('Shared WebGL context restored');
      if (sharedGL) {
        sharedVAO = setupFullscreenQuad(sharedGL);
      }
    });
  }
  return sharedGL;
}

// ---------------------------------------------------------------------------
// Extended uniform locations for MiniShaderRenderer
// ---------------------------------------------------------------------------

interface MiniUniforms extends StandardUniforms {
  iColorRGB: WebGLUniformLocation | null;
  iParams: WebGLUniformLocation | null;
  iSpeed: WebGLUniformLocation | null;
}

// ---------------------------------------------------------------------------
// MiniShaderRenderer
// ---------------------------------------------------------------------------

export class MiniShaderRenderer {
  canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D | null;
  private gl: WebGL2RenderingContext | null;
  private contextValid: boolean;
  private program: WebGLProgram | null = null;
  private startTime: number = performance.now();
  private uniforms: MiniUniforms = {} as MiniUniforms;
  private speed: number = 1.0;

  // Built-in texture assignments (from @texture directives)
  private channelTextures: (WebGLTexture | null)[] = [null, null, null, null];
  private channelResolutions: number[][] = [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]];
  private _channelResArray: Float32Array = new Float32Array(12);

  // Pre-allocated legacy uniform buffers
  private _colorArray: Float32Array = new Float32Array(30).fill(1.0);   // 10 colors * 3 components
  private _paramsArray: Float32Array = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5]);

  // Custom param state
  private customParams: ParamDef[] = [];
  private customUniformLocations: CustomParamUniforms = {};
  customParamValues: Record<string, ParamValue> = {};

  // File texture directives (populated on compile)
  fileTextureDirectives: TextureDirective[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.gl = getSharedGL();
    this.contextValid = !!this.gl;

    if (!this.gl) {
      console.warn('Shared WebGL context not available');
    }
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  setResolution(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.ctx2d = this.canvas.getContext('2d');
    }
  }

  getResolution(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  private _resizeSharedCanvas(width: number, height: number): void {
    if (sharedGLCanvas && (sharedGLCanvas.width !== width || sharedGLCanvas.height !== height)) {
      sharedGLCanvas.width = width;
      sharedGLCanvas.height = height;
    }
  }

  static ensureSharedCanvasSize(width: number, height: number): void {
    if (!sharedGLCanvas) {
      getSharedGL();
    }
    if (sharedGLCanvas) {
      if (sharedGLCanvas.width < width || sharedGLCanvas.height < height) {
        sharedGLCanvas.width = Math.max(sharedGLCanvas.width, width);
        sharedGLCanvas.height = Math.max(sharedGLCanvas.height, height);
      }
    }
  }

  static getSharedCanvas(): HTMLCanvasElement | null {
    if (!sharedGLCanvas) {
      getSharedGL();
    }
    return sharedGLCanvas;
  }

  setParam(name: string, value: ParamValue): void {
    if (name === 'speed') {
      this.setSpeed(value as number);
    } else {
      this.customParamValues[name] = value;
    }
  }

  setParams(params: Record<string, ParamValue> | null | undefined): void {
    if (!params) return;
    for (const [name, value] of Object.entries(params)) {
      this.setParam(name, value);
    }
  }

  resetCustomParams(): void {
    this.customParamValues = {};
  }

  compile(fragmentSource: string): void {
    if (!this.contextValid || !this.gl) {
      throw new Error('WebGL context not available');
    }

    const gl = this.gl;

    // Parse custom @param comments and generate uniform declarations
    const customParams = parseShaderParams(fragmentSource);
    const customUniformDecls = generateUniformDeclarations(customParams);

    // MiniShaderRenderer uses legacy uniforms in addition to standard ones
    const wrappedFragment = buildFragmentWrapper(fragmentSource, customUniformDecls, {
      extraUniforms: 'uniform vec3 iColorRGB[10];\nuniform float iParams[5];\nuniform float iSpeed;',
    });

    let program: WebGLProgram;
    try {
      program = compileProgram(gl, VERTEX_SHADER_SOURCE, wrappedFragment);
    } catch (err: unknown) {
      const compileErr = err as { _isCompileError?: boolean; message: string };
      if (compileErr._isCompileError) {
        throw new Error(compileErr.message);
      }
      throw err;
    }

    if (this.program) gl.deleteProgram(this.program);
    this.program = program;

    const stdUniforms = cacheStandardUniforms(gl, program);
    this.uniforms = {
      ...stdUniforms,
      iColorRGB: gl.getUniformLocation(program, 'iColorRGB'),
      iParams: gl.getUniformLocation(program, 'iParams'),
      iSpeed: gl.getUniformLocation(program, 'iSpeed'),
    };

    this.customParams = customParams;
    this.customUniformLocations = cacheCustomParamUniforms(gl, program, customParams);

    // Clean up old builtin textures
    for (let i = 0; i < 4; i++) {
      if (this.channelTextures[i]) {
        gl.deleteTexture(this.channelTextures[i]);
        this.channelTextures[i] = null;
        this.channelResolutions[i] = [0, 0, 1];
      }
    }

    // Parse @texture directives
    const allDirectives = parseTextureDirectives(fragmentSource);
    const builtinDirectives = allDirectives.filter(d => d.type === 'builtin');
    this.fileTextureDirectives = allDirectives.filter(d => d.type === 'file');

    // Apply builtin noise textures
    for (const { channel, textureName } of builtinDirectives) {
      const entry = createBuiltinTexture(gl, textureName);
      if (entry) {
        this.channelTextures[channel] = entry.texture;
        this.channelResolutions[channel] = [entry.width, entry.height, 1];
      }
    }
  }

  loadFileTexture(channel: number, dataUrl: string): Promise<{ width: number; height: number }> {
    const gl = this.gl;
    if (!gl || !this.contextValid) {
      return Promise.reject(new Error('WebGL context not available'));
    }
    if (this.channelTextures[channel]) {
      gl.deleteTexture(this.channelTextures[channel]);
    }
    return loadTextureFromDataUrl(gl, dataUrl).then(({ texture, width, height }) => {
      this.channelTextures[channel] = texture;
      this.channelResolutions[channel] = [width, height, 1];
      return { width, height };
    });
  }

  render(): void {
    if (!this.program || !this.contextValid || !this.gl || !sharedGLCanvas) return;

    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;

    this._resizeSharedCanvas(width, height);
    this._renderInternal(gl, width, height);

    if (this.ctx2d) {
      this.ctx2d.drawImage(sharedGLCanvas, 0, 0, width, height);
    }
  }

  renderDirect(targetCtx: CanvasRenderingContext2D, destX: number, destY: number, destWidth: number, destHeight: number): void {
    if (!this.program || !this.contextValid || !this.gl || !sharedGLCanvas) return;

    const gl = this.gl;
    gl.viewport(0, 0, destWidth, destHeight);
    this._renderInternal(gl, destWidth, destHeight);

    targetCtx.drawImage(
      sharedGLCanvas,
      0, sharedGLCanvas.height - destHeight, destWidth, destHeight,
      destX, destY, destWidth, destHeight,
    );
  }

  private _renderInternal(gl: WebGL2RenderingContext, width: number, height: number): void {
    const time = (performance.now() - this.startTime) / 1000 * this.speed;

    gl.useProgram(this.program);

    gl.uniform3f(this.uniforms.iResolution, width, height, 1);
    gl.uniform1f(this.uniforms.iTime, time);

    // Legacy uniforms
    gl.uniform3fv(this.uniforms.iColorRGB, this._colorArray);
    gl.uniform1fv(this.uniforms.iParams, this._paramsArray);
    gl.uniform1f(this.uniforms.iSpeed, this.speed);

    // Custom param uniforms
    for (const param of this.customParams) {
      const loc = this.customUniformLocations[param.name];
      if (loc === null || loc === undefined) continue;

      const value = this.customParamValues[param.name] !== undefined
        ? this.customParamValues[param.name]
        : param.default;

      if (param.isArray && Array.isArray(loc)) {
        for (let i = 0; i < (param.arraySize ?? 0); i++) {
          const elemLoc = loc[i];
          if (elemLoc === null) continue;
          const elemValue = (value as ParamArrayValue)[i];
          this._setUniform(gl, param.glslBaseType, elemLoc, elemValue);
        }
      } else {
        this._setUniform(gl, param.glslBaseType, loc as WebGLUniformLocation, value as ParamValue);
      }
    }

    // Bind built-in textures
    let hasTextures = false;
    for (let i = 0; i < 4; i++) {
      if (this.channelTextures[i]) {
        hasTextures = true;
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, this.channelTextures[i]);
        gl.uniform1i((this.uniforms as unknown as Record<string, WebGLUniformLocation | null>)[`iChannel${i}`], i);
      }
    }
    if (hasTextures && this.uniforms.iChannelResolution) {
      for (let i = 0; i < 4; i++) {
        this._channelResArray[i * 3] = this.channelResolutions[i][0];
        this._channelResArray[i * 3 + 1] = this.channelResolutions[i][1];
        this._channelResArray[i * 3 + 2] = this.channelResolutions[i][2];
      }
      gl.uniform3fv(this.uniforms.iChannelResolution, this._channelResArray);
    }

    gl.bindVertexArray(sharedVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private _setUniform(gl: WebGL2RenderingContext, type: GLSLType, loc: WebGLUniformLocation, value: ParamValue): void {
    switch (type) {
      case 'float':
        gl.uniform1f(loc, value as number);
        break;
      case 'int':
        gl.uniform1i(loc, value as number);
        break;
      case 'vec2':
        gl.uniform2fv(loc, Array.isArray(value) ? value : [value, value]);
        break;
      case 'vec3':
        gl.uniform3fv(loc, Array.isArray(value) ? value : [value, value, value]);
        break;
      case 'vec4':
        gl.uniform4fv(loc, Array.isArray(value) ? value : [value, value, value, value]);
        break;
    }
  }

  dispose(): void {
    const gl = this.gl;
    if (!gl) return;

    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }

    this.contextValid = false;
    this.uniforms = {} as MiniUniforms;
    this.customUniformLocations = {};
    this.customParams = [];

    for (let i = 0; i < 4; i++) {
      if (this.channelTextures[i]) {
        gl.deleteTexture(this.channelTextures[i]);
      }
    }
    this.channelTextures = [null, null, null, null];
    this.channelResolutions = [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]];
  }
}
