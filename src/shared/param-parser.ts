// Unified parameter parser — replaces 3 duplicate copies in:
//   js/param-parser.js, shader-renderer.js (ShaderParamParser), three-scene-renderer.js

import type {
  ParamDef, ParamBaseType, GLSLType, ParamValue, ParamArrayValue,
  ParamValues, TextureDirective,
} from './types/params.js';
import { VALID_TEXTURE_NAMES, VALID_FFT_SIZES } from './types/params.js';

const PARAM_REGEX = /^\s*\/\/\s*@param\s+(\w+)\s+(int|float|vec[234]|color)(\[(\d+)\])?\s*(.*)/;
const TEXTURE_REGEX = /^\s*\/\/\s*@texture\s+(iChannel[0-3])\s+(texture:(\w+)|(\w+)(?:\((\d+)\))?)/;
const FILE_TEXTURE_NAME_REGEX = /^[\w-]+$/;

/** Component count for vector types */
const VEC_COMPONENTS: Record<string, number> = { vec2: 2, vec3: 3, color: 3, vec4: 4 };

// ── Value parsing ────────────────────────────────────────────────────────────

/** Parse a single value string into the appropriate type */
export function parseValue(valueStr: string, baseType: ParamBaseType): ParamValue {
  const parts = valueStr.split(',').map(s => s.trim());
  switch (baseType) {
    case 'int':
      return parseInt(parts[0], 10) || 0;
    case 'float':
      return parseFloat(parts[0]) || 0.0;
    case 'vec2':
      return [parseFloat(parts[0]) || 0.0, parseFloat(parts[1]) || 0.0];
    case 'color':
    case 'vec3':
      return [parseFloat(parts[0]) || 0.0, parseFloat(parts[1]) || 0.0, parseFloat(parts[2]) || 0.0];
    case 'vec4':
      return [parseFloat(parts[0]) || 0.0, parseFloat(parts[1]) || 0.0, parseFloat(parts[2]) || 0.0, parseFloat(parts[3]) || 0.0];
    default:
      return 0;
  }
}

/** Get default value for a given type */
export function getDefaultValue(baseType: ParamBaseType, arraySize: number | null = null): ParamValue | ParamArrayValue {
  let defaultVal: ParamValue;
  switch (baseType) {
    case 'int': defaultVal = 0; break;
    case 'float': defaultVal = 0.5; break;
    case 'vec2': defaultVal = [0.5, 0.5]; break;
    case 'color':
    case 'vec3': defaultVal = [1.0, 1.0, 1.0]; break;
    case 'vec4': defaultVal = [0.0, 0.0, 0.0, 1.0]; break;
    default: defaultVal = 0;
  }

  if (arraySize) {
    return Array(arraySize).fill(null).map(() =>
      Array.isArray(defaultVal) ? [...defaultVal] : defaultVal
    );
  }
  return defaultVal;
}

// ── Line parsing helpers ─────────────────────────────────────────────────────

interface ParseRestResult {
  defaultValue: ParamValue | ParamArrayValue;
  min: number | null;
  max: number | null;
  description: string;
}

function parseRest(restStr: string, baseType: ParamBaseType, arraySize: number | null): ParseRestResult {
  let defaultValue = getDefaultValue(baseType, arraySize);
  let min: number | null = null;
  let max: number | null = null;
  let description = '';
  let remaining = restStr.trim();

  // Extract description (quoted string at the end)
  const descMatch = remaining.match(/"([^"]*)"$/);
  if (descMatch) {
    description = descMatch[1];
    remaining = remaining.slice(0, -descMatch[0].length).trim();
  }

  // For vector/color types, check if [x,y,z] is a default value (not a range)
  const expectedComponents = VEC_COMPONENTS[baseType];
  if (expectedComponents) {
    // Per-element array defaults: [[x,y,z],[a,b,c]]
    if (arraySize) {
      const nestedMatch = remaining.match(/^\s*\[((?:\s*\[[^\]]+\]\s*,?\s*)+)\]\s*$/);
      if (nestedMatch) {
        const innerBrackets: ParamValue[] = [];
        const innerRegex = /\[([^\]]+)\]/g;
        let m;
        while ((m = innerRegex.exec(nestedMatch[1])) !== null) {
          const parts = m[1].split(',').map((s: string) => s.trim());
          if (parts.length === expectedComponents) {
            innerBrackets.push(parseValue(parts.join(', '), baseType));
          }
        }
        if (innerBrackets.length === arraySize) {
          defaultValue = innerBrackets;
          return { defaultValue, min, max, description };
        }
      }
    }
    // Single vec default: [x,y,z]
    const bracketMatch = remaining.match(/^\s*\[([^\]]+)\]\s*$/);
    if (bracketMatch) {
      const parts = bracketMatch[1].split(',').map((s: string) => s.trim());
      if (parts.length === expectedComponents) {
        const singleVal = parseValue(parts.join(', '), baseType) as number[];
        if (arraySize) {
          defaultValue = Array(arraySize).fill(null).map(() => [...singleVal]);
        } else {
          defaultValue = singleVal;
        }
        return { defaultValue, min, max, description };
      }
    }
  }

  // Extract range [min, max]
  const rangeMatch = remaining.match(/\[([^\]]+)\]\s*$/);
  if (rangeMatch) {
    const rangeParts = rangeMatch[1].split(',').map((s: string) => s.trim());
    if (rangeParts.length >= 2) {
      min = parseFloat(rangeParts[0]);
      max = parseFloat(rangeParts[1]);
      if (isNaN(min)) min = null;
      if (isNaN(max)) max = null;
    }
    remaining = remaining.slice(0, -rangeMatch[0].length).trim();
  }

  // Remaining should be the default value
  if (remaining.length > 0) {
    if (arraySize) {
      const singleDefault = parseValue(remaining, baseType);
      defaultValue = Array(arraySize).fill(null).map(() =>
        Array.isArray(singleDefault) ? [...singleDefault] : singleDefault
      );
    } else {
      defaultValue = parseValue(remaining, baseType);
    }
  }

  return { defaultValue, min, max, description };
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Parse a single @param line. Returns null if not a valid @param comment. */
export function parseParamLine(line: string): ParamDef | null {
  const match = line.match(PARAM_REGEX);
  if (!match) return null;

  const name = match[1];
  const baseType = match[2] as ParamBaseType;
  const arraySize = match[4] ? parseInt(match[4], 10) : null;
  const rest = match[5] || '';

  const { defaultValue, min, max, description } = parseRest(rest, baseType, arraySize);

  const isColor = baseType === 'color';
  const glslBaseType: GLSLType = isColor ? 'vec3' : baseType as GLSLType;

  return {
    name,
    type: baseType,
    glslBaseType,
    arraySize,
    isArray: arraySize !== null,
    isColor,
    default: defaultValue,
    min,
    max,
    description,
    glslType: arraySize ? `${glslBaseType}[${arraySize}]` : glslBaseType,
    uniformDecl: arraySize
      ? `uniform ${glslBaseType} ${name}[${arraySize}];`
      : `uniform ${glslBaseType} ${name};`,
  };
}

/** Parse all @param comments from shader source */
export function parseShaderParams(shaderSource: string): ParamDef[] {
  const params: ParamDef[] = [];
  const lines = shaderSource.split('\n');

  for (const line of lines) {
    const param = parseParamLine(line);
    if (param) {
      params.push(param);
    }
  }

  return params;
}

/** Generate GLSL uniform declarations for parsed params */
export function generateUniformDeclarations(params: ParamDef[]): string {
  return params.map(p => p.uniformDecl).join('\n');
}

/** Create initial values object from parsed params */
export function createParamValues(params: ParamDef[]): ParamValues {
  const values: ParamValues = {};
  for (const param of params) {
    values[param.name] = param.isArray
      ? (param.default as ParamArrayValue).map(v => Array.isArray(v) ? [...v] : v)
      : (Array.isArray(param.default) ? [...(param.default as number[])] : param.default);
  }
  return values;
}

/** Parse @texture directives from shader source */
export function parseTextureDirectives(shaderSource: string): TextureDirective[] {
  const directives: TextureDirective[] = [];
  const lines = shaderSource.split('\n');

  for (const line of lines) {
    const match = line.match(TEXTURE_REGEX);
    if (match) {
      const channel = parseInt(match[1].charAt(8), 10);
      if (match[3]) {
        // texture:filename syntax
        const fileName = match[3];
        if (FILE_TEXTURE_NAME_REGEX.test(fileName)) {
          directives.push({ channel, textureName: fileName, type: 'file' });
        }
      } else {
        // Built-in texture name or AudioFFT
        const textureName = match[4];
        const sizeArg = match[5] ? parseInt(match[5], 10) : null;
        if (textureName === 'AudioFFT' && sizeArg !== null) {
          const validSizes = VALID_FFT_SIZES as readonly number[];
          if (validSizes.includes(sizeArg)) {
            directives.push({ channel, textureName: `AudioFFT(${sizeArg})`, type: 'audio', fftSize: sizeArg });
          }
        } else if (textureName === 'AudioFFT') {
          directives.push({ channel, textureName, type: 'audio', fftSize: 1024 });
        } else if (textureName === 'AudioFFTBig') {
          directives.push({ channel, textureName, type: 'audio', fftSize: 2048 });
        } else if (VALID_TEXTURE_NAMES.has(textureName)) {
          directives.push({ channel, textureName, type: 'builtin' });
        }
      }
    }
  }

  return directives;
}

/** Validate and clamp a value to param's range */
export function clampParamValue(param: ParamDef, value: ParamValue | ParamArrayValue): ParamValue | ParamArrayValue {
  if (param.min === null && param.max === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(v => {
      if (typeof v === 'number') {
        let clamped = v;
        if (param.min !== null) clamped = Math.max(param.min, clamped);
        if (param.max !== null) clamped = Math.min(param.max, clamped);
        return clamped;
      }
      return v;
    });
  }

  if (typeof value === 'number') {
    let clamped = value;
    if (param.min !== null) clamped = Math.max(param.min, clamped);
    if (param.max !== null) clamped = Math.min(param.max, clamped);
    return clamped;
  }

  return value;
}
