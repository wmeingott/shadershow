// RemoteManager — Remote control server lifecycle management
// Manages the Express + WebSocket remote control server and provides
// IPC query/dispatch helpers for communication with the renderer process.

import os from 'os';
import { ipcMain } from 'electron';
import { Logger } from '@shared/logger.js';
import { RemoteServer } from '../remote-server.js';

const log = new Logger('Remote');

const QUERY_TIMEOUT_MS = 3000;

/** Dependencies injected by the caller (main process wiring) */
export interface RemoteManagerDeps {
  getMainWindow: () => Electron.BrowserWindow | null;
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

      const timeout = setTimeout(() => {
        ipcMain.removeListener(`${channel}-response`, listener);
        reject(new Error('timeout'));
      }, QUERY_TIMEOUT_MS);

      const listener = (_event: Electron.IpcMainEvent, result: unknown): void => {
        clearTimeout(timeout);
        resolve(result);
      };

      ipcMain.once(`${channel}-response`, listener);
      mainWindow.webContents.send(channel, data ?? null);
    });
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
