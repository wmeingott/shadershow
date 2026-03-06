// Procedural texture generator — used as a file-based shader texture source
// Usage: // @texture iChannel0 shader(file:examples/texture-gen.frag, 512, 512, false)

// @param density float 8.0 [1.0, 32.0] "Pattern density"
// @param rotation float 0.0 [0.0, 6.28] "Pattern rotation angle"

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 centered = uv - 0.5;

    // Apply rotation
    float c = cos(rotation);
    float s = sin(rotation);
    centered = mat2(c, -s, s, c) * centered;

    // Generate concentric rings pattern
    float dist = length(centered) * density;
    float rings = sin(dist * 6.2831853) * 0.5 + 0.5;

    // Generate radial lines
    float angle = atan(centered.y, centered.x);
    float lines = sin(angle * density) * 0.5 + 0.5;

    // Combine patterns
    vec3 col = vec3(rings * 0.8, lines * 0.6, (rings + lines) * 0.4);

    fragColor = vec4(col, 1.0);
}
