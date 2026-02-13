// GLUtils — Shared WebGL2 utility functions used by ShaderRenderer, TileRenderer,
// and MiniShaderRenderer. Converted from the global GLUtils/AssetUtils objects.

import type { ParamDef, GLSLType, ParamBaseType } from '@shared/types/params.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StandardUniforms {
  iResolution: WebGLUniformLocation | null;
  iTime: WebGLUniformLocation | null;
  iTimeDelta: WebGLUniformLocation | null;
  iFrame: WebGLUniformLocation | null;
  iMouse: WebGLUniformLocation | null;
  iDate: WebGLUniformLocation | null;
  iChannel0: WebGLUniformLocation | null;
  iChannel1: WebGLUniformLocation | null;
  iChannel2: WebGLUniformLocation | null;
  iChannel3: WebGLUniformLocation | null;
  iChannelResolution: WebGLUniformLocation | null;
  iBPM: WebGLUniformLocation | null;
}

export type CustomParamUniforms = Record<string, WebGLUniformLocation | null | Array<WebGLUniformLocation | null>>;

export interface TextureInfo {
  texture: WebGLTexture;
  width: number;
  height: number;
}

export interface ShaderErrorInfo {
  line: number | null;
  message: string;
}

interface FragmentWrapperExtras {
  extraUniforms?: string;
  mainBody?: string;
}

interface BuiltinTextureSpec {
  width: number;
  height: number;
  gray: boolean;
}

interface CropDrawResult {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  drawW: number;
  drawH: number;
}

// ---------------------------------------------------------------------------
// GLUtils
// ---------------------------------------------------------------------------

export const VERTEX_SHADER_SOURCE = `#version 300 es
  layout(location = 0) in vec2 position;
  void main() {
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

export const QUAD_VERTICES = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

export function setupFullscreenQuad(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW);

  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  return vao;
}

export function buildFragmentWrapper(
  fragmentSource: string,
  customDecls: string,
  extras?: FragmentWrapperExtras,
): string {
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
}

export function compileProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
): WebGLProgram {
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
    const error = gl.getShaderInfoLog(fragmentShader) || '';
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    // eslint-disable-next-line no-throw-literal
    throw { message: error, raw: error, _isCompileError: true };
  }

  const program = gl.createProgram()!;
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

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  return program;
}

export function cacheStandardUniforms(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): StandardUniforms {
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
    iBPM: gl.getUniformLocation(program, 'iBPM'),
  };
}

export function cacheCustomParamUniforms(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  params: ParamDef[],
): CustomParamUniforms {
  const uniforms: CustomParamUniforms = {};
  for (const param of params) {
    if (param.isArray) {
      const arr: Array<WebGLUniformLocation | null> = [];
      for (let i = 0; i < (param.arraySize ?? 0); i++) {
        arr.push(gl.getUniformLocation(program, `${param.name}[${i}]`));
      }
      uniforms[param.name] = arr;
    } else {
      uniforms[param.name] = gl.getUniformLocation(program, param.name);
    }
  }
  return uniforms;
}

export function setUniformByType(
  gl: WebGL2RenderingContext,
  type: ParamBaseType,
  location: WebGLUniformLocation | null,
  value: number | number[],
): void {
  if (!location) return;
  switch (type) {
    case 'int':
      gl.uniform1i(location, value as number);
      break;
    case 'float':
      gl.uniform1f(location, value as number);
      break;
    case 'vec2':
      gl.uniform2f(location, (value as number[])[0], (value as number[])[1]);
      break;
    case 'color':
    case 'vec3':
      gl.uniform3f(location, (value as number[])[0], (value as number[])[1], (value as number[])[2]);
      break;
    case 'vec4':
      gl.uniform4f(location, (value as number[])[0], (value as number[])[1], (value as number[])[2], (value as number[])[3]);
      break;
  }
}

export function setCustomUniforms(
  gl: WebGL2RenderingContext,
  params: ParamDef[],
  values: Record<string, number | number[]>,
  locations: CustomParamUniforms,
): void {
  for (const param of params) {
    const value = values[param.name];
    const location = locations[param.name];

    if (location === null || location === undefined) continue;

    if (param.isArray && Array.isArray(location)) {
      const arrValue = value as number[];
      for (let i = 0; i < (param.arraySize ?? 0); i++) {
        const elemLocation = location[i];
        if (elemLocation === null) continue;
        setUniformByType(gl, param.type, elemLocation, arrValue[i]);
      }
    } else {
      setUniformByType(gl, param.type, location as WebGLUniformLocation | null, value);
    }
  }
}

export function loadTextureFromDataUrl(
  gl: WebGL2RenderingContext,
  dataUrl: string,
): Promise<TextureInfo> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const texture = gl.createTexture()!;
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
}

// Built-in noise texture specs
export const BUILTIN_TEXTURES: Record<string, BuiltinTextureSpec> = {
  RGBANoise:      { width: 256, height: 256, gray: false },
  RGBANoiseBig:   { width: 1024, height: 1024, gray: false },
  RGBANoiseSmall: { width: 64, height: 64, gray: false },
  GrayNoise:      { width: 256, height: 256, gray: true },
  GrayNoiseBig:   { width: 1024, height: 1024, gray: true },
  GrayNoiseSmall: { width: 64, height: 64, gray: true },
};

export function generateNoiseData(width: number, height: number, gray: boolean): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const off = i * 4;
    if (gray) {
      const v = Math.floor(Math.random() * 256);
      data[off] = data[off + 1] = data[off + 2] = v;
    } else {
      data[off] = Math.floor(Math.random() * 256);
      data[off + 1] = Math.floor(Math.random() * 256);
      data[off + 2] = Math.floor(Math.random() * 256);
    }
    data[off + 3] = 255;
  }
  return data;
}

export function createBuiltinTexture(
  gl: WebGL2RenderingContext,
  name: string,
): TextureInfo | null {
  const spec = BUILTIN_TEXTURES[name];
  if (!spec) return null;

  const { width, height, gray } = spec;
  const data = generateNoiseData(width, height, gray);

  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

  return { texture, width, height };
}

export function parseShaderError(error: string, wrapperLineCount: number): ShaderErrorInfo {
  const match = error.match(/ERROR:\s*\d+:(\d+):\s*(.+)/);
  if (match) {
    const line = Math.max(1, parseInt(match[1]) - wrapperLineCount);
    return { line, message: match[2] };
  }
  return { line: null, message: error };
}

// ---------------------------------------------------------------------------
// AssetUtils
// ---------------------------------------------------------------------------

export function computeCropDraw(
  srcW: number,
  srcH: number,
  params: Record<string, number>,
  destW: number,
  destH: number,
): CropDrawResult | null {
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
}

export function updateVideoLoop(
  video: HTMLVideoElement | null,
  params: { loop?: boolean; start?: number; end?: number },
): void {
  if (!video || !(video instanceof HTMLVideoElement)) return;
  const { loop, start = 0, end = 0 } = params;
  if (loop && end > start && start >= 0) {
    if (video.currentTime >= end || video.currentTime < start) {
      video.currentTime = start;
    }
  }
}
