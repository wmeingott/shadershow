// Bind directive test — demonstrates parameter binding to built-in uniforms
//
// Usage: Load this shader and enable audio (AudioFFT on iChannel0) to see
// sound-reactive parameter automation.

// @texture iChannel0 AudioFFT

// Replace mode: iBassLevel directly controls luminance (toggle on by default)
// @param lum float 0.5 [0.0,1.0] bind:iBassLevel,factor=1.5,offset=-0.5,toggle=on "Luminance (bass)"

// Add mode: bass pulse adds to the base value set by slider
// @param pulse float 0.3 [0.0,1.0] bind:iBassLevel,mode=add,factor=0.4,smooth=0.5,toggle=off "Bass pulse (add)"

// Range sugar: maps iMidLevel 0-1 to output range 0.2-0.8
// @param mid float 0.5 [0.0,1.0] bind:iMidLevel,range=[0.2,0.8],toggle=on "Mid range"

// Always-on binding (no toggle button): high frequency controls saturation
// @param sat float 0.7 [0.0,1.0] bind:iHighLevel,smooth=0.7 "Saturation (always bound)"

// Time-based: slow sweep controlled by iTime
// @param sweep float 0.0 [0.0,1.0] bind:iTime,factor=0.05,toggle=off "Time sweep"

// Regular param (no binding) for comparison
// @param scale float 3.0 [1.0,10.0] "Pattern scale"

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;

    // Create a pattern
    float pattern = 0.5 + 0.5 * sin(uv.x * scale * 6.28 + sweep * 6.28)
                              * cos(uv.y * scale * 6.28);

    // Mix color channels using bound params
    vec3 col = vec3(
        pattern * (lum + pulse),
        pattern * mid * 0.8,
        pattern * (1.0 - lum) * 0.6
    );

    // Apply saturation
    float gray = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(gray), col, sat);

    fragColor = vec4(col, 1.0);
}
