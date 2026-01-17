/*
 * ShaderShow - Available Uniforms
 * ================================
 * vec3  iResolution      - Viewport resolution (width, height, 1.0)
 * float iTime            - Playback time in seconds (affected by iSpeed)
 * float iTimeDelta       - Time since last frame in seconds
 * int   iFrame           - Current frame number
 * vec4  iMouse           - Mouse pixel coords (xy: current, zw: click)
 * vec4  iDate            - (year, month, day, time in seconds)
 *
 * sampler2D iChannel0-3  - Input textures (image, video, camera, audio, NDI)
 * vec3  iChannelResolution[4] - Resolution of each channel
 *
 * float iParams[5]       - Custom parameters P0-P4 (0.0-1.0, sliders)
 * vec3  iColorRGB[10]    - Custom colors C0-C9 (RGB, 0.0-1.0 each)
 * float iSpeed           - Speed multiplier for iTime
 */

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0, 2, 4));
    fragColor = vec4(col, 1.0);
}