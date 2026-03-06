// Shader Texture Channel Test — Dynamic
// The texture shader re-renders every frame (dynamic=true) because it uses iTime

// @texture iChannel0 shader(genNoise, 0.5, 0.5, true)

// @param noiseSpeed float 1.0 [0.1, 5.0] "Noise animation speed"
// @param noiseScale float 5.0 [1.0, 20.0] "Noise pattern scale"

// Simple animated noise texture
void genNoise(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 p = uv * noiseScale;

    // Simple pseudo-noise using sin combinations
    float n = sin(p.x * 12.9898 + p.y * 78.233 + iTime * noiseSpeed) * 43758.5453;
    n = fract(n);

    float n2 = sin(p.x * 39.346 + p.y * 11.135 + iTime * noiseSpeed * 0.7) * 43758.5453;
    n2 = fract(n2);

    float n3 = sin(p.x * 73.156 + p.y * 52.235 + iTime * noiseSpeed * 1.3) * 43758.5453;
    n3 = fract(n3);

    fragColor = vec4(n, n2, n3, 1.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;

    // Sample the dynamic noise texture
    vec4 noise = texture(iChannel0, uv);

    // Use noise to create a colorful plasma effect
    vec3 col;
    col.r = sin(noise.r * 6.28 + iTime) * 0.5 + 0.5;
    col.g = sin(noise.g * 6.28 + iTime * 1.3 + 2.0) * 0.5 + 0.5;
    col.b = sin(noise.b * 6.28 + iTime * 0.7 + 4.0) * 0.5 + 0.5;

    fragColor = vec4(col, 1.0);
}
