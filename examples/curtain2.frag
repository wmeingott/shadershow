/*
 * ShaderShow - Available Uniforms
 * ================================
 * vec3  iResolution      - Viewport resolution (width, height, 1.0)
 * float iTime            - Playback time in seconds
 * float iTimeDelta       - Time since last frame in seconds
 * int   iFrame           - Current frame number
 * vec4  iMouse           - Mouse pixel coords (xy: current, zw: click)
 * vec4  iDate            - (year, month, day, time in seconds)
 *
 * sampler2D iChannel0-3  - Input textures (image, video, camera, audio, NDI)
 * vec3  iChannelResolution[4] - Resolution of each channel
 *
 * Custom Parameters (@param)
 * --------------------------
 * Define custom uniforms with UI controls using @param comments:
 *   // @param name type [default] [min, max] "description"
 *
 * Supported types: int, float, vec2, vec3, vec4, color
 *
 * Examples:
 *   // @param speed float 1.0 [0.0, 2.0] "Animation speed"
 *   // @param center vec2 0.5, 0.5 "Center position"
 *   // @param tint color [1.0, 0.5, 0.0] "Tint color"
 */
 
// @param velvet color [0.04, 0.02, 0.06] 
// @param lights color[6] [[1.0, 0.85, 0.5],[0.3, 0.5, 1.0],[1.0, 0.2, 0.6],[0.1, 0.8, 0.7],[1.0, 0.6, 0.2],[0.4, 0.3, 1.0]] 
// @param fabric_params float[3] [0.3,0.3,0.5] [[0.0,2.0],[0.0,2.0],[0.0,2.0]}
// @param fabric_size vec2 [0.5, 0.5]

// --- Noise helpers ---
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = rot * p * 2.0;
    a *= 0.5;
  }
  return v;
}

// --- Fabric texture ---
float fabric(vec2 uv) {
  // Vertical threads (warp)
  float warp = sin(uv.x * 600.0 * fabric_size.x) * 0.5 + 0.5;
  warp = pow(warp, fabric_params[0]);
  // Horizontal threads (weft)
  float weft = sin(uv.y * 500.0 * fabric_size.y) * 0.5 + 0.5;
  weft = pow(weft, fabric_params[1]);
  // Combine as weave
  float weave = mix(warp, weft, fabric_params[2]);
  // Add fine grain
  weave *= 0.85 + 0.15 * noise(uv * 800.0);
  return weave;
}

// --- Fabric folds (draping) ---
float folds(vec2 uv) {
  float f = 0.0;
  // Large vertical drapes
  f += sin(uv.x * 6.2831 * 3.0 + 0.3 * sin(uv.y * 4.0)) * 0.35;
  f += sin(uv.x * 6.2831 * 7.0 - 0.15 * sin(uv.y * 6.0)) * 0.15;
  f += sin(uv.x * 6.2831 * 13.0) * 0.06;
  // Slight horizontal sag
  f += sin(uv.y * 6.2831 * 1.5 + 0.5) * 0.08;
  // Organic variation
  f += fbm(uv * 5.0) * 0.2 - 0.1;
  return f;
}

// --- Spotlight cone ---
vec3 spotlight(vec2 uv, vec2 origin, vec2 target, vec3 color, float width, float softness, float intensity) {
  // Direction from origin to target
  vec2 dir = normalize(target - origin);
  vec2 toP = uv - origin;
  
  // Project point onto beam axis
  float along = dot(toP, dir);
  if (along < 0.0) return vec3(0.0);
  
  // Perpendicular distance
  vec2 perp = toP - along * dir;
  float perpDist = length(perp);
  
  // Cone widens with distance
  float coneRadius = width * along;
  float edge = smoothstep(coneRadius, coneRadius * (1.0 - softness), perpDist);
  
  // Distance attenuation
  float dist = length(toP);
  float atten = 1.0 / (1.0 + 0.8 * dist * dist);
  
  // Atmospheric scattering in beam
  float scatter = exp(-perpDist * perpDist / (coneRadius * coneRadius * 0.5)) * 0.15;
  
  return color * (edge * atten * intensity + scatter * atten * intensity * 0.5);
}

// --- Dust particles ---
float particles(vec2 uv, float t) {
  float p = 0.0;
  for (int i = 0; i < 30; i++) {
    float fi = float(i);
    vec2 pos = vec2(
      hash(vec2(fi, 0.0)),
      fract(hash(vec2(fi, 1.0)) - t * (0.02 + 0.01 * hash(vec2(fi, 2.0))))
    );
    pos.x += sin(t * 0.5 + fi) * 0.03;
    float d = length(uv - pos);
    float size = 0.0008 + 0.0005 * hash(vec2(fi, 3.0));
    p += smoothstep(size, 0.0, d) * (0.3 + 0.7 * hash(vec2(fi, 4.0)));
  }
  return p;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord ){
  vec2 uv = fragCoord.xy / iResolution.xy;
  float aspect = iResolution.x / iResolution.y;
  vec2 uvA = vec2(uv.x * aspect, uv.y);
  
  float t = iTime;
  
  // --- Backdrop base color (deep velvet) ---
  vec3 velvet = velvet; // Very dark purple-black
  
  // --- Fabric surface ---
  float foldVal = folds(uv);
  float fabricTex = fabric(uv);
  
  // Fabric shading from folds — creates 3D drape look
  float foldShade = 0.7 + 0.3 * foldVal;
  foldShade *= fabricTex;
  
  // Normal from folds for lighting
  float dx = folds(uv + vec2(0.002, 0.0)) - folds(uv - vec2(0.002, 0.0));
  float dy = folds(uv + vec2(0.0, 0.002)) - folds(uv - vec2(0.0, 0.002));
  vec3 normal = normalize(vec3(-dx * 3.0, -dy * 3.0, 1.0));
  
  vec3 col = velvet * foldShade;
  
  // --- Stage lights ---
  // Light origins are above the stage (top of frame)
  // Targets hit the backdrop
  
  // Warm amber center spot
  float sway1 = sin(t * 0.3) * 0.03;
  vec3 light1 = spotlight(
    uvA, 
    vec2(aspect * 0.5 + sway1, 1.35),
    vec2(aspect * 0.5, 0.3),
    lights[0],
    0.55, 0.6, 2.2
  );
  
  // Cool blue from left
  float sway2 = sin(t * 0.25 + 1.0) * 0.04;
  vec3 light2 = spotlight(
    uvA,
    vec2(-0.15 + sway2, 1.3),
    vec2(aspect * 0.35, 0.2),
    lights[1],
    0.5, 0.65, 1.8
  );
  
  // Magenta from right
  float sway3 = sin(t * 0.2 + 2.5) * 0.04;
  vec3 light3 = spotlight(
    uvA,
    vec2(aspect + 0.15 + sway3, 1.3),
    vec2(aspect * 0.65, 0.2),
    lights[2],
    0.5, 0.65, 1.8
  );
  
  // Teal back-wash from below
  vec3 light4 = spotlight(
    uvA,
    vec2(aspect * 0.5, -0.3),
    vec2(aspect * 0.5, 0.5),
    lights[4],
    0.8, 0.7, 0.6
  );
  
  // Side warm fill left
  vec3 light5 = spotlight(
    uvA,
    vec2(-0.2, 0.5),
    vec2(aspect * 0.3, 0.5),
    lights[4],
    0.4, 0.7, 0.7
  );
  
  // Side cool fill right
  vec3 light6 = spotlight(
    uvA,
    vec2(aspect + 0.2, 0.5),
    vec2(aspect * 0.7, 0.5),
    lights[5],
    0.4, 0.7, 0.7
  );
  
  // Combine lights
  vec3 totalLight = light1 + light2 + light3 + light4 + light5 + light6;
  
  // Apply fabric normal to lighting (gives texture depth)
  float nDot = dot(normal, normalize(vec3(0.0, 0.3, 1.0)));
  float fabricLight = 0.7 + 0.3 * nDot;
  
  // Velvet sheen — highlights at grazing angles
  float sheen = pow(1.0 - abs(nDot), 3.0) * 0.15;
  
  col += totalLight * foldShade * fabricLight;
  col += totalLight * sheen;
  
  // --- Atmospheric haze in light beams ---
  float haze = 0.0;
  haze += length(light1) * 0.08;
  haze += length(light2) * 0.06;
  haze += length(light3) * 0.06;
  vec3 hazeColor = (light1 + light2 + light3) * 0.04;
  col += hazeColor;
  
  // --- Dust particles catching light ---
  float dust = particles(uv, t);
  vec3 dustLit = dust * (light1 + light2 + light3) * 1.5;
  col += dustLit;
  
  // --- Vignette ---
  float vig = 1.0 - 0.4 * pow(length(uv - 0.5) * 1.3, 2.0);
  col *= vig;
  
  // --- Subtle film grain ---
  float grain = (hash(uv * iResolution.xy + fract(t * 100.0)) - 0.5) * 0.03;
  col += grain;
  
  // Tone mapping
  col = col / (1.0 + col); // Reinhard
  col = pow(col, vec3(0.92)); // Slight gamma lift
  
  fragColor = vec4(col, 1.0);
}