// Colorful flames effect
// Custom params: // @param name type [default] [min, max] "description"
// @texture iChannel0 RGBANoise
// @param lights color[16] [[0.9, 0.4, 0.1],[0.9,0.7,0.3],[0.2, 0.6, 0.7],[0.6,0.8,0.9],[0.9, 0.3, 0.0],[0.9,0.3,0.0],[0.2, 0.3, 0.8],[0.9,0.6,0.9],[0.9, 0.4, 0.6],[0.9,0.7,0.3],[0.2, 0.6, 0.0],[0.6,0.8,0.9],[0.9, 0.4, 0.7],[0.1,0.8,0.5],[0.2, 0.3, 0.3],[0.9,0.6,0.9]]
// @param fspeed vec2 [0.03,0.1] "Flamme 8"
// @param size vec2 [0.4,0.1]  "Flamme 8"
// @param pos vec2 [0.4,0.1] [[-5.0,5.0],[-1.0,1.0]]  "Flamme 8"

#define R iResolution.xy
#define S smoothstep
#define T texture

vec3 flame (vec2 u, float s, vec3 c1, vec3 c2) {
    float y = S(-.6,.6,u.y);
    u += T(iChannel0, u*.02 + vec2(s - iTime*fspeed[0]*0.2, s - iTime*fspeed[1]*.5)).r * y * vec2(0.7, 0.2);
    float f = S(.1, 0., length(u) - size[0]);
    f *= S(0., 1., length(u + vec2(0., .35)));
    return f*mix(c1,c2,y);
}

void mainImage( out vec4 O, in vec2 I )
{
    vec2 u = (I-.5*R)/R.y*vec2(10.,1.3);
    
    vec3 C = vec3(.0,.0,.0);
    
    int i = 0;
    for(i = 0; i < 8 ; i++){
      C +=flame(pos + u+vec2(float(i) * size[1] * 2.0,0.0),.1 * float(i),lights[i*2],lights[i*2+1]);
    }
    
    O = vec4(C+C,1.0);
}