// =============================================================================
// GLCompositor — WebGL2 mixer channel compositor
// Replaces the 2D overlay canvas path in renderMixerFrame().
// Renders each channel into an FBO texture, blends with the accumulator via
// a composite shader, then presents the result to the default framebuffer.
// =============================================================================
//
// Blend mode formulas are from W3C Compositing and Blending Level 1:
// https://www.w3.org/TR/compositing/
// Each formula is cited per-mode in the composite fragment shader below.

import { Logger, LOG_LEVEL } from '@shared/logger.js';
import { computeCropDraw } from '@renderer/renderers/gl-utils.js';

const log = new Logger('GLCompositor', LOG_LEVEL.WARN);

// Maps CSS/Canvas blend mode strings → integer IDs used in the composite shader.
// ponytail: integer dispatch avoids string comparisons in the hot path.
const MODE_MAP: Record<string, number> = {
  'lighter':      0,
  'source-over':  1,
  'multiply':     2,
  'screen':       3,
  'overlay':      4,
  'hard-light':   5,
  'soft-light':   6,
  'difference':   7,
  'exclusion':    8,
  'color-dodge':  9,
  'color-burn':   10,
};

const _warnedModes = new Set<string>();

// ---------------------------------------------------------------------------
// Vertex shader — shared by both programs.
// Full-screen quad via gl_VertexID (no VAO needed).
// Outputs vUv in [0,1]×[0,1] over the viewport.
// ---------------------------------------------------------------------------
const VERT_SRC = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // IDs 0-3 via TRIANGLE_STRIP cover the full clip-space quad
  float x = float(gl_VertexID & 1);
  float y = float((gl_VertexID >> 1) & 1);
  vUv = vec2(x, y);
  gl_Position = vec4(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// Composite fragment shader — blend uSrc onto uAcc using the chosen mode.
//
// For each blend mode, the semantics are:
//   outColor = vec4(mix(acc.rgb, B(src.rgb, acc.rgb), uAlpha), 1.0)
// where B is the W3C separable blend function, EXCEPT for 'lighter' which
// folds alpha additively:
//   outColor = vec4(clamp(acc.rgb + src.rgb * uAlpha, 0.0, 1.0), 1.0)
//
// Both src and acc are opaque (alpha=1), so Porter-Duff simplifies to the
// single mix() call above for all modes except lighter.
// ---------------------------------------------------------------------------
const COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uAcc;
uniform sampler2D uSrc;
uniform float uAlpha;
uniform int uMode;
out vec4 outColor;

// W3C §8.7 — hard-light helper used by both hard-light (mode 5) and overlay (mode 4)
// B(Cb,Cs): if Cs <= 0.5: 2*Cb*Cs  else: 1-2*(1-Cb)*(1-Cs)
// cs = first arg drives the condition.
vec3 hardLight(vec3 cs, vec3 cb) {
  return mix(2.0*cs*cb, 1.0 - 2.0*(1.0-cs)*(1.0-cb), step(0.5, cs));
}

// W3C §8.8 — soft-light (piecewise per-channel)
// B(Cb,Cs): if Cs<=0.5: Cb-(1-2Cs)*Cb*(1-Cb)
//           else if Cb<=0.25: Cb+(2Cs-1)*Cb*((16Cb-12)*Cb+3)
//           else: Cb+(2Cs-1)*(sqrt(Cb)-Cb)
float softLightCh(float cs, float cb) {
  float b = cb <= 0.25 ? ((16.0*cb - 12.0)*cb + 4.0)*cb : sqrt(cb);
  return cs <= 0.5
    ? cb - (1.0 - 2.0*cs)*cb*(1.0 - cb)
    : cb + (2.0*cs - 1.0)*(b - cb);
}
vec3 softLight(vec3 cs, vec3 cb) {
  return vec3(softLightCh(cs.r,cb.r), softLightCh(cs.g,cb.g), softLightCh(cs.b,cb.b));
}

void main() {
  vec3 s = texture(uSrc, vUv).rgb;   // source channel
  vec3 d = texture(uAcc, vUv).rgb;   // accumulated backdrop

  if (uMode == 0) {
    // lighter (Add) — W3C Porter-Duff 'lighter': Cs*αs + Cd, clamped.
    // With opaque backdrop: outC = clamp(d + s*alpha, 0, 1)
    outColor = vec4(clamp(d + s * uAlpha, 0.0, 1.0), 1.0);
    return;
  }

  vec3 b;
  if      (uMode == 1) b = s;                          // source-over (Normal) — W3C §8.1: B(Cb,Cs)=Cs
  else if (uMode == 2) b = s * d;                      // multiply — W3C §8.2: B(Cb,Cs)=Cb*Cs
  else if (uMode == 3) b = s + d - s * d;              // screen — W3C §8.3: B(Cb,Cs)=Cb+Cs-Cb*Cs
  else if (uMode == 4) b = hardLight(d, s);            // overlay — W3C §8.4: B(Cb,Cs)=HardLight(Cs,Cb)
  else if (uMode == 5) b = hardLight(s, d);            // hard-light — W3C §8.7: B(Cb,Cs)=HardLight(Cs,Cb) with Cs driving condition
  else if (uMode == 6) b = softLight(s, d);            // soft-light — W3C §8.8
  else if (uMode == 7) b = abs(s - d);                 // difference — W3C §8.9: B(Cb,Cs)=|Cb-Cs|
  else if (uMode == 8) b = s + d - 2.0*s*d;           // exclusion — W3C §8.10: B(Cb,Cs)=Cb+Cs-2*Cb*Cs
  else if (uMode == 9) b = clamp(d / max(1.0-s, vec3(1e-6)), vec3(0.0), vec3(1.0));
                                                        // color-dodge — W3C §8.11: B(Cb,Cs)=min(1,Cb/(1-Cs))
  else                 b = 1.0 - clamp((1.0-d) / max(s, vec3(1e-6)), vec3(0.0), vec3(1.0));
                                                        // color-burn — W3C §8.12: B(Cb,Cs)=1-min(1,(1-Cb)/Cs)

  // Standard compositing over opaque backdrop: outC = mix(d, B(s,d), alpha)
  outColor = vec4(mix(d, b, uAlpha), 1.0);
}`;

// ---------------------------------------------------------------------------
// Blit fragment shader — used for both asset→fboSrc and acc→screen.
//
// For assets: viewport+scissor clips to dest rect; gl_FragCoord gives pixel
// position within the FBO; uDestRect converts it to position within the dest
// rect; tiling + animation are applied; source crop UV is computed.
//
// For present (acc→screen): uDestRect=(0,0,fboW,fboH), uSrcUvRect=(0,0,1,1),
// uRepeat=(1,1), uAnimOffset=(0,0). The math degenerates to a straight blit.
//
// Asset textures are uploaded with UNPACK_FLIP_Y_WEBGL=true so v=0 is the
// image bottom (GL convention). vSrcUvRect.y = 1-(sy+sh)/natH (GL bottom of
// crop), vSrcUvRect.w = sh/natH. Sampling at 1-tiled.y maps canvas-top-down
// coords to the flipped texture correctly.
//
// Acc textures are written by the composite pass using vUv (v=0=bottom), so
// sampling at (u, fragY/fboH) is correct — the present formula below handles
// this: 1-v_c = 1-(1-fragY/fboH) = fragY/fboH.
// ---------------------------------------------------------------------------
const BLIT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec4 uDestRect;    // [x, y_gl, w, h] in pixels (y from GL bottom)
uniform vec4 uSrcUvRect;   // [u0, v0_gl, uSize, vSize] in texture (v0 = GL bottom of crop)
uniform vec2 uRepeat;      // [repeatX, repeatY]
uniform vec2 uAnimOffset;  // [animU, animV] in tile-UV units, canvas-style (positive = shift right/down)
out vec4 outColor;

void main() {
  // Position within dest rect; u=0 left, v_c=0 top (canvas convention for animation math)
  float u   = (gl_FragCoord.x - uDestRect.x) / uDestRect.z;
  float v_c = 1.0 - (gl_FragCoord.y - uDestRect.y) / uDestRect.w;

  // Apply tiling and animation
  vec2 tiled = fract(vec2(u, v_c) * uRepeat - uAnimOffset);

  // Map tiled coords to source crop in flipped texture:
  //   tiled.y=0 (top in canvas) → high texture v (image top, since FLIP_Y)
  //   tiled.y=1 (bottom) → low texture v (= uSrcUvRect.y)
  vec2 uv = vec2(
    uSrcUvRect.x + tiled.x * uSrcUvRect.z,
    uSrcUvRect.y + (1.0 - tiled.y) * uSrcUvRect.w
  );
  outColor = texture(uTex, uv);
}`;

// ---------------------------------------------------------------------------
// GL helpers
// ---------------------------------------------------------------------------

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh) ?? 'unknown';
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed: ${info}`);
  }
  return sh;
}

function linkProg(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog) ?? 'unknown';
    gl.deleteProgram(prog);
    throw new Error(`Program link failed: ${info}`);
  }
  return prog;
}

function makeTex(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return tex;
}

function makeFbo(gl: WebGL2RenderingContext, tex: WebGLTexture): WebGLFramebuffer {
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    throw new Error(`FBO incomplete: 0x${status.toString(16)}`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return fbo;
}

// ---------------------------------------------------------------------------
// GLCompositor
// ---------------------------------------------------------------------------

export class GLCompositor {
  private readonly gl: WebGL2RenderingContext;

  // Programs
  private readonly compositeProg: WebGLProgram;
  private readonly blitProg: WebGLProgram;

  // Composite program uniform locations
  private readonly uAcc: WebGLUniformLocation;
  private readonly uSrc: WebGLUniformLocation;
  private readonly uAlpha: WebGLUniformLocation;
  private readonly uMode: WebGLUniformLocation;

  // Blit program uniform locations
  private readonly uTex: WebGLUniformLocation;
  private readonly uDestRect: WebGLUniformLocation;
  private readonly uSrcUvRect: WebGLUniformLocation;
  private readonly uRepeat: WebGLUniformLocation;
  private readonly uAnimOffset: WebGLUniformLocation;

  // FBO resources — lazily allocated, reallocated on resize
  private texSrc: WebGLTexture | null = null;
  private texAccA: WebGLTexture | null = null;
  private texAccB: WebGLTexture | null = null;
  private fboSrc: WebGLFramebuffer | null = null;
  private fboAccA: WebGLFramebuffer | null = null;
  private fboAccB: WebGLFramebuffer | null = null;
  private fboW = 0;
  private fboH = 0;

  // Ping-pong state (updated by _runComposite)
  private readTex: WebGLTexture | null = null;
  private writeTex: WebGLTexture | null = null;
  private writeFbo: WebGLFramebuffer | null = null;

  // Asset texture cache (per channel index)
  private readonly _assetTextures = new Map<number, WebGLTexture>();
  private readonly _assetSources = new Map<number, HTMLImageElement | HTMLVideoElement>();
  private readonly _assetVideoTimes = new Map<number, number>();

  /**
   * Construct the compositor. Throws if shader compilation or FBO creation fails —
   * the caller should catch and fall back to the 2D overlay path.
   */
  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.compositeProg = linkProg(gl, VERT_SRC, COMPOSITE_FRAG);
    this.blitProg = linkProg(gl, VERT_SRC, BLIT_FRAG);

    const getU = (prog: WebGLProgram, name: string): WebGLUniformLocation => {
      const loc = gl.getUniformLocation(prog, name);
      if (loc === null) throw new Error(`Uniform not found: ${name}`);
      return loc;
    };

    this.uAcc       = getU(this.compositeProg, 'uAcc');
    this.uSrc       = getU(this.compositeProg, 'uSrc');
    this.uAlpha     = getU(this.compositeProg, 'uAlpha');
    this.uMode      = getU(this.compositeProg, 'uMode');
    this.uTex       = getU(this.blitProg, 'uTex');
    this.uDestRect  = getU(this.blitProg, 'uDestRect');
    this.uSrcUvRect = getU(this.blitProg, 'uSrcUvRect');
    this.uRepeat    = getU(this.blitProg, 'uRepeat');
    this.uAnimOffset= getU(this.blitProg, 'uAnimOffset');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Begin a new compositor frame.
   * Resizes FBOs if the canvas dimensions changed, clears the accumulator to
   * opaque black, and resets ping-pong state.
   */
  begin(width: number, height: number): void {
    const gl = this.gl;
    this._resizeFbos(width, height);

    // Clear accA → opaque black (the initial backdrop)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboAccA);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Ping-pong: read from accA, write to accB
    this.readTex  = this.texAccA;
    this.writeTex = this.texAccB;
    this.writeFbo = this.fboAccB;
  }

  /**
   * Composite a shader channel.
   * Binds fboSrc, clears it, calls render() (which must draw to the currently
   * bound framebuffer), then runs the composite pass.
   *
   * TileRenderer.render() sets gl.viewport + gl.scissor from its bounds and
   * disables scissor after drawing — bounds are already 0,0,w,h for mixer
   * channels, so the draw covers the full fboSrc.
   */
  compositeShader(render: () => void, alpha: number, modeStr: string): void {
    const gl = this.gl;
    const mode = this._resolveMode(modeStr);

    // Bind src FBO; render() draws into it
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboSrc);
    gl.viewport(0, 0, this.fboW, this.fboH);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    render();

    // Restore state that TileRenderer may have left behind
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    this._runComposite(alpha, mode);
  }

  /**
   * Composite an asset (image or video) channel.
   *
   * @param channelIndex  - used to key the per-channel texture cache
   * @param src           - the image/video element
   * @param params        - asset params (crop, x/y offset, repeat, speed)
   * @param canvasW/H     - output canvas dimensions
   * @param elapsed       - seconds since scene start (for animation)
   * @param alpha         - channel alpha [0,1]
   * @param modeStr       - blend mode string
   */
  compositeAsset(
    channelIndex: number,
    src: HTMLImageElement | HTMLVideoElement,
    params: Record<string, number>,
    canvasW: number,
    canvasH: number,
    elapsed: number,
    alpha: number,
    modeStr: string,
  ): void {
    const gl = this.gl;
    const mode = this._resolveMode(modeStr);

    const tex = this._getOrUpdateAssetTex(channelIndex, src);
    if (!tex) return; // source not ready

    // Compute crop and dest geometry using the same logic as drawAssetWithCrop
    const natW = (src as HTMLImageElement).naturalWidth  || (src as HTMLVideoElement).videoWidth  || 0;
    const natH = (src as HTMLImageElement).naturalHeight || (src as HTMLVideoElement).videoHeight || 0;
    if (!natW || !natH) return;

    const crop = computeCropDraw(natW, natH, params, canvasW, canvasH);
    if (!crop) return;

    const { sx, sy, sw, sh, drawW, drawH } = crop;
    const { x = 0, y = 0, repeatX = 1, repeatY = 1, speedX = 0, speedY = 0 } = params;

    // Source UV in flipped texture (UNPACK_FLIP_Y_WEBGL=true → v=0=image bottom)
    const u0     = sx / natW;
    const v0_gl  = 1 - (sy + sh) / natH;   // GL bottom of crop in flipped texture
    const uSize  = sw / natW;
    const vSize  = sh / natH;

    // Dest rect in GL coords (y from bottom)
    const destX   = x;
    const destY_gl = canvasH - y - drawH;

    // Animation offsets in tile-UV units (canvas convention: positive = shift right/down)
    const rX = repeatX || 1;
    const rY = repeatY || 1;
    const tileW = drawW / rX;
    const tileH = drawH / rY;
    const animU = tileW > 0 ? (((speedX * elapsed) % tileW + tileW) % tileW) / tileW : 0;
    const animV = tileH > 0 ? (((speedY * elapsed) % tileH + tileH) % tileH) / tileH : 0;

    // Blit asset into fboSrc with crop, tiling, animation
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboSrc);
    gl.viewport(0, 0, this.fboW, this.fboH);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(destX, destY_gl, drawW, drawH);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.disable(gl.BLEND);
    gl.useProgram(this.blitProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.uTex, 0);
    gl.uniform4f(this.uDestRect, destX, destY_gl, drawW, drawH);
    gl.uniform4f(this.uSrcUvRect, u0, v0_gl, uSize, vSize);
    gl.uniform2f(this.uRepeat, rX, rY);
    gl.uniform2f(this.uAnimOffset, animU, animV);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.disable(gl.SCISSOR_TEST);

    this._runComposite(alpha, mode);
  }

  /**
   * Present the accumulated result to the default framebuffer.
   * Uses the blit program with identity UV rect so the math degenerates to a
   * straight copy (see BLIT_FRAG header comment).
   */
  present(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.fboW, this.fboH);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.blitProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.readTex);
    gl.uniform1i(this.uTex, 0);
    gl.uniform4f(this.uDestRect, 0, 0, this.fboW, this.fboH);
    gl.uniform4f(this.uSrcUvRect, 0, 0, 1, 1);
    gl.uniform2f(this.uRepeat, 1, 1);
    gl.uniform2f(this.uAnimOffset, 0, 0);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.compositeProg);
    gl.deleteProgram(this.blitProg);
    this._deleteFbos();
    for (const tex of this._assetTextures.values()) gl.deleteTexture(tex);
    this._assetTextures.clear();
    this._assetSources.clear();
    this._assetVideoTimes.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _resizeFbos(w: number, h: number): void {
    if (w === this.fboW && h === this.fboH) return;
    const gl = this.gl;
    this._deleteFbos();

    this.texSrc  = makeTex(gl, w, h); this.fboSrc  = makeFbo(gl, this.texSrc);
    this.texAccA = makeTex(gl, w, h); this.fboAccA = makeFbo(gl, this.texAccA);
    this.texAccB = makeTex(gl, w, h); this.fboAccB = makeFbo(gl, this.texAccB);

    this.fboW = w;
    this.fboH = h;
  }

  private _deleteFbos(): void {
    const gl = this.gl;
    if (this.texSrc)  { gl.deleteTexture(this.texSrc);  gl.deleteFramebuffer(this.fboSrc!);  }
    if (this.texAccA) { gl.deleteTexture(this.texAccA); gl.deleteFramebuffer(this.fboAccA!); }
    if (this.texAccB) { gl.deleteTexture(this.texAccB); gl.deleteFramebuffer(this.fboAccB!); }
    this.texSrc = this.texAccA = this.texAccB = null;
    this.fboSrc = this.fboAccA = this.fboAccB = null;
    this.fboW = 0; this.fboH = 0;
  }

  /** Blend texSrc onto readTex → writeFbo, then swap ping-pong. */
  private _runComposite(alpha: number, mode: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.writeFbo);
    gl.viewport(0, 0, this.fboW, this.fboH);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.compositeProg);
    gl.uniform1f(this.uAlpha, alpha);
    gl.uniform1i(this.uMode, mode);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.readTex);
    gl.uniform1i(this.uAcc, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texSrc);
    gl.uniform1i(this.uSrc, 1);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Swap: what we just wrote is now the accumulator; recycle the old read target
    const prevRead = this.readTex;
    this.readTex  = this.writeTex;
    this.writeTex = prevRead;
    this.writeFbo = prevRead === this.texAccA ? this.fboAccA : this.fboAccB;
  }

  /**
   * Return (and lazily create/update) a WebGL texture for the given asset.
   * Images are uploaded once per source object change.
   * Videos are re-uploaded only when currentTime changes (guard from commit 5d23ecd).
   * Uses UNPACK_FLIP_Y_WEBGL=true so GL v=0 = image bottom (standard convention).
   */
  private _getOrUpdateAssetTex(
    channelIndex: number,
    src: HTMLImageElement | HTMLVideoElement,
  ): WebGLTexture | null {
    // Readiness check
    if (src instanceof HTMLImageElement) {
      if (!src.complete || src.naturalWidth === 0) return null;
    } else {
      if (src.readyState < 2) return null; // HAVE_CURRENT_DATA
    }

    const gl = this.gl;
    const prevSrc = this._assetSources.get(channelIndex);
    let tex = this._assetTextures.get(channelIndex);

    // Evict stale texture when source changes
    if (prevSrc !== src) {
      if (tex) gl.deleteTexture(tex);
      tex = undefined;
      this._assetSources.set(channelIndex, src);
      this._assetVideoTimes.set(channelIndex, -1);
    }

    const isNew = !tex;
    if (isNew) {
      tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._assetTextures.set(channelIndex, tex);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, tex ?? null);
    }

    let needUpload = isNew;
    if (!needUpload && src instanceof HTMLVideoElement) {
      const t = src.currentTime;
      if (t !== this._assetVideoTimes.get(channelIndex)) {
        this._assetVideoTimes.set(channelIndex, t);
        needUpload = true;
      }
    }

    if (needUpload) {
      // ponytail: UNPACK_FLIP_Y_WEBGL inverts rows on upload so v=0=image bottom,
      // matching GL convention. UV crop math in compositeAsset and the blit shader
      // depend on this being set consistently.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }

    return tex!;
  }

  private _resolveMode(modeStr: string): number {
    const m = MODE_MAP[modeStr];
    if (m === undefined) {
      if (!_warnedModes.has(modeStr)) {
        log.warn(`Unknown blend mode "${modeStr}", using source-over`);
        _warnedModes.add(modeStr);
      }
      return MODE_MAP['source-over']!;
    }
    return m;
  }
}
