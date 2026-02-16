// Unified parameter parser — replaces 3 duplicate copies in:
//   js/param-parser.js, shader-renderer.js (ShaderParamParser), three-scene-renderer.js

import type {
  ParamDef, ParamBaseType, GLSLType, ParamValue, ParamArrayValue,
  ParamValues, TextureDirective, StructDef, StructFieldDef,
} from './types/params.js';
import { VALID_TEXTURE_NAMES, VALID_FFT_SIZES } from './types/params.js';

const PARAM_REGEX = /^\s*\/\/\s*@param\s+(\w+)\s+(int|float|vec[234]|color)\b(\[(\d+)\])?\s*(.*)/;
const STRUCT_PARAM_REGEX = /^\s*\/\/\s*@param\s+(\w+)\s+(\w+)(\[(\d+)\])?\s*(.*)/;
const STRUCTURE_REGEX = /^\s*\/\/\s*@structure\s+(\w+)\s+(.*)/s;
const TEXTURE_REGEX = /^\s*\/\/\s*@texture\s+(iChannel[0-3])\s+(texture:(\w+)|(\w+)(?:\((\d+)\))?)/;
const FILE_TEXTURE_NAME_REGEX = /^[\w-]+$/;
const BASE_TYPES = new Set<string>(['int', 'float', 'vec2', 'vec3', 'vec4', 'color']);

/** Component count for vector types */
const VEC_COMPONENTS: Record<string, number> = { vec2: 2, vec3: 3, color: 3, vec4: 4 };
const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{6})$/;

// ── Directive extraction from // and /* */ comments ─────────────────────────

/** Strip leading whitespace and optional * prefix from block comment lines */
function stripBlockPrefix(s: string): string {
  return s.replace(/^\s*\*?\s?/, '');
}

/**
 * Process a content line during directive extraction.
 * Handles continuation (lines ending with >) and emits completed directives.
 * Returns updated pending continuation string.
 */
function handleDirectiveLine(content: string, pending: string, result: string[]): string {
  content = content.trim();
  if (!content) return pending;

  if (pending) {
    // Inside @structure continuation, @param lines are fields — not new directives
    const inStructure = pending.startsWith('@structure');

    if (!inStructure && /^@(?:param|texture|structure)\b/.test(content)) {
      // New directive starts — finalize the pending one
      result.push('// ' + pending.trim());
      pending = '';
      // Fall through to process as new directive
    } else {
      // Append continuation content
      if (content.endsWith('>')) {
        return pending + ' ' + content.slice(0, -1).trimEnd();
      }
      result.push('// ' + (pending + ' ' + content).trim());
      return '';
    }
  }

  // Check if this is a directive start
  if (/^@(?:param|texture|structure)\b/.test(content)) {
    if (content.endsWith('>')) {
      return content.slice(0, -1).trimEnd();
    }
    result.push('// ' + content);
  }
  return '';
}

/**
 * Extract @param, @texture, and @structure directive lines from shader source.
 * Handles both // and block comments with three continuation styles:
 *   >   — single-line: next comment line continues this directive
 *   >>  — block-open:  all following lines are joined until <<
 *   <<  — block-close: ends a >> block
 * Returns normalized lines like "// @param speed float 0.5".
 */
function extractDirectiveLines(source: string): string[] {
  const result: string[] = [];
  const lines = source.split('\n');
  let inBlockComment = false;
  let pending = '';
  let mlAccum = '';    // accumulator for >> … << multi-line blocks
  let inML = false;    // inside a >> … << block

  /** Feed one stripped content line through >> / << handling, then handleDirectiveLine */
  function feed(raw: string): void {
    const content = raw.trim();

    // ── Inside a >> … << block: accumulate until << ──
    if (inML) {
      const endIdx = content.indexOf('<<');
      if (endIdx >= 0) {
        const before = content.slice(0, endIdx).trim();
        if (before) mlAccum += ' ' + before;
        inML = false;
        pending = handleDirectiveLine(mlAccum.trim(), pending, result);
        mlAccum = '';
      } else if (content) {
        mlAccum += ' ' + content;
      }
      return;
    }

    // ── Check for >> at end of line to start a block ──
    if (content.endsWith('>>')) {
      const before = content.slice(0, -2).trimEnd();
      // Merge any existing > pending into the block accumulator
      mlAccum = pending ? pending + ' ' + before : before;
      pending = '';
      inML = true;
      return;
    }

    // ── Regular single-line (may use > continuation) ──
    pending = handleDirectiveLine(content, pending, result);
  }

  for (const line of lines) {
    if (!inBlockComment) {
      // Check for // line comment first (takes precedence over /*)
      const slashMatch = line.match(/^\s*\/\/\s*(.*)/);
      if (slashMatch) {
        feed(slashMatch[1]);
        continue;
      }

      // Check for /* block comment start
      const bcStart = line.indexOf('/*');
      if (bcStart >= 0) {
        const bcEnd = line.indexOf('*/', bcStart + 2);
        if (bcEnd >= 0) {
          // Single-line block comment: /* ... */
          feed(stripBlockPrefix(line.substring(bcStart + 2, bcEnd)));
        } else {
          // Multi-line block comment starts
          inBlockComment = true;
          feed(stripBlockPrefix(line.substring(bcStart + 2)));
        }
      } else if (!inML && pending) {
        // Non-comment line ends any pending continuation
        result.push('// ' + pending.trim());
        pending = '';
      }
    } else {
      // Inside block comment
      const bcEnd = line.indexOf('*/');
      let content: string;
      if (bcEnd >= 0) {
        content = line.substring(0, bcEnd);
        inBlockComment = false;
      } else {
        content = line;
      }
      feed(stripBlockPrefix(content));

      // If block comment ended, finalize any pending continuation
      if (!inBlockComment && !inML && pending) {
        result.push('// ' + pending.trim());
        pending = '';
      }
    }
  }

  // Finalize any remaining state
  if (inML && mlAccum) {
    pending = handleDirectiveLine(mlAccum.trim(), pending, result);
  }
  if (pending) {
    result.push('// ' + pending.trim());
  }

  return result;
}

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
  mins: number[] | null;
  maxs: number[] | null;
  description: string;
}

/** Extract all top-level bracket groups from a string, respecting nesting. */
function extractBracketGroups(str: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (str[i] === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        groups.push(str.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return groups;
}

function parseRest(restStr: string, baseType: ParamBaseType, arraySize: number | null): ParseRestResult {
  let defaultValue = getDefaultValue(baseType, arraySize);
  let min: number | null = null;
  let max: number | null = null;
  let mins: number[] | null = null;
  let maxs: number[] | null = null;
  let description = '';
  let remaining = restStr.trim();

  // Extract description (quoted string at the end)
  const descMatch = remaining.match(/"([^"]*)"$/);
  if (descMatch) {
    description = descMatch[1];
    remaining = remaining.slice(0, -descMatch[0].length).trim();
  }

  // For color type, support #RRGGBB hex default
  if (baseType === 'color') {
    const hexMatch = remaining.match(HEX_COLOR_REGEX);
    if (hexMatch) {
      const hex = hexMatch[1];
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      defaultValue = [r, g, b];
      return { defaultValue, min, max, mins, maxs, description };
    }
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
          return { defaultValue, min, max, mins, maxs, description };
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
        return { defaultValue, min, max, mins, maxs, description };
      }
    }
  }

  // For scalar array types (int[N], float[N]), parse bracket groups for defaults and ranges
  if (arraySize && (baseType === 'int' || baseType === 'float')) {
    const groups = extractBracketGroups(remaining);
    if (groups.length >= 1) {
      // First bracket group: per-element defaults [0.3,0.3,0.5]
      const defaultParts = groups[0].slice(1, -1).split(',').map(s => s.trim());
      if (defaultParts.length === arraySize) {
        defaultValue = defaultParts.map(s => baseType === 'int' ? (parseInt(s, 10) || 0) : (parseFloat(s) || 0));
      }

      if (groups.length >= 2) {
        // Second bracket group: per-element ranges [[0.0,2.0],[0.0,2.0],[0.0,2.0]]
        const innerRegex = /\[([^\]]+)\]/g;
        const inner = groups[1].slice(1, -1); // strip outer brackets
        const ranges: Array<[number, number]> = [];
        let m;
        while ((m = innerRegex.exec(inner)) !== null) {
          const rp = m[1].split(',').map(s => s.trim());
          if (rp.length >= 2) {
            ranges.push([parseFloat(rp[0]), parseFloat(rp[1])]);
          }
        }
        if (ranges.length === arraySize) {
          mins = ranges.map(r => isNaN(r[0]) ? 0 : r[0]);
          maxs = ranges.map(r => isNaN(r[1]) ? 1 : r[1]);
        } else if (ranges.length === 1) {
          // Single range applied to all elements
          min = isNaN(ranges[0][0]) ? null : ranges[0][0];
          max = isNaN(ranges[0][1]) ? null : ranges[0][1];
        }
      }
      // Remove parsed groups from remaining
      let pos = 0;
      for (const g of groups) {
        const idx = remaining.indexOf(g, pos);
        if (idx >= 0) pos = idx + g.length;
      }
      remaining = remaining.slice(pos).trim();
    }
    return { defaultValue, min, max, mins, maxs, description };
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

  // Strip optional brackets from scalar defaults: [0.5] → 0.5
  if (!arraySize && (baseType === 'int' || baseType === 'float')) {
    const bracketScalar = remaining.match(/^\[([^\],]+)\]$/);
    if (bracketScalar) remaining = bracketScalar[1].trim();
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

  return { defaultValue, min, max, mins, maxs, description };
}

// ── Structure support ────────────────────────────────────────────────────────

/** Split a string on commas at bracket depth 0 */
function splitTopLevel(str: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '[') depth++;
    else if (str[i] === ']') depth--;
    else if (str[i] === ',' && depth === 0) {
      parts.push(str.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(str.slice(start).trim());
  return parts;
}

/** Parse a single field value for a struct default */
function parseFieldValue(str: string, type: ParamBaseType): ParamValue {
  str = str.trim();
  if (type === 'color') {
    const hexMatch = str.match(HEX_COLOR_REGEX);
    if (hexMatch) {
      const hex = hexMatch[1];
      return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255];
    }
  }
  if (str.startsWith('[') && str.endsWith(']')) {
    return parseValue(str.slice(1, -1), type);
  }
  return parseValue(str, type);
}

/** Parse a combined @structure line into a StructDef */
function parseStructureLine(line: string): StructDef | null {
  const match = line.match(STRUCTURE_REGEX);
  if (!match) return null;

  const name = match[1];
  const rest = match[2];

  // Split on @param boundaries
  const fieldSegments = rest.split(/@param\s+/).filter(s => s.trim());

  const fields: StructFieldDef[] = [];
  for (const segment of fieldSegments) {
    const fieldLine = '// @param ' + segment.trim();
    const paramDef = parseParamLine(fieldLine);
    if (paramDef && !paramDef.isArray) {
      fields.push({
        name: paramDef.name,
        type: paramDef.type,
        glslType: paramDef.glslBaseType,
        isColor: paramDef.isColor,
        default: paramDef.default as ParamValue,
        min: paramDef.min,
        max: paramDef.max,
        description: paramDef.description,
      });
    }
  }

  return fields.length > 0 ? { name, fields } : null;
}

/** Parse nested struct default values */
function parseStructDefaults(
  restStr: string,
  structDef: StructDef,
  arraySize: number | null,
  paramName: string,
): Record<string, ParamValue> {
  const result: Record<string, ParamValue> = {};
  let remaining = restStr.trim();

  // Strip trailing description
  const descMatch = remaining.match(/"([^"]*)"$/);
  if (descMatch) {
    remaining = remaining.slice(0, -descMatch[0].length).trim();
  }

  if (!remaining.startsWith('[')) return result;
  const inner = remaining.slice(1, -1).trim();

  if (arraySize) {
    const elements = splitTopLevel(inner);
    for (let i = 0; i < Math.min(elements.length, arraySize); i++) {
      const elemStr = elements[i].trim();
      const elemInner = elemStr.startsWith('[') ? elemStr.slice(1, -1).trim() : elemStr;
      const fieldValues = splitTopLevel(elemInner);
      for (let f = 0; f < Math.min(fieldValues.length, structDef.fields.length); f++) {
        const field = structDef.fields[f];
        result[`${paramName}[${i}].${field.name}`] = parseFieldValue(fieldValues[f], field.type);
      }
    }
  } else {
    const fieldValues = splitTopLevel(inner);
    for (let f = 0; f < Math.min(fieldValues.length, structDef.fields.length); f++) {
      const field = structDef.fields[f];
      result[`${paramName}.${field.name}`] = parseFieldValue(fieldValues[f], field.type);
    }
  }

  return result;
}

/** Expand a struct-typed @param into flat ParamDef entries */
function expandStructParam(
  paramName: string,
  structDef: StructDef,
  arraySize: number | null,
  defaults: Record<string, ParamValue>,
  description: string,
): ParamDef[] {
  const params: ParamDef[] = [];
  const count = arraySize ?? 1;
  const isArray = arraySize !== null;

  for (let i = 0; i < count; i++) {
    for (const field of structDef.fields) {
      const fullName = isArray ? `${paramName}[${i}].${field.name}` : `${paramName}.${field.name}`;
      const defaultVal = defaults[fullName] !== undefined
        ? defaults[fullName]
        : (Array.isArray(field.default) ? [...field.default] : field.default);

      params.push({
        name: fullName,
        type: field.type,
        glslBaseType: field.glslType,
        arraySize: null,
        isArray: false,
        isColor: field.isColor,
        default: defaultVal,
        min: field.min,
        max: field.max,
        mins: null,
        maxs: null,
        description: field.description,
        glslType: field.glslType,
        uniformDecl: '',
        structDef,
        structParent: paramName,
        structIndex: isArray ? i : undefined,
        structField: field.name,
        structArraySize: arraySize,
      });
    }
  }

  return params;
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

  const { defaultValue, min, max, mins, maxs, description } = parseRest(rest, baseType, arraySize);

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
    mins,
    maxs,
    description,
    glslType: arraySize ? `${glslBaseType}[${arraySize}]` : glslBaseType,
    uniformDecl: arraySize
      ? `uniform ${glslBaseType} ${name}[${arraySize}];`
      : `uniform ${glslBaseType} ${name};`,
  };
}

/** Parse all @param and @structure comments from shader source */
export function parseShaderParams(shaderSource: string): ParamDef[] {
  const params: ParamDef[] = [];
  const directiveLines = extractDirectiveLines(shaderSource);
  const structs = new Map<string, StructDef>();

  // First pass: collect struct definitions
  for (const line of directiveLines) {
    const structDef = parseStructureLine(line);
    if (structDef) {
      structs.set(structDef.name, structDef);
    }
  }

  // Second pass: parse params (expanding struct types into flat fields)
  for (const line of directiveLines) {
    // Try regular base-type param first
    const param = parseParamLine(line);
    if (param) {
      params.push(param);
      continue;
    }

    // Try struct-typed param
    const structMatch = line.match(STRUCT_PARAM_REGEX);
    if (structMatch) {
      const name = structMatch[1];
      const typeName = structMatch[2];
      const arraySize = structMatch[4] ? parseInt(structMatch[4], 10) : null;
      const rest = structMatch[5] || '';

      // Skip if type is a base type (already handled above) or unknown struct
      if (BASE_TYPES.has(typeName)) continue;
      const structDef = structs.get(typeName);
      if (!structDef) continue;

      // Extract description
      const descMatch = rest.match(/"([^"]*)"$/);
      const description = descMatch ? descMatch[1] : '';

      const defaults = parseStructDefaults(rest, structDef, arraySize, name);
      params.push(...expandStructParam(name, structDef, arraySize, defaults, description));
    }
  }

  return params;
}

/** Generate GLSL uniform declarations for parsed params (including struct types) */
export function generateUniformDeclarations(params: ParamDef[]): string {
  const parts: string[] = [];
  const seenStructTypes = new Set<string>();
  const seenStructUniforms = new Set<string>();

  for (const p of params) {
    if (p.structDef && p.structParent) {
      // Emit struct type declaration once
      if (!seenStructTypes.has(p.structDef.name)) {
        seenStructTypes.add(p.structDef.name);
        const fields = p.structDef.fields.map(f => `  ${f.glslType} ${f.name};`).join('\n');
        parts.push(`struct ${p.structDef.name} {\n${fields}\n};`);
      }
      // Emit struct uniform declaration once per parent param
      if (!seenStructUniforms.has(p.structParent)) {
        seenStructUniforms.add(p.structParent);
        const arrSuffix = p.structArraySize ? `[${p.structArraySize}]` : '';
        parts.push(`uniform ${p.structDef.name} ${p.structParent}${arrSuffix};`);
      }
    } else if (p.uniformDecl) {
      parts.push(p.uniformDecl);
    }
  }

  return parts.join('\n');
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

/** Parse @texture directives from shader source (// and block comments, with > continuation) */
export function parseTextureDirectives(shaderSource: string): TextureDirective[] {
  const directives: TextureDirective[] = [];
  const directiveLines = extractDirectiveLines(shaderSource);

  for (const line of directiveLines) {
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
  const hasPerElement = param.mins !== null && param.maxs !== null;
  if (param.min === null && param.max === null && !hasPerElement) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((v, i) => {
      if (typeof v === 'number') {
        let clamped = v;
        const lo = hasPerElement && param.mins![i] !== undefined ? param.mins![i] : param.min;
        const hi = hasPerElement && param.maxs![i] !== undefined ? param.maxs![i] : param.max;
        if (lo !== null) clamped = Math.max(lo, clamped);
        if (hi !== null) clamped = Math.min(hi, clamped);
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
