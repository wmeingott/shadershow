// IRenderer interface — unifies ShaderRenderer, ThreeSceneRenderer,
// MiniShaderRenderer, TileRenderer, AssetRenderer

import type { ParamDef, ParamValue, ParamValues, ParamArrayValue } from './params.js';

/** Result of a shader compilation */
export interface CompileResult {
  success: boolean;
  errors?: ShaderError[];
}

/** A shader compilation error */
export interface ShaderError {
  line: number;
  message: string;
}

/** Stats returned from a render call */
export interface RenderStats {
  fps?: number;
  frameTime?: number;
}

/** Channel types for texture inputs */
export type ChannelType = 'empty' | 'image' | 'video' | 'camera' | 'audio' | 'ndi' | 'builtin';

/**
 * Core renderer interface implemented by all renderer classes.
 *
 * Required methods are the minimum set every renderer must implement.
 * Optional methods are for specific capabilities (texture loading, etc.).
 */
export interface IRenderer {
  /** Compile shader or scene source. Returns success/error info. */
  compile(source: string, isJSX?: boolean): CompileResult;

  /** Render one frame. Returns optional stats. */
  render(): RenderStats | void;

  /** Set the rendering resolution */
  setResolution(width: number, height: number): void;

  /** Set a single named parameter */
  setParam(name: string, value: ParamValue | ParamArrayValue): void;

  /** Get all current parameter values */
  getParams(): ParamValues;

  /** Get parsed custom @param definitions from current shader */
  getCustomParamDefs(): ParamDef[];

  /** Set multiple custom param values at once */
  setCustomParamValues(values: ParamValues): void;

  /** Set multiple params at once (including built-in like speed) */
  setParams(params: ParamValues): void;

  /** Reinitialize the renderer (e.g. after context loss) */
  reinitialize(): void;

  /** Clean up all resources */
  dispose(): void;

  // --- Optional capabilities ---

  /** Load a texture image into a channel */
  loadTexture?(channel: number, dataUrl: string): void;

  /** Load a video into a channel */
  loadVideo?(channel: number, filePath: string): void;

  /** Load camera input into a channel */
  loadCamera?(channel: number): void;

  /** Load audio FFT into a channel */
  loadAudio?(channel: number, fftSize?: number): void;

  /** Clear a channel */
  clearChannel?(channel: number): void;

  /** Get the current shader/scene source */
  getSource?(): string;

  /** Set playback speed */
  setSpeed?(speed: number): void;

  /** Get the WebGL canvas element */
  getCanvas?(): HTMLCanvasElement;
}
