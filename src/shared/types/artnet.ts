// Art-Net DMX types

/** A single DMX channel mapping */
export interface ArtNetMapping {
  /** DMX channel number (1-512) */
  dmxChannel: number;
  /** What this channel controls */
  target: ArtNetTarget;
}

/** Target types for DMX channel mappings */
export type ArtNetTarget =
  | { type: 'param'; name: string }
  | { type: 'mixer-alpha'; channelIndex: number }
  | { type: 'mixer-select'; channelIndex: number; threshold?: number }
  | { type: 'vp-recall'; vpTabIndex: number; presetIndex: number; threshold?: number }
  | { type: 'preset-recall'; presetIndex: number; threshold?: number }
  | { type: 'blackout'; threshold?: number }
  | { type: 'speed' };

/** A single DMX value change sent via IPC */
export interface ArtNetChange {
  target: ArtNetTarget;
  dmxValue: number; // 0-255
}

/** Art-Net settings persisted to disk */
export interface ArtNetSettings {
  enabled: boolean;
  universe: number;       // 0-32767
  mappings: ArtNetMapping[];
}

/** Status payload sent to the renderer */
export interface ArtNetStatus {
  enabled: boolean;
  universe: number;
  packetsReceived: number;
  lastPacketTime: number;
  error?: string;
}

/** Default Art-Net settings */
export const ARTNET_DEFAULTS: ArtNetSettings = {
  enabled: false,
  universe: 0,
  mappings: [],
};

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
