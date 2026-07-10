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

  const changes: Array<{ target: { type: string; [k: string]: unknown }; dmxValue: number }> = [];
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
      if (isHigh && !wasHigh) changes.push({ target: m.target as { type: string; [k: string]: unknown }, dmxValue });
      continue;
    }

    changes.push({ target: m.target as { type: string; [k: string]: unknown }, dmxValue });
  }

  if (changes.length > 0) applyControlChanges(changes);
}
