// Lights Grid Shader
// @param rows int 5 [1, 10] "Number of rows"
// @param cols int 5 [1, 10] "Number of columns"
// @param colorByColumn int 0 [0, 1] "Color mode: 0=per row, 1=per column"
// @param lightSize float 0.35 [0.1, 0.5] "Size of each light"
// @param glowIntensity float 0.5 [0.0, 1.0] "Glow intensity"
// @param colors vec3[10] 1.0, 1.0, 1.0 "Color palette for rows/columns"

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;

    // Calculate cell coordinates
    vec2 cellSize = vec2(1.0 / float(cols), 1.0 / float(rows));
    vec2 cellCoord = uv / cellSize;
    vec2 cellIndex = floor(cellCoord);
    vec2 cellUV = fract(cellCoord);

    // Center of cell (0.5, 0.5)
    vec2 center = vec2(0.5);
    float dist = length(cellUV - center);

    // Determine which color to use based on colorByColumn mode
    int colorIndex;
    if (colorByColumn == 1) {
        colorIndex = int(cellIndex.x) % 10;
    } else {
        colorIndex = int(cellIndex.y) % 10;
    }

    // Get color from uniform array
    vec3 lightColor = colors[colorIndex];

    // Create light with soft edges and glow
    float light = smoothstep(lightSize, lightSize * 0.3, dist);

    // Add glow effect
    float glowAmount = mix(0.5, 3.0, glowIntensity);
    float glow = exp(-dist * glowAmount * 3.0) * 0.5;

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
