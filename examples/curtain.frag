 // @param curtainColor color [0.6, 0.02, 0.05] "Curtain color"
 // @param structure float 12.0 [2.0, 40.0] "Curtain fold structure"
 // @param illumination color [1.0, 0.85, 0.5] "Bottom illumination color"
 // @param illuminationHeight float 0.35 [0.05, 1.0] "Illumination reach"
 // @param illuminationIntensity float 1.5 [0.0, 4.0] "Illumination intensity"
 // @param droopAmount float 0.15 [0.0, 0.5] "Curtain droop amount"
 // @param swaySpeed float 0.3 [0.0, 2.0] "Gentle sway speed"
 // @param swayAmount float 0.01 [0.0, 0.05] "Sway amplitude"


void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;

    // Subtle sway animation
    float sway = sin(iTime * swaySpeed + uv.y * 3.0) * swayAmount;
    float x = uv.x + sway;

    // --- Curtain folds ---
    // Primary fold pattern
    float foldPhase = x * structure * 3.14159;
    float fold = sin(foldPhase);
    float foldSharp = sin(foldPhase * 2.0) * 0.3;

    // Fold depth creates lighting variation (simulates 3D folds)
    float foldLight = 0.55 + 0.35 * fold + 0.1 * foldSharp;

    // Add subtle secondary wrinkle detail
    float wrinkle = sin(foldPhase * 3.7 + 1.3) * 0.06;
    wrinkle += sin(foldPhase * 5.1 - 0.7) * 0.03;
    foldLight += wrinkle;

    // --- Vertical shading (top darker, slight droop) ---
    // Droop: curtain sags slightly between folds
    float droop = droopAmount * (0.5 - 0.5 * cos(foldPhase * 2.0));
    float adjustedY = uv.y + droop;

    // Top gathers / valance shadow
    float topShadow = smoothstep(1.0, 0.85, adjustedY) * 0.25;

    // General vertical gradient: slightly darker at top
    float verticalShade = 0.85 + 0.15 * (1.0 - adjustedY);

    // --- Velvet-like material ---
    // Fresnel-ish darkening at fold edges for velvet look
    float foldAngle = abs(cos(foldPhase));
    float velvet = mix(0.7, 1.0, foldAngle * foldAngle);

    // Combine all shading
    float shade = foldLight * verticalShade * velvet - topShadow;
    shade = clamp(shade, 0.0, 1.0);

    // Apply curtain color
    vec3 col = curtainColor * shade;

    // --- Subtle fabric texture (noise approximation) ---
    float texNoise = fract(sin(dot(floor(fragCoord * 0.8), vec2(12.9898, 78.233))) * 43758.5453);
    col *= 0.97 + 0.03 * texNoise;

    // --- Bottom illumination (footlights) ---
    float illumMask = 1.0 - smoothstep(0.0, illuminationHeight, adjustedY);
    illumMask *= illumMask; // Quadratic falloff for softer light
    // Illumination also catches the front faces of folds more
    float illumFold = 0.7 + 0.3 * clamp(fold, 0.0, 1.0);
    vec3 illum = illumination * illumMask * illumFold * illuminationIntensity;

    // Add illumination (additive blending for light)
    col += curtainColor * illum * 0.5 + illum * 0.15;

    // Slight top highlight (ambient overhead light)
    float topLight = smoothstep(0.7, 1.0, adjustedY) * 0.08;
    col += curtainColor * topLight;

    fragColor = vec4(col, 1.0);
}
