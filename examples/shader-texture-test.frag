// Shader Texture Channel Test
// Demonstrates using a shader function to generate a texture for iChannel0

// @texture iChannel0 shader(genTexture, 256, 256, false)

// @param scale float 4.0 [1.0, 20.0] "Texture pattern scale"
// @param tint color [0.2, 0.6, 1.0] "Tint color for the generated texture"

// Generate a procedural checkerboard texture
void genTexture(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / vec2(256.0);
    vec2 grid = floor(uv * scale);
    float checker = mod(grid.x + grid.y, 2.0);
    // Add some gradient variation
    vec3 col = mix(vec3(0.1), tint, checker);
    col += uv.x * 0.15;
    fragColor = vec4(col, 1.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;

    // Sample the generated texture
    vec4 tex = texture(iChannel0, uv);

    // Apply a simple distortion effect using the texture
    vec2 offset = (tex.rg - 0.5) * 0.05;
    vec4 texDistorted = texture(iChannel0, uv + offset + vec2(sin(iTime * 0.5) * 0.02));

    // Mix original and distorted
    vec3 col = mix(tex.rgb, texDistorted.rgb, 0.5 + 0.5 * sin(iTime));

    // Add vignette
    float vignette = 1.0 - length(uv - 0.5) * 0.8;
    col *= vignette;

    fragColor = vec4(col, 1.0);
}
