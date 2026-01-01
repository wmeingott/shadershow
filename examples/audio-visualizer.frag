// Audio Visualizer Example
// Load audio input to iChannel0: File > Use Audio Input (FFT) for Channel 0
//
// iChannel0 texture layout (512x2):
//   Row 0 (y=0.0): FFT frequency spectrum (0-255, bass on left, treble on right)
//   Row 1 (y=1.0): Waveform / time domain data (centered at 128)

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec3 col = vec3(0.0);

    // Get audio data
    float fft = texture(iChannel0, vec2(uv.x, 0.0)).r;      // Frequency spectrum
    float wave = texture(iChannel0, vec2(uv.x, 1.0)).r;     // Waveform

    // Frequency bars visualization (bottom half)
    if (uv.y < 0.5) {
        float barHeight = fft * 0.5;
        if (uv.y < barHeight) {
            // Color based on frequency (bass=red, mid=green, treble=blue)
            vec3 barColor = vec3(1.0 - uv.x, abs(uv.x - 0.5) * 2.0, uv.x);
            col = barColor * (1.0 - uv.y / barHeight * 0.5);
        }
    }

    // Waveform visualization (top half)
    if (uv.y >= 0.5) {
        float waveY = 0.75 + (wave - 0.5) * 0.4; // Center wave in top half
        float dist = abs(uv.y - waveY);
        float glow = 0.008 / (dist + 0.008);
        col += vec3(0.2, 0.8, 1.0) * glow;
    }

    // Add some bass-reactive background glow
    float bass = texture(iChannel0, vec2(0.05, 0.0)).r;
    col += vec3(0.1, 0.02, 0.15) * bass * 2.0;

    // Circular spectrum visualizer in center
    vec2 center = uv - 0.5;
    float angle = atan(center.y, center.x);
    float radius = length(center);
    float freqIndex = (angle + 3.14159) / 6.28318; // 0 to 1
    float freqValue = texture(iChannel0, vec2(freqIndex, 0.0)).r;

    float innerRadius = 0.1;
    float outerRadius = innerRadius + freqValue * 0.15;

    if (radius > innerRadius && radius < outerRadius) {
        float intensity = 1.0 - (radius - innerRadius) / (outerRadius - innerRadius);
        vec3 circleColor = 0.5 + 0.5 * cos(angle + iTime + vec3(0, 2, 4));
        col += circleColor * intensity * 0.5;
    }

    fragColor = vec4(col, 1.0);
}
