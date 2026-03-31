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

/** A field within a @structure definition */
export interface StructFieldDef {
  name: string;
  type: ParamBaseType;
  glslType: GLSLType;
  isColor: boolean;
  default: ParamValue;
  min: number | null;
  max: number | null;
  description: string;
}

/** A @structure definition */
export interface StructDef {
  name: string;
  fields: StructFieldDef[];
}

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
  /** Per-element min values for array params, or null */
  mins: number[] | null;
  /** Per-element max values for array params, or null */
  maxs: number[] | null;
  /** Human-readable description */
  description: string;
  /** Full GLSL type string (e.g. "vec3[10]") */
  glslType: string;
  /** GLSL uniform declaration (e.g. "uniform vec3 tint;") */
  uniformDecl: string;
  /** Struct definition (set on expanded struct field params) */
  structDef?: StructDef;
  /** Parent param name (e.g. "figures") for struct fields */
  structParent?: string;
  /** Array element index for struct array fields */
  structIndex?: number;
  /** Field name within the struct */
  structField?: string;
  /** Array size of the parent struct param */
  structArraySize?: number | null;
  /** Binding to a built-in uniform variable */
  binding?: ParamBinding;
  /** Art-Net DMX channel (1-512) mapped to this param via dmx: directive */
  dmxChannel?: number;
}

/** Valid sources for param bindings */
export type BindSource = 'iBassLevel' | 'iMidLevel' | 'iHighLevel' | 'iBPM' | 'iTime';

/** Valid bind source names set */
export const VALID_BIND_SOURCES = new Set<string>([
  'iBassLevel', 'iMidLevel', 'iHighLevel', 'iBPM', 'iTime',
]);

/** Param binding to a built-in uniform for sound-reactive automation */
export interface ParamBinding {
  /** Built-in uniform to bind from */
  source: BindSource;
  /** Scale factor: result = (source + offset) * factor. Default 1.0 */
  factor: number;
  /** Offset applied before scaling: result = (source + offset) * factor. Default 0.0 */
  offset: number;
  /** Blend mode: 'replace' overrides slider, 'add' adds to slider value. Default 'replace' */
  mode: 'replace' | 'add';
  /** Smoothing factor 0.0-1.0 (EMA alpha, higher = smoother). Default 0 (raw) */
  smooth: number;
  /** Toggle behavior: 'always' = no button, 'on' = button starts enabled, 'off' = button starts disabled */
  toggle: 'always' | 'on' | 'off';
}

/** Map of param name → current value */
export interface ParamValues {
  [name: string]: ParamValue | ParamArrayValue;
}

/** Texture directive types */
export type TextureDirectiveType = 'builtin' | 'file' | 'audio' | 'shader';

/** Valid built-in texture names */
export type BuiltinTextureName =
  | 'RGBANoise' | 'RGBANoiseBig' | 'RGBANoiseSmall'
  | 'GrayNoise' | 'GrayNoiseBig' | 'GrayNoiseSmall';

/** Parsed @texture directive from shader source */
export interface TextureDirective {
  /** Channel index 0-3 */
  channel: number;
  /** Texture name (e.g. "RGBANoise", "AudioFFT(1024)", "myfile", "shader:funcName") */
  textureName: string;
  /** Directive type */
  type: TextureDirectiveType;
  /** FFT size for audio directives */
  fftSize?: number;
  /** Function name for inline shader texture (calls this instead of mainImage) */
  shaderFunc?: string;
  /** File path for file-based shader texture (relative to project root) */
  shaderFile?: string;
  /** Resolution width spec: 0.0-1.0 = relative to iResolution, >1.0 = absolute pixels */
  shaderWidth?: number;
  /** Resolution height spec: 0.0-1.0 = relative to iResolution, >1.0 = absolute pixels */
  shaderHeight?: number;
  /** Whether to re-render each frame (true) or only on param changes (false) */
  shaderDynamic?: boolean;
}

/** Valid FFT sizes for AudioFFT directives */
export const VALID_FFT_SIZES = [64, 128, 256, 512, 1024, 2048, 4096] as const;
export type FFTSize = typeof VALID_FFT_SIZES[number];

/** Valid built-in texture names set */
export const VALID_TEXTURE_NAMES = new Set<string>([
  'RGBANoise', 'RGBANoiseBig', 'RGBANoiseSmall',
  'GrayNoise', 'GrayNoiseBig', 'GrayNoiseSmall',
]);
