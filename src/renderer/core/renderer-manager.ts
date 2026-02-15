// RendererManager — Initialization, restart, and mode-switching for the main
// rendering pipeline.  Typed version of js/renderer.js lines 74-206.

import { state } from './state.js';
import type { RenderMode } from './state.js';
import { createTaggedLogger, LOG_LEVEL } from '@shared/logger.js';
import { ShaderRenderer } from '../renderers/shader-renderer.js';
import { ThreeSceneRenderer } from '../renderers/three-scene-renderer.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createTaggedLogger(LOG_LEVEL.WARN);

// ---------------------------------------------------------------------------
// Window augmentation (only the APIs this module touches)
// ---------------------------------------------------------------------------

declare const window: Window & {
  THREE?: unknown;
  Babel?: unknown;
  loadThreeJS?: () => Promise<void>;
  loadBabel?: () => Promise<void>;
};

import { compileShader } from '../ui/editor.js';
import { cacheRenderLoopElements, renderLoop } from './render-loop.js';
import { setStatus } from '../ui/utils.js';

// ---------------------------------------------------------------------------
// Minimal Ace editor interface (only what setRenderMode needs)
// ---------------------------------------------------------------------------

interface AceSession {
  setMode(mode: string): void;
}

interface AceEditorLike {
  session: AceSession;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create the primary ShaderRenderer, attach it to state, and apply the
 * initial resolution from the resolution-select dropdown.
 */
export function initRenderer(): void {
  const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    log.error('RendererManager', 'Cannot find #shader-canvas element');
    return;
  }

  // Initialize shader renderer (always available)
  state.shaderRenderer = new ShaderRenderer(canvas);

  // Scene renderer will be initialized lazily when needed
  state.sceneRenderer = null;

  // Start with shader renderer as default
  state.renderer = state.shaderRenderer;
  state.renderMode = 'shader';

  // Set initial resolution from the dropdown
  const select = document.getElementById('resolution-select') as HTMLSelectElement | null;
  if (select) {
    const [width, height] = select.value.split('x').map(Number);
    (state.shaderRenderer as ShaderRenderer).setResolution(width, height);
  }
}

/**
 * Cancel the current animation frame, reinitialize the shader renderer,
 * recompile the editor content, and restart the render loop.
 */
export function restartRender(): void {
  // Cancel current render loop
  if (state.animationId) {
    cancelAnimationFrame(state.animationId);
    state.animationId = null;
  }

  // Reinitialize the shader renderer (resets GL state, geometry, textures)
  (state.shaderRenderer as ShaderRenderer).reinitialize();

  // Recompile current shader from editor
  compileShader();

  // Restart render loop
  cacheRenderLoopElements();
  renderLoop(performance.now());

  setStatus('Render restarted', 'success');
}

/**
 * Lazily initialize the ThreeSceneRenderer.  Loads Three.js and Babel
 * globals on first call if they are not yet available.
 *
 * @returns The ThreeSceneRenderer instance, or `null` on failure.
 */
export async function ensureSceneRenderer(): Promise<ThreeSceneRenderer | null> {
  if (state.sceneRenderer) return state.sceneRenderer as ThreeSceneRenderer;

  // Lazy-load Three.js and Babel if not yet available
  if (!window.THREE && window.loadThreeJS) {
    await window.loadThreeJS();
  }
  if (!window.Babel && window.loadBabel) {
    await window.loadBabel();
  }

  const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    log.error('RendererManager', '#shader-canvas not found');
    return null;
  }

  try {
    if (window.THREE) {
      const sceneRenderer = new ThreeSceneRenderer(canvas);
      sceneRenderer.setResolution(canvas.width, canvas.height);
      state.sceneRenderer = sceneRenderer;
      return sceneRenderer;
    } else {
      log.error('RendererManager', 'THREE.js not available for scene rendering');
      return null;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('RendererManager', 'Failed to initialize ThreeSceneRenderer:', message);
    return null;
  }
}

/**
 * Switch the active renderer between shader, scene, and asset modes.
 * Updates the editor's syntax mode and reinitializes the appropriate
 * renderer so shared WebGL context state is clean.
 */
export async function setRenderMode(mode: RenderMode): Promise<void> {
  // Guard: renderer may not be initialized yet during startup
  if (!state.shaderRenderer) {
    state.renderMode = mode;
    return;
  }

  if (mode === state.renderMode) return;

  state.renderMode = mode;
  log.info('RendererManager', 'Render mode switched to:', mode);

  if (mode === 'scene') {
    const sceneRenderer = await ensureSceneRenderer();
    if (!sceneRenderer) {
      log.error('RendererManager', 'Cannot switch to scene mode - ThreeSceneRenderer not available');
      state.renderMode = 'shader';
      return;
    }
    // Reinitialize after ShaderRenderer has used the shared WebGL context --
    // ShaderRenderer overwrites GL state that Three.js tracks internally
    sceneRenderer.reinitialize();
    state.renderer = sceneRenderer;
    (state.editor as AceEditorLike).session.setMode('ace/mode/javascript');
  } else {
    state.renderer = state.shaderRenderer;
    (state.editor as AceEditorLike).session.setMode('ace/mode/glsl');
    // Reinitialize after Three.js has used the shared WebGL context --
    // Three.js overwrites GL state (VAOs, programs, textures)
    (state.shaderRenderer as ShaderRenderer).reinitialize();
  }

  const canvas = document.getElementById('shader-canvas') as HTMLCanvasElement | null;
  if (canvas) {
    (state.renderer as ShaderRenderer | ThreeSceneRenderer).setResolution(canvas.width, canvas.height);
  }
}

/**
 * Detect the appropriate render mode from a filename and/or shader content.
 * Content-based detection takes priority so that scene code saved in `.glsl`
 * files is still recognized.
 */
export function detectRenderMode(filename: string | null, content: string | null): RenderMode {
  // Content-based detection takes priority (handles scene code in .glsl files)
  if (content) {
    if (content.includes('function setup') && content.includes('THREE')) {
      return 'scene';
    }
  }

  if (!filename) {
    if (content && (content.includes('void mainImage') || content.includes('void main()'))) {
      return 'shader';
    }
    return 'shader';
  }

  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'jsx' || (ext === 'js' && filename.includes('.scene.'))) {
    return 'scene';
  }

  if (content && content.includes('function setup')) {
    return 'scene';
  }

  return 'shader';
}
