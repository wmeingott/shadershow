# Plan 009: Atomic shader+param propagation — params always travel with the shader that needs them

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 11508aa..HEAD -- src/fullscreen/fullscreen-renderer.ts src/renderer/ui/editor.ts src/renderer/grid/shader-grid.ts src/renderer/grid/visual-presets.ts src/preload/preload.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug / architecture

## Symptom

For some shaders, the user-set `@param` values are honored in the preview (PP)
but the fullscreen output (FS) renders with the shader's `@param` *defaults*.

## Root cause (verified)

Every renderer's `compile()` resets all custom param values to the `@param`
defaults parsed from source — there is no carry-over:

- `ShaderRenderer.compile` — `src/renderer/renderers/shader-renderer.ts:1084-1085`
  (`this.customParamValues = createParamValues(this.customParams)`)
- `TileRenderer.compile` — `src/renderer/renderers/tile-renderer.ts:151-152`
- `ThreeSceneRenderer.compile` — `src/renderer/renderers/three-scene-renderer.ts:257`

So FS correctness depends on an unstated protocol invariant: *every message
that makes FS compile must be followed by a param push that lands after the
compile*. Three flows violate it:

1. **`shader-update` silently drops its `params` payload.** The FS handler
   `onShaderUpdate` (`src/fullscreen/fullscreen-renderer.ts:1724-1758`, payload
   type at `:127-130`) reads only `renderMode` + `shaderCode`.
   `selectGridSlot` *already sends* `params` in this message
   (`src/renderer/grid/shader-grid.ts:1818-1822`) — ignored on arrival. It only
   works because of a redundant `sendBatchParamUpdate` sent right after
   (`:1824-1826`).

2. **Slot → editor flow never syncs params to FS — the reported bug.**
   `loadGridShaderToEditor` (`src/renderer/grid/shader-grid.ts:1577-1645`)
   opens the slot in a tab → `tab-activated` → `compileShader()`
   (`src/renderer/ui/editor.ts:241-253`) → FS gets
   `sendShaderUpdate({shaderCode, renderMode})` **with no params**
   (`editor.ts:369-372`) → FS recompiles → defaults. The local preview is then
   fixed up via a `setTimeout(100ms)` that restores `slotData.customParams` to
   the *local* renderer only (`shader-grid.ts:1621-1631`). Result: preview
   correct, FS at defaults. Plain editor-tab switches hit the same
   param-less send.

3. **Mode-switch race.** `onShaderUpdate` `await`s `ensureSceneRenderer()`
   before compiling when switching to scene mode
   (`fullscreen-renderer.ts:1735-1745`). A `batch-param-update` queued right
   behind the shader message is processed during that await
   (`:1784-1793`), then the compile wipes it.

Aggravating factor: `setParam` silently drops names not present in the current
compile's value map (`shader-renderer.ts:871-884`, same guard in
`setCustomParamValues:907-914` and TileRenderer) — any param event that
arrives before its shader is compiled vanishes without trace.

**The contrast that points at the fix:** every *other* shader-carrying IPC
channel already does compile → `setParams` atomically inside one handler —
`init-fullscreen` (`fullscreen-renderer.ts:1663-1694`), `mixer-channel-update`
(`:2007-2012`), `tile-assign` (`:863-866` via `assignTileShader`),
`ab-shader-update` (`:2124-2127`), `ab-composition-update` (`:2185-2189`).
The main single-shader path is the only one that doesn't.

## Concept

Establish one invariant and make it structural, not procedural:

> **Any message that causes a receiver to compile a shader carries the full
> authoritative param snapshot, and the receiver applies it in the same
> handler turn (compile → setParams, nothing interleaved). Incremental
> `param-update` / `batch-param-update` events are live tweaks on top of that
> base, never the mechanism that establishes it.**

Corollary on the send side: the FS message mirrors *what the preview renderer
actually holds after its own compile+restore* — FS state is derived from
preview state, not from a hand-maintained sequence of pushes.

This is a generalization of what init-fullscreen / mixer / tiles / A/B already
do, applied to the one channel that missed it. No new IPC channels, no new
state stores.

### Rejected alternatives

- **Central param store in MAIN, both windows subscribe**: biggest hammer;
  adds a hop to the 60 Hz slider path; rewrites every module for a bug that
  is one missing field + one missing apply.
- **Preserve same-name values across `compile()` inside renderers**: fixes
  code edits but not shader switches (stale cross-shader value leakage), and
  leaves the ordering race intact.
- **Sequence numbers/acks on param messages**: protocol machinery to survive
  an ordering requirement we can simply eliminate.

## Steps

### 1. FS: honor `params` in `shader-update`

`src/fullscreen/fullscreen-renderer.ts`

- Add `params?: ParamValues` to `ShaderUpdateData` (`:127-130`).
- In `onShaderUpdate` (`:1724-1758`), after the successful
  `renderer!.compile(...)`, apply:

  ```ts
  if (data.params) renderer!.setParams(data.params);
  ```

  `ShaderRenderer.setParams` exists (`shader-renderer.ts:917`), and
  `ThreeSceneRenderer.setParams` exists (`three-scene-renderer.ts:567`), so
  this is mode-safe. Because the apply now happens *after* the `await` inside
  the same handler, the scene-switch race is gone for this carrier.

### 2. REN: `compileShader()` restores slot params, then sends them

`src/renderer/ui/editor.ts` (`compileShader`, `:270` ff)

- After `renderer.compile(source)` succeeds and **before**
  `generateCustomParamUI()`: if the active grid slot has saved values, restore
  them to the local renderer:

  ```ts
  const slot = state.activeGridSlot !== null ? state.gridSlots[state.activeGridSlot] : null;
  if (slot?.customParams && state.renderMode !== 'scene') {
    renderer.setCustomParamValues?.(slot.customParams);
  }
  ```

  (`setCustomParamValues` ignores names the new compile doesn't declare, so
  this is safe for edited sources — matching params keep user values, removed
  ones disappear, new ones get defaults.)

- Change the FS sync (`:369-372`) to carry the post-restore snapshot:

  ```ts
  window.electronAPI.sendShaderUpdate({
    shaderCode: source,
    renderMode: state.renderMode,
    params: renderer.getParams?.(),
  });
  ```

  `getParams()` merges built-ins (speed) + custom values
  (`shader-renderer.ts:886-894`), i.e. exactly what the preview will render
  with. Guard with optional chaining for the scene-renderer surface; if the
  scene renderer lacks `getParams`, fall back to
  `renderer.getCustomParamValues?.()`.

### 3. Remove the now-redundant patch-up code

- `src/renderer/grid/shader-grid.ts:1612-1631` (`loadGridShaderToEditor`):
  delete the `setTimeout(100)` param-restore block — step 2 restores params
  synchronously inside the compile it was waiting for. Keep the
  `state.compileTimeout` cancellation (`:1612-1618`). Keep the
  `bindingStates` restore by moving it into the same place only if trivially
  possible; otherwise leave the timeout solely for `setBindingStates` and add
  a `ponytail:` comment naming that residue.
- `src/renderer/grid/shader-grid.ts:1824-1826` (`selectGridSlot`): delete the
  `sendBatchParamUpdate(allParams)` backstop — `sendShaderUpdate` already
  carries `allParams` (`:1821`) and FS now applies it atomically.
- `src/renderer/grid/visual-presets.ts:495-496`: leave the
  `sendBatchParamUpdate(allParams)` — VP recall applies *preset* params after
  `await compileShader()`, so this batch is doing real work (a live update on
  top of the base). Do not remove.

### 4. (Optional, one line) Make silent drops visible

In `ShaderRenderer.setParam` (`shader-renderer.ts:871-884`): when a name
matches neither map, `log.debug('setParam dropped', name)`. Diagnostic only —
with steps 1–3 the drop should no longer occur in normal flows.

## Verification

1. `npm run build` — clean.
2. Grep invariant: every `sendShaderUpdate(` call site passes a `params` field
   (`grep -rn "sendShaderUpdate(" src/renderer`). Expected: editor.ts and
   shader-grid.ts both carry params.
3. Runtime smoke (`npm start`, needs a display; clear `ELECTRON_RUN_AS_NODE`):
   1. Pick a grid slot whose shader has `@param`s; move sliders away from
      defaults (values persist to `slot.customParams`).
   2. Open fullscreen. FS must match preview (init path).
   3. **Double-click the slot** (edit-in-editor path). FS must still match
      preview — this is the reported bug's repro.
   4. Single-click between two param'd slots. FS follows, values honored.
   5. Edit shader source (add whitespace, wait 500 ms debounce). Preview and
      FS must stay identical (both keep saved slot values for surviving
      params).
   6. Switch a scene slot ↔ shader slot with FS open (mode-switch race):
      params honored on both.

## STOP conditions

- `ShaderRenderer.setParams` or `ThreeSceneRenderer.setParams` missing or
  signature-mismatched at the cited lines.
- `compileShader()` turns out to be called in a context where
  `state.activeGridSlot` points at a *different* shader than the editor
  content (would restore wrong values) — verify by logging slot index +
  tab title during smoke step 3; on mismatch, restore from the active *tab*'s
  slotIndex (`tabs.ts:276-289`) instead and note it in the README row.
- A/B mode regressions in smoke testing (A/B has its own carriers and should
  be untouched — any change in its behavior means an unintended interaction).
