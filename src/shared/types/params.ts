// Parameter type definitions for @param and @texture shader directives

/** Base GLSL types supported in @param directives */
export type ParamBaseType = 'int' | 'float' | 'vec2' | 'vec3' | 'vec4' | 'color';

/** The actual GLSL type (color maps to vec3) */
export type GLSLType = 'int' | 'float' | 'vec2' | 'vec3' | 'vec4';

/** A scalar or vector value */
export type ScalarValue = number;
export type VectorValue = number[];

/** A single param value — number for int/float, number[] for vec2/3/4 */
export type ParamValue = number | number[];

/** An array param value — array of ParamValue */
export type ParamArrayValue = ParamValue[];

/** Parsed @param definition from shader source */
export interface ParamDef {
  /** Param name (used as uniform name) */
  name: string;
  /** Original type from @param directive (keeps 'color' for UI) */
  type: ParamBaseType;
  /** Actual GLSL type (color → vec3) */
  glslBaseType: GLSLType;
  /** Array size, or null for non-array */
  arraySize: number | null;
  /** Whether this is an array param */
  isArray: boolean;
  /** Whether this uses a color picker UI */
  isColor: boolean;
  /** Default value */
  default: ParamValue | ParamArrayValue;
  /** Minimum range value, or null */
  min: number | null;
  /** Maximum range value, or null */
  max: number | null;
  /** Human-readable description */
  description: string;
  /** Full GLSL type string (e.g. "vec3[10]") */
  glslType: string;
  /** GLSL uniform declaration (e.g. "uniform vec3 tint;") */
  uniformDecl: string;
}

/** Map of param name → current value */
export interface ParamValues {
  [name: string]: ParamValue | ParamArrayValue;
}

/** Texture directive types */
export type TextureDirectiveType = 'builtin' | 'file' | 'audio';

/** Valid built-in texture names */
export type BuiltinTextureName =
  | 'RGBANoise' | 'RGBANoiseBig' | 'RGBANoiseSmall'
  | 'GrayNoise' | 'GrayNoiseBig' | 'GrayNoiseSmall';

/** Parsed @texture directive from shader source */
export interface TextureDirective {
  /** Channel index 0-3 */
  channel: number;
  /** Texture name (e.g. "RGBANoise", "AudioFFT(1024)", "myfile") */
  textureName: string;
  /** Directive type */
  type: TextureDirectiveType;
  /** FFT size for audio directives */
  fftSize?: number;
}

/** Valid FFT sizes for AudioFFT directives */
export const VALID_FFT_SIZES = [64, 128, 256, 512, 1024, 2048, 4096] as const;
export type FFTSize = typeof VALID_FFT_SIZES[number];

/** Valid built-in texture names set */
export const VALID_TEXTURE_NAMES = new Set<string>([
  'RGBANoise', 'RGBANoiseBig', 'RGBANoiseSmall',
  'GrayNoise', 'GrayNoiseBig', 'GrayNoiseSmall',
]);
