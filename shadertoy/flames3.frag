// Colorful flames effect
// Custom params: // @param name type [default] [min, max] "description"
// @texture iChannel0 RGBANoise
// @param light1 color[2] [[0.9, 0.4, 0.1],[0.9,0.7,0.3]] "Flamme 1"
// @param light2 color[2] [[0.2, 0.6, 0.7],[0.6,0.8,0.9]] "Flamme 2"
// @param light3 color[2] [[0.9, 0.3, 0.0],[0.9,0.3,0.0]] "Flamme 3"
// @param light4 color[2] [[0.2, 0.3, 0.8],[0.9,0.6,0.9]] "Flamme 4"
// @param light5 color[2] [[0.9, 0.4, 0.6],[0.9,0.7,0.3]] "Flamme 5"
// @param light6 color[2] [[0.2, 0.6, 0.0],[0.6,0.8,0.9]] "Flamme 6"
// @param light7 color[2] [[0.9, 0.4, 0.7],[0.1,0.8,0.5]] "Flamme 7"
// @param light8 color[2] [[0.2, 0.3, 0.3],[0.9,0.6,0.9]] "Flamme 8"

#define R iResolution.xy
#define S smoothstep
#define T texture

vec3 flame (vec2 u, float s, vec3 c1, vec3 c2) {
    float y = S(-.6,.6,u.y);
    u += T(iChannel0, u*.02 + vec2(s - iTime*.03, s - iTime*.1)).r * y * vec2(0.7, 0.2);
    float f = S(.1, 0., length(u) - .4);
    f *= S(0., 1., length(u + vec2(0., .35)));
    return f*mix(c1,c2,y);
}

void mainImage( out vec4 O, in vec2 I )
{
    vec2 u = (I-.5*R)/R.y*vec2(10.,1.3);
    
    vec3 f1 = flame(u+vec2( 7.5,0.0),.1,light1[0],light1[1]);
    vec3 f2 = flame(u+vec2( 6.,0.),.2,light2[0],light2[1]);
    vec3 f3 = flame(u+vec2( 4.5,0.),.3,light3[0],light3[1]);
    vec3 f4 = flame(u+vec2( 3.,0.),.4,light4[0],light4[1]);
    vec3 f5 = flame(u+vec2( 1.5,0.),.5,light5[0],light5[1]);
    vec3 f6 = flame(u+vec2( 0.,0.),.6,light6[0],light6[1]);
    vec3 f7 = flame(u+vec2( -1.5,0.),.7,light7[0],light7[1]);
    vec3 f8 = flame(u+vec2(-3.,0.),.8,light8[0],light8[1]);

    vec3 C = f1+f2+f3+f4+f5+f6+f7+f8;
    O = vec4(C+C,1.0);
}