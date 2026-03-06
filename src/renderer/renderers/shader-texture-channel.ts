// ShaderTextureChannel — FBO-based render-to-texture for shader-generated channel textures.
// Used by @texture iChannel0 shader(funcName, width, height, dynamic) directives.

import type { ParamDef, ParamValues } from '@shared/types/params.js';
import {
  setupFullscreenQuad,
  buildFragmentWrapper,
  compileProgram,
  VERTEX_SHADER_SOURCE,
  cacheStandardUniforms,
  cacheCustomParamUniforms,
  setCustomUniforms,
} from './gl-utils.js';
import type { StandardUniforms, CustomParamUniforms } from './gl-utils.js';
import {
  parseShaderParams,
  parseShaderConsts,
  generateConstDefines,
  generateUniformDeclarations,
  createParamValues,
} from '@shared/param-parser.js';
import { Logger } from '@shared/logger.js';

const log = new Logger('ShaderTex');

export class ShaderTextureChannel {
  private gl: WebGL2RenderingContext;
  readonly channel: number;
  private program: WebGLProgram | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private texture: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;

  private uniforms: StandardUniforms = {} as StandardUniforms;
  private customParamUniforms: CustomParamUniforms = {};

  /** Parsed @param definitions from the texture shader source */
  readonly customParams: ParamDef[];
  /** Default values for texture shader's own params */
  private ownDefaults: ParamValues;

  /** Texture resolution in pixels */
  private texWidth: number = 0;
  private texHeight: number = 0;

  /** Resolution spec from directive (0-1 = relative, >1 = absolute) */
  private widthSpec: number;
  private heightSpec: number;

  /** Whether this texture re-renders each frame */
  readonly dynamic: boolean;

  /** Whether a static texture needs re-rendering (param change) */
  private _dirty: boolean = true;

  /** Whether the texture has been rendered at least once */
  private _rendered: boolean = false;

  constructor(
    gl: WebGL2RenderingContext,
    channel: number,
    source: string,
    entryFunc: string,
    widthSpec: number,
    heightSpec: number,
    dynamic: boolean,
  ) {
    this.gl = gl;
    this.channel = channel;
    this.widthSpec = widthSpec;
    this.heightSpec = heightSpec;
    this.dynamic = dynamic;

    // Parse params from the texture shader source
    this.customParams = parseShaderParams(source);
    this.ownDefaults = createParamValues(this.customParams);

    // Create VAO for fullscreen quad
    this.vao = setupFullscreenQuad(gl);

    // Compile the shader program
    this.compileProgram(gl, source, entryFunc);

    // Create FBO (texture allocated on first render when resolution is known)
    this.fbo = gl.createFramebuffer();

    log.info(`STC ch${channel}: ${entryFunc}, ${widthSpec}x${heightSpec}, dynamic=${dynamic}`);
  }

  private compileProgram(gl: WebGL2RenderingContext, source: string, entryFunc: string): void {
    const consts = parseShaderConsts(source);
    const constDefines = generateConstDefines(consts);
    const uniformDecls = generateUniformDeclarations(this.customParams);
    const customUniformDecls = [constDefines, uniformDecls].filter(Boolean).join('\n');

    // Build fragment shader with custom entry point (no tiling, no post-processing)
    const wrappedFragment = buildFragmentWrapper(source, customUniformDecls, {
      mainBody: `${entryFunc}(outColor, gl_FragCoord.xy);`,
    });

    try {
      this.program = compileProgram(gl, VERTEX_SHADER_SOURCE, wrappedFragment);
    } catch (err: any) {
      if (err._isCompileError) {
        log.error(`STC ch${this.channel} compile error:`, err.raw);
        throw new Error(`Shader texture compile error: ${err.message}`);
      }
      throw err;
    }

    this.uniforms = cacheStandardUniforms(gl, this.program);
    this.customParamUniforms = cacheCustomParamUniforms(gl, this.program, this.customParams);
  }

  /**
   * Update texture resolution based on canvas size.
   * Returns true if the resolution changed (requiring FBO recreation).
   */
  updateResolution(canvasWidth: number, canvasHeight: number): boolean {
    const newW = this.widthSpec <= 1.0
      ? Math.max(1, Math.round(this.widthSpec * canvasWidth))
      : Math.round(this.widthSpec);
    const newH = this.heightSpec <= 1.0
      ? Math.max(1, Math.round(this.heightSpec * canvasHeight))
      : Math.round(this.heightSpec);

    if (newW === this.texWidth && newH === this.texHeight) return false;

    this.texWidth = newW;
    this.texHeight = newH;
    this.recreateTexture();
    this._dirty = true;
    return true;
  }

  private recreateTexture(): void {
    const gl = this.gl;

    // Delete old texture
    if (this.texture) {
      gl.deleteTexture(this.texture);
    }

    // Create new texture
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, this.texWidth, this.texHeight,
      0, gl.RGBA, gl.UNSIGNED_BYTE, null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    // Attach to FBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    log.debug(`STC ch${this.channel}: texture ${this.texWidth}x${this.texHeight}`);
  }

  /** Mark this texture as needing re-render (for static textures on param change) */
  markDirty(): void {
    this._dirty = true;
  }

  /** Whether this texture needs rendering this frame */
  needsRender(): boolean {
    return this.dynamic || this._dirty;
  }

  /**
   * Render the shader texture to the FBO.
   * @param time Current time in seconds
   * @param timeDelta Time since last frame
   * @param frameCount Current frame number
   * @param mouse Mouse state [x, y, clickX, clickY]
   * @param channelTextures Parent's channel textures (for iChannel access)
   * @param channelResolutions Parent's channel resolutions
   * @param paramValues Shared param values (main shader + texture shader combined)
   */
  render(
    time: number,
    timeDelta: number,
    frameCount: number,
    mouse: [number, number, number, number],
    channelTextures: (WebGLTexture | null)[],
    channelResolutions: [number, number, number][],
    paramValues: ParamValues,
  ): void {
    if (!this.program || !this.fbo || !this.texture) return;
    if (this.texWidth === 0 || this.texHeight === 0) return;

    const gl = this.gl;

    // Bind FBO and set viewport to texture size
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.texWidth, this.texHeight);

    gl.useProgram(this.program);

    // Set standard uniforms
    gl.uniform3f(this.uniforms.iResolution, this.texWidth, this.texHeight, 1);
    gl.uniform1f(this.uniforms.iTime, time);
    gl.uniform1f(this.uniforms.iTimeDelta, timeDelta);
    gl.uniform1i(this.uniforms.iFrame, frameCount);
    gl.uniform4f(this.uniforms.iMouse, mouse[0], mouse[1], mouse[2], mouse[3]);

    // Date
    const date = new Date();
    gl.uniform4f(this.uniforms.iDate,
      date.getFullYear(), date.getMonth(), date.getDate(),
      date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds() + date.getMilliseconds() / 1000,
    );

    // BPM and audio levels (pass 0 for now; could be enhanced later)
    gl.uniform1f(this.uniforms.iBPM, 0);
    gl.uniform1f(this.uniforms.iBassLevel, 0);
    gl.uniform1f(this.uniforms.iMidLevel, 0);
    gl.uniform1f(this.uniforms.iHighLevel, 0);

    // Tiling defaults (texture shaders don't tile)
    const tileCols = gl.getUniformLocation(this.program, 'tile_cols');
    const tileRows = gl.getUniformLocation(this.program, 'tile_rows');
    if (tileCols) gl.uniform1f(tileCols, 1);
    if (tileRows) gl.uniform1f(tileRows, 1);

    // Set custom param uniforms using shared values
    const mergedValues: Record<string, number | number[]> = {};
    for (const param of this.customParams) {
      const val = paramValues[param.name] !== undefined
        ? paramValues[param.name]
        : this.ownDefaults[param.name];
      if (val !== undefined) {
        mergedValues[param.name] = val as number | number[];
      }
    }
    setCustomUniforms(gl, this.customParams, mergedValues, this.customParamUniforms);

    // Bind parent's channel textures (excluding our own channel to avoid feedback)
    const resArray = new Float32Array(12);
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      if (i === this.channel) {
        // Don't bind our own output texture — bind a 1x1 black fallback
        gl.bindTexture(gl.TEXTURE_2D, null);
        resArray[i * 3] = 0;
        resArray[i * 3 + 1] = 0;
        resArray[i * 3 + 2] = 1;
      } else {
        gl.bindTexture(gl.TEXTURE_2D, channelTextures[i]);
        resArray[i * 3] = channelResolutions[i][0];
        resArray[i * 3 + 1] = channelResolutions[i][1];
        resArray[i * 3 + 2] = channelResolutions[i][2];
      }
      gl.uniform1i(
        (this.uniforms as any)[`iChannel${i}`] as WebGLUniformLocation | null,
        i,
      );
    }
    gl.uniform3fv(this.uniforms.iChannelResolution, resArray);

    // Draw
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Restore default framebuffer (caller is responsible for viewport)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this._dirty = false;
    this._rendered = true;
  }

  /** Get the rendered texture (FBO color attachment) */
  getTexture(): WebGLTexture | null {
    return this.texture;
  }

  /** Get the texture resolution as [width, height, 1] */
  getResolution(): [number, number, number] {
    return [this.texWidth, this.texHeight, 1];
  }

  /** Whether this texture has been rendered at least once */
  get rendered(): boolean {
    return this._rendered;
  }

  /** Clean up all WebGL resources */
  dispose(): void {
    const gl = this.gl;
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
    if (this.texture) {
      gl.deleteTexture(this.texture);
      this.texture = null;
    }
    if (this.fbo) {
      gl.deleteFramebuffer(this.fbo);
      this.fbo = null;
    }
    if (this.vao) {
      gl.deleteVertexArray(this.vao);
      this.vao = null;
    }
  }
}
