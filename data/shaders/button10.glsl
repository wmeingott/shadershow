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

// genuary: Lights on/off. Make something that changes when you switch on or off the “digital” lights.

// flight path, given z, get xy
#define P(z) vec3(cos((z)*.01)*164.,cos((z)*.012)*164., z)

// MENGERLAYER
#define m(f, h)\
    s /= (f), \
    p = abs(fract(q/s)*s - s*.5), \
 	d = min(d, min(max(p.x, p.y), \
               min(max(p.y, p.z), \
               max(p.x, p.z))) - s/(h))

void mainImage(out vec4 o, vec2 u) {
   
    float i, T = iTime,d,s = 1.275,
          j = (.05*dot(fract(sin(.7*T+u)), sin(u))),
          f;
    vec3  c,r = iResolution;
    mat2 rot = mat2(cos(cos(T*.06)*4.+vec4(0,33,11,0)));
    
    // scale coords
    u = (u+u - r.xy) / r.y;

    // cinema bars
    if (abs(u.y) > .75) { o = vec4(0); return; }
    
    // look around
    u += vec2( sin(iTime)*.5, sin(iTime*.5)*.5 );
    
    // on-off frequency, changes color, too
    f = (1.+tanh(cos(sin(T*T)*.05+T*.3)*3.)*13.);
    
    // set up ray origin, dir, look-at
    vec3  q,p = P(T*32.),
          Z = normalize( P(T*32.+4.) - p),
          X = normalize(vec3(Z.z,0,-Z)),
          D = vec3(rot*u, 1) * mat3(-X, cross(X, Z), Z);
 
    for(;i++ < 64.;
        // add grayscale color and foggy border
        c += s + .4*dot(u,u) - f/s
    )
        // raymarch position
        q = p += j + D * s,
        // can play with initial dist (d) and scale (s)
        d=9e9,s=2e2,

        // apply some menger layers
        m(1., 3.),
        m(2., 4.),
        m(9., 4.),
        p += cos(p.yzx) * 1e1,
        // -1 to 1 + min(gyroid, menger);
        s = .02+.5*abs(sin(p.z*.2)+min(dot(sin(q/236.), cos(q.yzx/166.))*5., d)),
        // restore p (m() macro modifies it)
        p = q;
    
    
    // tanh tone map, colorize, divide brightness
    o.rgb = tanh(vec3(f,2,3)*c/1e4);

}