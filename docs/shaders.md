# ShaderShow Shader Reference

ShaderShow renders GLSL fragment shaders using the Shadertoy convention. Shaders define a
`mainImage(out vec4 fragColor, in vec2 fragCoord)` function. Configuration is done through
comment directives (`@param`, `@texture`, `@const`, `@structure`, `@option`).

Three.js scenes (`.scene.js` / `.jsx`) use the same `@param` directives and are documented
in the [Scenes](#threejs-scenes) section.

---

## Built-in Uniforms

These uniforms are available in every shader without any directives:

| Uniform | Type | Description |
|---------|------|-------------|
| `iResolution` | `vec3` | Viewport size `(width, height, 1.0)` |
| `iTime` | `float` | Playback time in seconds |
| `iTimeDelta` | `float` | Time since last frame in seconds |
| `iFrame` | `int` | Current frame number |
| `iMouse` | `vec4` | Mouse pixel coords — `xy`: current position, `zw`: last click position |
| `iDate` | `vec4` | `(year, month, day, timeInSeconds)` |
| `iChannel0`–`iChannel3` | `sampler2D` | Input textures (see [Channels](#channels)) |
| `iChannelResolution` | `vec3[4]` | Resolution of each channel texture |
| `iBPM` | `float` | Detected beats per minute (requires audio channel) |
| `iBassLevel` | `float` | Low-frequency audio level 0–1 (requires audio channel) |
| `iMidLevel` | `float` | Mid-frequency audio level 0–1 (requires audio channel) |
| `iHighLevel` | `float` | High-frequency audio level 0–1 (requires audio channel) |
| `tile_cols` | `float` | Number of tile columns (1.0 when not tiling) |
| `tile_rows` | `float` | Number of tile rows (1.0 when not tiling) |

---

## Channels

Each of the 4 input channels (`iChannel0`–`iChannel3`) can hold one of these source types:

- **Empty** — no texture bound
- **Image** — static image file
- **Video** — video file, updated each frame
- **Camera** — webcam feed, updated each frame
- **Audio FFT** — frequency spectrum from audio input (see `@texture` below)
- **NDI** — network video via NDI protocol
- **Shader** — output of another shader function or file (see `@texture shader(...)`)

Channels can be assigned interactively through the UI or declaratively via `@texture` directives.

---

## Directives

Directives are written in comments (`//` or `/* */` blocks). They configure parameters,
textures, constants, and rendering options.

### Comment Styles

```glsl
// @param speed float 1.0 [0.0, 5.0] "Speed"

/* @param speed float 1.0 [0.0, 5.0] "Speed" */

/*
 * @param speed float 1.0 [0.0, 5.0] "Speed"
 */
```

### Line Continuation

Long directives can be split across multiple comment lines:

```glsl
// Single-line continuation (> at end):
// @param myArray float[3] >
// [0.1, 0.2, 0.3] [[0.0, 1.0]] "My array"

// Multi-line block (>> to open, << to close):
// @structure Light >>
//   @param pos vec3 [0.0, 0.0, 0.0] [-10.0, 10.0]
//   @param color color [1.0, 1.0, 1.0]
//   @param intensity float 1.0 [0.0, 5.0]
// <<
```

---

## @param — Custom Parameters

Declares a uniform with an auto-generated UI slider or color picker in the parameter panel.

### Syntax

```
@param <name> <type>[<arraySize>] [default] [range] [bind:...] ["description"]
```

### Supported Types

| Type | GLSL Type | UI Control | Default |
|------|-----------|------------|---------|
| `int` | `int` | Slider (integer steps) | `0` |
| `float` | `float` | Slider | `0.5` |
| `vec2` | `vec2` | 2 sliders (x, y) | `0.5, 0.5` |
| `vec3` | `vec3` | 3 sliders (x, y, z) | `1.0, 1.0, 1.0` |
| `vec4` | `vec4` | 4 sliders (x, y, z, w) | `0.0, 0.0, 0.0, 1.0` |
| `color` | `vec3` | Color picker + RGB sliders | `1.0, 1.0, 1.0` |

### Scalar Parameters

```glsl
// Minimal — uses type defaults
// @param speed float

// With default value
// @param speed float 1.0

// With default and range
// @param speed float 1.0 [0.0, 5.0]

// With description
// @param speed float 1.0 [0.0, 5.0] "Animation speed"
```

### Vector Parameters

```glsl
// vec2 with bracket default
// @param center vec2 [0.5, 0.5]

// vec3 with range (applies to all components)
// @param scale vec3 [1.0, 1.0, 1.0] [0.0, 5.0]
```

### Color Parameters

```glsl
// RGB float values
// @param tint color [1.0, 0.5, 0.0] "Tint color"

// Hex color (#RRGGBB)
// @param tint color #FF8800 "Tint color"
```

### Array Parameters

Declare arrays by appending `[N]` to the type:

```glsl
// Float array with uniform defaults
// @param weights float[4] 0.5 [0.0, 1.0] "Weights"

// Float array with per-element defaults
// @param weights float[3] [0.1, 0.2, 0.3] [0.0, 1.0]

// Float array with per-element ranges
// @param levels float[3] [0.3, 0.5, 0.7] [[0.0, 1.0], [0.0, 2.0], [0.0, 3.0]]

// Vec3 array with per-element defaults
// @param points vec3[2] [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]] [-1.0, 1.0]

// Color array
// @param palette color[3] [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
```

Array defaults are **cycled** when fewer values are given than the array size. For example,
`float[6] [0.1, 0.2, 0.3]` produces `[0.1, 0.2, 0.3, 0.1, 0.2, 0.3]`.

### Binding Parameters to Built-in Variables

The `bind:` modifier connects a built-in uniform to a parameter for real-time automation
(e.g. sound-reactive visuals). The bound value is computed each frame and drives the
parameter automatically.

**Syntax:**
```
bind:<source>[,factor=F][,offset=O][,range=[low,high]][,mode=replace|add][,smooth=S][,toggle[=on|off]]
```

**Formula:** `result = (source + offset) * factor`

| Option | Default | Description |
|--------|---------|-------------|
| `factor=F` | `1.0` | Scale factor applied after offset |
| `offset=O` | `0.0` | Offset added to source before scaling |
| `range=[low,high]` | — | Sugar for mapping source 0–1 to output low–high (computes factor/offset) |
| `mode=replace` | `replace` | Bound value replaces slider value |
| `mode=add` | — | Bound value is added to slider value (slider sets base) |
| `smooth=S` | `0` | Smoothing 0.0–1.0 (exponential moving average; higher = smoother) |
| `toggle` | — | Show toggle button, starts **off** |
| `toggle=on` | — | Show toggle button, starts **on** |
| `toggle=off` | — | Show toggle button, starts **off** |
| *(omitted)* | — | Binding always active, no toggle button shown |

**Bindable sources:**

| Source | Range | Description |
|--------|-------|-------------|
| `iBassLevel` | 0–1 | Low-frequency audio level |
| `iMidLevel` | 0–1 | Mid-frequency audio level |
| `iHighLevel` | 0–1 | High-frequency audio level |
| `iBPM` | ~60–200 | Detected BPM (raw value) |
| `iTime` | 0–∞ | Shader playback time in seconds |

**Examples:**

```glsl
// Bass level directly controls luminance (toggle on by default)
// @param lum float 0.5 [0.0, 1.0] bind:iBassLevel,factor=1.5,offset=-0.5,toggle=on "Luminance"

// Bass adds to base slider value (good for "pulse on beat" effects)
// @param pulse float 0.3 [0.0, 1.0] bind:iBassLevel,mode=add,factor=0.4,smooth=0.5,toggle=off "Bass pulse"

// Map mid level 0–1 to output range 0.2–0.8
// @param mid float 0.5 [0.0, 1.0] bind:iMidLevel,range=[0.2,0.8],toggle=on "Mid range"

// Always-on binding (no toggle button)
// @param sat float 0.7 [0.0, 1.0] bind:iHighLevel,smooth=0.7 "Saturation"

// Time-based sweep
// @param sweep float 0.0 [0.0, 1.0] bind:iTime,factor=0.05,toggle=off "Time sweep"
```

**UI behavior:**
- **Replace mode**: When active, the slider is dimmed and the bound value is shown
- **Add mode**: The slider remains interactive (sets the base), and the bound value is added on top
- **Toggle button**: A small "B" button appears next to the parameter; click to enable/disable
- Output is always clamped to the parameter's `[min, max]` range

---

## @texture — Channel Textures

Assigns a texture source to an input channel. Applied when the shader is compiled.

### Syntax

```
@texture iChannel<N> <source>
```

Where `<N>` is 0–3 and `<source>` is one of the following:

### Built-in Noise Textures

```glsl
// @texture iChannel0 RGBANoise        // 256x256 RGBA noise
// @texture iChannel0 RGBANoiseBig     // 1024x1024 RGBA noise
// @texture iChannel0 RGBANoiseSmall   // 64x64 RGBA noise
// @texture iChannel0 GrayNoise        // 256x256 grayscale noise
// @texture iChannel0 GrayNoiseBig     // 1024x1024 grayscale noise
// @texture iChannel0 GrayNoiseSmall   // 64x64 grayscale noise
```

### Audio FFT

```glsl
// Default FFT size (1024)
// @texture iChannel0 AudioFFT

// Custom FFT size (64, 128, 256, 512, 1024, 2048, 4096)
// @texture iChannel0 AudioFFT(2048)

// Legacy alias for 2048
// @texture iChannel0 AudioFFTBig
```

The audio FFT texture is a single-row image where each pixel's red channel contains the
frequency magnitude. Use `texture(iChannel0, vec2(freq, 0.5)).r` to sample.

When an audio channel is active, `iBPM`, `iBassLevel`, `iMidLevel`, and `iHighLevel`
uniforms are updated each frame.

### File Textures

Load an image file from the `data/media/` directory:

```glsl
// @texture iChannel1 texture:my-image
```

The file name (without extension) must match a file in `data/media/`. Supported formats
depend on the browser (PNG, JPG, WebP, etc.).

### Shader Textures

Use the output of another shader as a texture input. The shader runs in its own offscreen
framebuffer and the result is bound to the channel.

```glsl
// Inline function (must be defined in the same file):
// @texture iChannel1 shader(myTexGen, 512, 512, true)

// External file:
// @texture iChannel1 shader(file:effects/warp.frag, 0.5, 0.5, false)
```

**Parameters:** `shader(<source>, <width>, <height>, <dynamic>)`

| Parameter | Description |
|-----------|-------------|
| `source` | Function name (inline) or `file:path` (relative to shader directory) |
| `width` | Resolution width: `0.0–1.0` = fraction of main resolution, `>1.0` = absolute pixels |
| `height` | Resolution height: same rules as width |
| `dynamic` | `true` = re-render every frame, `false` = render only when params change |

The texture shader function has the same signature as `mainImage`:

```glsl
void myTexGen(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    fragColor = vec4(uv, 0.5, 1.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec4 tex = texture(iChannel1, fragCoord / iResolution.xy);
    fragColor = tex;
}
```

---

## @const — Compile-time Constants

Defines integer constants that are substituted into `@param` directives and emitted as
`#define` directives in the compiled shader. Useful for array sizes that need to be both
a GLSL constant and a parameter array dimension.

### Syntax

```
@const <NAME> <integer>
```

The name must start with a capital letter or underscore and contain only uppercase letters,
digits, and underscores.

### Example

```glsl
// @const NUM_LIGHTS 3
// @param brightness float[NUM_LIGHTS] 0.5 [0.0, 1.0] "Light brightness"

// In the compiled shader, NUM_LIGHTS is available as a #define:
for (int i = 0; i < NUM_LIGHTS; i++) {
    color += computeLight(i, brightness[i]);
}
```

The `[NUM_LIGHTS]` in the `@param` line is replaced with `[3]` before parsing.

---

## @structure — Struct Parameters

Defines a named struct type whose fields become grouped parameter controls. Struct params
can be arrays, giving you repeating groups of related controls (e.g. multiple lights).

### Syntax

```
@structure <TypeName> @param <field1> ... @param <field2> ...
```

Each `@param` inside the structure defines a field using the same syntax as regular `@param`
(except binding is not supported on struct fields).

### Example

```glsl
// @const NUM_LIGHTS 3

// Define the struct type (uses > or >> continuation):
// @structure Light >>
//   @param pos vec3 [0.0, 5.0, 0.0] [-10.0, 10.0]
//   @param color color [1.0, 1.0, 1.0]
//   @param intensity float 1.0 [0.0, 5.0] "Brightness"
// <<

// Declare a uniform using the struct type:
// @param lights Light[NUM_LIGHTS]

// With per-element defaults:
// @param lights Light[2] [[0,5,0, 1,0,0, 1.0], [0,3,2, 0,1,0, 0.8]]
```

This generates GLSL:
```glsl
struct Light {
  vec3 pos;
  vec3 color;
  float intensity;
};
uniform Light lights[3];
```

In the UI, each array element gets its own collapsible section with controls for all fields.
Access in GLSL: `lights[0].pos`, `lights[1].color`, `lights[2].intensity`.

---

## @option — Rendering Options

### 2.5D Relief Effect

Adds a parallax depth effect based on luminance, giving flat shaders a raised/embossed look.

```glsl
// @option 2.5d 30%
```

The percentage controls the depth strength (higher = more pronounced relief). The effect
modifies how the shader is rendered — no code changes needed in `mainImage`.

---

## Three.js Scenes

Three.js scene files (`.scene.js` or `.jsx`) support `@param` directives for custom
parameters with the same syntax as GLSL shaders.

### Scene API

A scene file exports two main functions:

```javascript
// @param rotationSpeed float 1.0 [0.0, 5.0] "Rotation speed"
// @param color color [0.2, 0.6, 1.0] "Object color"

function setup(THREE, canvas, params) {
    // THREE   — Three.js library object
    // canvas  — the rendering canvas element
    // params  — object with current parameter values

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, canvas.width / canvas.height, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });

    // ... create objects ...

    return { scene, camera, renderer, /* custom objects */ };
}

function animate(time, deltaTime, params, objects, mouse, channels) {
    // time      — playback time in seconds
    // deltaTime — time since last frame
    // params    — current parameter values (includes bpm, bassLevel, midLevel, highLevel)
    // objects   — the return value from setup()
    // mouse     — { x, y, buttons } normalized mouse state
    // channels  — array of THREE.Texture objects for iChannel0–3
}
```

The `params` object in `animate()` includes audio analysis values alongside custom
parameters:
- `params.bpm` — detected BPM
- `params.bassLevel` — low-frequency level (0–1)
- `params.midLevel` — mid-frequency level (0–1)
- `params.highLevel` — high-frequency level (0–1)

### Legacy Signature

An older calling convention is also supported (auto-detected):

```javascript
function animate(objects, time, deltaTime, params, mouse, channels) { ... }
```

---

## Minimal Shader Template

```glsl
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0, 2, 4));
    fragColor = vec4(col, 1.0);
}
```

## Complete Example

```glsl
// @texture iChannel0 AudioFFT
// @const NUM_RINGS 5

// @param brightness float 0.8 [0.0, 1.0] bind:iBassLevel,factor=0.5,mode=add,smooth=0.3,toggle=on "Brightness"
// @param tint color #4488FF "Tint color"
// @param ringSize float[NUM_RINGS] [0.1, 0.2, 0.3, 0.4, 0.5] [0.01, 1.0] "Ring sizes"
// @param speed float 1.0 [0.0, 5.0] "Animation speed"

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / iResolution.y;
    float d = length(uv);

    vec3 col = vec3(0.0);
    for (int i = 0; i < NUM_RINGS; i++) {
        float ring = abs(d - ringSize[i]);
        ring = smoothstep(0.02, 0.0, ring);
        col += tint * ring;
    }

    col *= brightness;
    fragColor = vec4(col, 1.0);
}
```
