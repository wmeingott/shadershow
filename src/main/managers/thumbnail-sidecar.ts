/**
 * Pure split/merge helpers for the thumbnail sidecar file.
 * No Electron imports — stays testable with plain node against the built output.
 */

export type ThumbnailMap = Record<string, string>;

/**
 * Remove every thumbnail data-URL from a v2 grid state (in place) and return
 * them keyed by structural path. Keys:
 *   slot thumbnails:  `t{tabIndex}s{slotIndex}`
 *   mix presets:      `t{tabIndex}m{presetIndex}`
 *   visual presets:   `v{vpTabIndex}p{presetIndex}`
 */
export function splitThumbnails(gridState: any): ThumbnailMap {
  const thumbs: ThumbnailMap = {};

  if (Array.isArray(gridState?.tabs)) {
    for (let ti = 0; ti < gridState.tabs.length; ti++) {
      const tab = gridState.tabs[ti];
      if (!tab) continue;

      // Shader/asset slots
      if (Array.isArray(tab.slots)) {
        for (let si = 0; si < tab.slots.length; si++) {
          const slot = tab.slots[si];
          if (slot && typeof slot.thumbnail === 'string') {
            thumbs[`t${ti}s${si}`] = slot.thumbnail;
            delete slot.thumbnail;
          }
        }
      }

      // Mix presets
      if (Array.isArray(tab.mixPresets)) {
        for (let pi = 0; pi < tab.mixPresets.length; pi++) {
          const preset = tab.mixPresets[pi];
          if (preset && typeof preset.thumbnail === 'string') {
            thumbs[`t${ti}m${pi}`] = preset.thumbnail;
            preset.thumbnail = null;
          }
        }
      }
    }
  }

  if (Array.isArray(gridState?.vpTabs)) {
    for (let vi = 0; vi < gridState.vpTabs.length; vi++) {
      const vpTab = gridState.vpTabs[vi];
      if (!vpTab || !Array.isArray(vpTab.presets)) continue;
      for (let pi = 0; pi < vpTab.presets.length; pi++) {
        const preset = vpTab.presets[pi];
        if (preset && typeof preset.thumbnail === 'string') {
          thumbs[`v${vi}p${pi}`] = preset.thumbnail;
          preset.thumbnail = null;
        }
      }
    }
  }

  return thumbs;
}

/**
 * Re-attach sidecar thumbnails into a parsed grid state (in place).
 * An inline thumbnail already present wins (legacy file mid-migration).
 * Silently skips keys whose target no longer exists (slot deleted since last write).
 */
export function mergeThumbnails(gridState: any, thumbs: ThumbnailMap): void {
  for (const key of Object.keys(thumbs)) {
    const val = thumbs[key];

    // slot: t{ti}s{si}
    const slotMatch = key.match(/^t(\d+)s(\d+)$/);
    if (slotMatch) {
      const ti = Number(slotMatch[1]);
      const si = Number(slotMatch[2]);
      const slot = gridState?.tabs?.[ti]?.slots?.[si];
      if (slot && !slot.thumbnail) slot.thumbnail = val;
      continue;
    }

    // mix preset: t{ti}m{pi}
    const mixMatch = key.match(/^t(\d+)m(\d+)$/);
    if (mixMatch) {
      const ti = Number(mixMatch[1]);
      const pi = Number(mixMatch[2]);
      const preset = gridState?.tabs?.[ti]?.mixPresets?.[pi];
      if (preset && !preset.thumbnail) preset.thumbnail = val;
      continue;
    }

    // visual preset: v{vi}p{pi}
    const vpMatch = key.match(/^v(\d+)p(\d+)$/);
    if (vpMatch) {
      const vi = Number(vpMatch[1]);
      const pi = Number(vpMatch[2]);
      const preset = gridState?.vpTabs?.[vi]?.presets?.[pi];
      if (preset && !preset.thumbnail) preset.thumbnail = val;
      continue;
    }
    // unknown key format — silently skip
  }
}
