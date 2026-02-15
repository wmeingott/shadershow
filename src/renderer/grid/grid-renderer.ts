// Grid Renderer — animation loop, visibility observer, container height tracking,
// and file texture caching for grid thumbnail renderers.
// Typed version of the grid-animation and file-texture portions of js/shader-grid.js.

import { state } from '../core/state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal electronAPI surface used by this module */
declare const window: Window & {
  electronAPI: {
    loadFileTexture: (textureName: string) => Promise<{ success: boolean; dataUrl?: string }>;
  };
};

/** Runtime shape of a grid slot's renderer (MiniShaderRenderer or similar) */
interface SlotRenderer {
  setSpeed(speed: number): void;
  render(): void;
  loadFileTexture?(channel: number, dataUrl: string): Promise<unknown>;
  loadTexture?(channel: number, dataUrl: string): Promise<unknown>;
  fileTextureDirectives?: { channel: number; textureName: string }[];
}

/** Runtime shape of a grid slot stored in state.gridSlots */
interface GridSlot {
  renderer?: SlotRenderer | null;
  params?: { speed?: number; [key: string]: unknown } | null;
}

// ---------------------------------------------------------------------------
// File texture cache
// ---------------------------------------------------------------------------

/**
 * Cache for file texture data URLs.
 * Avoids re-reading from disk for each grid slot that uses the same texture.
 * Exported so that grid-persistence can clear it on import.
 */
export const fileTextureCache = new Map<string, string>();

/**
 * Load file textures for a renderer after compile.
 * Reads textures from the main process via electronAPI and caches the
 * resulting data URLs so subsequent renderers can reuse them.
 */
export async function loadFileTexturesForRenderer(renderer: SlotRenderer): Promise<void> {
  if (!renderer.fileTextureDirectives || renderer.fileTextureDirectives.length === 0) return;

  for (const { channel, textureName } of renderer.fileTextureDirectives) {
    try {
      let dataUrl = fileTextureCache.get(textureName);
      if (!dataUrl) {
        const result = await window.electronAPI.loadFileTexture(textureName);
        if (result.success && result.dataUrl) {
          dataUrl = result.dataUrl;
          fileTextureCache.set(textureName, dataUrl);
        } else {
          continue;
        }
      }
      // MiniShaderRenderer uses loadFileTexture(); ShaderRenderer uses loadTexture()
      const loadFn = renderer.loadFileTexture || renderer.loadTexture;
      if (loadFn) await loadFn.call(renderer, channel, dataUrl);
    } catch (_err) {
      // Silently skip failed textures in grid thumbnails
    }
  }
}

// ---------------------------------------------------------------------------
// Max container height tracking
// ---------------------------------------------------------------------------

let maxContainerHeight = 0;

/**
 * Measure the grid container's natural height and enforce a minimum so the
 * panel never visually shrinks when switching tabs.
 */
export function applyMaxContainerHeight(): void {
  const container = document.getElementById('shader-grid-container');
  if (!container) return;

  // Temporarily remove min-height to measure natural height
  container.style.minHeight = '';
  requestAnimationFrame(() => {
    const h = container.scrollHeight;
    if (h > maxContainerHeight) maxContainerHeight = h;
    if (maxContainerHeight > 0) container.style.minHeight = `${maxContainerHeight}px`;
  });
}

/**
 * Reset max container height to zero (e.g. when tab count changes).
 */
export function resetMaxContainerHeight(): void {
  maxContainerHeight = 0;
}

// Reset max height tracking when panel width changes (grid reflows)
let _gridPanelWidth = 0;

const _gridResizeObserver = new ResizeObserver((entries: ResizeObserverEntry[]) => {
  for (const entry of entries) {
    const w = entry.contentRect.width;
    if (_gridPanelWidth && Math.abs(w - _gridPanelWidth) > 1) {
      maxContainerHeight = 0;
      applyMaxContainerHeight();
    }
    _gridPanelWidth = w;
  }
});

// Attach the resize observer once the DOM is ready
requestAnimationFrame(() => {
  const panel = document.getElementById('grid-panel');
  if (panel) _gridResizeObserver.observe(panel);
});

// ---------------------------------------------------------------------------
// Grid visibility observer
// ---------------------------------------------------------------------------

/** Grid animation frame rate limiting (10fps = 100ms interval) */
const GRID_FRAME_INTERVAL = 100;

/** Set of slot indices currently visible in the viewport */
const visibleSlots = new Set<number>();

let gridIntersectionObserver: IntersectionObserver | null = null;

export function cleanupGridVisibilityObserver(): void {
  if (gridIntersectionObserver) {
    gridIntersectionObserver.disconnect();
    gridIntersectionObserver = null;
  }
  visibleSlots.clear();
}

export function initGridVisibilityObserver(): void {
  // Cleanup existing observer first
  cleanupGridVisibilityObserver();

  gridIntersectionObserver = new IntersectionObserver(
    (entries: IntersectionObserverEntry[]) => {
      entries.forEach((entry) => {
        const target = entry.target as HTMLElement;
        const slotIndex = parseInt(target.dataset.slot ?? '', 10);
        if (isNaN(slotIndex)) return;
        if (entry.isIntersecting) {
          visibleSlots.add(slotIndex);
        } else {
          visibleSlots.delete(slotIndex);
        }
      });
    },
    {
      root: document.getElementById('grid-panel'),
      threshold: 0.1, // Consider visible if at least 10% is showing
    },
  );

  // Observe all grid slots (exclude the add button)
  document.querySelectorAll('.grid-slot:not(.grid-add-btn)').forEach((slot) => {
    gridIntersectionObserver!.observe(slot);
  });
}

// ---------------------------------------------------------------------------
// Grid animation loop
// ---------------------------------------------------------------------------

/**
 * Start the 10fps grid animation loop.
 * Only visible slots (tracked via IntersectionObserver) are rendered each frame.
 */
export function startGridAnimation(): void {
  if (state.gridAnimationId) return;

  // Initialize visibility observer if not already done
  initGridVisibilityObserver();

  // Use setTimeout instead of RAF for 10fps -- more efficient since we
  // don't need 60fps callbacks
  function animateGrid(): void {
    // Skip rendering if grid panel is not visible (hidden via UI toggle).
    // Keep the timer running so it resumes when the grid is shown.
    if (!state.gridEnabled) {
      state.gridAnimationId = setTimeout(animateGrid, GRID_FRAME_INTERVAL) as unknown as number;
      return;
    }

    // Only render slots that are currently visible
    for (const slotIndex of visibleSlots) {
      const slot = state.gridSlots[slotIndex] as GridSlot | undefined;
      if (slot?.renderer) {
        slot.renderer.setSpeed(slot.params?.speed ?? 1);
        slot.renderer.render();
      }
    }

    // Schedule next frame at 10fps interval
    state.gridAnimationId = setTimeout(animateGrid, GRID_FRAME_INTERVAL) as unknown as number;
  }

  // Start the animation loop
  animateGrid();
}

/**
 * Stop the grid animation loop and clean up the visibility observer.
 */
export function stopGridAnimation(): void {
  if (state.gridAnimationId) {
    clearTimeout(state.gridAnimationId);
    state.gridAnimationId = null;
  }
  cleanupGridVisibilityObserver();
}

/**
 * Re-initialize the visibility observer.
 * Call this after the grid DOM has been rebuilt (e.g. tab switch, slot add/remove).
 */
export function reinitGridVisibilityObserver(): void {
  initGridVisibilityObserver();
}
