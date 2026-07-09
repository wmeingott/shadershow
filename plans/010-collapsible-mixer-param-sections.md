# Plan 010: Collapsible mixer channel sections in the params panel

> **Executor instructions**: Follow this plan step by step. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0b62a6c..HEAD -- src/renderer/ui/params.ts src/renderer/ui/mixer.ts css/params.css`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: ux / feature

## Problem (measured live)

With shaders on several mixer channels, PAR does generate a section per
channel (verified via CDP: 3 channels → sections with 1/17/2 rows), but the
panel is a short scroll strip (~200 px in a small window) and the channel
sections sit *below* ~340 px of static controls (speed/tiling/local presets);
one 5-param shader section alone is ~590 px tall. Users see only the first
section's top — "params for all used shaders" are buried, not missing.
Design chosen by user: **stacked + collapsible** (single column kept).

Independent label bug: slot-assigned channels without `filePath` render as
"Ch N: Mix Preset" (`src/renderer/ui/params.ts:1327-1332`).

## Changes

1. `src/renderer/ui/params.ts` (`generateMixerParamsUI`):
   - Module-level `collapsedMixerSections: Set<number>` (session-only) +
     exported `expandMixerParamSection(channelIndex)`.
   - Per channel: sticky header row `.mixer-channel-header` = caret button
     (▶/▼, toggles the set + `generateCustomParamUI()`) + existing title
     (title click keeps selecting the channel). Collapsed → render header
     only, skip param rows.
   - Label fallback chain: slot label → file basename → `Slot N` →
     `Asset`/`Mix Preset`.
2. `src/renderer/ui/mixer.ts`: call `expandMixerParamSection(i)` on
   `assignShaderToMixer` / `assignAssetToMixer` and per channel in
   `recallMixState` (fresh assignment always shows its params).
3. `css/params.css`: sticky header (top 0 within `#params-panel` scroll,
   opaque panel background, z-index above rows), caret button styling,
   collapsed spacing.

All expanded by default. No persistence, no IPC, fullscreen untouched.

## Verification

`npm run build`; then CDP drive (see `.claude/skills/verify/SKILL.md`):
assign slots 0/8/12 to three channels → 3 expanded sections with correct
`Slot N` labels; caret collapses to header-only and back; title click still
sets `state.mixerSelectedChannel`; reassigning a collapsed channel
auto-expands it. Clip-screenshot the panel as evidence.
