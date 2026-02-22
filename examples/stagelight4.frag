// @param speed float 0.8 [0.0, 3.0] "Sweep Speed"
// @param phase float 1.35 [0.0,5.0]
// @param intensity float 1.25 [0.1, 3.0] "Global Intensity"
// @param spread float 0.22 [0.05, 0.8] "Beam Spread"
// @param dust float 0.02 [0.0, 0.1] "Air Dust Amount"
// @param environment color [0.01, 0.01, 0.03]
// @param halo float 0.1 [0.0,1.0]
// @param fla float 0.1 [0.0,1.0]
// @param position vec2 [0.0,0.45]
// @param space float 0.15 [0.0,1.0]
// @param fog color [0.05, 0.08, 0.2]
/* @param base vec2[9] [ >>
  [-0.5, -0.45],
  [-0.10, -0.48],
  [-0.5, -0.45],
  [-0.5, -0.45],
  [-0.10, -0.48],
  [-0.5, -0.45],
  [-0.5, -0.45],
  [-0.10, -0.48],
  [-0.5, -0.45]
  ] [-0.5,0.5] <<
*/
/* @param colors color[9] [>>
    [0.0, 1.0, 0.8],
    [0.1, 0.3, 1.0],
    [1.0, 0.0, 0.8],  
    [0.0, 1.0, 0.8],
    [0.1, 0.3, 1.0],
    [1.0, 0.0, 0.8], 
    [0.0, 1.0, 0.8],
    [0.1, 0.3, 1.0],
    [1.0, 0.0, 0.8]  
  ]"Farben" <<
*/

#define LIGHTS 9

// 2D rotation matrix
mat2 rot(float a) {
    float s = sin(a), c = cos(a);
    return mat2(c, -s, s, c);
}

// Pseudo-random noise for atmospheric scattering
float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

// Draw a single volumetric spotlight
vec3 drawSpotlight(vec2 uv, vec2 origin, vec2 baseTarget, vec3 color, float animOffset) {
    // Animate target to simulate moving lights
    vec2 target = baseTarget;
    float t = iTime * speed;
    
    // Complex sweeping motion using combined sine waves
    target.x += sin(t * 0.8 + animOffset) * 0.25 + cos(t * 0.43 + animOffset * 0.5) * 0.1;
    target.y += sin(t * 1.1 + animOffset) * 0.05;

    vec2 dir = target - origin;
    float len = length(dir);
    vec2 n = dir / len;
    
    // Vector from ray origin to current pixel
    vec2 p = uv - origin;
    
    // Projection of pixel along the beam direction
    float h = dot(p, n);

    vec3 accum = vec3(0.0);

    // 1. Source Lens Flare (always visible, even behind)
    float flareDist = length(p);
    float flare = fla * 0.005 / (flareDist + 0.002);
    // Add specular starburst effect slightly
    flare += 0.002 / (abs(p.x * p.y) + 0.003) * smoothstep(halo, 0.0, flareDist);
    accum += color * flare;

    // 2. Volumetric Beam (only forward projection)
    if (h > 0.0) {
        // Orthogonal distance from beam center
        float d = length(p - n * clamp(h, 0.0, len));

        // Spread width over distance
        float coneWidth = 0.01 + h * spread; 
        float cone = smoothstep(coneWidth, 0.0, d);
        cone = pow(cone, 1.8); // Soften the edge

        float coreWidth = 0.005 + h * (spread * 0.3);
        float core = smoothstep(coreWidth, 0.0, d);
        core = pow(core, 2.5); // Intense bright center

        // Fade out over distance to target
        float fade = smoothstep(len + 0.15, len * 0.2, h); 

        accum += color * (cone * 0.4 + core * 0.8) * fade;
    }

    // 3. Stage / Floor illumination (Intersection approximation)
    vec2 floorHit = uv - target;
    floorHit.y *= 3.5; // Simulate extreme perspective plane squash
    float hitDist = length(floorHit);
    
    // Base glow where beam hits
    float stageGlow = smoothstep(0.5, 0.0, hitDist);
    // Add a hot core to the floor spot
    stageGlow += smoothstep(0.15, 0.0, hitDist) * 1.5;
    
    // Only illuminate floor if the beam reached it
    float beamReach = smoothstep(len + 0.3, len - 0.2, h);
    accum += color * stageGlow * 0.35 * beamReach;

    return accum * intensity;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    // Normalize coordinates (-0.5 to 0.5 for height, wider for width)
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    // Base dark environment color
    vec3 col = environment;

    // Draw 6 Spotlights
    // params: uv, origin_pos, base_target_pos, color, animation_phase_offset
    
    for(int i = 0; i < LIGHTS; i++){
      col += drawSpotlight(uv, vec2(space * float(LIGHTS / 2 - i)  , 0.00) + position, base[i], colors[i], phase * float(i));
    }
    
    // Broad stage ambient floor glow
    vec2 floorBase = uv - vec2(0.0, -0.55);
    floorBase.x *= 0.8;
    floorBase.y *= 3.5;
    float baseGlow = smoothstep(1.2, 0.0, length(floorBase));
    col += fog * baseGlow * intensity * 0.4;

    // Atmospheric noise / dust scattering
    float noiseVal = hash(uv + fract(iTime * 0.1));
    col += noiseVal * dust;

    // Vignette mask to darken edges
    float vi = length(uv * vec2(1.0, 1.3));
    col *= 1.0 - smoothstep(0.1, 1.1, vi);

    // ACES-like Tonemapping for cinematic bright cores
    col = 1.0 - exp(-col * 1.2);
    
    // Gamma correction
    col = pow(col, vec3(1.0 / 2.2));

    fragColor = vec4(col, 1.0);
}