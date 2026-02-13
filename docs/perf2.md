# ShaderShow Performance Analysis - January 2026

This report identifies performance bottlenecks in the ShaderShow codebase with focus on rendering efficiency.

---

## Critical Issues

### 1. Tiled Preview Mode - Canvas Resizing Every Frame

**File:** `js/renderer.js` (lines 357-368)

**Problem:** In tiled preview mode, each tile's MiniShaderRenderer is resized to the tile dimensions, rendered, then resized back to thumbnail size - **every single frame**:

```javascript
// Save original canvas size
const origWidth = miniRenderer.canvas.width;
const origHeight = miniRenderer.canvas.height;

// Resize to tile dimensions for high-quality rendering
miniRenderer.setResolution(bound.width, bound.height);  // RESIZE #1
miniRenderer.render();

// ... copy to overlay ...

// Restore original canvas size
miniRenderer.setResolution(origWidth, origHeight);  // RESIZE #2
```

**Impact:** HIGH
- Canvas resize triggers WebGL framebuffer reallocation
- For 4x4 grid (16 tiles) at 60fps = **1,920 resize operations per second**
- Each resize deallocates and reallocates GPU memory
- Major GPU pipeline stall

**Fix:** Use viewport scissoring on a single large canvas, or render tiles once and cache results.

---

### 2. Shared WebGL Canvas Dimension Thrashing

**File:** `js/shader-grid.js` (lines 1473-1477)

**Problem:** `MiniShaderRenderer._resizeSharedCanvas()` is called on every render, potentially resizing the shared canvas multiple times per frame:

```javascript
_resizeSharedCanvas(width, height) {
  if (sharedGLCanvas && (sharedGLCanvas.width !== width || sharedGLCanvas.height !== height)) {
    sharedGLCanvas.width = width;   // Expensive!
    sharedGLCanvas.height = height; // Expensive!
  }
}
```

**Impact:** HIGH
- Called by every `MiniShaderRenderer.render()`
- With tiles of different sizes, this thrashes the shared canvas dimensions
- WebGL framebuffer reallocation on each resize

**Fix:** Use a fixed-size shared canvas and render with viewport/scissor, or batch tiles by resolution.

---

### 3. GPU->CPU Sync in Tiled Preview

**File:** `js/renderer.js` (lines 362-365)

**Problem:** Each tile uses `ctx.drawImage(miniCanvas, ...)` to copy from WebGL canvas to 2D canvas overlay:

```javascript
const miniCanvas = miniRenderer.canvas;
if (miniCanvas) {
  ctx.drawImage(miniCanvas, drawX, drawY);  // GPU->CPU sync point
}
```

**Impact:** MEDIUM-HIGH
- `drawImage` from WebGL canvas requires GPU->CPU pixel readback
- Creates pipeline stall waiting for GPU to finish rendering
- With 16 tiles, that's 16 sync points per frame

**Fix:** Composite entirely in WebGL using render-to-texture, or use a single WebGL canvas with viewport clipping.

---

## Medium Priority Issues

### 4. Grid Animation Continues When Hidden

**File:** `js/shader-grid.js` (lines 1346-1362)

**Problem:** The grid animation loop checks `visibleSlots` but doesn't check if the grid panel itself is hidden:

```javascript
function animateGrid() {
  // Only render slots that are currently visible
  for (const slotIndex of visibleSlots) {  // visibleSlots from IntersectionObserver
    const slot = state.gridSlots[slotIndex];
    if (slot && slot.renderer) {
      slot.renderer.setSpeed(slot.params?.speed ?? 1);
      slot.renderer.render();  // Still renders when grid hidden!
    }
  }
  state.gridAnimationId = setTimeout(animateGrid, GRID_FRAME_INTERVAL);
}
```

**Impact:** MEDIUM
- When grid panel is hidden (`display: none`), slots may still be in `visibleSlots`
- IntersectionObserver doesn't fire for elements in hidden containers
- Grid slots continue rendering at 10fps even when invisible

**Fix:** Add check: `if (!state.gridEnabled) return;` at start of animation loop.

---

### 5. Canvas 2D Context State Changes Per Frame

**File:** `js/renderer.js` (lines 304-314, 374-377, 392-396)

**Problem:** The tiled preview sets font, color, and alignment properties repeatedly per tile per frame:

```javascript
// For each tile, every frame:
ctx.fillStyle = '#444';
ctx.font = '14px monospace';  // String parsing on every call!
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillText(`${i + 1}`, ...);
```

**Impact:** MEDIUM
- `ctx.font` setter parses the font string each time
- Multiple style changes trigger 2D context state updates
- At 60fps with 16 tiles = 960+ property changes per second

**Fix:** Set font/colors once at initialization, only draw text when tile content changes.

---

### 6. Full Grid DOM Rebuild on Single Slot Removal

**File:** `js/shader-grid.js` (lines 196-265)

**Problem:** Removing one slot calls `rebuildGridDOM()` which destroys and recreates all slot elements:

```javascript
function removeGridSlotElement(index) {
  state.gridSlots.splice(index, 1);
  rebuildGridDOM();  // Destroys ALL elements, recreates ALL
}

function rebuildGridDOM() {
  slotEventListeners.forEach(/* remove all */);
  container.innerHTML = '';  // Destroy all DOM
  for (let i = 0; i < state.gridSlots.length; i++) {
    const slotEl = createGridSlotElement(i);  // Recreate each
    container.appendChild(slotEl);
  }
  // Re-register all observers...
}
```

**Impact:** MEDIUM
- Removing 1 slot causes 16+ elements to be destroyed/recreated
- All event listeners removed and re-added
- Forces layout recalculation for entire grid
- IntersectionObserver re-registration

**Fix:** Implement incremental DOM updates - remove just the single element and re-index.

---

### 7. Scene Snapshot Rendering Blocks UI

**File:** `js/shader-grid.js` (lines 745-762)

**Problem:** Assigning a scene to a slot triggers synchronous render operations:

```javascript
const sceneRenderer = ensureSceneRenderer();
if (sceneRenderer) {
  sceneRenderer.compile(sceneCode);  // Blocking
  sceneRenderer.resetTime();
  sceneRenderer.render();            // Blocking GPU render
  ctx.drawImage(mainCanvas, ...);    // GPU->CPU sync
}
```

**Impact:** MEDIUM
- Shader compilation is CPU-bound and blocking
- Scene render is GPU-bound
- `drawImage` requires GPU->CPU readback
- UI freezes during this operation

**Fix:** Defer snapshot to requestIdleCallback, use cached snapshots, or show placeholder immediately.

---

## Lower Priority Issues

### 8. Excessive IPC Calls on Parameter Changes

**File:** `js/params.js` (lines 486, 507)

**Problem:** Each slider drag event sends IPC messages:

```javascript
function updateCustomParamValue(...) {
  state.renderer.setParam(paramName, value);
  window.electronAPI.sendParamUpdate({...});  // IPC call
  if (state.tiledPreviewEnabled) {
    window.electronAPI.updateTileParam?.(...);  // Another IPC
  }
}
```

**Impact:** LOW-MEDIUM
- Slider drags generate 60+ events/second
- Each triggers 1-2 IPC calls
- IPC has serialization/deserialization overhead

**Fix:** Debounce IPC calls, batch multiple param changes, sync on drag end.

---

### 9. Repeated DOM Queries

**File:** `js/shader-grid.js` (various locations)

**Problem:** Slot selection queries DOM repeatedly:

```javascript
if (state.activeGridSlot !== null) {
  const prevSlot = document.querySelector(`.grid-slot[data-slot="${state.activeGridSlot}"]`);
  if (prevSlot) prevSlot.classList.remove('active');
}
state.activeGridSlot = slotIndex;
const slot = document.querySelector(`.grid-slot[data-slot="${slotIndex}"]`);
```

**Impact:** LOW
- Attribute selectors require DOM traversal
- Called on each slot click
- Not per-frame but adds up

**Fix:** Cache slot element references in a Map keyed by slot index.

---

### 10. Resizer Mousemove Not Debounced

**File:** `js/controls.js` (lines 178-211)

**Problem:** Editor resize calls `state.editor.resize()` on every mousemove:

```javascript
document.addEventListener('mousemove', (e) => {
  if (!activeResizer) return;
  // ... calculate dimensions ...
  state.editor.resize();  // Called on every pixel movement
});
```

**Impact:** LOW
- Only during active drag
- Ace editor resize may trigger layout calculation

**Fix:** Use requestAnimationFrame or resize on mouseup only.

---

## Summary Table

| Issue | File | Impact | Fix Effort |
|-------|------|--------|------------|
| Tile canvas resizing per frame | renderer.js:357-368 | HIGH | Medium |
| Shared canvas dimension thrashing | shader-grid.js:1473-1477 | HIGH | Medium |
| GPU->CPU sync in tiled preview | renderer.js:362-365 | HIGH | High |
| Grid animation when hidden | shader-grid.js:1346-1362 | MEDIUM | Low |
| 2D context state per frame | renderer.js:304-314 | MEDIUM | Low |
| Full DOM rebuild on removal | shader-grid.js:196-265 | MEDIUM | Medium |
| Scene snapshot blocking | shader-grid.js:745-762 | MEDIUM | Medium |
| Excessive IPC calls | params.js:486,507 | LOW-MEDIUM | Low |
| Repeated DOM queries | shader-grid.js (various) | LOW | Low |
| Resizer not debounced | controls.js:178-211 | LOW | Low |

---

## Recommended Priority

1. **Fix tiled preview canvas resizing** - Biggest impact, causes GPU thrashing
2. **Stop grid animation when hidden** - Easy fix, saves 10fps of rendering
3. **Cache 2D context state** - Simple fix, reduces per-frame overhead
4. **Batch tile rendering** - Avoid GPU->CPU sync per tile
5. **Incremental DOM updates** - Better UX for grid operations

---

## Profiling Recommendations

To validate these findings:
1. Open DevTools > Performance tab
2. Record while using tiled preview mode
3. Look for:
   - Long "GPU" bars (canvas resizing)
   - "readback" operations (GPU->CPU sync)
   - Layout/Recalc events during grid operations

---

*Generated: January 2026*
