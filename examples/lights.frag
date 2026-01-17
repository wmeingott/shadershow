/*
 * Lights Grid Shader
 *
 * Parameters:
 *   iParams[0] - Number of rows (0.0 = 1 row, 1.0 = 10 rows)
 *   iParams[1] - Number of columns (0.0 = 1 col, 1.0 = 10 cols)
 *   iParams[2] - Color mode: <= 0.5 colors per row, > 0.5 colors per column
 *   iParams[3] - Light size (0.0 = small, 1.0 = large)
 *   iParams[4] - Glow intensity (0.0 = no glow, 1.0 = max glow)
 *
 * Colors:
 *   iColorRGB[0-9] - Colors for rows or columns (wraps if more rows/cols than colors)
 */

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;

    // Calculate grid dimensions from params (1 to 10)
    int rows = int(mix(1.0, 10.0, iParams[0]));
    int cols = int(mix(1.0, 10.0, iParams[1]));

    // Color mode: false = per row, true = per column
    bool colorByColumn = iParams[2] > 0.5;

    // Light size and glow
    float lightSize = mix(0.2, 0.45, iParams[3]);
    float glowIntensity = mix(0.5, 3.0, iParams[4]);

    // Calculate cell coordinates
    vec2 cellSize = vec2(1.0 / float(cols), 1.0 / float(rows));
    vec2 cellCoord = uv / cellSize;
    vec2 cellIndex = floor(cellCoord);
    vec2 cellUV = fract(cellCoord);

    // Center of cell (0.5, 0.5)
    vec2 center = vec2(0.5);
    float dist = length(cellUV - center);

    // Determine which color to use
    int colorIndex;
    if (colorByColumn) {
        colorIndex = int(cellIndex.x) % 10;
    } else {
        colorIndex = int(cellIndex.y) % 10;
    }

    // Get color from uniform array
    vec3 lightColor = iColorRGB[colorIndex];

    // Create light with soft edges and glow
    float light = smoothstep(lightSize, lightSize * 0.3, dist);

    // Add glow effect
    float glow = exp(-dist * glowIntensity * 3.0) * 0.5;

    // Combine light and glow
    vec3 color = lightColor * (light + glow);

    // Dark background
    vec3 bgColor = vec3(0.02);
    color = mix(bgColor, color, light + glow * 0.8);

    // Add subtle grid lines
    vec2 gridLine = smoothstep(0.02, 0.0, cellUV) + smoothstep(0.98, 1.0, cellUV);
    color += vec3(0.03) * max(gridLine.x, gridLine.y);

    fragColor = vec4(color, 1.0);
}
