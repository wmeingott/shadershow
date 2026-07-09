// Shared hex ↔ normalized-RGB conversion (0..1 floats, '#rrggbb' strings).
// Used by params, tiling, and ab-preview.

/** Convert normalized RGB (0..1, clamped) to a '#rrggbb' string. */
export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => {
    const hex = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

/** Parse a '#rrggbb' (or 'rrggbb') string to normalized RGB. Invalid input returns `fallback`. */
export function hexToRgb(
  hex: string,
  fallback: [number, number, number] = [1, 1, 1],
): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return fallback;
  return [
    parseInt(result[1], 16) / 255,
    parseInt(result[2], 16) / 255,
    parseInt(result[3], 16) / 255,
  ];
}
