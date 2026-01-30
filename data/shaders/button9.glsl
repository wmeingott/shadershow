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
 * Types: int, float, vec2, vec3, vec4, color
 */

/*
    "Artifacts" by @XorDev
    
    https://x.com/XorDev/status/2008361514684539306
*/
void mainImage( out vec4 O, vec2 I)
{
    //Iterator, raymarch depth and step distance
    float i, z, d;
    
    //Raymarch sample point
    vec3 p;
    
    //Clear fragColor and raymarch 77 steps
    for(O*=i; i++<77.;
        //Slowly step forward using the distance to a distorted z-plane
        z += d = abs(p.z/30.+.2),
        //Add color (attenuating with distance to surface)
        O += vec4(z,z,9,1) / d,
        //Compute the next sample point
        p = z * normalize(vec3(I+I,0) - iResolution.xyy),
        //Shift diagonally
        p.xy += iTime)
        
        //Use blocky "turbulence" for the distortion
        //https://mini.gmshaders.com/p/turbulence
        for(d=0.; d++<9.; p+=sin(round(p)+d*3.).zxy);
        
    //Tanh tonemapping
    //https://mini.gmshaders.com/p/func-tanh
    O = tanh(O/8e4);
}