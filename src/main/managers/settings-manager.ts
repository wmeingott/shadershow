// SettingsManager — loads, saves, and serves application settings
// Extracted from main.js settings-related code

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import { Logger } from '@shared/logger.js';
import {
  type Resolution,
  type AppSettings,
  type SettingsDialogData,
  NDI_RESOLUTIONS,
  RECORDING_RESOLUTIONS,
} from '@shared/types/settings.js';
import { type ArtNetMapping, ARTNET_DEFAULTS } from '@shared/types/artnet.js';

const log = new Logger('Settings');

/** Default settings values */
const DEFAULTS: AppSettings = {
  ndiResolution: { width: 1920, height: 1080, label: '1920x1080 (1080p)' },
  ndiFrameSkip: 4,
  recordingResolution: { width: 1920, height: 1080, label: '1920x1080 (1080p)' },
  gridSlotWidth: 0,
  remoteEnabled: false,
  remotePort: 9876,
  remoteToken: '',
  artnetEnabled: ARTNET_DEFAULTS.enabled,
  artnetUniverse: ARTNET_DEFAULTS.universe,
  artnetMappings: ARTNET_DEFAULTS.mappings,
};

/**
 * Manages persistent application settings (data/settings.json).
 *
 * Holds in-memory state for NDI resolution, recording resolution, frame skip,
 * grid slot width, and remote control settings. Provides load/save to disk
 * and a getter that assembles the full SettingsDialogData for the renderer.
 */
export class SettingsManager {
  private readonly settingsFile: string;

  // Mutable settings state
  ndiResolution: Resolution;
  ndiFrameSkip: number;
  recordingResolution: Resolution;
  gridSlotWidth: number;
  remoteEnabled: boolean;
  remotePort: number;
  remoteToken: string;
  artnetEnabled: boolean;
  artnetUniverse: number;
  artnetMappings: ArtNetMapping[];

  constructor(settingsFile: string) {
    this.settingsFile = settingsFile;

    // Initialize with defaults
    this.ndiResolution = { ...DEFAULTS.ndiResolution };
    this.ndiFrameSkip = DEFAULTS.ndiFrameSkip;
    this.recordingResolution = { ...DEFAULTS.recordingResolution };
    this.gridSlotWidth = DEFAULTS.gridSlotWidth;
    this.remoteEnabled = DEFAULTS.remoteEnabled;
    this.remotePort = DEFAULTS.remotePort;
    this.remoteToken = DEFAULTS.remoteToken;
    this.artnetEnabled = DEFAULTS.artnetEnabled;
    this.artnetUniverse = DEFAULTS.artnetUniverse;
    this.artnetMappings = [...DEFAULTS.artnetMappings];
  }

  /**
   * Load settings from the JSON file on disk.
   * Missing or invalid fields retain their current (default) values.
   */
  async load(): Promise<void> {
    log.debug('Loading settings...');
    try {
      const raw = await this.readFileOrNull(this.settingsFile);
      if (raw) {
        const data = JSON.parse(raw) as Partial<AppSettings & { paramRanges?: unknown }>;

        if (data.ndiResolution) {
          this.ndiResolution = data.ndiResolution;
        }
        if (data.recordingResolution) {
          this.recordingResolution = data.recordingResolution;
        }
        if (typeof data.ndiFrameSkip === 'number' && data.ndiFrameSkip >= 1) {
          this.ndiFrameSkip = data.ndiFrameSkip;
        }
        if (typeof data.gridSlotWidth === 'number' && data.gridSlotWidth > 0) {
          this.gridSlotWidth = data.gridSlotWidth;
        }
        if (typeof data.remoteEnabled === 'boolean') {
          this.remoteEnabled = data.remoteEnabled;
        }
        if (typeof data.remotePort === 'number' && data.remotePort >= 1024 && data.remotePort <= 65535) {
          this.remotePort = data.remotePort;
        }
        if (typeof data.remoteToken === 'string' && data.remoteToken) {
          this.remoteToken = data.remoteToken;
        }
        if (typeof data.artnetEnabled === 'boolean') {
          this.artnetEnabled = data.artnetEnabled;
        }
        if (typeof data.artnetUniverse === 'number' && data.artnetUniverse >= 0) {
          this.artnetUniverse = data.artnetUniverse;
        }
        if (Array.isArray(data.artnetMappings)) {
          this.artnetMappings = data.artnetMappings;
        }
      }
    } catch (err) {
      log.error('Failed to load settings:', err);
    }
  }

  /**
   * Save settings to the JSON file on disk.
   * Merges with existing file contents so that fields managed by other
   * parts of the application (e.g. paramRanges) are preserved.
   *
   * @param additionalData - Extra key/value pairs to merge into the saved JSON
   */
  async save(additionalData: Record<string, unknown> = {}): Promise<void> {
    try {
      // Load existing settings to preserve data we don't manage
      let existingData: Record<string, unknown> = {};
      const raw = await this.readFileOrNull(this.settingsFile);
      if (raw) {
        existingData = JSON.parse(raw) as Record<string, unknown>;
      }

      const data: Record<string, unknown> = {
        ...existingData,
        ndiResolution: this.ndiResolution,
        ndiFrameSkip: this.ndiFrameSkip,
        recordingResolution: this.recordingResolution,
        remoteEnabled: this.remoteEnabled,
        remotePort: this.remotePort,
        remoteToken: this.remoteToken,
        artnetEnabled: this.artnetEnabled,
        artnetUniverse: this.artnetUniverse,
        artnetMappings: this.artnetMappings,
        ...additionalData,
      };

      await fs.promises.writeFile(this.settingsFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      log.error('Failed to save settings:', err);
    }
  }

  /**
   * Assemble the full settings dialog payload for the renderer.
   * Includes resolution presets, current values, and remote IPs.
   */
  async getSettings(): Promise<SettingsDialogData> {
    // Load grid slot width from file (it may have been written by other parts
    // of the app without going through this manager)
    let gridSlotWidth: number | null = this.gridSlotWidth || null;

    try {
      const raw = await this.readFileOrNull(this.settingsFile);
      if (raw) {
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (typeof data.gridSlotWidth === 'number' && data.gridSlotWidth > 0) {
          gridSlotWidth = data.gridSlotWidth;
        }
      }
    } catch (err) {
      log.error('Failed to load settings from file:', err);
    }

    return {
      ndiResolution: this.ndiResolution,
      ndiResolutions: NDI_RESOLUTIONS,
      ndiFrameSkip: this.ndiFrameSkip,
      ndiEnabled: false, // NDI enabled state is managed externally
      recordingResolution: this.recordingResolution,
      recordingResolutions: RECORDING_RESOLUTIONS,
      gridSlotWidth: gridSlotWidth ?? 0,
      remoteEnabled: this.remoteEnabled,
      remotePort: this.remotePort,
      remoteToken: this.remoteToken,
      remoteIPs: this.getRemoteIPs(),
      artnetEnabled: this.artnetEnabled,
      artnetUniverse: this.artnetUniverse,
      artnetMappings: this.artnetMappings,
    };
  }

  /**
   * Return non-internal IPv4 addresses from all network interfaces.
   * Used to display the remote control URL in the settings dialog.
   */
  getRemoteIPs(): string[] {
    const interfaces = os.networkInterfaces();
    const ips: string[] = [];
    for (const iface of Object.values(interfaces)) {
      if (!iface) continue;
      for (const info of iface) {
        if (info.family === 'IPv4' && !info.internal) {
          ips.push(info.address);
        }
      }
    }
    return ips;
  }

  /**
   * Generate a remote token if one doesn't exist yet.
   * Called when the remote server is about to start.
   */
  async ensureRemoteToken(): Promise<string> {
    if (!this.remoteToken) {
      this.remoteToken = crypto.randomBytes(16).toString('hex');
      await this.save();
    }
    return this.remoteToken;
  }

  /** Regenerate the remote control token. */
  async regenerateRemoteToken(): Promise<string> {
    this.remoteToken = crypto.randomBytes(16).toString('hex');
    await this.save();
    return this.remoteToken;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Read a file and return its contents, or null if missing/unreadable.
   */
  private async readFileOrNull(filePath: string): Promise<string | null> {
    try {
      return await fs.promises.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      log.error(`Failed to read ${filePath}:`, err);
      return null;
    }
  }
}
