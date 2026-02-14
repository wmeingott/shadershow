// RemoteManager — Remote control server lifecycle management
// Manages the Express + WebSocket remote control server and provides
// IPC query/dispatch helpers for communication with the renderer process.

import os from 'os';
import { ipcMain, screen } from 'electron';
import { Logger } from '@shared/logger.js';
import { RemoteServer } from '../remote-server.js';
import type { DisplayInfoDTO } from '../remote-server.js';
import type { WindowManager, DisplayInfo } from './window-manager.js';

const log = new Logger('Remote');

const QUERY_TIMEOUT_MS = 3000;
let _nextQueryId = 1;

/** Dependencies injected by the caller (main process wiring) */
export interface RemoteManagerDeps {
  getMainWindow: () => Electron.BrowserWindow | null;
  getWindowManager?: () => WindowManager;
}

export class RemoteManager {
  private server: RemoteServer | null = null;
  private readonly deps: RemoteManagerDeps;

  constructor(deps: RemoteManagerDeps) {
    this.deps = deps;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the remote control server on the given port.
   * No-op if the server is already running.
   */
  start(port: number): void {
    if (this.server) return;

    log.info(`Starting remote control server on port ${port}`);

    this.server = new RemoteServer({
      queryRenderer: (channel: string, data?: unknown) => this.queryRenderer(channel, data),
      dispatchAction: (channel: string, data: unknown) => this.dispatchAction(channel, data),
      getDisplays: () => this.getDisplays(),
      openFullscreenOnDisplay: (displayId: number) => this.openFullscreenOnDisplay(displayId),
      closeFullscreen: () => this.closeFullscreenWindow(),
      getPreviewFrame: () => this.getPreviewFrame(),
    });

    this.server.start(port);
  }

  /**
   * Stop the remote control server and release resources.
   */
  stop(): void {
    if (this.server) {
      log.info('Stopping remote control server');
      this.server.stop();
      this.server = null;
    }
  }

  /**
   * Forward a state change to all connected WebSocket clients.
   */
  broadcast(type: string, data: unknown): void {
    if (this.server) {
      this.server.broadcast(type, data);
    }
  }

  /**
   * Return all non-internal IPv4 addresses on the local machine.
   * Useful for displaying the remote control URL to the user.
   */
  getLocalIPs(): string[] {
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
   * Check whether the remote server is currently running.
   */
  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Send an IPC message to the renderer and wait for a response.
   *
   * The renderer is expected to reply on `${channel}-response` within
   * {@link QUERY_TIMEOUT_MS} milliseconds. Rejects if the main window
   * is unavailable or the response times out.
   */
  queryRenderer(channel: string, data?: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const mainWindow = this.deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        reject(new Error('No main window'));
        return;
      }

      // Use correlation ID to match responses when multiple queries are in-flight
      const queryId = _nextQueryId++;
      const responseChannel = `${channel}-response`;

      const timeout = setTimeout(() => {
        ipcMain.removeListener(responseChannel, listener);
        reject(new Error('timeout'));
      }, QUERY_TIMEOUT_MS);

      // Use persistent listener that filters by queryId and removes itself on match
      const listener = (_event: Electron.IpcMainEvent, result: unknown): void => {
        const res = result as Record<string, unknown> | null;
        if (res && res._queryId !== undefined && res._queryId !== queryId) {
          return; // Not our response — keep listening
        }
        ipcMain.removeListener(responseChannel, listener);
        clearTimeout(timeout);
        resolve(result);
      };

      ipcMain.on(responseChannel, listener);
      // Inject correlation ID into the request
      const payload = (data && typeof data === 'object') ? { ...data as object, _queryId: queryId } : { _queryId: queryId };
      mainWindow.webContents.send(channel, payload);
    });
  }

  // ---------------------------------------------------------------------------
  // Display / Fullscreen helpers
  // ---------------------------------------------------------------------------

  private getDisplays(): DisplayInfoDTO[] {
    const wm = this.deps.getWindowManager?.();
    const displays = screen.getAllDisplays();
    const fsWin = wm?.getFullscreenWindow();
    const fsDisplayId = fsWin && !fsWin.isDestroyed()
      ? screen.getDisplayMatching(fsWin.getBounds()).id
      : null;

    return displays.map((d, i) => ({
      id: d.id,
      label: `${d.bounds.width}x${d.bounds.height}${i === 0 ? ' (Primary)' : ''}`,
      primary: i === 0,
      hasFullscreen: d.id === fsDisplayId,
      bounds: d.bounds,
    }));
  }

  private openFullscreenOnDisplay(displayId: number): void {
    const wm = this.deps.getWindowManager?.();
    if (!wm) return;
    const displays = screen.getAllDisplays();
    const display = displays.find(d => d.id === displayId);
    if (display) {
      wm.openFullscreen(display as unknown as DisplayInfo);
    }
  }

  private closeFullscreenWindow(): void {
    const wm = this.deps.getWindowManager?.();
    if (!wm) return;
    const fsWin = wm.getFullscreenWindow();
    if (fsWin && !fsWin.isDestroyed()) {
      fsWin.close();
    }
  }

  private async getPreviewFrame(): Promise<Buffer | null> {
    try {
      const result = await this.queryRenderer('remote-get-preview-frame') as { dataUrl: string } | null;
      if (result && result.dataUrl) {
        const base64 = result.dataUrl.replace(/^data:image\/\w+;base64,/, '');
        return Buffer.from(base64, 'base64');
      }
    } catch {
      // timeout or no window — ignore
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Send an IPC message to the renderer without waiting for a response.
   * Silently drops the message if the main window is unavailable.
   */
  private dispatchAction(channel: string, data: unknown): void {
    const mainWindow = this.deps.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  }
}
