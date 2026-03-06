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
  buildShaderExtras,
} from './gl-utils.js';
import { parseShaderParams, parseShaderConsts, generateConstDefines, generateUniformDeclarations, parseTextureDirectives, parseOption25D, createParamValues } from '@shared/param-parser.js';
import { ShaderTextureChannel } from './shader-texture-channel.js';
import { ppValues } from '../ui/post-process.js';
import { tilingValues } from '../ui/tiling.js';

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

  // Post-processing uniform locations
  private _ppUniforms = { luminance: null as WebGLUniformLocation | null, hue: null as WebGLUniformLocation | null, saturation: null as WebGLUniformLocation | null, contrast: null as WebGLUniformLocation | null };

  // Tiling uniform locations
  private _tilingUniforms = { space: null as WebGLUniformLocation | null, bg: null as WebGLUniformLocation | null, cols: null as WebGLUniformLocation | null, rows: null as WebGLUniformLocation | null };

  // File texture directives (populated on compile)
  fileTextureDirectives: TextureDirective[] = [];

  // Shader texture channels (FBO-based render-to-texture for inline funcs)
  private shaderTextureChannels: Map<number, ShaderTextureChannel> = new Map();
  shaderTextureDirectives: TextureDirective[] = [];

  // When true, tiling + post-processing GLSL is compiled in and uniforms are set each frame.
  // Used by A/B preview renderers; grid thumbnails leave this false.
  private _enableEffects: boolean;

  constructor(canvas: HTMLCanvasElement, options?: { enableEffects?: boolean }) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.gl = getSharedGL();
    this.contextValid = !!this.gl;
    this._enableEffects = options?.enableEffects ?? false;

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

  getCustomParamDefs(): ParamDef[] {
    return this.customParams;
  }

  getCustomParamValues(): Record<string, ParamValue> {
    return { ...this.customParamValues };
  }

  resetCustomParams(): void {
    this.customParamValues = {};
  }

  compile(fragmentSource: string): void {
    if (!this.contextValid || !this.gl) {
      throw new Error('WebGL context not available');
    }

    const gl = this.gl;

    // Parse @const directives and custom @param comments
    const consts = parseShaderConsts(fragmentSource);
    const constDefines = generateConstDefines(consts);
    const customParams = parseShaderParams(fragmentSource);
    const uniformDecls = generateUniformDeclarations(customParams);
    const customUniformDecls = [constDefines, uniformDecls].filter(Boolean).join('\n');

    // MiniShaderRenderer uses legacy uniforms; A/B mode adds tiling + post-processing
    const depthPct = parseOption25D(fragmentSource);
    const { extras: finalExtras } = buildShaderExtras({
      legacyUniforms: true,
      tiling: this._enableEffects,
      depthPct,
      postProcess: this._enableEffects,
    });
    const wrappedFragment = buildFragmentWrapper(fragmentSource, customUniformDecls, finalExtras);

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

    // Cache post-processing uniform locations
    this._ppUniforms = {
      luminance:  gl.getUniformLocation(program, '_pp_luminance'),
      hue:        gl.getUniformLocation(program, '_pp_hue'),
      saturation: gl.getUniformLocation(program, '_pp_saturation'),
      contrast:   gl.getUniformLocation(program, '_pp_contrast'),
    };

    // Cache tiling uniform locations
    this._tilingUniforms = {
      space: gl.getUniformLocation(program, '_tile_space'),
      bg:    gl.getUniformLocation(program, '_tile_bg'),
      cols:  gl.getUniformLocation(program, 'tile_cols'),
      rows:  gl.getUniformLocation(program, 'tile_rows'),
    };

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
    this.shaderTextureDirectives = allDirectives.filter(d => d.type === 'shader');

    // Apply builtin noise textures
    for (const { channel, textureName } of builtinDirectives) {
      const entry = createBuiltinTexture(gl, textureName);
      if (entry) {
        this.channelTextures[channel] = entry.texture;
        this.channelResolutions[channel] = [entry.width, entry.height, 1];
      }
    }

    // Create shader texture channels for inline function directives
    this.disposeShaderTextureChannels();
    for (const dir of this.shaderTextureDirectives) {
      if (dir.shaderFunc) {
        try {
          const stc = new ShaderTextureChannel(
            gl, dir.channel, fragmentSource, dir.shaderFunc,
            dir.shaderWidth!, dir.shaderHeight!, dir.shaderDynamic!,
          );
          this.shaderTextureChannels.set(dir.channel, stc);
        } catch {
          // Silently skip failed shader textures in thumbnails
        }
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

    // Render shader texture channels before main shader
    if (this.shaderTextureChannels.size > 0) {
      const paramValues = { ...this.customParamValues };
      // Fill in defaults for params not explicitly set
      for (const param of this.customParams) {
        if (paramValues[param.name] === undefined) {
          paramValues[param.name] = param.default as any;
        }
      }

      for (let ch = 0; ch < 4; ch++) {
        const stc = this.shaderTextureChannels.get(ch);
        if (!stc) continue;
        stc.updateResolution(width, height);
        if (stc.needsRender()) {
          stc.render(
            time, 0, 0, [0, 0, 0, 0],
            this.channelTextures as (WebGLTexture | null)[],
            this.channelResolutions as [number, number, number][],
            paramValues,
          );
        }
        const stcTex = stc.getTexture();
        if (stcTex) {
          this.channelTextures[ch] = stcTex;
          this.channelResolutions[ch] = stc.getResolution();
        }
      }

      // Restore viewport for main shader render
      gl.viewport(0, 0, width, height);
    }

    gl.useProgram(this.program);

    if (this._enableEffects) {
      // iResolution divided by tiling cols/rows (same as ShaderRenderer)
      gl.uniform3f(this.uniforms.iResolution, width / tilingValues.cols, height / tilingValues.rows, 1);
    } else {
      gl.uniform3f(this.uniforms.iResolution, width, height, 1);
    }
    gl.uniform1f(this.uniforms.iTime, time);

    // Legacy uniforms
    gl.uniform3fv(this.uniforms.iColorRGB, this._colorArray);
    gl.uniform1fv(this.uniforms.iParams, this._paramsArray);
    gl.uniform1f(this.uniforms.iSpeed, this.speed);

    if (this._enableEffects) {
      // Post-processing uniforms
      gl.uniform1f(this._ppUniforms.luminance, ppValues.luminance);
      gl.uniform1f(this._ppUniforms.hue, ppValues.hue);
      gl.uniform1f(this._ppUniforms.saturation, ppValues.saturation);
      gl.uniform1f(this._ppUniforms.contrast, ppValues.contrast);

      // Tiling uniforms
      gl.uniform2f(this._tilingUniforms.space, tilingValues.spaceX, tilingValues.spaceY);
      gl.uniform3f(this._tilingUniforms.bg, tilingValues.bgR, tilingValues.bgG, tilingValues.bgB);
      gl.uniform1f(this._tilingUniforms.cols, tilingValues.cols);
      gl.uniform1f(this._tilingUniforms.rows, tilingValues.rows);
    }

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

  private disposeShaderTextureChannels(): void {
    for (const stc of this.shaderTextureChannels.values()) {
      stc.dispose();
    }
    this.shaderTextureChannels.clear();
  }

  dispose(): void {
    const gl = this.gl;
    if (!gl) return;

    this.disposeShaderTextureChannels();

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
