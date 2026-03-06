// Shader Texture Channel Test — File-based
// Demonstrates using an external shader file to generate a texture for iChannel0

// @texture iChannel0 shader(file:examples/texture-gen.frag, 512, 512, false)

// @param zoom float 1.0 [0.1, 5.0] "Zoom level for texture sampling"

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;

    // Sample the generated texture with zoom
    vec2 texUV = (uv - 0.5) * zoom + 0.5;
    vec4 tex = texture(iChannel0, texUV);

    // Simple color manipulation
    vec3 col = tex.rgb;
    col = pow(col, vec3(0.8)); // slight gamma adjustment

    fragColor = vec4(col, 1.0);
}
