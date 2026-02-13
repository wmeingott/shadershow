# Creating Three.js Scenes for ShaderShow

ShaderShow supports interactive Three.js scenes as an alternative to GLSL shaders. Scenes provide full 3D rendering with lights, materials, particles, and more — all controllable via the same parameter slider system used for shaders.

## Quick Start

A scene is a JavaScript file with three functions: `setup()`, `animate()`, and `cleanup()`.

```javascript
// @param rotationSpeed float 1.0 [0.1, 5.0] "How fast the cube spins"

function setup(THREE, canvas, params) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);

  const camera = new THREE.PerspectiveCamera(60, canvas.width / canvas.height, 0.1, 100);
  camera.position.set(0, 2, 5);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(canvas.width, canvas.height, false);

  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x4488ff })
  );
  scene.add(cube);

  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(5, 5, 5);
  scene.add(light);

  return { scene, camera, renderer, cube };
}

function animate(time, delta, params, objects) {
  objects.cube.rotation.y += delta * params.rotationSpeed;
  objects.cube.rotation.x += delta * params.rotationSpeed * 0.5;
}

function cleanup(objects) {
  objects.cube.geometry.dispose();
  objects.cube.material.dispose();
}
```

Save as `.jsx` or `.scene.js`, or paste directly into the editor and switch to Scene mode.

## File Types

| Extension | Format | Notes |
|-----------|--------|-------|
| `.jsx` | JSX/React syntax | Auto-compiled with Babel |
| `.scene.js` | Plain JavaScript | Direct execution |
| *(editor)* | Plain JavaScript | Auto-detected if code contains `function setup` and `THREE` or `scene` |

## The Three Functions

### `setup(THREE, canvas, params, channels, mouse)`

Called once when the scene loads. Creates the scene, camera, and all objects.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `THREE` | object | The Three.js library (`window.THREE`) |
| `canvas` | HTMLCanvasElement | The WebGL canvas to render to |
| `params` | object | Current custom parameter values |
| `channels` | THREE.Texture[] | Array of 4 channel textures (iChannel0-3) |
| `mouse` | object | Mouse state: `{ x, y, clickX, clickY, isDown }` |

**Return value:** An object containing at minimum `scene` and `camera`:

```javascript
return {
  scene,      // Required: THREE.Scene
  camera,     // Required: THREE.Camera
  renderer,   // Optional: THREE.WebGLRenderer (one is created for you if omitted)
  // Any other properties become the `objects` parameter in animate()
  cube,
  particles,
  lights: [light1, light2]
};
```

If you return a custom `renderer`, ShaderShow takes ownership of it. If you omit it, the default renderer is used automatically.

**Tip:** Anything you return from `setup()` (beyond `scene`, `camera`, `renderer`) is accessible in `animate()` via the `objects` parameter. You can also use a nested `objects` key:

```javascript
return {
  scene, camera, renderer,
  objects: { cube, lights, state: { angle: 0 } }
};
```

### `animate(time, delta, params, objects, mouse, channels)`

Called every frame. Update your scene here — move objects, change colors, respond to parameters.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `time` | number | Elapsed time in seconds (affected by speed slider) |
| `delta` | number | Seconds since last frame (affected by speed slider) |
| `params` | object | Current parameter values (custom + built-in) |
| `objects` | object | State returned from `setup()` |
| `mouse` | object | Mouse state: `{ x, y, clickX, clickY, isDown }` |
| `channels` | THREE.Texture[] | Array of 4 channel textures |

**Alternative signature** — if your first parameter is named `objects`, `context`, `ctx`, or `sceneObjects`, the order is auto-detected:

```javascript
// Also valid — detected automatically
function animate(objects, time, delta, params, mouse, channels) { ... }
```

You don't need to call `renderer.render()` — ShaderShow handles that after your `animate()` returns.

### `cleanup(objects)`

Called when the scene is replaced or unloaded. Dispose of GPU resources here.

```javascript
function cleanup(objects) {
  if (objects.cube) {
    objects.cube.geometry.dispose();
    objects.cube.material.dispose();
  }
}
```

ShaderShow also traverses the scene and disposes of remaining geometries/materials automatically, but explicit cleanup is good practice for textures and complex resources.

## Custom Parameters

Define parameters with `@param` comments at the top of the file. These create slider controls in the UI.

### Syntax

```
// @param name type default [min, max] "description"
```

### Supported Types

| Type | Default range | Example |
|------|---------------|---------|
| `int` | 0-10 | `// @param count int 5 [1, 20] "Number of objects"` |
| `float` | 0.0-1.0 | `// @param speed float 0.5 [0.0, 3.0] "Animation speed"` |
| `color` | [1,1,1] | `// @param tint color [1.0, 0.5, 0.0] "Object color"` |
| `vec2` | [0,0] | `// @param offset vec2 [0.0, 0.0] [-1, 1] "Position offset"` |
| `vec3` | [0,0,0] | `// @param pos vec3 [0, 1, 0] [-5, 5] "Position"` |
| `vec4` | [0,0,0,0] | `// @param rect vec4 [0, 0, 1, 1] [0, 1] "Bounds"` |

Arrays are also supported: `float[3]`, `color[10]`, `vec2[4]`, etc.

### Accessing Parameters

```javascript
function animate(time, delta, params, objects) {
  const speed = params.speed;         // Custom float parameter
  const color = params.tint;          // Custom color: [r, g, b] in 0-1 range
  const count = params.count;         // Custom int parameter
}
```

### Built-in Parameters

These are always available in `params`:

| Name | Type | Description |
|------|------|-------------|
| `speed` | float | Playback speed multiplier (from speed slider, default 1.0) |
| `bpm` | float | Beat detection value from audio channel (0-1 normalized) |

## Channels (Input Textures)

Scenes can use the 4 input channels (iChannel0-3) as Three.js textures. Channels can hold images, video, webcam, audio FFT, or NDI sources.

```javascript
function setup(THREE, canvas, params, channels) {
  // channels[0] through channels[3] are THREE.Texture objects (or null)
  const texturedMaterial = new THREE.MeshBasicMaterial({ map: channels[0] });

  // ...
  return { scene, camera, renderer, texturedMaterial };
}

function animate(time, delta, params, objects, mouse, channels) {
  // Channel textures update automatically each frame (video, camera, etc.)
  // If you need to react to texture changes:
  if (channels[0]) {
    objects.texturedMaterial.map = channels[0];
    objects.texturedMaterial.needsUpdate = true;
  }
}
```

## Mouse Input

The `mouse` object tracks cursor position and clicks on the preview canvas.

```javascript
function animate(time, delta, params, objects, mouse) {
  if (mouse.isDown) {
    // Drag interaction
    const nx = mouse.x / canvas.width;   // Normalized 0-1
    const ny = mouse.y / canvas.height;  // 0 = bottom, 1 = top
  }
}
```

| Property | Type | Description |
|----------|------|-------------|
| `x` | number | Current X position (0 = left edge) |
| `y` | number | Current Y position (0 = bottom edge) |
| `clickX` | number | X position of last mouse-down |
| `clickY` | number | Y position of last mouse-down |
| `isDown` | boolean | `true` while mouse button is held |

## Helper Functions

You can define any number of helper functions alongside the three main functions. They are available throughout the scene:

```javascript
// @param numLights int 6 [1, 12] "Number of lights"

function createLight(THREE, color, position) {
  const light = new THREE.PointLight(color, 1, 10);
  light.position.set(...position);
  return light;
}

function setup(THREE, canvas, params) {
  const scene = new THREE.Scene();
  // ...

  const lights = [];
  for (let i = 0; i < params.numLights; i++) {
    const light = createLight(THREE, 0xffffff, [i * 2, 3, 0]);
    scene.add(light);
    lights.push(light);
  }

  return { scene, camera, renderer, lights };
}
```

## Best Practices

### Always set `preserveDrawingBuffer: true`

Required for NDI output, Syphon, and screen capture to work:

```javascript
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true
});
renderer.setSize(canvas.width, canvas.height, false);
```

### Use delta time for animation

Frame-rate-independent animation ensures consistent speed across different machines:

```javascript
// Good: frame-rate independent
objects.cube.rotation.y += delta * params.speed * 2;

// Bad: tied to frame rate
objects.cube.rotation.y += 0.01;
```

### Use `time` for periodic motion

The `time` parameter gives smooth, continuous time suitable for sine waves and oscillation:

```javascript
objects.light.position.x = Math.sin(time * 2.0) * 5;
objects.light.intensity = (Math.sin(time * 4.0) + 1) * 0.5;
```

### Dispose resources in cleanup

Prevent GPU memory leaks by disposing geometries, materials, and textures:

```javascript
function cleanup(objects) {
  objects.particles.geometry.dispose();
  objects.particles.material.dispose();
  if (objects.texture) objects.texture.dispose();
}
```

### Handle optional parameters with defaults

```javascript
function animate(time, delta, params, objects) {
  const speed = params.speed || 1.0;
  const opacity = params.hazeOpacity ?? 0.4;  // ?? preserves 0 as valid
}
```

### Store mutable state in objects

The `objects` parameter persists across frames. Use it for accumulators, angles, and state that evolves over time:

```javascript
function setup(THREE, canvas, params) {
  // ...
  return {
    scene, camera, renderer,
    objects: { cameraAngle: 0, particles: [], spawnTimer: 0 }
  };
}

function animate(time, delta, params, objects) {
  objects.cameraAngle += delta * params.rotateSpeed;
  objects.spawnTimer += delta;
}
```

## Error Handling

Runtime errors in `animate()` are caught and reported to the status bar (throttled to every 2 seconds to avoid flooding). Errors in `setup()` prevent the scene from loading and show a compilation error.

Listen for scene errors programmatically:

```javascript
window.addEventListener('scene-runtime-error', (e) => {
  console.error('Scene error:', e.detail.message, 'in', e.detail.source);
  // source: 'setup', 'animate', or 'cleanup'
});
```

## Complete Example: Animated Particle Field

```javascript
// Particle Field - Floating particles with color cycling
//
// @param particleCount float 0.5 [0.1, 1.0] "Particle density"
// @param driftSpeed float 0.3 [0.0, 2.0] "Drift speed"
// @param particleSize float 0.08 [0.01, 0.3] "Particle size"
// @param baseColor color [0.2, 0.5, 1.0] "Base color"

function setup(THREE, canvas, params) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050510);

  const camera = new THREE.PerspectiveCamera(70, canvas.width / canvas.height, 0.1, 100);
  camera.position.z = 20;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(canvas.width, canvas.height, false);

  // Create particles
  const count = Math.floor(2000 * params.particleCount);
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    positions[i * 3]     = (Math.random() - 0.5) * 40;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 40;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 40;
    velocities[i * 3]     = (Math.random() - 0.5) * 0.02;
    velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.02;
    velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.02;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    size: params.particleSize,
    color: new THREE.Color(...params.baseColor),
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });

  const particles = new THREE.Points(geometry, material);
  scene.add(particles);

  return { scene, camera, renderer, objects: { particles, velocities, count } };
}

function animate(time, delta, params, objects) {
  const { particles, velocities, count } = objects;
  const positions = particles.geometry.attributes.position.array;

  // Update particle positions
  for (let i = 0; i < count; i++) {
    positions[i * 3]     += velocities[i * 3] * params.driftSpeed;
    positions[i * 3 + 1] += velocities[i * 3 + 1] * params.driftSpeed;
    positions[i * 3 + 2] += velocities[i * 3 + 2] * params.driftSpeed;

    // Wrap around
    for (let j = 0; j < 3; j++) {
      if (positions[i * 3 + j] > 20) positions[i * 3 + j] = -20;
      if (positions[i * 3 + j] < -20) positions[i * 3 + j] = 20;
    }
  }
  particles.geometry.attributes.position.needsUpdate = true;

  // Color cycling
  const hue = (time * 0.05) % 1;
  const base = params.baseColor;
  particles.material.color.setRGB(
    base[0] * (0.5 + 0.5 * Math.sin(time)),
    base[1] * (0.5 + 0.5 * Math.sin(time + 2)),
    base[2] * (0.5 + 0.5 * Math.sin(time + 4))
  );
  particles.material.size = params.particleSize;

  // Gentle camera rotation
  particles.rotation.y = time * 0.05;
}

function cleanup(objects) {
  objects.particles.geometry.dispose();
  objects.particles.material.dispose();
}
```
