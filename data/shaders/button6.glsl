// Colorful flames effect
// Custom params: // @param name type [default] [min, max] "description"

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
    
    vec3 f1 = flame(u+vec2( 7.5,0.2),.1,vec3(.9,.4,.1),vec3(.9,.7,.3));
    vec3 f2 = flame(u+vec2( 6.,0.),.2,vec3(.2,.6,.7),vec3(.6,.8,.9));
    vec3 f3 = flame(u+vec2( 4.5,0.),.3,vec3(.9,.0,.0),vec3(.9,.3,.0));
    vec3 f4 = flame(u+vec2( 3.,0.),.4,vec3(.2,.3,.8),vec3(.9,.6,.9));
    vec3 f5 = flame(u+vec2( 1.5,0.),.5,vec3(.9,.4,.6),vec3(.9,.7,.3));
    vec3 f6 = flame(u+vec2( 0.,0.),.6,vec3(.2,.6,.7),vec3(.6,.8,.9));
    vec3 f7 = flame(u+vec2( -1.5,0.),.7,vec3(.9,.4,.3),vec3(1.,.8,.5));
    vec3 f8 = flame(u+vec2(-3.,0.),.8,vec3(.2,.3,.8),vec3(.9,.6,.9));

    vec3 C = f1+f2+f3+f4+f5+f6+f7+f8;
    O = vec4(C+C,1.0);
}