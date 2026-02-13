// Settings and resolution types

/** A resolution preset */
export interface Resolution {
  width: number;
  height: number;
  label: string;
}

/** NDI-specific settings */
export interface NDISettings {
  resolution: Resolution;
  frameSkip: number;
  enabled: boolean;
}

/** Recording-specific settings */
export interface RecordingSettings {
  resolution: Resolution;
}

/** Remote control settings */
export interface RemoteSettings {
  enabled: boolean;
  port: number;
  ips?: string[];
}

/** Persisted application settings (data/settings.json) */
export interface AppSettings {
  ndiResolution: Resolution;
  ndiFrameSkip: number;
  recordingResolution: Resolution;
  gridSlotWidth: number;
  remoteEnabled: boolean;
  remotePort: number;
}

/** Settings returned to renderer for the settings dialog */
export interface SettingsDialogData {
  ndiResolution: Resolution;
  ndiResolutions: Resolution[];
  ndiFrameSkip: number;
  ndiEnabled: boolean;
  recordingResolution: Resolution;
  recordingResolutions: Resolution[];
  gridSlotWidth: number;
  remoteEnabled: boolean;
  remotePort: number;
  remoteIPs: string[];
}

/** Claude AI settings */
export interface ClaudeSettings {
  hasKey: boolean;
  maskedKey: string;
  model: string;
  models: ClaudeModel[];
}

/** Claude model definition */
export interface ClaudeModel {
  id: string;
  display_name: string;
}

/** NDI resolution presets */
export const NDI_RESOLUTIONS: Resolution[] = [
  { width: 640, height: 360, label: '640x360 (360p)' },
  { width: 854, height: 480, label: '854x480 (480p)' },
  { width: 1280, height: 720, label: '1280x720 (720p)' },
  { width: 1536, height: 864, label: '1536x864' },
  { width: 1920, height: 1080, label: '1920x1080 (1080p)' },
  { width: 2560, height: 1440, label: '2560x1440 (1440p)' },
  { width: 3072, height: 1824, label: '3072x1824' },
  { width: 3840, height: 2160, label: '3840x2160 (4K)' },
  { width: 0, height: 0, label: 'Match Preview' },
  { width: -1, height: -1, label: 'Custom...' },
];

/** Recording resolution presets */
export const RECORDING_RESOLUTIONS: Resolution[] = [
  { width: 640, height: 360, label: '640x360 (360p)' },
  { width: 854, height: 480, label: '854x480 (480p)' },
  { width: 1280, height: 720, label: '1280x720 (720p)' },
  { width: 1536, height: 864, label: '1536x864' },
  { width: 1920, height: 1080, label: '1920x1080 (1080p)' },
  { width: 2560, height: 1440, label: '2560x1440 (1440p)' },
  { width: 3072, height: 1824, label: '3072x1824' },
  { width: 3840, height: 2160, label: '3840x2160 (4K)' },
  { width: 0, height: 0, label: 'Match Preview' },
];
