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
 //  @texture iChannel0 AudioFFT(1024)
 //  @param background color [0.05, 0.02, 0.1] "Tint color"
 //  @param rays float 8 [1,32] "Anzahl Lichter"
 //  @param angles vec2 1.5,0.4 [0.0,5.0]
 //  @param origin vec2 0.0,0.8
 //  @param offset vec2 0.5,2.5 [0.0,5.0]
 //  @param rayColor color [0.0,0.2,0.4]
 //  @param rayTime float 1.0 [0.0,1.0]
 //  @param rayChange vec3 0.5,0.5,1.2 [0.0,3.0]
 //  @param raySmooth vec2 0.15,0.6 [0.0,2.0]
 //  @param rayAttn float 0.5 [-1.0,1.0]
 //  @param starSpeed float 1.0 [0.0,10.0]
 //  @param starDepth float 40 [0.0,500]
 //  @param starWeight float 0.1 [0.0,1.0]
 //  @param starSize float 0.5 [0.0,2.0]
 //  @param starColor color [1.0,0.9,0.7]
 //  @param starFade float 3.0 [0.0,10.0]
 //  @param audio vec3 [0.0,0.0,0.0] [-2.0,2.0]

// Disco Stage Shader 
// Reproduktion: Lichtkegel, Partikel und Tanzfläche

float hash12(vec2 p) {
	vec3 p3  = fract(vec3(p.xyx) * .1031);
    p3 += dot(p3, p3.yzx + 33.33 + iTime * 0.00001 * starSpeed);
    return fract((p3.x + p3.y) * p3.z);
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = fragCoord/iResolution.xy;
    vec2 p = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    
    // Zeit-Variablen für Animation
    float t = iTime * 0.5;

    // 1. HINTERGRUND & FARBVERLAUF
    vec3 col = background; // Dunkles Violett/Blau
    
    // 2. LICHTKEGEL (Spotlights)
    float numRays = rays;
    for(float i = 0.0; i < numRays; i++) {
        // Schwenkbewegung
        float angle = sin(t + i * angles.x) * angles.y;
        float xOffset = (i / numRays - offset.x) * offset.y;
        
        // Strahlengeometrie
        vec2 rayOrigin = vec2(xOffset, origin.y);
        vec2 rayDir = vec2(sin(angle), -cos(angle));
        
        // Distanz zum Strahl berechnen
        vec2 v = p - rayOrigin;
        float dist = length(v - rayDir * max(0.0, dot(v, rayDir)));
        
        // Regenbogenfarben basierend auf dem Index
        vec3 rayCol = rayChange.x + rayChange.y * cos(rayColor * 10.0 + i * rayChange.z + t * rayTime);
          rayCol *= 1.0 + audio.x * (iBassLevel - 0.5) ;
          rayCol *= 1.0 + (iMidLevel - 0.5) * audio.y;
          rayCol *= 1.0 + (iHighLevel - 0.5) * audio.z ;
        
        // Intensität des Strahls (nach unten hin auffächernd)
        float beam = smoothstep(raySmooth.x, 0.0, dist);
        beam *= pow(1.0 - uv.y, rayAttn); // Abschwächung nach unten


        col += rayCol * beam * raySmooth.y;
    }

    // 3. GLITZERPARTIKEL (Stars)
    vec2 gv = uv * starDepth;
    vec2 id = floor(gv);
    float n = hash12(id);
    if(n > 0.92) {
        float size = sin(t * starFade + n * 10.0) * 0.5 + starSize;
        float star = smoothstep(starWeight * size, 0.0, length(fract(gv) - 0.5));
        col += star * starColor * n;
    }

    // 4. TANZFLÄCHE (Boden)
    /*
    if(uv.y < 0.25) {
        // Perspektivische Verzerrung für den Boden
        float floorUV = (uv.y / 0.25); 
        float perspective = (p.x / floorUV);
        
        // Boden-Gitter (Dielen-Optik)
        float stripes = smoothstep(0.02, 0.03, abs(sin(perspective * 15.0)));
        vec3 floorCol = col * 0.8 + 0.1; // Reflexion des Lichts
        
        // Lichtflecken auf dem Boden
        float spots = smoothstep(0.4, 0.0, length(vec2(p.x, uv.y - 0.1)));
        floorCol += spots * vec3(1.0, 0.8, 0.5) * 0.3;
        
        col = mix(floorCol * stripes, col, pow(floorUV, 0.5));
    }
    */
    // Post-Processing: Kontrast und Vignette
    col *= 1.2;
    col -= length(uv - 0.5) * 0.2; // Vignette

    fragColor = vec4(col, 1.0);
}