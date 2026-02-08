// Stage Lights Array Simulation - OPTIMIZED
// Creates an array of animated stage lights with volumetric fog

// @param showGround float 0.5 [0.0, 1.0] "Show ground (>0.5)"
// @param lightHeight float 0.5 [0.0, 1.0] "Light height"
// @param lightDepth float 0.5 [0.0, 1.0] "Light depth"
// @param light1 color [1.0, 0.0, 0.0] "Light 1"
// @param light2 color [0.0, 1.0, 0.0] "Light 2"
// @param light3 color [0.0, 0.0, 1.0] "Light 3"
// @param light4 color [1.0, 1.0, 0.0] "Light 4"
// @param light5 color [1.0, 0.0, 1.0] "Light 5"
// @param light6 color [0.0, 1.0, 1.0] "Light 6"
// @param light7 color [1.0, 0.5, 0.0] "Light 7"
// @param light8 color [0.5, 0.0, 1.0] "Light 8"

#define NUM_LIGHTS 8
#define PI 3.14159265359
#define MAX_STEPS 88  // Reduziert von ~100

// Vereinfachte Noise-Funktion
float hash(float n) {
    return fract(sin(n) * 43758.5453123);
}

// Schnellerer Noise - weniger Operationen
float noise2(vec3 x) {
    vec3 p = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    
    float n = p.x + p.y * 57.0 + 113.0 * p.z;
    float a = hash(n);
    float b = hash(n + 1.0);
    float c = hash(n + 57.0);
    float d = hash(n + 58.0);
    float e = hash(n + 113.0);
    float f1 = hash(n + 114.0);
    float g = hash(n + 170.0);
    float h = hash(n + 171.0);
    
    return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
               mix(mix(e, f1, f.x), mix(g, h, f.x), f.y), f.z);
}

float noise(vec3 x){
  return 1.0;
}
// Vorberechnete Lichtdaten
struct Light {
    vec3 pos;
    vec3 dir;
    vec3 color;
    float angle;
    float intensity;
};

// Lichtparameter einmal pro Frame berechnen
void setupLights(out Light lights[NUM_LIGHTS]) {
    // Build color array from named parameters
    vec3 lightColors[NUM_LIGHTS];
    lightColors[0] = light1;
    lightColors[1] = light2;
    lightColors[2] = light3;
    lightColors[3] = light4;
    lightColors[4] = light5;
    lightColors[5] = light6;
    lightColors[6] = light7;
    lightColors[7] = light8;

    for (int j = 0; j < NUM_LIGHTS; j++) {
        float lightIndex = float(j);
        float phase = lightIndex * PI * 2.0 / float(NUM_LIGHTS);
        float swing = sin(iTime * 0.5 + phase) * 0.3;
        float tilt = cos(iTime * 0.7 + phase * 1.5) * 0.2;

        lights[j].pos = vec3(-3.5 + lightIndex * 1.0, 3.0 * lightHeight + 3.0, 10.0 * lightDepth - 10.0);
        lights[j].dir = normalize(vec3(swing, -0.8 + tilt, 1.0));
        lights[j].angle = 0.3 + 0.1 * sin(iTime + phase);

        // Flicker
        float flicker = 0.9 + 0.1 * sin(iTime * 20.0 + lightIndex * 7.0);
        lights[j].intensity = 2.0 * flicker;
        lights[j].color = lightColors[j];
    }
}

// Optimierte Spotlight-Berechnung
vec3 spotlightFast(vec3 pos, Light light, float fog) {
    vec3 toLight = light.pos - pos;
    float dist2 = dot(toLight, toLight);  // Quadrat statt length()
    vec3 lightVec = toLight * inversesqrt(dist2);
    
    float spotEffect = dot(lightVec, -light.dir);
    float spotCutoff = cos(light.angle);
    
    if (spotEffect < spotCutoff) return vec3(0.0);
    
    float edge = smoothstep(spotCutoff, 1.0, spotEffect);
    float dist = sqrt(dist2);
    float attenuation = 1.0 / (1.0 + 0.1 * dist + 0.01 * dist2);
    
    return light.color * (edge * attenuation * fog * light.intensity);
}

// Optimiertes Ray Marching
vec3 volumetricLighting(vec3 ro, vec3 rd, float maxDist, Light lights[NUM_LIGHTS]) {
    vec3 color = vec3(0.0);
    
    // Adaptive Schrittweite
    float stepSize = maxDist / float(MAX_STEPS);
    stepSize = max(stepSize, 0.15);  // Minimum 0.15
    
    float t = stepSize * 0.5;  // Start mit halber Schrittweite (besseres Sampling)
    
    for (int i = 0; i < MAX_STEPS; i++) {
        if (t >= maxDist) break;
        
        vec3 pos = ro + rd * t;
        
        // Fog nur einmal pro Schritt berechnen
        float fog = 0.1 + noise(pos * 0.5 + vec3(0.0, -iTime * 0.1, 0.0)) * 0.05;
        
        // Alle Lichter akkumulieren
        vec3 lightContrib = vec3(0.0);
        for (int j = 0; j < NUM_LIGHTS; j++) {
            lightContrib += spotlightFast(pos, lights[j], fog);
        }
        
        color += lightContrib;
        t += stepSize;
    }
    
    return color * stepSize;
}

float groundPlane(vec3 ro, vec3 rd) {
    return rd.y < 0.0 ? -ro.y / rd.y : -1.0;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    
    // Lichter einmal pro Pixel vorberechnen
    Light lights[NUM_LIGHTS];
    setupLights(lights);
    
    // Camera
    vec3 ro = vec3(0.0, 1.5, 5.0);
    vec3 forward = normalize(vec3(0.0, 1.0, 0.0) - ro);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), forward));
    vec3 up = cross(forward, right);
    vec3 rd = normalize(forward + uv.x * right + uv.y * up);
    
    // Background
    vec3 color = vec3(0.02, 0.02, 0.05) * (1.0 - uv.y * 0.5);
    
    // Ground
    float groundT = 0.0;
    if(showGround >= 0.5){
    groundT = groundPlane(ro, rd);
    if (groundT > 0.0) {
        vec3 groundPos = ro + rd * groundT;
        vec2 checker = floor(groundPos.xz * 2.0);
        float pattern = mod(checker.x + checker.y, 2.0);
        color = mix(color, mix(vec3(0.05), vec3(0.1), pattern), exp(-groundT * 0.1));
    }
    }
    // Volumetric lighting
    color += volumetricLighting(ro, rd, groundT > 0.0 ? groundT : 10.0, lights);
    
    // Tonemapping + Gamma + Vignette kombiniert
    color = pow(color / (1.0 + color), vec3(0.4545)) * (1.0 - dot(uv, uv) * 0.3);
    if(uv.y < 0.48 || uv.y > 0.52){
      fragColor = vec4(color, 1.0);
    } else {
      fragColor = vec4(0.0,0.0,0.0,1.0);
    }
    
} 