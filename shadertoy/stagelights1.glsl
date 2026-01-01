// Stage Lights Array Simulation
// Creates an array of animated stage lights with volumetric fog

#define NUM_LIGHTS 8
#define PI 3.14159265359

// Noise function for organic movement
float hash(float n) {
    return fract(sin(n) * 43758.5453123);
}

float noise(vec3 x) {
    vec3 p = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    
    float n = p.x + p.y * 57.0 + 113.0 * p.z;
    return mix(mix(mix(hash(n + 0.0), hash(n + 1.0), f.x),
                   mix(hash(n + 57.0), hash(n + 58.0), f.x), f.y),
               mix(mix(hash(n + 113.0), hash(n + 114.0), f.x),
                   mix(hash(n + 170.0), hash(n + 171.0), f.x), f.y), f.z);
}

// Volumetric fog density
float fogDensity(vec3 pos) {
    float base = 0.1;
    float n = noise(pos * 0.5 + vec3(0.0, -iTime * 0.1, 0.0));
    return base + n * 0.05;
}

// Calculate spotlight contribution
vec3 spotlight(vec3 pos, vec3 lightPos, vec3 lightDir, vec3 color, float angle, float intensity) {
    vec3 toLight = lightPos - pos;
    float dist = length(toLight);
    vec3 lightVec = normalize(toLight);
    
    // Spotlight cone
    float spotEffect = dot(lightVec, -lightDir);
    float spotCutoff = cos(angle);
    
    if (spotEffect < spotCutoff) return vec3(0.0);
    
    // Soft edge falloff
    float edge = 1.0 - (1.0 - spotEffect) / (1.0 - spotCutoff);
    edge = smoothstep(0.0, 1.0, edge);
    
    // Distance attenuation
    float attenuation = 1.0 / (1.0 + 0.1 * dist + 0.01 * dist * dist);
    
    // Volumetric scattering
    float fog = fogDensity(pos);
    
    return color * edge * attenuation * fog * intensity;
}

// Ray marching for volumetric lighting
vec3 volumetricLighting(vec3 ro, vec3 rd, float maxDist) {
    vec3 color = vec3(0.0);
    float stepSize = 0.1;
    int steps = int(maxDist / stepSize);
    
    for (int i = 0; i < steps; i++) {
        float t = float(i) * stepSize;
        vec3 pos = ro + rd * t;
        
        // Calculate contribution from each light
        for (int j = 0; j < NUM_LIGHTS; j++) {
            float lightIndex = float(j);
            
            // Animate light positions and directions
            float phase = lightIndex * PI * 2.0 / float(NUM_LIGHTS);
            float swing = sin(iTime * 0.5 + phase) * 0.3;
            float tilt = cos(iTime * 0.7 + phase * 1.5) * 0.2;
            
            // Light setup
            vec3 lightPos = vec3(
                -3.5 + lightIndex * 1.0,
                3.0,
                -2.0
            );
            
            vec3 lightDir = normalize(vec3(
                swing,
                -0.8 + tilt,
                1.0
            ));
            
            // Light colors - alternating warm and cool
            vec3 lightColor;
            if (mod(lightIndex, 3.0) == 0.0) {
                lightColor = vec3(1.0, 0.3, 0.1); // Warm orange
            } else if (mod(lightIndex, 3.0) == 1.0) {
                lightColor = vec3(0.2, 0.5, 1.0); // Cool blue
            } else {
                lightColor = vec3(1.0, 0.9, 0.7); // Warm white
            }
            
            // Flicker effect
            float flicker = 0.9 + 0.1 * sin(iTime * 20.0 + lightIndex * 7.0);
            
            color += spotlight(pos, lightPos, lightDir, lightColor, 
                             0.3 + 0.1 * sin(iTime + phase), 
                             2.0 * flicker);
        }
    }
    
    return color * stepSize;
}

// Simple ground plane
float groundPlane(vec3 ro, vec3 rd) {
    if (rd.y >= 0.0) return -1.0;
    return -ro.y / rd.y;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    
    // Camera setup
    vec3 ro = vec3(0.0, 1.5, 5.0);
    vec3 lookAt = vec3(0.0, 1.0, 0.0);
    
    // Camera matrix
    vec3 forward = normalize(lookAt - ro);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), forward));
    vec3 up = cross(forward, right);
    
    vec3 rd = normalize(forward + uv.x * right + uv.y * up);
    
    // Background gradient
    vec3 color = vec3(0.02, 0.02, 0.05) * (1.0 - uv.y * 0.5);
    
    // Ground
    float groundT = groundPlane(ro, rd);
    if (groundT > 0.0) {
        vec3 groundPos = ro + rd * groundT;
        
        // Stage floor pattern
        vec2 checker = floor(groundPos.xz * 2.0);
        float pattern = mod(checker.x + checker.y, 2.0);
        vec3 groundColor = mix(vec3(0.05), vec3(0.1), pattern);
        
        // Fade with distance
        float fade = exp(-groundT * 0.1);
        color = mix(color, groundColor, fade);
    }
    
    // Add volumetric lighting
    float maxDist = groundT > 0.0 ? groundT : 10.0;
    color += volumetricLighting(ro, rd, maxDist);
    
    // Tone mapping and gamma correction
    color = color / (1.0 + color); // Reinhard tone mapping
    color = pow(color, vec3(0.4545)); // Gamma correction
    
    // Subtle vignette
    float vignette = 1.0 - dot(uv, uv) * 0.3;
    color *= vignette;
    
    fragColor = vec4(color, 1.0);
}