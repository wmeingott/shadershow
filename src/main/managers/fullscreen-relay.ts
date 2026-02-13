// FullscreenRelay — forwards IPC messages between main and fullscreen windows
// Extracted from main.js relay handler boilerplate into a single class.

import { ipcMain, type IpcMainEvent, type BrowserWindow } from 'electron';
import { Logger } from '@shared/logger.js';

const log = new Logger('FullscreenRelay');

/** Dependencies injected into FullscreenRelay at construction time. */
export interface FullscreenRelayDeps {
  getMainWindow: () => BrowserWindow | null;
  getFullscreenWindow: () => BrowserWindow | null;
  onFullscreenStateReceived: (shaderState: unknown) => void;
  onTiledModeChanged: (active: boolean) => void;
}

/**
 * One-way relay channels forwarded from the main window to the fullscreen window.
 * Each channel simply re-sends data unchanged.
 */
const MAIN_TO_FULLSCREEN_CHANNELS = [
  'shader-update',
  'time-sync',
  'param-update',
  'batch-param-update',
  'blackout',
  'asset-update',
  'tile-layout-update',
  'tile-assign',
  'tile-param-update',
  'mixer-param-update',
  'mixer-alpha-update',
  'mixer-blend-mode',
  'mixer-channel-update',
  'init-tiled-fullscreen',
] as const;

/**
 * Manages IPC relay between the main renderer window and the fullscreen window.
 *
 * Most messages are simple one-way forwards (main -> fullscreen or fullscreen -> main).
 * A few channels require special handling (bidirectional preset-sync, fullscreen-state
 * triggering window creation, exit-tiled-mode updating tiled state).
 */
export class FullscreenRelay {
  private readonly deps: FullscreenRelayDeps;

  constructor(deps: FullscreenRelayDeps) {
    this.deps = deps;
  }

  /**
   * Register all IPC relay handlers.
   * Call this once during application startup.
   */
  registerAll(): void {
    // Simple main -> fullscreen relays
    for (const channel of MAIN_TO_FULLSCREEN_CHANNELS) {
      this.relay(channel);
    }

    // Fullscreen -> main: forward FPS data
    this.registerFullscreenFps();

    // Bidirectional: preset sync based on sender identity
    this.registerPresetSync();

    // Special: fullscreen-state triggers window creation
    this.registerFullscreenState();

    // Special: exit-tiled-mode forwards + updates tiled state
    this.registerExitTiledMode();

    log.debug('All relay handlers registered');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Send a message to the fullscreen window if it exists and is not destroyed.
   */
  private sendToFullscreen(channel: string, data?: unknown): void {
    const win = this.deps.getFullscreenWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }

  /**
   * Send a message to the main window if it exists and is not destroyed.
   */
  private sendToMain(channel: string, data?: unknown): void {
    const win = this.deps.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }

  /**
   * Register a simple one-way relay: renderer -> main process -> fullscreen window.
   * The data is forwarded unchanged.
   */
  private relay(channel: string): void {
    ipcMain.on(channel, (_event: IpcMainEvent, data: unknown) => {
      log.debug(`Relay ${channel}`);
      this.sendToFullscreen(channel, data);
    });
  }

  /**
   * Forward FPS data from the fullscreen window back to the main window.
   */
  private registerFullscreenFps(): void {
    ipcMain.on('fullscreen-fps', (_event: IpcMainEvent, fps: unknown) => {
      this.sendToMain('fullscreen-fps', fps);
    });
  }

  /**
   * Bidirectional preset sync: forward presets in the opposite direction
   * of whoever sent them (main -> fullscreen or fullscreen -> main).
   */
  private registerPresetSync(): void {
    ipcMain.on('preset-sync', (event: IpcMainEvent, data: unknown) => {
      const senderId = event.sender.id;
      const mainWin = this.deps.getMainWindow();
      const fsWin = this.deps.getFullscreenWindow();

      // Forward to fullscreen if sender is the main window
      if (mainWin && !mainWin.isDestroyed() && senderId === mainWin.webContents.id) {
        if (fsWin && !fsWin.isDestroyed()) {
          fsWin.webContents.send('preset-sync', data);
        }
      }

      // Forward to main if sender is the fullscreen window
      if (fsWin && !fsWin.isDestroyed() && senderId === fsWin.webContents.id) {
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send('preset-sync', data);
        }
      }
    });
  }

  /**
   * When the main window responds with its current state, forward it to the
   * dependency callback which triggers fullscreen window creation.
   */
  private registerFullscreenState(): void {
    ipcMain.on('fullscreen-state', (_event: IpcMainEvent, shaderState: unknown) => {
      log.debug('Received fullscreen-state, creating fullscreen window');
      this.deps.onFullscreenStateReceived(shaderState);
    });
  }

  /**
   * Forward exit-tiled-mode to the fullscreen window and notify the callback
   * that tiled mode has been deactivated.
   */
  private registerExitTiledMode(): void {
    ipcMain.on('exit-tiled-mode', () => {
      this.sendToFullscreen('exit-tiled-mode');
      this.deps.onTiledModeChanged(false);
    });
  }
}
