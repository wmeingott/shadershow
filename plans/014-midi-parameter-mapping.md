# Plan 014: MIDI parameter mapping — analogous to Art-Net DMX

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 87bd95b..HEAD -- src/shared/types/artnet.ts src/shared/types/settings.ts src/main/managers/settings-manager.ts src/main/managers/artnet-manager.ts src/main/ipc-registry.ts src/preload/preload.ts src/renderer/ipc/ipc-handlers.ts src/renderer/ui/artnet-dialog.ts src/renderer/ui/settings-dialog.ts src/renderer/app.ts`
> If any in-scope file changed since this plan was written, compare the
> excerpts quoted in each task against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Goal:** MIDI input (CC + notes) can control the same targets Art-Net DMX already controls — speed, shader params (general and shader-specific), mixer alpha/select, VP/preset recall, blackout — configured from a new "MIDI" section in the settings dialog with a mapping editor and MIDI Learn.

**Architecture:** Use the **Web MIDI API in the renderer process** (Chromium ships it; Electron grants non-sysex MIDI by default) — zero new dependencies, no native module, identical on macOS/Linux/Windows. Unlike Art-Net (UDP socket must live in MAIN), MIDI events arrive directly in REN, so the manager is a small renderer module; MAIN only persists settings. Mappings reuse the existing `ArtNetTarget` vocabulary and the existing change-application switch in `ipc-handlers.ts` (extracted into an exported function), with MIDI values 0–127 scaled to the 0–255 range that switch already expects.

**Tech Stack:** TypeScript, Web MIDI API (`navigator.requestMIDIAccess`, typed in TS ≥4.9 DOM lib — no extra @types), existing esbuild/tsc build.

## Global Constraints

- No new npm dependencies (Web MIDI is built into Chromium/Electron).
- No automated test framework exists in this repo — each task verifies with `npm run typecheck` (must exit 0); final task does a live check via the `verify` skill (CDP).
- IPC channel names are kebab-case (`set-midi-mappings`).
- Settings persist to `data/settings.json` via `SettingsManager` (atomic tmp+rename write already implemented).
- MIDI channel in mappings is 1–16, with `0` = "any channel". CC/note numbers are 0–127.
- Value scaling: MIDI `0–127` → `Math.round(v / 127 * 255)` so 127 maps exactly to 255; threshold semantics (`> 127` default) then match Art-Net.
- Commit after every task with a `feat(midi): ...` message.

## What is deliberately skipped (YAGNI)

- No `midi:` param-comment directive (analogous to `dmx:`) — UI assignment covers the request; add later by mirroring `extractDmxChannel` in `src/shared/param-parser.ts:578-593` and `syncDmxMappingsFromParams` in `src/renderer/ui/params.ts:635-669`.
- No MIDI output/feedback to controllers, no sysex, no pitch-bend/program-change, no 14-bit CC.
- No batching of applied changes: events are in-process (no IPC hop like Art-Net's 30 fps batch); per-message apply is the same rate as dragging a param slider.

## STOP conditions

- `navigator.requestMIDIAccess()` rejects in the Electron renderer (permission denied). Remedy to apply then: in `src/main/app.ts`, after `app.whenReady()`, add
  `session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(true));`
  (import `session` from `electron`). Only add this if access is actually denied — Electron's default grants it.
- The excerpts quoted in a task no longer match the live file (drift).
- `npm run typecheck` fails on code not touched by this plan.

---

### Task 1: Shared MIDI types + shared `isThresholdTarget`

**Files:**
- Create: `src/shared/types/midi.ts`
- Modify: `src/shared/types/artnet.ts` (add exported `isThresholdTarget`)
- Modify: `src/main/managers/artnet-manager.ts:202,234-239` (use the shared predicate)
- Modify: `src/shared/types/settings.ts:38-41,56-59` (midi fields in both settings interfaces)

**Interfaces:**
- Consumes: existing `ArtNetTarget` from `src/shared/types/artnet.ts`.
- Produces: `MidiMapping { channel: number; kind: 'cc' | 'note'; number: number; target: MidiTarget }`, `MidiLearnEvent { channel; kind; number; value }`, `MIDI_DEFAULTS`, and `isThresholdTarget(target: ArtNetTarget): boolean` — used by Tasks 2, 4, 5.

- [ ] **Step 1: Create `src/shared/types/midi.ts`**

```ts
// MIDI mapping types — reuses the Art-Net control-target vocabulary.

import type { ArtNetTarget } from './artnet.js';

/** What a MIDI message can control (same targets as Art-Net DMX) */
export type MidiTarget = ArtNetTarget;

/** A single MIDI CC/note mapping */
export interface MidiMapping {
  /** MIDI channel 1-16, or 0 = any channel */
  channel: number;
  /** Message kind: continuous controller or note on/off */
  kind: 'cc' | 'note';
  /** CC number or note number (0-127) */
  number: number;
  /** What this message controls */
  target: MidiTarget;
}

/** MIDI settings persisted to disk (data/settings.json) */
export interface MidiSettings {
  enabled: boolean;
  /** Web MIDI input id to listen on; '' = all inputs */
  inputId: string;
  mappings: MidiMapping[];
}

/** Event delivered to the mapping dialog while MIDI Learn is active */
export interface MidiLearnEvent {
  channel: number;
  kind: 'cc' | 'note';
  number: number;
  value: number; // 0-127
}

/** Default MIDI settings */
export const MIDI_DEFAULTS: MidiSettings = {
  enabled: false,
  inputId: '',
  mappings: [],
};
```

- [ ] **Step 2: Add shared `isThresholdTarget` to `src/shared/types/artnet.ts`**

Append at the end of the file:

```ts
/**
 * Targets that fire once on a rising edge over a threshold
 * (as opposed to continuously tracking a value).
 */
export function isThresholdTarget(target: ArtNetTarget): boolean {
  return target.type === 'vp-recall'
    || target.type === 'preset-recall'
    || target.type === 'blackout'
    || target.type === 'mixer-select';
}
```

- [ ] **Step 3: Use it in `src/main/managers/artnet-manager.ts`**

Change the import at the top (line 6) from:

```ts
import type { ArtNetMapping, ArtNetChange, ArtNetStatus, ArtNetTarget } from '@shared/types/artnet.js';
```

to:

```ts
import { isThresholdTarget } from '@shared/types/artnet.js';
import type { ArtNetMapping, ArtNetChange, ArtNetStatus } from '@shared/types/artnet.js';
```

At line 202 change `if (this.isThresholdTarget(target)) {` to `if (isThresholdTarget(target)) {`, and delete the now-unused private method (lines 234–239):

```ts
  private isThresholdTarget(target: ArtNetTarget): boolean {
    return target.type === 'vp-recall'
      || target.type === 'preset-recall'
      || target.type === 'blackout'
      || target.type === 'mixer-select';
  }
```

(The `ArtNetTarget` type import becomes unused by this deletion — that is why Step 3 removed it from the import.)

- [ ] **Step 4: Add midi fields to `src/shared/types/settings.ts`**

In `AppSettings` (after line 40, `artnetMappings: ...`):

```ts
  midiEnabled: boolean;
  midiInputId: string;
  midiMappings: import('./midi.js').MidiMapping[];
```

In `SettingsDialogData` (after line 58, `artnetMappings: ...`):

```ts
  midiEnabled: boolean;
  midiInputId: string;
  midiMappings: import('./midi.js').MidiMapping[];
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/midi.ts src/shared/types/artnet.ts src/shared/types/settings.ts src/main/managers/artnet-manager.ts
git commit -m "feat(midi): shared MIDI mapping types, shared isThresholdTarget predicate"
```

---

### Task 2: Main-process persistence (settings-manager, ipc-registry, preload)

MAIN owns no MIDI runtime — it only stores `midiEnabled` / `midiInputId` / `midiMappings` in `data/settings.json` and returns them to the renderer.

**Files:**
- Modify: `src/main/managers/settings-manager.ts` (defaults, fields, load, save, getSettings)
- Modify: `src/main/ipc-registry.ts` (new `set-midi-mappings` listener after the `set-artnet-mappings` one at line 227-235; midi block in `handleSaveSettings` after the "4b. Art-Net" block ending at line 827)
- Modify: `src/preload/preload.ts` (after line 247, `onArtNetDmxUpdate`)

**Interfaces:**
- Consumes: `MidiMapping`, `MIDI_DEFAULTS` from Task 1.
- Produces: persisted settings fields `midiEnabled: boolean`, `midiInputId: string`, `midiMappings: MidiMapping[]` returned inside `SettingsDialogData` from the existing `get-settings` handle; IPC send channel `set-midi-mappings`; `window.electronAPI.setMidiMappings(mappings)` in the renderer.

- [ ] **Step 1: settings-manager — import + defaults**

In `src/main/managers/settings-manager.ts`, next to the artnet import (line 15):

```ts
import { type MidiMapping, MIDI_DEFAULTS } from '@shared/types/midi.js';
```

In the `DEFAULTS` object (after line 30, `artnetMappings: ARTNET_DEFAULTS.mappings,`):

```ts
  midiEnabled: MIDI_DEFAULTS.enabled,
  midiInputId: MIDI_DEFAULTS.inputId,
  midiMappings: MIDI_DEFAULTS.mappings,
```

Class fields (after line 53, `artnetMappings: ArtNetMapping[];`):

```ts
  midiEnabled: boolean;
  midiInputId: string;
  midiMappings: MidiMapping[];
```

Constructor (after `this.artnetMappings = [...DEFAULTS.artnetMappings];`):

```ts
    this.midiEnabled = DEFAULTS.midiEnabled;
    this.midiInputId = DEFAULTS.midiInputId;
    this.midiMappings = [...DEFAULTS.midiMappings];
```

- [ ] **Step 2: settings-manager — load/save/getSettings**

In `load()`, after the `artnetMappings` block:

```ts
        if (typeof data.midiEnabled === 'boolean') {
          this.midiEnabled = data.midiEnabled;
        }
        if (typeof data.midiInputId === 'string') {
          this.midiInputId = data.midiInputId;
        }
        if (Array.isArray(data.midiMappings)) {
          this.midiMappings = data.midiMappings;
        }
```

In `save()`, in the `data` object after `artnetMappings: this.artnetMappings,`:

```ts
        midiEnabled: this.midiEnabled,
        midiInputId: this.midiInputId,
        midiMappings: this.midiMappings,
```

In `getSettings()`, in the returned object after `artnetMappings: this.artnetMappings,`:

```ts
      midiEnabled: this.midiEnabled,
      midiInputId: this.midiInputId,
      midiMappings: this.midiMappings,
```

- [ ] **Step 3: ipc-registry — mapping persistence listener**

In `src/main/ipc-registry.ts`, directly after the `set-artnet-mappings` listener (after line 235):

```ts
    // 11f. set-midi-mappings — persist MIDI mappings (renderer owns the MIDI runtime)
    ipcMain.on('set-midi-mappings', (_event, mappings: unknown) => {
      if (!Array.isArray(mappings)) return;
      settingsManager.midiMappings = mappings;
      settingsManager.save();
    });
```

- [ ] **Step 4: ipc-registry — persist enable/device on Apply**

In `handleSaveSettings`, after the "4b. Art-Net DMX settings" block (after line 827):

```ts
    // 4c. MIDI settings (renderer owns the MIDI runtime; main only persists)
    if (typeof settings.midiEnabled === 'boolean') {
      settingsManager.midiEnabled = settings.midiEnabled;
    }
    if (typeof settings.midiInputId === 'string') {
      settingsManager.midiInputId = settings.midiInputId;
    }
```

- [ ] **Step 5: preload**

In `src/preload/preload.ts`, after line 247 (`onArtNetDmxUpdate: ...`):

```ts
  // MIDI (runtime lives in the renderer via Web MIDI; main only persists mappings)
  setMidiMappings: (mappings: any[]) => ipcRenderer.send('set-midi-mappings', mappings),
```

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` — expected exit 0.

```bash
git add src/main/managers/settings-manager.ts src/main/ipc-registry.ts src/preload/preload.ts
git commit -m "feat(midi): persist MIDI settings (enabled, input device, mappings) in main"
```

---

### Task 3: Extract `applyControlChanges` in the renderer

The Art-Net change-application switch (`src/renderer/ipc/ipc-handlers.ts:1271-1382`) is target-vocabulary logic, not Art-Net logic. Extract it so MIDI reuses it verbatim.

**Files:**
- Modify: `src/renderer/ipc/ipc-handlers.ts:1267-1383`

**Interfaces:**
- Produces: `export function applyControlChanges(changes: Array<{ target: { type: string; [k: string]: unknown }; dmxValue: number }>): void` — value range 0–255; consumed by Task 4.

- [ ] **Step 1: Extract the function**

The current code (line 1271) is:

```ts
  window.electronAPI.onArtNetDmxUpdate((changes: Array<{ target: { type: string; [k: string]: unknown }; dmxValue: number }>) => {
    const renderer = state.renderer as ShaderRendererLike | null;
    if (!renderer) return;

    for (const { target, dmxValue } of changes) {
      switch (target.type) {
        // ... cases: speed, param, mixer-alpha, mixer-select, vp-recall, preset-recall, blackout ...
      }
    }
  });
```

Replace the registration with:

```ts
  window.electronAPI.onArtNetDmxUpdate(applyControlChanges);
```

and move the entire callback body — unchanged — into a new **module-level exported function** placed after the enclosing registration function (i.e. after the closing brace at line 1383):

```ts
/**
 * Apply a batch of control changes to the app (shared by Art-Net DMX and MIDI).
 * Values are 0-255 (DMX range); MIDI callers scale 0-127 up before calling.
 */
export function applyControlChanges(changes: Array<{ target: { type: string; [k: string]: unknown }; dmxValue: number }>): void {
  const renderer = state.renderer as ShaderRendererLike | null;
  if (!renderer) return;

  for (const { target, dmxValue } of changes) {
    switch (target.type) {
      // ... the existing 1275-1381 switch body, moved verbatim ...
    }
  }
}
```

Do not edit any case body. `state`, `ShaderRendererLike`, `GridSlot`, `MixerChannel`, `recallLocalPreset` (imported at line 86) and `recallVisualPreset` (line 92) are already module-scope in this file.

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck` — expected exit 0.

```bash
git add src/renderer/ipc/ipc-handlers.ts
git commit -m "refactor(artnet): extract applyControlChanges for reuse by MIDI"
```

---

### Task 4: Renderer MIDI engine (`midi.ts`) + startup init

**Files:**
- Create: `src/renderer/ui/midi.ts`
- Modify: `src/renderer/app.ts` (one call after `await initSettingsOnLoad();`, line 51)

**Interfaces:**
- Consumes: `applyControlChanges` (Task 3), `isThresholdTarget` (Task 1), `MidiMapping`/`MidiLearnEvent` (Task 1), `window.electronAPI.getSettings()` (existing).
- Produces (consumed by Tasks 5–6):
  - `initMidiOnLoad(): Promise<void>` — read settings, start if enabled
  - `configureMidi(enabled: boolean, inputId: string): Promise<void>` — apply Settings dialog "Apply"
  - `setMidiMappings(mappings: MidiMapping[]): void` — live-swap mappings
  - `listMidiInputs(): Promise<Array<{ id: string; name: string }>>`
  - `getMidiStatus(): { enabled: boolean; inputId: string; lastEvent: string }`
  - `setMidiLearnCallback(cb: ((ev: MidiLearnEvent) => void) | null): void` — while set, messages go to the callback instead of being applied

- [ ] **Step 1: Create `src/renderer/ui/midi.ts`**

```ts
// MIDI input — maps Web MIDI CC/note messages to app controls (same targets
// as Art-Net DMX). Runs entirely in the renderer; main only persists settings.

import { createTaggedLogger } from '@shared/logger.js';
import { isThresholdTarget } from '@shared/types/artnet.js';
import type { MidiMapping, MidiLearnEvent } from '@shared/types/midi.js';
import { applyControlChanges } from '../ipc/ipc-handlers.js';

const log = createTaggedLogger();

declare const window: Window & {
  electronAPI: {
    getSettings(): Promise<{ midiEnabled?: boolean; midiInputId?: string; midiMappings?: MidiMapping[] }>;
  };
};

let access: MIDIAccess | null = null;
let enabled = false;
let inputId = ''; // '' = listen on all inputs
let mappings: MidiMapping[] = [];
// Rising-edge state for threshold triggers (keyed by mapping index)
const triggerState = new Map<number, boolean>();
let learnCallback: ((ev: MidiLearnEvent) => void) | null = null;
let lastEvent = '';

/** Read persisted settings and start MIDI if enabled. Call once at startup. */
export async function initMidiOnLoad(): Promise<void> {
  const s = await window.electronAPI.getSettings();
  mappings = s.midiMappings ?? [];
  inputId = s.midiInputId ?? '';
  if (s.midiEnabled) await startMidi();
}

/** Apply enable state + input selection from the settings dialog. */
export async function configureMidi(newEnabled: boolean, newInputId: string): Promise<void> {
  inputId = newInputId;
  if (newEnabled && !enabled) {
    await startMidi();
  } else if (!newEnabled && enabled) {
    stopMidi();
  } else if (enabled) {
    bindInputs(); // input selection may have changed
  }
}

export function setMidiMappings(newMappings: MidiMapping[]): void {
  mappings = newMappings;
  triggerState.clear();
}

/** List available MIDI inputs (requests access on first call). */
export async function listMidiInputs(): Promise<Array<{ id: string; name: string }>> {
  if (!(await ensureAccess())) return [];
  return [...access!.inputs.values()].map(i => ({ id: i.id, name: i.name ?? i.id }));
}

export function getMidiStatus(): { enabled: boolean; inputId: string; lastEvent: string } {
  return { enabled, inputId, lastEvent };
}

/** While set, incoming messages go to the callback instead of being applied (MIDI Learn). */
export function setMidiLearnCallback(cb: ((ev: MidiLearnEvent) => void) | null): void {
  learnCallback = cb;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function ensureAccess(): Promise<boolean> {
  if (access) return true;
  try {
    access = await navigator.requestMIDIAccess();
    access.onstatechange = () => {
      if (enabled) bindInputs(); // rebind on hot-plug
    };
    return true;
  } catch (err) {
    lastEvent = 'MIDI access denied';
    log.error('MIDI', 'requestMIDIAccess failed:', err);
    return false;
  }
}

async function startMidi(): Promise<void> {
  if (enabled) return;
  if (!(await ensureAccess())) return;
  enabled = true;
  bindInputs();
  log.info('MIDI', `Listening (${access!.inputs.size} input(s), device: ${inputId || 'all'})`);
}

function stopMidi(): void {
  enabled = false;
  if (access) {
    for (const input of access.inputs.values()) input.onmidimessage = null;
  }
  triggerState.clear();
  log.info('MIDI', 'Stopped');
}

function bindInputs(): void {
  if (!access) return;
  for (const input of access.inputs.values()) {
    const listen = enabled && (!inputId || input.id === inputId);
    input.onmidimessage = listen ? handleMessage : null;
  }
}

function handleMessage(e: MIDIMessageEvent): void {
  const data = e.data;
  if (!data || data.length < 3) return;

  const type = data[0]! & 0xf0;
  const channel = (data[0]! & 0x0f) + 1; // 1-16
  let kind: 'cc' | 'note';
  let value: number; // 0-127
  if (type === 0xb0) {
    kind = 'cc';
    value = data[2]!;
  } else if (type === 0x90) {
    kind = 'note';
    value = data[2]!; // note-on velocity (0 = note-off by convention)
  } else if (type === 0x80) {
    kind = 'note';
    value = 0; // note-off
  } else {
    return; // ponytail: CC + notes only; pitch-bend/program-change if ever needed
  }
  const number = data[1]!;

  lastEvent = `${kind === 'cc' ? 'CC' : 'Note'} ${number} ch${channel} = ${value}`;

  if (learnCallback) {
    learnCallback({ channel, kind, number, value });
    return;
  }

  const changes: Array<{ target: MidiMapping['target']; dmxValue: number }> = [];
  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i]!;
    if (m.kind !== kind || m.number !== number) continue;
    if (m.channel !== 0 && m.channel !== channel) continue;

    const dmxValue = Math.round((value / 127) * 255);

    // Threshold targets fire once on the rising edge (mirrors ArtNetManager)
    if (isThresholdTarget(m.target)) {
      const threshold = (m.target as { threshold?: number }).threshold ?? 127;
      const wasHigh = triggerState.get(i) ?? false;
      const isHigh = dmxValue > threshold;
      triggerState.set(i, isHigh);
      if (isHigh && !wasHigh) changes.push({ target: m.target, dmxValue });
      continue;
    }

    changes.push({ target: m.target, dmxValue });
  }

  if (changes.length > 0) applyControlChanges(changes);
}
```

Note: `MIDIAccess` / `MIDIMessageEvent` come from the standard TS DOM lib — no import needed. If `log.info('MIDI', ...)`'s signature doesn't match this repo's logger, mimic the exact call style used at the top of `src/renderer/ipc/ipc-handlers.ts:15-21`.

- [ ] **Step 2: Init at startup**

In `src/renderer/app.ts`, add the import next to the settings-dialog import (line 15):

```ts
import { initMidiOnLoad } from './ui/midi.js';
```

and after `await initSettingsOnLoad();` (line 51):

```ts
    void initMidiOnLoad(); // don't block startup on MIDI permission
```

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` — expected exit 0.

```bash
git add src/renderer/ui/midi.ts src/renderer/app.ts
git commit -m "feat(midi): renderer Web MIDI engine with CC/note mapping and edge triggers"
```

---

### Task 5: Mapping dialog (share target-editor helpers with Art-Net)

**Files:**
- Modify: `src/renderer/ui/artnet-dialog.ts` (export 4 existing helpers; extract row wiring into `wireTargetInputs`)
- Create: `src/renderer/ui/midi-dialog.ts`

**Interfaces:**
- Consumes: from `artnet-dialog.ts` (after this task): `getParamNames(): string[]`, `renderTargetOptions(target: ArtNetTarget, paramNames: string[]): string`, `createDefaultTarget(type: string): ArtNetTarget`, `wireTargetInputs(row: Element, target: ArtNetTarget): void`. From Task 4: `setMidiLearnCallback`.
- Produces: `showMidiMappingDialog(mappings: MidiMapping[], onSave: (mappings: MidiMapping[]) => void): void` — consumed by Task 6.

- [ ] **Step 1: Export helpers from `artnet-dialog.ts`**

Add `export` to three existing functions (no body changes): `getParamNames` (line 104), `renderTargetOptions` (line 186), `createDefaultTarget` (line 216).

Then extract the target-specific input wiring (currently inline in `renderMappingList`, lines 156-175) into a new exported function at module level:

```ts
/** Wire the target-specific inputs produced by renderTargetOptions (shared with the MIDI dialog) */
export function wireTargetInputs(row: Element, target: ArtNetTarget): void {
  const paramSelect = row.querySelector('.artnet-param-name') as HTMLSelectElement | null;
  paramSelect?.addEventListener('change', () => {
    (target as { name: string }).name = paramSelect.value;
  });

  const chIdxInput = row.querySelector('.artnet-ch-idx') as HTMLInputElement | null;
  chIdxInput?.addEventListener('change', () => {
    (target as { channelIndex: number }).channelIndex = parseInt(chIdxInput.value) || 0;
  });

  const vpTabInput = row.querySelector('.artnet-vp-tab') as HTMLInputElement | null;
  vpTabInput?.addEventListener('change', () => {
    (target as { vpTabIndex: number }).vpTabIndex = parseInt(vpTabInput.value) || 0;
  });

  const presetInput = row.querySelector('.artnet-preset-idx') as HTMLInputElement | null;
  presetInput?.addEventListener('change', () => {
    (target as { presetIndex: number }).presetIndex = parseInt(presetInput.value) || 0;
  });
}
```

and replace those inline blocks in `renderMappingList` with:

```ts
    wireTargetInputs(row, editMappings[idx]!.target);
```

(Keep the `chInput`, `typeSelect`, and `removeBtn` wiring in place — only the four target-specific input blocks move.)

- [ ] **Step 2: Create `src/renderer/ui/midi-dialog.ts`**

```ts
// MIDI Mapping Dialog — configure MIDI CC/note → app control mappings.
// Mirrors artnet-dialog.ts and reuses its target-editor helpers.

import type { MidiMapping, MidiLearnEvent } from '@shared/types/midi.js';
import {
  getParamNames,
  renderTargetOptions,
  createDefaultTarget,
  wireTargetInputs,
} from './artnet-dialog.js';
import { setMidiLearnCallback } from './midi.js';

/** Current mappings being edited */
let editMappings: MidiMapping[] = [];
let learnMode = false;

/**
 * Show the MIDI mapping configuration dialog.
 * @param mappings Current mappings to edit
 * @param onSave Callback with updated mappings
 */
export function showMidiMappingDialog(
  mappings: MidiMapping[],
  onSave: (mappings: MidiMapping[]) => void,
): void {
  editMappings = JSON.parse(JSON.stringify(mappings));
  learnMode = false;

  const overlay = document.createElement('div');
  overlay.id = 'midi-mapping-overlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    display: flex; align-items: center; justify-content: center; z-index: 10000;
  `;

  overlay.innerHTML = `
    <div class="midi-mapping-dialog" style="
      background: var(--bg-primary, #1e1e1e); color: var(--text-primary, #ccc);
      border: 1px solid var(--border-color, #555); border-radius: 6px;
      width: 760px; max-height: 80vh; display: flex; flex-direction: column;
      font-size: 13px;
    ">
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border-color, #555);">
        <h3 style="margin: 0; font-size: 15px;">MIDI Mappings</h3>
        <button id="midi-close-btn" style="background: none; border: none; color: var(--text-primary); font-size: 18px; cursor: pointer;">&times;</button>
      </div>
      <div style="padding: 12px 16px; display: flex; gap: 8px; border-bottom: 1px solid var(--border-color, #333);">
        <button id="midi-add-btn" class="btn-secondary" style="font-size: 12px;">+ Add Mapping</button>
        <button id="midi-learn-btn" class="btn-secondary" style="font-size: 12px;">Learn</button>
        <span id="midi-learn-status" style="color: var(--text-secondary); font-size: 11px; align-self: center;"></span>
      </div>
      <div id="midi-mapping-list" style="overflow-y: auto; flex: 1; padding: 8px 16px; min-height: 120px;"></div>
      <div style="display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border-color, #555);">
        <button id="midi-cancel-btn" class="btn-secondary">Cancel</button>
        <button id="midi-save-btn" class="btn-primary">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  renderMappingList();

  overlay.querySelector('#midi-close-btn')!.addEventListener('click', close);
  overlay.querySelector('#midi-cancel-btn')!.addEventListener('click', close);
  overlay.querySelector('#midi-save-btn')!.addEventListener('click', () => {
    onSave(editMappings);
    close();
  });
  overlay.querySelector('#midi-add-btn')!.addEventListener('click', () => {
    editMappings.push({ channel: 0, kind: 'cc', number: 1, target: { type: 'speed' } });
    renderMappingList();
  });
  overlay.querySelector('#midi-learn-btn')!.addEventListener('click', toggleLearn);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', keyHandler);

  function close(): void {
    stopLearn();
    document.removeEventListener('keydown', keyHandler);
    overlay.remove();
  }
}

/** Render the mapping list */
function renderMappingList(): void {
  const list = document.getElementById('midi-mapping-list');
  if (!list) return;

  if (editMappings.length === 0) {
    list.innerHTML = '<div style="color: var(--text-secondary); padding: 20px; text-align: center;">No mappings configured. Click "+ Add Mapping" or "Learn" to begin.</div>';
    return;
  }

  const paramNames = getParamNames();
  const chOptions = (sel: number) =>
    `<option value="0" ${sel === 0 ? 'selected' : ''}>Any</option>` +
    Array.from({ length: 16 }, (_, i) =>
      `<option value="${i + 1}" ${sel === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('');

  list.innerHTML = editMappings.map((m, i) => `
    <div class="midi-mapping-row" style="display: flex; gap: 8px; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--border-color, #333);" data-index="${i}">
      <label style="font-size: 11px; color: var(--text-secondary);">CH</label>
      <select class="midi-ch-select" style="background: var(--bg-secondary, #2a2a2a); color: var(--text-primary); border: 1px solid var(--border-color, #555); padding: 3px; font-size: 12px;">${chOptions(m.channel)}</select>
      <select class="midi-kind-select" style="background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); padding: 3px; font-size: 12px;">
        <option value="cc" ${m.kind === 'cc' ? 'selected' : ''}>CC</option>
        <option value="note" ${m.kind === 'note' ? 'selected' : ''}>Note</option>
      </select>
      <input type="number" class="midi-num-input" value="${m.number}" min="0" max="127" style="width: 50px; background: var(--bg-secondary, #2a2a2a); color: var(--text-primary); border: 1px solid var(--border-color, #555); padding: 3px 5px; font-size: 12px;">
      <select class="midi-target-type" style="background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); padding: 3px; font-size: 12px;">
        <option value="speed" ${m.target.type === 'speed' ? 'selected' : ''}>Speed</option>
        <option value="param" ${m.target.type === 'param' ? 'selected' : ''}>Parameter</option>
        <option value="mixer-alpha" ${m.target.type === 'mixer-alpha' ? 'selected' : ''}>Mixer Alpha</option>
        <option value="mixer-select" ${m.target.type === 'mixer-select' ? 'selected' : ''}>Mixer Select</option>
        <option value="vp-recall" ${m.target.type === 'vp-recall' ? 'selected' : ''}>VP Recall</option>
        <option value="preset-recall" ${m.target.type === 'preset-recall' ? 'selected' : ''}>Preset Recall</option>
        <option value="blackout" ${m.target.type === 'blackout' ? 'selected' : ''}>Blackout</option>
      </select>
      ${renderTargetOptions(m.target, paramNames)}
      <button class="midi-remove-btn" style="background: none; border: none; color: #f66; cursor: pointer; font-size: 16px; padding: 2px 6px;" title="Remove">&times;</button>
    </div>
  `).join('');

  list.querySelectorAll('.midi-mapping-row').forEach((row) => {
    const idx = parseInt(row.getAttribute('data-index')!);
    const mapping = editMappings[idx]!;

    const chSelect = row.querySelector('.midi-ch-select') as HTMLSelectElement;
    chSelect.addEventListener('change', () => {
      mapping.channel = parseInt(chSelect.value) || 0;
    });

    const kindSelect = row.querySelector('.midi-kind-select') as HTMLSelectElement;
    kindSelect.addEventListener('change', () => {
      mapping.kind = kindSelect.value === 'note' ? 'note' : 'cc';
    });

    const numInput = row.querySelector('.midi-num-input') as HTMLInputElement;
    numInput.addEventListener('change', () => {
      const val = parseInt(numInput.value);
      if (val >= 0 && val <= 127) mapping.number = val;
    });

    const typeSelect = row.querySelector('.midi-target-type') as HTMLSelectElement;
    typeSelect.addEventListener('change', () => {
      mapping.target = createDefaultTarget(typeSelect.value);
      renderMappingList();
    });

    wireTargetInputs(row, mapping.target);

    const removeBtn = row.querySelector('.midi-remove-btn') as HTMLButtonElement;
    removeBtn.addEventListener('click', () => {
      editMappings.splice(idx, 1);
      renderMappingList();
    });
  });
}

/** Toggle MIDI learn — next incoming CC/note creates a mapping */
function toggleLearn(): void {
  if (learnMode) {
    stopLearn();
    return;
  }
  learnMode = true;
  const btn = document.getElementById('midi-learn-btn');
  const status = document.getElementById('midi-learn-status');
  if (btn) btn.textContent = 'Stop Learn';
  if (status) status.textContent = 'Move a knob or press a pad on your MIDI controller... (MIDI must be enabled)';

  setMidiLearnCallback((ev: MidiLearnEvent) => {
    if (ev.value === 0) return; // ignore note-offs / zeroed CCs while learning
    if (!editMappings.some(m => m.kind === ev.kind && m.number === ev.number && m.channel === ev.channel)) {
      editMappings.push({ channel: ev.channel, kind: ev.kind, number: ev.number, target: { type: 'speed' } });
      renderMappingList();
    }
    if (status) status.textContent = `Detected ${ev.kind === 'cc' ? 'CC' : 'Note'} ${ev.number} ch${ev.channel} — added mapping`;
    stopLearn();
  });
}

function stopLearn(): void {
  learnMode = false;
  setMidiLearnCallback(null);
  const btn = document.getElementById('midi-learn-btn');
  if (btn) btn.textContent = 'Learn';
  const status = document.getElementById('midi-learn-status');
  if (status) status.textContent = '';
}
```

Note: `renderTargetOptions`/`wireTargetInputs` keep their `artnet-*` CSS class names inside MIDI rows — they're internal hooks, not styles. Renaming them everywhere would be a bigger diff for zero behavior.

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` — expected exit 0.

```bash
git add src/renderer/ui/artnet-dialog.ts src/renderer/ui/midi-dialog.ts
git commit -m "feat(midi): MIDI mapping dialog with Learn, shared target editor with Art-Net"
```

---

### Task 6: Settings dialog MIDI section

**Files:**
- Modify: `src/renderer/ui/settings-dialog.ts`

**Interfaces:**
- Consumes: `showMidiMappingDialog` (Task 5); `configureMidi`, `setMidiMappings`, `listMidiInputs` (Task 4); `settings.midiEnabled/midiInputId/midiMappings` from `getSettings()` (Task 2); `window.electronAPI.setMidiMappings` (Task 2).
- Produces: `SettingsData` now carries `midiEnabled: boolean; midiInputId: string` to the existing `save-settings` channel.

- [ ] **Step 1: Imports and types**

Add imports after line 12 (`import { showArtNetMappingDialog } ...`):

```ts
import type { MidiMapping } from '@shared/types/midi.js';
import { showMidiMappingDialog } from './midi-dialog.js';
import { configureMidi, setMidiMappings, listMidiInputs } from './midi.js';
```

In the `SettingsData` interface (after line 27, `artnetUniverse: number;`):

```ts
  midiEnabled: boolean;
  midiInputId: string;
```

In the `declare const window` electronAPI surface (after line 45, `toggleArtNet(): void;`):

```ts
    setMidiMappings(mappings: MidiMapping[]): void;
```

- [ ] **Step 2: Section markup**

In the `showSettingsDialog` template, insert directly after the Art-Net section's closing `</div>` (line 191):

```html
        <div class="settings-section">
          <h3>MIDI</h3>
          <div class="setting-row">
            <label>Enable:</label>
            <input type="checkbox" id="settings-midi-enabled" ${settings.midiEnabled ? 'checked' : ''}>
          </div>
          <div class="setting-row">
            <label>Device:</label>
            <select id="settings-midi-device" style="max-width: 220px">
              <option value="">All devices</option>
            </select>
          </div>
          <div class="setting-row">
            <label>Mappings:</label>
            <button class="btn-secondary" id="settings-midi-mappings-btn">Configure (${settings.midiMappings?.length ?? 0})</button>
          </div>
          <div class="setting-row">
            <label>Status:</label>
            <span id="settings-midi-status" style="color: var(--text-secondary)">${settings.midiEnabled ? 'Active' : 'Inactive'}</span>
          </div>
        </div>
```

- [ ] **Step 3: Wiring**

After the Art-Net mapping button wiring (line 278-285), add:

```ts
  // MIDI — populate device list asynchronously (needs Web MIDI access)
  const midiDeviceSel = document.getElementById('settings-midi-device') as HTMLSelectElement;
  void listMidiInputs().then((inputs) => {
    midiDeviceSel.innerHTML = '<option value="">All devices</option>'
      + inputs.map(i => `<option value="${i.id}" ${i.id === settings.midiInputId ? 'selected' : ''}>${i.name}</option>`).join('');
  });

  // MIDI mapping button
  const midiMappingsBtn = document.getElementById('settings-midi-mappings-btn');
  midiMappingsBtn?.addEventListener('click', () => {
    showMidiMappingDialog(settings.midiMappings ?? [], (mappings) => {
      window.electronAPI.setMidiMappings(mappings); // persist (main)
      setMidiMappings(mappings);                    // apply live (renderer)
      settings.midiMappings = mappings;
      midiMappingsBtn.textContent = `Configure (${mappings.length})`;
    });
  });
```

- [ ] **Step 4: Apply flow**

In `applySettings()`, after the Art-Net parse (line 457-459):

```ts
  // Parse MIDI settings
  const midiEnabled = (document.getElementById('settings-midi-enabled') as HTMLInputElement).checked;
  const midiInputId = (document.getElementById('settings-midi-device') as HTMLSelectElement).value;
```

Extend the payload line (currently line 462) to:

```ts
  const settingsData: SettingsData = { ndiResolution, ndiFrameSkip, gridSlotWidth, remoteEnabled, remotePort, artnetEnabled, artnetUniverse, midiEnabled, midiInputId };
```

And directly after `window.electronAPI.saveSettings(settingsData);` (line 466):

```ts
  // Apply MIDI immediately (runtime lives in this process)
  void configureMidi(midiEnabled, midiInputId);
```

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — expected exit 0.

```bash
git add src/renderer/ui/settings-dialog.ts
git commit -m "feat(midi): MIDI section in settings dialog (enable, device, mappings, status)"
```

---

### Task 7: Build, live verification, plan bookkeeping

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: exit 0 (tsc + esbuild bundles for main/renderer/fullscreen/preload).

- [ ] **Step 2: Live UI verification (verify skill / CDP)**

Launch the app (remember the `ELECTRON_RUN_AS_NODE` gotcha — clear it) and check:

1. Open Settings → a "MIDI" section renders between "Art-Net DMX" and "AI Assistant" with Enable, Device ("All devices" at minimum), Configure (0), Status.
2. Click Configure → MIDI Mappings dialog opens; "+ Add Mapping" creates a row with CH=Any, CC, number 1, target Speed; switch target to Parameter → the param dropdown lists the current shader's params (shader-specific assignment); Save.
3. `data/settings.json` now contains `"midiMappings": [...]`, and after Apply with Enable checked, `"midiEnabled": true`.
4. Restart the app → Settings shows the mapping count and enabled state persisted.
5. Console shows no `requestMIDIAccess` errors (if access is denied, see STOP conditions).

- [ ] **Step 3: Hardware smoke test (user, when a controller is available)**

With a MIDI controller attached: enable MIDI, open the mapping dialog, press Learn, move a knob → a row appears with the detected channel/CC. Map it to a shader param and confirm the PAR slider and preview react; map a pad (Note) to Preset Recall and confirm it fires once per press. This step needs physical hardware — flag it in the status row if it couldn't be run.

- [ ] **Step 4: Update `plans/README.md`**

Set plan 014's status row (see table) to DONE with a one-line verification summary, noting whether Step 3 ran.

- [ ] **Step 5: Commit**

```bash
git add plans/README.md
git commit -m "docs(plans): mark 014 MIDI parameter mapping done"
```

---

## Self-review notes

- Spec coverage: MIDI receive analogous to Art-Net (Task 4), same target set including general (speed, mixer, presets, blackout) and shader-specific params (param dropdown fed by `getCustomParamDefs`, Tasks 3/5), settings UI section (Task 6), persistence (Task 2), Learn (Tasks 4/5).
- Type consistency: `MidiMapping.{channel,kind,number,target}` used identically in Tasks 1, 2, 4, 5, 6; `applyControlChanges(changes: Array<{target, dmxValue}>)` signature matches between Tasks 3 and 4; exported dialog helpers named `getParamNames`/`renderTargetOptions`/`createDefaultTarget`/`wireTargetInputs` in both Tasks 5's steps.
- Known ceiling: per-message apply with no batching (`ponytail:` note in midi.ts) — revisit only if a controller floods sendParamUpdate IPC noticeably.
