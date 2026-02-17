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
 /*
    @structure light_t >
      @param position vec3 > 
      @param direction vec3 >
      @param c color #000000  >
      @param angle float 0.9 [-1.0,1.0] 
 
    @param light_param light_t[5] [ >
      [[-5.0,6.0,2.0],[1.0,-1.5,0.0],[0.1,0.3,1.0],0.92], >
      [[-2.0,6.5,3.0],[0.4,-1.8,0.0],[1.0, 0.1, 0.8],0.94], >
      [[0.5,7.0,2.5],[0.0,-2.0,0.0],[0.2, 0.4, 1.0],0.95], >
      [[3.0,6.5,3.0],[-0.3,-1.7,0.0],[0.1,0.3,1.0],0.93], >
      [[6.0,6.0,2.0],[-1.0,-1.4,0.0],[0.1,0.3,1.0],0.92] >
    ] 

 */
 
 
// Autor: Gemini (nach Vorlage des Benutzerbildes)
// Lizenz: MIT

// --- Einstellungen ---
#define NUM_LIGHTS 5
#define MAX_DIST 50.0
#define FOG_DENSITY 0.08
#define LIGHT_INTENSITY 3.5

// --- Noise Funktionen (für Nebel und Bodenstruktur) ---

// Einfacher Hash für Pseudo-Zufall
float hash(float n) {
    return fract(sin(n) * 43758.5453123);
}

// 3D Noise Funktion (Value Noise)
float noise(vec3 x) {
    vec3 p = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float n = p.x + p.y * 57.0 + 113.0 * p.z;
    float res = mix(mix(mix(hash(n + 0.0), hash(n + 1.0), f.x),
                        mix(hash(n + 57.0), hash(n + 58.0), f.x), f.y),
                    mix(mix(hash(n + 113.0), hash(n + 114.0), f.x),
                        mix(hash(n + 170.0), hash(n + 171.0), f.x), f.y), f.z);
    return res;
}

// Fractal Brownian Motion (für detaillierteren Nebel/Boden)
float fbm(vec3 p) {
    float f = 0.0;
    f += 0.5000 * noise(p); p *= 2.02;
    f += 0.2500 * noise(p); p *= 2.03;
    f += 0.1250 * noise(p); p *= 2.01;
    return f;
}

// --- Lichtdefinitionen ---
struct Light {
    vec3 pos;
    vec3 dir;
    vec3 color;
    float angle; // Kosinus des halben Öffnungswinkels
};

Light lights[NUM_LIGHTS];

void setupLights() {
    // Lichtpositionen und Farben ähnlich dem Bild
    // Links: Blau
    for(int i = 0; i < NUM_LIGHTS; i++){
            lights[i] = Light(light_param[i].position, normalize(light_param[i].direction), light_param[i].c, light_param[i].angle);
    }
    /*
    lights[0] = Light(vec3(-5.0, 6.0, 2.0), normalize(vec3(1.0, -1.5, 0.0)), vec3(0.1, 0.3, 1.0), 0.92);
    // Mitte-Links: Pink/Magenta
    lights[1] = Light(vec3(-2.0, 6.5, 3.0), normalize(vec3(0.4, -1.8, 0.0)), vec3(1.0, 0.1, 0.8), 0.94);
    // Mitte: Blau
    lights[2] = Light(vec3(0.5, 7.0, 2.5), normalize(vec3(0.0, -2.0, 0.0)), vec3(0.2, 0.4, 1.0), 0.95);
    // Mitte-Rechts: Pink
    lights[3] = Light(vec3(3.0, 6.5, 3.0), normalize(vec3(-0.3, -1.7, 0.0)), vec3(0.9, 0.2, 0.9), 0.93);
    // Rechts: Pink/Violett
    lights[4] = Light(vec3(6.0, 6.0, 2.0), normalize(vec3(-1.0, -1.4, 0.0)), vec3(0.8, 0.1, 1.0), 0.92);
    */
}

// --- Volumetrisches Licht ---

// Berechnet den Beitrag eines einzelnen Scheinwerfers an einem Punkt im Raum
vec3 getSpotlightContrib(vec3 p, Light l) {
    vec3 lightToPoint = p - l.pos;
    float dist = length(lightToPoint);
    vec3 dir = lightToPoint / dist;

    // Prüfen, ob der Punkt im Lichtkegel liegt
    float cosAngle = dot(dir, l.dir);
    float spotEffect = smoothstep(l.angle, l.angle + 0.05,  cosAngle) * (cosAngle);

    // Distanzabfall
    float attenuation = 1.0 / (1.0 + dist * 0.1 + dist * dist * 0.02);

    // Nebel-Struktur (Noise)
    float fogNoise = fbm(p * 0.5 + vec3(0.0, iTime * 0.2, 0.0)); // Bewegender Nebel
    fogNoise = mix(0.5, 1.0, fogNoise);

    return l.color * spotEffect * attenuation * fogNoise * LIGHT_INTENSITY;
}

// Raymarching für volumetrischen Nebel
vec3 traceFog(vec3 ro, vec3 rd, float maxT) {
    vec3 fogColor = vec3(0.0);
    float t = 0.0;
    // Wenige Schritte für Performance, mit Dithering für Glätte
    int numSteps = 40;
    float stepSize = maxT / float(numSteps);

    // Dithering des Startpunkts, um Banding zu vermeiden
    t += hash(dot(rd.xy, vec2(12.9898, 78.233)) + iTime) * stepSize;

    for (int i = 0; i < numSteps; ++i) {
        if (t > maxT) break;
        vec3 p = ro + rd * t;

        vec3 currentStepLight = vec3(0.0);
        for (int j = 0; j < NUM_LIGHTS; ++j) {
            currentStepLight += getSpotlightContrib(p, lights[j]);
        }

        // Lichtquelle direkt sichtbar machen (Lens Flare Fake)
        for (int j = 0; j < NUM_LIGHTS; ++j) {
            vec3 toLight = lights[j].pos - ro;
            float dToLight = length(toLight);
            float proj = dot(normalize(toLight), rd);
            // Wenn wir fast direkt in das Licht schauen
            if(proj > 0.99 && t > dToLight - stepSize && t < dToLight + stepSize) {
                 currentStepLight += lights[j].color * 50.0 * pow(proj, 256.0) / (dToLight*dToLight);
            }
        }

        fogColor += currentStepLight * FOG_DENSITY * stepSize;
        t += stepSize;
    }
    return fogColor;
}


// --- Boden und Szene ---

// Bodenhöhe
const float floorHeight = -1.5;

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    setupLights();

    // UV-Koordinaten normalisieren (-1 bis 1, aspect corrected)
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    // Kamera Setup
    vec3 ro = vec3(0.0, 1.0, -6.0); // Kameraposition
    vec3 ta = vec3(0.0, 1.0, 0.0);  // Zielpunkt
    vec3 fwd = normalize(ta - ro);
    vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, fwd);
    vec3 rd = normalize(fwd + uv.x * right + uv.y * up); // Strahlrichtung

    vec3 finalColor = vec3(0.0);

    // --- Bodenschnittpunkt ---
    float tFloor = (floorHeight - ro.y) / rd.y;

    if (tFloor > 0.0 && tFloor < MAX_DIST) {
        // Wir treffen den Boden
        vec3 floorPos = ro + rd * tFloor;

        // Bodenstruktur (Bump Map für Reflexionen)
        // Wir verzerren die Position, die für die Reflexion genutzt wird
        vec3 distortedPos = floorPos;
        distortedPos.x += fbm(floorPos * 2.0) * 0.2;
        distortedPos.z += fbm(floorPos * 1.5 + vec3(0.0, 0.0, 1.0)) * 0.3;

        // Basis-Bodenfarbe (dunkel)
        vec3 floorBaseColor = vec3(0.02);

        // Direkte Beleuchtung auf dem Boden (Lichtflecken)
        vec3 floorLight = vec3(0.0);
        for(int i=0; i<NUM_LIGHTS; ++i) {
             // Einfacher Abstandsbasierten Lichtfleck auf dem Boden
             vec3 lightDirToFloor = normalize(floorPos - lights[i].pos);
             float spot = smoothstep(lights[i].angle-0.05, lights[i].angle+0.05, dot(lightDirToFloor, lights[i].dir));
             float dist = length(lights[i].pos - floorPos);
             float atten = 1.0 / (1.0 + dist*0.5 + dist*dist*0.1);
             floorLight += lights[i].color * spot * atten * 2.0;
        }
        floorBaseColor += floorLight;

        // Reflexion berechnen
        vec3 normal = vec3(0.0, 1.0, 0.0);
        // Normalen-Störung für welligen Effekt
        float bump = fbm(distortedPos*3.0);
        normal = normalize(normal + vec3(dFdx(bump), 0.0, dFdy(bump)) * 0.2);

        vec3 reflectDir = reflect(rd, normal);

        // Volumetrisches Licht des reflektierten Strahls berechnen
        vec3 reflectedSky = traceFog(floorPos, reflectDir, MAX_DIST - tFloor);

        // Fresnel-Effekt (Reflexion ist stärker bei flachem Winkel)
        float fresnel = pow(1.0 - max(0.0, dot(-rd, normal)), 4.0);
        fresnel = mix(0.2, 0.9, fresnel); // Basis-Reflexivität + Fresnel

        finalColor = mix(floorBaseColor, reflectedSky, fresnel);

    } else {
        // Wir treffen den "Himmel" / Hintergrund
        finalColor = traceFog(ro, rd, MAX_DIST);
        // Sehr dunkler Hintergrundverlauf
        finalColor += vec3(0.01, 0.01, 0.02) * (1.0 - uv.y);
    }

    // --- Post-Processing ---
    // Vignette
    vec2 q = fragCoord.xy / iResolution.xy;
    finalColor *= 0.5 + 0.5*pow( 16.0*q.x*q.y*(1.0-q.x)*(1.0-q.y), 0.25 );

    // Tone Mapping (Reinhard) und Gamma-Korrektur
    finalColor = finalColor / (1.0 + finalColor);
    finalColor = pow(finalColor, vec3(1.0 / 2.2));

    fragColor = vec4(finalColor, 1.0);
}