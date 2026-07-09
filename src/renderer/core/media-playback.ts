import { state } from './state.js';
import { AssetRenderer } from '../renderers/asset-renderer.js';
import { ThreeSceneRenderer } from '../renderers/three-scene-renderer.js';

/**
 * Runtime tab shape — state.shaderTabs is typed narrowly; the actual objects
 * carry a `type` field and asset slots carry a `renderer` field.
 */
interface RuntimeTab {
  type?: string;
  slots?: Array<{ renderer?: unknown } | null>;
}

/**
 * Runtime mixer channel shape — state.mixerChannels is typed narrowly; the
 * actual objects carry `enabled`, `_ownsRenderer`, `slotIndex`, `tabIndex`.
 */
interface RuntimeChannel {
  enabled: boolean;
  renderer: unknown;
  _ownsRenderer?: boolean;
  slotIndex: number | null;
  tabIndex?: number | null;
}

/**
 * Pause media nothing on screen is using; resume the rest. Called on the
 * transitions that change what's watched: mixer enable/assign/clear,
 * render-mode switch, fullscreen open/close.
 * ponytail: alpha deliberately ignored — an enabled channel at alpha 0 keeps
 * decoding so crossfades up from zero never hitch. Add timed hysteresis here
 * if idle-at-zero decode ever matters.
 */
export function reconcileMediaPlayback(): void {
  const channels = state.mixerChannels as unknown as RuntimeChannel[];
  const tabs = state.shaderTabs as unknown as RuntimeTab[];

  // Build the referenced set. Include both owned renderers and slot renderers
  // for grid-assigned channels — the latter are used by renderMixerComposite
  // (mixer.ts resolves slot.renderer for channels where slotIndex is set).
  const referenced = new Set<unknown>();
  for (const ch of channels) {
    if (!ch.enabled) continue;
    if (ch.renderer) referenced.add(ch.renderer);
    if (ch.slotIndex !== null && ch.tabIndex != null) {
      const tab = tabs[ch.tabIndex];
      const slotRenderer = tab?.slots?.[ch.slotIndex]?.renderer;
      if (slotRenderer) referenced.add(slotRenderer);
    }
  }

  // Grid-backed asset videos: play while grid thumbs are live (no fullscreen)
  // or while an enabled mixer channel references them.
  for (const tab of tabs) {
    if (tab?.type !== 'assets') continue;
    for (const slot of tab.slots || []) {
      const r = slot?.renderer;
      if (r instanceof AssetRenderer) r.setDecodeActive(referenced.has(r) || !state.fullscreenActive);
    }
  }

  // Mixer-owned asset renderers exist only for their channel.
  for (const ch of channels) {
    if (ch._ownsRenderer && ch.renderer instanceof AssetRenderer) ch.renderer.setDecodeActive(ch.enabled);
  }

  // Scene media runs only while the scene renderer is the active preview renderer.
  const scene = state.sceneRenderer as ThreeSceneRenderer | null;
  if (scene) scene.setMediaActive(state.renderer === scene);
}
