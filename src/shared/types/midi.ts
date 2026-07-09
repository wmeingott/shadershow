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
