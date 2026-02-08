// @param cColor color [1.0, 0.3, 0.1] "Fire color"
// @param rradius float 0.5 [0.0, 1.0] "radius halo"
// @param mradius float 0.1 [0.0, 1.0] "Radius voll"
// @param gridsize int 10 [0,100] "Anzahl"
// @param speedx float 0.0 [-2.0,2.0] "Geschwindigkeit X"
// @param speedy float 0.0 [-2.0,2.0] "Geschwindigkeit Y"



void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    // Normalize coordinates to 0-1 range
    vec2 uv = fragCoord.xy / iResolution.xy;
    
    uv.x = uv.x + (mod(iTime, iResolution.x) * speedx);
    uv.y = uv.y + (mod(iTime, iResolution.y) * speedy);
    
    // Grid parameters
    float gridSize = float(gridsize);
    float radius = rradius * (1.0 / gridSize);
    
    // Scale UV to grid space (0 to 10)
    vec2 gridUV = uv * gridSize;
    
    // Get the cell index (0-9) and position within cell (0-1)
    vec2 cellIndex = floor(gridUV);
    vec2 cellUV = fract(gridUV);
    
    // Center of each cell is at (0.5, 0.5) in cell space
    // Convert radius to cell space (cell is 1/10 of screen, so radius * 10)
    float cellRadius = radius * gridSize;
    
    // Distance from center of cell
    float dist = distance(cellUV, vec2(0.5));
    
    // Draw circle: white inside, black outside
    float circle = smoothstep(mradius, cellRadius, dist);
    
    // Output color
    vec3 color = cColor - vec3(circle);
    
    fragColor = vec4(color, 1.0);
}
