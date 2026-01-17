# ShaderShow Performance Analysis

This document identifies performance bottlenecks in the ShaderShow codebase and provides recommendations for optimization.

---

## Table of Contents

1. [Rendering Loop Issues](#1-rendering-loop-issues)
2. [State Management & Excessive Re-renders](#2-state-management--excessive-re-renders)
3. [IPC Communication Overhead](#3-ipc-communication-overhead)
4. [File I/O Bottlenecks](#4-file-io-bottlenecks)
5. [DOM Manipulation & Layout Thrashing](#5-dom-manipulation--layout-thrashing)
6. [Memory Management & Resource Leaks](#6-memory-management--resource-leaks)
7. [NDI/Syphon Frame Conversion Inefficiency](#7-ndisyphon-frame-conversion-inefficiency)
8. [Event Listener Mismanagement](#8-event-listener-mismanagement)
9. [Grid Animation Inefficiency](#9-grid-animation-inefficiency)
10. [Preset & Parameter Sync Inefficiency](#10-preset--parameter-sync-inefficiency)
11. [Editor Debouncing Issues](#11-editor-debouncing-issues)
12. [Menu Rebuilding Overhead](#12-menu-rebuilding-overhead)
13. [Summary & Priority Matrix](#13-summary--priority-matrix)

---

## 1. Rendering Loop Issues

### Problem: Excessive Uniform Array Allocations Per Frame

**File:** `js/shader-renderer.js` (Lines 655-668)

The render method creates new `Float32Array` objects every single frame for color and parameter arrays:

```javascript
// Created EVERY frame
const colorArray = new Float32Array(30); // 10 colors * 3 components
for (let i = 0; i < 10; i++) {
  colorArray[i * 3] = this.params[`r${i}`];
  colorArray[i * 3 + 1] = this.params[`g${i}`];
  colorArray[i * 3 + 2] = this.params[`b${i}`];
}

const paramsArray = new Float32Array(5);
for (let i = 0; i < 5; i++) {
  paramsArray[i] = this.params[`p${i}`];
}
```

**Impact:** At 60 FPS, this creates 3,600+ temporary arrays per minute, causing garbage collection pressure and frame drops.

### Recommendation

Pre-allocate typed arrays once during initialization:

```javascript
class ShaderRenderer {
  constructor() {
    // Pre-allocate reusable buffers
    this._colorArray = new Float32Array(30);
    this._paramsArray = new Float32Array(5);
  }

  render() {
    // Reuse pre-allocated arrays
    for (let i = 0; i < 10; i++) {
      this._colorArray[i * 3] = this.params[`r${i}`];
      this._colorArray[i * 3 + 1] = this.params[`g${i}`];
      this._colorArray[i * 3 + 2] = this.params[`b${i}`];
    }
    gl.uniform3fv(loc, this._colorArray);
  }
}
```

---

### Problem: Inefficient Frame Rate Limiting

**File:** `js/renderer.js` (Lines 63-68)

Frame rate checks happen after `requestAnimationFrame` is already called:

```javascript
if (currentTime - lastPreviewFrameTime < state.previewFrameInterval) {
  return;  // Still consumes a RAF slot
}
```

**Impact:** Wasted CPU cycles on RAF callbacks that do nothing.

### Recommendation

Use a smarter frame scheduling approach:

```javascript
let scheduledFrame = null;

function scheduleNextFrame() {
  if (scheduledFrame) return;
  scheduledFrame = requestAnimationFrame((time) => {
    scheduledFrame = null;
    render(time);
    scheduleNextFrame();
  });
}

// Or use setTimeout for specific frame rates
function renderLoop() {
  render();
  setTimeout(renderLoop, 1000 / targetFPS);
}
```

---

## 2. State Management & Excessive Re-renders

### Problem: Unthrottled Mousemove Listener

**File:** `js/params.js` (Lines 272-277)

```javascript
canvasContainer.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect(); // DOM query every move
  state.mousePosition.x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  state.mousePosition.y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
  updateMouseControlledParams(); // Called on EVERY pixel moved
});
```

**Impact:** Can trigger 100+ times/second during fast mouse movement, calling `getBoundingClientRect()` (forces layout recalc) and updating parameters excessively.

### Recommendation

Throttle mousemove and cache DOM measurements:

```javascript
let cachedRect = null;
let rectCacheTime = 0;
const RECT_CACHE_TTL = 100; // ms

function getCachedRect(canvas) {
  const now = performance.now();
  if (!cachedRect || now - rectCacheTime > RECT_CACHE_TTL) {
    cachedRect = canvas.getBoundingClientRect();
    rectCacheTime = now;
  }
  return cachedRect;
}

// Throttle to ~60fps max
let lastMouseUpdate = 0;
canvasContainer.addEventListener('mousemove', (e) => {
  const now = performance.now();
  if (now - lastMouseUpdate < 16) return; // Skip if < 16ms since last update
  lastMouseUpdate = now;

  const rect = getCachedRect(canvas);
  state.mousePosition.x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  state.mousePosition.y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
  updateMouseControlledParams();
});

// Invalidate cache on resize
window.addEventListener('resize', () => { cachedRect = null; });
```

---

### Problem: Mouse-Controlled Parameter Saves on Every Movement

**File:** `js/params.js` (Lines 298-316)

When mouse is assigned to parameters P0-P4, every mousemove triggers:

```javascript
state.gridSlots[state.activeGridSlot].params[param] = value;
saveGridState(); // Called on EVERY mousemove!
```

**Impact:** Synchronous IPC and file I/O on every mouse movement.

### Recommendation

Debounce grid state saves and batch parameter updates:

```javascript
let saveGridStateTimeout = null;

function debouncedSaveGridState() {
  if (saveGridStateTimeout) clearTimeout(saveGridStateTimeout);
  saveGridStateTimeout = setTimeout(() => {
    saveGridState();
    saveGridStateTimeout = null;
  }, 500); // Save at most every 500ms
}
```

---

## 3. IPC Communication Overhead

### Problem: Excessive Parameter Sync IPC Calls

**File:** `js/params.js` (Lines 57, 71, 129, 154, 181, 205, 254, 310)

Every slider input and mousemove triggers IPC:

```javascript
window.electronAPI.sendParamUpdate({ name, value });
```

**Impact:** Can send 1000+ IPC messages per second during rapid parameter changes or mouse drag operations.

### Recommendation

Batch and throttle IPC calls:

```javascript
const pendingParamUpdates = new Map();
let paramUpdateScheduled = false;

function sendParamUpdate(name, value) {
  pendingParamUpdates.set(name, value);

  if (!paramUpdateScheduled) {
    paramUpdateScheduled = true;
    requestAnimationFrame(() => {
      if (pendingParamUpdates.size > 0) {
        window.electronAPI.sendParamUpdates(Object.fromEntries(pendingParamUpdates));
        pendingParamUpdates.clear();
      }
      paramUpdateScheduled = false;
    });
  }
}

// In main process, handle batch updates:
ipcMain.on('param-updates-batch', (event, updates) => {
  for (const [name, value] of Object.entries(updates)) {
    // Apply each param
  }
});
```

---

## 4. File I/O Bottlenecks

### Problem: Synchronous File Operations

**File:** `main.js` (Lines 932-938)

```javascript
ipcMain.on('save-content', (event, content) => {
  if (currentFilePath) {
    try {
      fs.writeFileSync(currentFilePath, content, 'utf-8'); // BLOCKING!
    } catch (err) {
      // ...
    }
  }
});
```

**Impact:** Blocks the main process during file writes, causing UI freezes.

### Recommendation

Use async file operations and write queuing:

```javascript
const { promises: fsPromises } = require('fs');

// Async file write with error handling
ipcMain.handle('save-content', async (event, content) => {
  if (currentFilePath) {
    try {
      await fsPromises.writeFile(currentFilePath, content, 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  return { success: false, error: 'No file path' };
});

// Optional: Write queue to prevent concurrent writes
const writeQueue = new Map();

async function queuedWrite(filePath, content) {
  const existing = writeQueue.get(filePath);
  if (existing) {
    existing.content = content; // Update pending content
    return existing.promise;
  }

  const entry = { content, promise: null };
  entry.promise = (async () => {
    await new Promise(r => setTimeout(r, 100)); // Batch writes
    const finalContent = entry.content;
    writeQueue.delete(filePath);
    await fsPromises.writeFile(filePath, finalContent, 'utf-8');
  })();

  writeQueue.set(filePath, entry);
  return entry.promise;
}
```

---

### Problem: Repeated JSON Parse/Stringify

**File:** `main.js` (Lines 1092, 1102, 1126, 1150)

Large grid state (32 shaders with params) requires parsing/stringifying frequently:

```javascript
fs.writeFileSync(gridStateFile, JSON.stringify(metadata, null, 2));
const metadata = JSON.parse(data);
```

### Recommendation

Cache parsed state and use incremental updates:

```javascript
let cachedGridState = null;
let gridStateDirty = false;

function updateGridSlot(slotIndex, params) {
  if (!cachedGridState) {
    cachedGridState = loadGridState();
  }
  cachedGridState.slots[slotIndex] = params;
  gridStateDirty = true;
}

// Periodic flush
setInterval(() => {
  if (gridStateDirty && cachedGridState) {
    fs.writeFile(gridStateFile, JSON.stringify(cachedGridState, null, 2), () => {});
    gridStateDirty = false;
  }
}, 5000);

// Or use a more efficient format like MessagePack for large state
```

---

## 5. DOM Manipulation & Layout Thrashing

### Problem: Repeated DOM Queries in Preset Sync

**File:** `js/ipc.js` (Lines 190-205)

```javascript
document.querySelectorAll('.preset-btn.local-preset').forEach((btn, i) => {
  btn.classList.toggle('active', i === data.index);
});
document.querySelectorAll('.preset-btn.global-preset').forEach(btn => {
  btn.classList.remove('active');
});
```

**Impact:** Multiple DOM queries with iteration for each sync event.

### Recommendation

Cache DOM element references:

```javascript
// Cache on initialization
const presetButtons = {
  local: Array.from(document.querySelectorAll('.preset-btn.local-preset')),
  global: Array.from(document.querySelectorAll('.preset-btn.global-preset'))
};

// Use cached references
function syncPresetState(data) {
  presetButtons.local.forEach((btn, i) => {
    btn.classList.toggle('active', i === data.index);
  });
  presetButtons.global.forEach(btn => {
    btn.classList.remove('active');
  });
}
```

---

### Problem: Excessive DOM Queries in Grid Operations

**File:** `js/shader-grid.js` (Lines 305-306, 464-471)

```javascript
const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
const canvas = slot.querySelector('canvas');
```

**Impact:** Called 32 times for grid operations.

### Recommendation

Cache grid slot elements:

```javascript
const gridSlotElements = new Map();

function getGridSlot(slotIndex) {
  if (!gridSlotElements.has(slotIndex)) {
    const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
    gridSlotElements.set(slotIndex, {
      slot,
      canvas: slot?.querySelector('canvas'),
      overlay: slot?.querySelector('.slot-overlay')
    });
  }
  return gridSlotElements.get(slotIndex);
}
```

---

## 6. Memory Management & Resource Leaks

### Problem: Texture Buffer Creation Every Frame

**File:** `js/shader-renderer.js` (Lines 421-460)

```javascript
// updateVideoTextures() called every render frame (60fps)
if (this.channelAudioSources[i]) {
  const audio = this.channelAudioSources[i];
  const combinedData = new Uint8Array(512 * 2); // NEW allocation every frame
  combinedData.set(audio.frequencyData, 0);
  combinedData.set(audio.timeDomainData, 512);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 512, 2, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, combinedData);
}
```

**Impact:** At 60 FPS with audio enabled = 3,600 allocations/minute.

### Recommendation

Pre-allocate audio data buffer:

```javascript
class ShaderRenderer {
  constructor() {
    this._audioBuffer = new Uint8Array(512 * 2);
  }

  updateVideoTextures() {
    if (this.channelAudioSources[i]) {
      const audio = this.channelAudioSources[i];
      this._audioBuffer.set(audio.frequencyData, 0);
      this._audioBuffer.set(audio.timeDomainData, 512);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 512, 2, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, this._audioBuffer);
    }
  }
}
```

---

## 7. NDI/Syphon Frame Conversion Inefficiency

### Problem: Per-Frame Pixel Flipping

**File:** `js/ndi.js` (Lines 36-40)

```javascript
const rowSize = width * 4;
for (let y = 0; y < height; y++) {
  const srcRow = (height - 1 - y) * rowSize;
  const dstRow = y * rowSize;
  flippedBuffer.set(pixelBuffer.subarray(srcRow, srcRow + rowSize), dstRow);
}
```

**Impact:** O(pixels) per frame. For 1920x1080 @ 60fps = massive CPU cost.

### Recommendation

Option 1: Flip in shader (zero CPU cost):

```glsl
// In output shader, flip Y coordinate
vec2 uv = gl_FragCoord.xy / iResolution.xy;
uv.y = 1.0 - uv.y; // Flip
vec4 color = texture(iChannel0, uv);
```

Option 2: Use WebGL's `pixelStorei` with pre-flipped rendering:

```javascript
// Render to framebuffer upside-down
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
```

Option 3: Use Web Workers for parallel flipping:

```javascript
// worker.js
self.onmessage = function(e) {
  const { buffer, width, height } = e.data;
  const flipped = new Uint8Array(buffer.length);
  const rowSize = width * 4;
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * rowSize;
    flipped.set(new Uint8Array(buffer.buffer, srcRow, rowSize), y * rowSize);
  }
  self.postMessage({ flipped }, [flipped.buffer]);
};
```

---

### Problem: Base64 Encoding of Entire Frame

**File:** `js/ndi.js` (Lines 57-66)

```javascript
function uint8ArrayToBase64(bytes) {
  let binary = '';
  const len = bytes.length; // 1920*1080*4 = 8.3MB
  for (let i = 0; i < len; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, end);
    binary += String.fromCharCode.apply(null, chunk); // String concatenation!
  }
  return btoa(binary);
}
```

**Impact:** 8.3MB → base64 (11MB) per frame @ 15fps = 165 MB/s data processing.

### Recommendation

Use SharedArrayBuffer for zero-copy IPC (requires proper headers):

```javascript
// In renderer
const sharedBuffer = new SharedArrayBuffer(width * height * 4);
const pixelView = new Uint8Array(sharedBuffer);

gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixelView);

// Send reference, not copy
ipcRenderer.send('ndi-frame', {
  sharedBuffer, // Reference only
  width,
  height
});

// In main process
ipcMain.on('ndi-frame', (event, { sharedBuffer, width, height }) => {
  const pixels = new Uint8Array(sharedBuffer);
  // Use directly without copy
});
```

Or use Node's native Buffer transfer:

```javascript
// Renderer
const buffer = Buffer.from(pixelData.buffer);
ipcRenderer.send('ndi-frame-buffer', buffer, width, height);

// Main (using Electron's buffer serialization)
ipcMain.on('ndi-frame-buffer', (event, buffer, width, height) => {
  // buffer is already a Node Buffer
});
```

---

## 8. Event Listener Mismanagement

### Problem: Unthrottled Document-Level Mousemove

**File:** `js/controls.js` (Lines 117-150)

```javascript
document.addEventListener('mousemove', (e) => {
  if (!activeResizer) return;
  const containerWidth = document.getElementById('main-content').offsetWidth; // DOM read
  const newWidth = (e.clientX / containerWidth) * 100;
  // ... more DOM operations
});
```

**Impact:** Fires 100+ times/second during resize, with DOM reads/writes every time.

### Recommendation

Use requestAnimationFrame for resize updates:

```javascript
let pendingResize = null;

document.addEventListener('mousemove', (e) => {
  if (!activeResizer) return;

  // Store latest position, don't process yet
  pendingResize = e.clientX;

  if (!resizeRAFId) {
    resizeRAFId = requestAnimationFrame(processResize);
  }
});

function processResize() {
  resizeRAFId = null;
  if (pendingResize === null || !activeResizer) return;

  const containerWidth = document.getElementById('main-content').offsetWidth;
  const newWidth = (pendingResize / containerWidth) * 100;

  // Batch DOM writes
  requestAnimationFrame(() => {
    // Apply all style changes at once
  });

  pendingResize = null;
}
```

---

## 9. Grid Animation Inefficiency

### Problem: All 32 Shaders Animated Always

**File:** `js/shader-grid.js` (Lines 606-627)

```javascript
function animateGrid(currentTime) {
  state.gridAnimationId = requestAnimationFrame(animateGrid);
  if (currentTime - lastGridFrameTime < GRID_FRAME_INTERVAL) return;
  lastGridFrameTime = currentTime;

  for (let i = 0; i < 32; i++) {
    if (state.gridSlots[i] && state.gridSlots[i].renderer) {
      state.gridSlots[i].renderer.setParams(state.gridSlots[i].params);
      state.gridSlots[i].renderer.render();
    }
  }
}
```

**Impact:** 32 shader renders × 10fps = 320 WebGL draw calls/sec even when grid is hidden.

### Recommendation

Only animate visible slots and pause when hidden:

```javascript
function animateGrid(currentTime) {
  if (!isGridVisible()) {
    // Pause animation when grid is not visible
    return;
  }

  state.gridAnimationId = requestAnimationFrame(animateGrid);
  if (currentTime - lastGridFrameTime < GRID_FRAME_INTERVAL) return;
  lastGridFrameTime = currentTime;

  // Only render visible slots (use IntersectionObserver)
  const visibleSlots = getVisibleGridSlots();
  for (const slotIndex of visibleSlots) {
    const slot = state.gridSlots[slotIndex];
    if (slot?.renderer) {
      slot.renderer.setParams(slot.params);
      slot.renderer.render();
    }
  }
}

// Use IntersectionObserver to track visibility
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const slotIndex = parseInt(entry.target.dataset.slot);
    slotVisibility.set(slotIndex, entry.isIntersecting);
  });
}, { threshold: 0.1 });

// Observe each grid slot
document.querySelectorAll('.grid-slot').forEach(slot => {
  observer.observe(slot);
});
```

---

## 10. Preset & Parameter Sync Inefficiency

### Problem: Rebuilds Parameter Mappings Every Call

**File:** `js/params.js` (Lines 320-334)

```javascript
export function loadParamsToSliders(params) {
  const paramMappings = [ // Recreated EVERY time
    { id: 'param-speed', name: 'speed' }
  ];
  for (let i = 0; i < 5; i++) {
    paramMappings.push({ id: `param-p${i}`, name: `p${i}` });
  }
  // ... 30+ more mappings
}
```

### Recommendation

Define mappings once as a module-level constant:

```javascript
// Define once at module level
const PARAM_MAPPINGS = [
  { id: 'param-speed', name: 'speed' },
  ...Array.from({ length: 5 }, (_, i) => ({ id: `param-p${i}`, name: `p${i}` })),
  ...Array.from({ length: 10 }, (_, i) => [
    { id: `param-r${i}`, name: `r${i}` },
    { id: `param-g${i}`, name: `g${i}` },
    { id: `param-b${i}`, name: `b${i}` }
  ]).flat()
];

// Also cache slider elements
const sliderElements = new Map();
PARAM_MAPPINGS.forEach(({ id }) => {
  sliderElements.set(id, document.getElementById(id));
});

export function loadParamsToSliders(params) {
  for (const { id, name } of PARAM_MAPPINGS) {
    const slider = sliderElements.get(id);
    if (slider && params[name] !== undefined) {
      slider.value = params[name];
    }
  }
}
```

---

## 11. Editor Debouncing Issues

### Problem: 500ms Debounce Causes Perceived Lag

**File:** `js/editor.js` (Lines 19-23)

```javascript
state.editor.session.on('change', () => {
  clearTimeout(state.compileTimeout);
  state.compileTimeout = setTimeout(compileShader, 500);
});
```

**Impact:** User perceives 500ms lag between typing and seeing shader updates. Modern editors use 100-200ms.

### Recommendation

Reduce debounce time and add visual feedback:

```javascript
const COMPILE_DEBOUNCE = 150; // Reduced from 500ms
let pendingCompile = false;

state.editor.session.on('change', () => {
  clearTimeout(state.compileTimeout);

  // Show "compiling..." indicator immediately
  if (!pendingCompile) {
    pendingCompile = true;
    setStatus('Compiling...', 'info');
  }

  state.compileTimeout = setTimeout(() => {
    pendingCompile = false;
    compileShader();
  }, COMPILE_DEBOUNCE);
});
```

Optional: Add incremental compilation for large shaders:

```javascript
// Only recompile if changes are significant
let lastShaderHash = null;

function compileIfChanged(source) {
  const hash = simpleHash(source);
  if (hash === lastShaderHash) return;
  lastShaderHash = hash;
  compileShader();
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
```

---

## 12. Menu Rebuilding Overhead

### Problem: Full Menu Rebuild on NDI Refresh

**File:** `main.js` (Lines 349-379)

```javascript
click: async () => {
  await refreshNDISources();
  createMenu(); // Rebuilds ENTIRE menu!
}
```

**Impact:** Rebuilds application menu with all 9 submenus just to update NDI sources.

### Recommendation

Use dynamic menu updates instead of full rebuild:

```javascript
let ndiSubmenu = null;

function createMenu() {
  ndiSubmenu = new Menu();
  // ... build initial NDI menu

  const template = [
    // ... other menus
    {
      label: 'NDI',
      submenu: ndiSubmenu
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function refreshNDIMenu() {
  const sources = await refreshNDISources();

  // Clear and rebuild only NDI submenu
  ndiSubmenu.clear();

  ndiSubmenu.append(new MenuItem({
    label: 'Refresh Sources',
    click: refreshNDIMenu
  }));

  ndiSubmenu.append(new MenuItem({ type: 'separator' }));

  sources.forEach(source => {
    ndiSubmenu.append(new MenuItem({
      label: source.name,
      click: () => selectNDISource(source)
    }));
  });

  // No need to rebuild entire menu
}
```

---

## 13. Summary & Priority Matrix

### High Priority (Immediate Impact)

| Issue | File | Impact | Effort |
|-------|------|--------|--------|
| NDI frame conversion | ndi.js | CPU blocking, dropped frames | Medium |
| Array allocation per frame | shader-renderer.js | GC pressure, frame drops | Low |
| Synchronous file writes | main.js | UI freezes | Low |
| Unthrottled mousemove | params.js | 100+ IPC calls/sec | Low |

### Medium Priority (Noticeable Improvement)

| Issue | File | Impact | Effort |
|-------|------|--------|--------|
| Grid animation when hidden | shader-grid.js | Wasted GPU | Medium |
| IPC batching | params.js | Reduced overhead | Medium |
| DOM query caching | ipc.js, shader-grid.js | Faster updates | Low |
| Frame rate limiting | renderer.js | Fewer wasted RAFs | Low |

### Low Priority (Polish)

| Issue | File | Impact | Effort |
|-------|------|--------|--------|
| Editor debounce time | editor.js | Perceived responsiveness | Low |
| Menu rebuilding | main.js | Minor UI lag | Medium |
| Preset mapping caching | params.js | Micro-optimization | Low |

---

## Implementation Checklist

- [ ] Pre-allocate typed arrays in ShaderRenderer
- [ ] Add throttling to mousemove handlers
- [ ] Implement IPC batching for parameter updates
- [ ] Convert synchronous file operations to async
- [ ] Cache DOM element references
- [ ] Add visibility detection for grid animation
- [ ] Optimize NDI frame transfer (SharedArrayBuffer or shader flip)
- [ ] Reduce editor debounce time
- [ ] Implement incremental menu updates

---

## Estimated Performance Gains

| Optimization | Estimated Improvement |
|--------------|----------------------|
| NDI frame optimization | 30-50% CPU reduction during streaming |
| Array pre-allocation | 10-20% fewer GC pauses |
| IPC batching | 90% fewer IPC messages |
| Async file I/O | Eliminates UI freezes |
| Grid visibility detection | 50-90% GPU reduction when hidden |
| Mousemove throttling | 80% fewer event callbacks |

---

*Generated: January 2026*
