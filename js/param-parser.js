// Parameter Parser Module
// Parses @param comments from shader source to define custom uniforms
//
// Format: // @param name type [default] [range] ["description"]
//
// Supported types:
//   int, int[N]       - Integer or integer array
//   float, float[N]   - Float or float array
//   vec2, vec2[N]     - 2D vector or array
//   vec3, vec3[N]     - 3D vector or array (also used for colors)
//   vec4, vec4[N]     - 4D vector or array
//
// Examples:
//   // @param brightness float 0.5 [0.0, 1.0] "Light intensity"
//   // @param count int 5 [1, 10] "Number of items"
//   // @param center vec2 0.5, 0.5 "Center position"
//   // @param color vec3 1.0, 0.0, 0.0 "Main color"
//   // @param colors vec3[10] 1.0, 1.0, 1.0 "Color palette"

const PARAM_REGEX = /^\s*\/\/\s*@param\s+(\w+)\s+(int|float|vec[234])(\[(\d+)\])?\s*(.*)/;

// Parse a single value based on type
function parseValue(valueStr, baseType) {
  const parts = valueStr.split(',').map(s => s.trim());

  switch (baseType) {
    case 'int':
      return parseInt(parts[0], 10) || 0;
    case 'float':
      return parseFloat(parts[0]) || 0.0;
    case 'vec2':
      return [
        parseFloat(parts[0]) || 0.0,
        parseFloat(parts[1]) || 0.0
      ];
    case 'vec3':
      return [
        parseFloat(parts[0]) || 0.0,
        parseFloat(parts[1]) || 0.0,
        parseFloat(parts[2]) || 0.0
      ];
    case 'vec4':
      return [
        parseFloat(parts[0]) || 0.0,
        parseFloat(parts[1]) || 0.0,
        parseFloat(parts[2]) || 0.0,
        parseFloat(parts[3]) || 0.0
      ];
    default:
      return 0;
  }
}

// Get default value for a type
function getDefaultValue(baseType, arraySize = null) {
  let defaultVal;
  switch (baseType) {
    case 'int':
      defaultVal = 0;
      break;
    case 'float':
      defaultVal = 0.5;
      break;
    case 'vec2':
      defaultVal = [0.5, 0.5];
      break;
    case 'vec3':
      defaultVal = [1.0, 1.0, 1.0];
      break;
    case 'vec4':
      defaultVal = [0.0, 0.0, 0.0, 1.0];
      break;
    default:
      defaultVal = 0;
  }

  if (arraySize) {
    return Array(arraySize).fill(null).map(() =>
      Array.isArray(defaultVal) ? [...defaultVal] : defaultVal
    );
  }
  return defaultVal;
}

// Parse the rest of the line after type (default, range, description)
function parseRest(restStr, baseType, arraySize) {
  let defaultValue = getDefaultValue(baseType, arraySize);
  let min = null;
  let max = null;
  let description = '';

  let remaining = restStr.trim();

  // Extract description (quoted string at the end)
  const descMatch = remaining.match(/"([^"]*)"$/);
  if (descMatch) {
    description = descMatch[1];
    remaining = remaining.slice(0, -descMatch[0].length).trim();
  }

  // Extract range [min, max]
  const rangeMatch = remaining.match(/\[([^\]]+)\]\s*$/);
  if (rangeMatch) {
    const rangeParts = rangeMatch[1].split(',').map(s => s.trim());
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
      // For arrays, parse single default that applies to all elements
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

// Parse a single @param line
function parseParamLine(line) {
  const match = line.match(PARAM_REGEX);
  if (!match) return null;

  const name = match[1];
  const baseType = match[2];
  const arraySize = match[4] ? parseInt(match[4], 10) : null;
  const rest = match[5] || '';

  const { defaultValue, min, max, description } = parseRest(rest, baseType, arraySize);

  return {
    name,
    type: baseType,
    arraySize,
    isArray: arraySize !== null,
    default: defaultValue,
    min,
    max,
    description,
    // Full GLSL type string
    glslType: arraySize ? `${baseType}[${arraySize}]` : baseType,
    // Uniform declaration
    uniformDecl: arraySize
      ? `uniform ${baseType} ${name}[${arraySize}];`
      : `uniform ${baseType} ${name};`
  };
}

// Parse all @param comments from shader source
export function parseShaderParams(shaderSource) {
  const params = [];
  const lines = shaderSource.split('\n');

  for (const line of lines) {
    // Stop parsing when we hit non-comment, non-empty line
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*')) {
      // Check if it's the start of actual code (not just empty or comment)
      if (!trimmed.startsWith('*/')) {
        break;
      }
    }

    const param = parseParamLine(line);
    if (param) {
      params.push(param);
    }
  }

  return params;
}

// Generate uniform declarations for parsed params
export function generateUniformDeclarations(params) {
  return params.map(p => p.uniformDecl).join('\n');
}

// Create initial values object from parsed params
export function createParamValues(params) {
  const values = {};
  for (const param of params) {
    values[param.name] = param.isArray
      ? param.default.map(v => Array.isArray(v) ? [...v] : v)
      : (Array.isArray(param.default) ? [...param.default] : param.default);
  }
  return values;
}

// Validate and clamp a value to param's range
export function clampParamValue(param, value) {
  if (param.min === null && param.max === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(v => {
      if (typeof v === 'number') {
        if (param.min !== null) v = Math.max(param.min, v);
        if (param.max !== null) v = Math.min(param.max, v);
      }
      return v;
    });
  }

  if (typeof value === 'number') {
    if (param.min !== null) value = Math.max(param.min, value);
    if (param.max !== null) value = Math.min(param.max, value);
  }

  return value;
}
