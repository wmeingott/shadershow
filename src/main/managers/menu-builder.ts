// MenuBuilder — constructs the application menu from injected dependencies
// Extracted from main.js createMenu() and submenu builder functions (lines 190-532)

import { Menu, screen, app, type MenuItemConstructorOptions } from 'electron';
import { type Resolution, NDI_RESOLUTIONS, RECORDING_RESOLUTIONS } from '@shared/types/settings.js';
import { Logger } from '@shared/logger.js';

const log = new Logger('Menu');

/** Dependencies injected into MenuBuilder via the constructor */
export interface MenuBuilderDeps {
  // Actions
  onNewFile: (fileType?: string) => void;
  onOpenFile: () => void;
  onSaveFile: () => void;
  onSaveFileAs: () => void;
  onLoadTexture: (channel: number) => void;
  onLoadVideo: (channel: number) => void;
  onUseCamera: (channel: number) => void;
  onUseAudio: (channel: number) => void;
  onClearChannel: (channel: number) => void;
  onToggleNDI: () => void;
  onSetNDIResolution: (res: Resolution) => void;
  onToggleSyphon: () => void;
  onToggleRecording: () => void;
  onSetRecordingResolution: (res: Resolution) => void;
  onOpenFullscreen: (display: Electron.Display) => void;
  onSaveGridPresetsAs: () => void;
  onLoadGridPresetsFrom: () => void;
  onExportState: () => void;
  onImportState: () => void;
  onShowTextureCreator: () => void;

  // State getters
  getNDIResolution: () => Resolution;
  getNDIEnabled: () => boolean;
  getRecordingResolution: () => Resolution;
  getRecordingEnabled: () => boolean;
  getNDISourceCache: () => Array<{ name: string }>;
  getNDIReceiverSource: (channel: number) => { name: string } | null;

  // Send to renderer
  sendToMain: (channel: string, ...args: unknown[]) => void;

  // Save settings
  onSaveSettings: () => void;
}

/**
 * Builds and installs the application menu.
 *
 * All side-effectful operations (file I/O, window management, NDI, Syphon,
 * recording) are reached through the injected `MenuBuilderDeps`, keeping the
 * menu construction pure and testable.
 */
export class MenuBuilder {
  private readonly deps: MenuBuilderDeps;

  constructor(deps: MenuBuilderDeps) {
    this.deps = deps;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Build the full menu template and set it as the application menu. */
  buildMenu(): void {
    const isMac = process.platform === 'darwin';
    const d = this.deps;

    const template: MenuItemConstructorOptions[] = [
      // macOS app menu
      ...(isMac
        ? [
            {
              label: app.name,
              submenu: [
                { role: 'about' as const },
                { type: 'separator' as const },
                { role: 'services' as const },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { role: 'unhide' as const },
                { type: 'separator' as const },
                { role: 'quit' as const },
              ],
            },
          ]
        : []),

      // ── File ──────────────────────────────────────────────────────────
      {
        label: 'File',
        submenu: [
          {
            label: 'New',
            accelerator: 'CmdOrCtrl+N',
            click: () => d.onNewFile(),
          },
          {
            label: 'Open...',
            accelerator: 'CmdOrCtrl+O',
            click: () => d.onOpenFile(),
          },
          { type: 'separator' },
          {
            label: 'Save',
            accelerator: 'CmdOrCtrl+S',
            click: () => d.onSaveFile(),
          },
          {
            label: 'Save As...',
            accelerator: 'CmdOrCtrl+Shift+S',
            click: () => d.onSaveFileAs(),
          },
          { type: 'separator' },
          // Load Texture to channels 0-3
          {
            label: 'Load Texture to Channel 0',
            click: () => d.onLoadTexture(0),
          },
          {
            label: 'Load Texture to Channel 1',
            click: () => d.onLoadTexture(1),
          },
          {
            label: 'Load Texture to Channel 2',
            click: () => d.onLoadTexture(2),
          },
          {
            label: 'Load Texture to Channel 3',
            click: () => d.onLoadTexture(3),
          },
          { type: 'separator' },
          // Load Video to channels 0-3
          {
            label: 'Load Video to Channel 0',
            click: () => d.onLoadVideo(0),
          },
          {
            label: 'Load Video to Channel 1',
            click: () => d.onLoadVideo(1),
          },
          {
            label: 'Load Video to Channel 2',
            click: () => d.onLoadVideo(2),
          },
          {
            label: 'Load Video to Channel 3',
            click: () => d.onLoadVideo(3),
          },
          { type: 'separator' },
          // Camera for channels 0-3
          {
            label: 'Use Camera for Channel 0',
            click: () => d.onUseCamera(0),
          },
          {
            label: 'Use Camera for Channel 1',
            click: () => d.onUseCamera(1),
          },
          {
            label: 'Use Camera for Channel 2',
            click: () => d.onUseCamera(2),
          },
          {
            label: 'Use Camera for Channel 3',
            click: () => d.onUseCamera(3),
          },
          { type: 'separator' },
          // Audio FFT for channels 0-3
          {
            label: 'Use Audio Input (FFT) for Channel 0',
            click: () => d.onUseAudio(0),
          },
          {
            label: 'Use Audio Input (FFT) for Channel 1',
            click: () => d.onUseAudio(1),
          },
          {
            label: 'Use Audio Input (FFT) for Channel 2',
            click: () => d.onUseAudio(2),
          },
          {
            label: 'Use Audio Input (FFT) for Channel 3',
            click: () => d.onUseAudio(3),
          },
          { type: 'separator' },
          // NDI Source for channels 0-3
          {
            label: 'NDI Source for Channel 0',
            submenu: this.buildNDISourceSubmenu(0),
          },
          {
            label: 'NDI Source for Channel 1',
            submenu: this.buildNDISourceSubmenu(1),
          },
          {
            label: 'NDI Source for Channel 2',
            submenu: this.buildNDISourceSubmenu(2),
          },
          {
            label: 'NDI Source for Channel 3',
            submenu: this.buildNDISourceSubmenu(3),
          },
          { type: 'separator' },
          {
            label: 'Create Texture...',
            click: () => d.onShowTextureCreator(),
          },
          { type: 'separator' },
          // Clear channels 0-3
          {
            label: 'Clear Channel 0',
            click: () => d.onClearChannel(0),
          },
          {
            label: 'Clear Channel 1',
            click: () => d.onClearChannel(1),
          },
          {
            label: 'Clear Channel 2',
            click: () => d.onClearChannel(2),
          },
          {
            label: 'Clear Channel 3',
            click: () => d.onClearChannel(3),
          },
          { type: 'separator' },
          {
            label: 'Save Grid Presets...',
            accelerator: 'CmdOrCtrl+Shift+G',
            click: () => d.onSaveGridPresetsAs(),
          },
          {
            label: 'Load Grid Presets...',
            accelerator: 'CmdOrCtrl+Alt+G',
            click: () => d.onLoadGridPresetsFrom(),
          },
          { type: 'separator' },
          {
            label: 'Export Application State...',
            click: () => d.onExportState(),
          },
          {
            label: 'Import Application State...',
            click: () => d.onImportState(),
          },
          { type: 'separator' },
          isMac ? { role: 'close' as const } : { role: 'quit' as const },
        ],
      },

      // ── Edit ──────────────────────────────────────────────────────────
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },

      // ── View ──────────────────────────────────────────────────────────
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },

      // ── Shader ────────────────────────────────────────────────────────
      {
        label: 'Shader',
        submenu: [
          {
            label: 'Compile',
            accelerator: 'CmdOrCtrl+Enter',
            click: () => d.sendToMain('compile-shader'),
          },
          {
            label: 'Play/Pause',
            accelerator: 'Space',
            click: () => d.sendToMain('toggle-playback'),
          },
          {
            label: 'Reset Time',
            accelerator: 'CmdOrCtrl+R',
            click: () => d.sendToMain('reset-time'),
          },
          {
            label: 'Restart Render',
            click: () => d.sendToMain('restart-render'),
          },
          { type: 'separator' },
          {
            label: 'Fullscreen Preview',
            submenu: this.buildFullscreenSubmenu(),
          },
          {
            label: 'Configure Tiled Display...',
            click: () => d.sendToMain('open-tile-config'),
          },
          { type: 'separator' },
          {
            label: d.getNDIEnabled() ? 'Stop NDI Output' : 'Start NDI Output',
            id: 'ndi-toggle',
            click: () => d.onToggleNDI(),
          },
          {
            label: 'NDI Resolution',
            id: 'ndi-resolution-menu',
            submenu: this.buildNDIResolutionSubmenu(),
          },
          // Syphon toggle — macOS only
          ...(isMac
            ? [
                { type: 'separator' as const },
                {
                  label: 'Start Syphon Output',
                  id: 'syphon-toggle',
                  click: () => d.onToggleSyphon(),
                },
              ]
            : []),
          { type: 'separator' },
          {
            label: d.getRecordingEnabled()
              ? 'Stop Recording'
              : 'Start Recording',
            id: 'recording-toggle',
            accelerator: 'CmdOrCtrl+Shift+R',
            click: () => d.onToggleRecording(),
          },
          {
            label: 'Recording Resolution',
            id: 'recording-resolution-menu',
            submenu: this.buildRecordingResolutionSubmenu(),
          },
          { type: 'separator' },
          {
            label: 'Run Benchmark...',
            click: () => d.sendToMain('run-benchmark'),
          },
        ],
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }

  // ---------------------------------------------------------------------------
  // Private submenu builders
  // ---------------------------------------------------------------------------

  /**
   * Build the "Fullscreen Preview" submenu listing all connected displays.
   * The first display gets the CmdOrCtrl+F accelerator.
   */
  private buildFullscreenSubmenu(): MenuItemConstructorOptions[] {
    const displays = screen.getAllDisplays();
    return displays.map(
      (display, index): MenuItemConstructorOptions => ({
        label: `Display ${index + 1} (${display.size.width}x${display.size.height})`,
        accelerator: index === 0 ? 'CmdOrCtrl+F' : undefined,
        click: () => this.deps.onOpenFullscreen(display),
      }),
    );
  }

  /**
   * Build the "NDI Resolution" submenu with radio items for each preset.
   * The currently active resolution is checked.
   */
  private buildNDIResolutionSubmenu(): MenuItemConstructorOptions[] {
    const currentRes = this.deps.getNDIResolution();
    return NDI_RESOLUTIONS.map(
      (res): MenuItemConstructorOptions => ({
        label: res.label,
        type: 'radio',
        checked: currentRes.label === res.label,
        click: () => this.deps.onSetNDIResolution(res),
      }),
    );
  }

  /**
   * Build the "Recording Resolution" submenu with radio items for each preset.
   * Selecting a resolution saves settings and rebuilds the menu.
   */
  private buildRecordingResolutionSubmenu(): MenuItemConstructorOptions[] {
    const currentRes = this.deps.getRecordingResolution();
    return RECORDING_RESOLUTIONS.map(
      (res): MenuItemConstructorOptions => ({
        label: res.label,
        type: 'radio',
        checked: currentRes.label === res.label,
        click: () => {
          this.deps.onSetRecordingResolution(res);
          log.debug(`Recording resolution set to ${res.label}`);
          this.deps.onSaveSettings();
          this.buildMenu();
        },
      }),
    );
  }

  /**
   * Build the "NDI Source for Channel N" submenu.
   * Contains a "Refresh Sources..." action, a separator, and then either a
   * list of discovered NDI sources (radio items) or a disabled placeholder
   * when no sources have been found.
   */
  private buildNDISourceSubmenu(channel: number): MenuItemConstructorOptions[] {
    const items: MenuItemConstructorOptions[] = [
      {
        label: 'Refresh Sources...',
        click: () => {
          this.deps.sendToMain('refresh-ndi-sources');
          // After refresh the caller should rebuild the menu
          this.buildMenu();
        },
      },
      { type: 'separator' },
    ];

    const sources = this.deps.getNDISourceCache();

    if (sources.length === 0) {
      items.push({
        label: '(No sources found)',
        enabled: false,
      });
    } else {
      const currentSource = this.deps.getNDIReceiverSource(channel);
      for (const source of sources) {
        items.push({
          label: source.name,
          type: 'radio',
          checked: currentSource !== null && currentSource.name === source.name,
          click: () => {
            this.deps.sendToMain('use-ndi-source', channel, source);
          },
        });
      }
    }

    return items;
  }
}
