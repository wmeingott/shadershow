// WindowManager — creates and manages BrowserWindow instances
// Extracted from main.js window creation/management functions

import { BrowserWindow, screen } from 'electron';
import path from 'path';
import { Logger } from '@shared/logger.js';

const log = new Logger('Window');

/** Display descriptor matching Electron's Display shape */
export interface DisplayInfo {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  [key: string]: unknown;
}

/** Tiled fullscreen configuration forwarded to the fullscreen renderer */
export interface TileConfig {
  layout: { rows: number; cols: number; gap: number };
  tiles: unknown[];
  [key: string]: unknown;
}

/**
 * Manages the main application window, fullscreen output window,
 * and modal dialog windows (custom resolution, texture creator).
 *
 * Owns the `mainWindow` and `fullscreenWindow` references and provides
 * helpers for sending IPC messages to either window.
 */
export class WindowManager {
  mainWindow: BrowserWindow | null = null;
  fullscreenWindow: BrowserWindow | null = null;
  currentFilePath: string | null = null;
  tiledModeActive = false;

  private pendingFullscreenDisplay: DisplayInfo | null = null;
  private readonly appDir: string;

  constructor(appDir: string) {
    this.appDir = appDir;
  }

  // ── Accessors ──────────────────────────────────────────────────────

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  getFullscreenWindow(): BrowserWindow | null {
    return this.fullscreenWindow;
  }

  // ── IPC helpers ────────────────────────────────────────────────────

  /**
   * Send an IPC message to the main window, if it exists and is not destroyed.
   */
  sendToMain(channel: string, ...args: unknown[]): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, ...args);
    }
  }

  /**
   * Send an IPC message to the fullscreen window, if it exists and is not destroyed.
   */
  sendToFullscreen(channel: string, ...args: unknown[]): void {
    if (this.fullscreenWindow && !this.fullscreenWindow.isDestroyed()) {
      this.fullscreenWindow.webContents.send(channel, ...args);
    }
  }

  // ── Main window ────────────────────────────────────────────────────

  /**
   * Create the main application BrowserWindow.
   * Loads `index.html` from the app directory and prevents automatic title updates.
   */
  createWindow(): BrowserWindow {
    this.mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      webPreferences: {
        preload: path.join(this.appDir, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
      backgroundColor: '#1e1e1e',
      title: 'ShaderShow',
    });

    this.mainWindow.loadFile(path.join(this.appDir, 'index.html'));

    // Prevent the page from overwriting the window title
    this.mainWindow.on('page-title-updated', (e) => {
      e.preventDefault();
    });

    return this.mainWindow;
  }

  // ── Title ──────────────────────────────────────────────────────────

  /**
   * Update the main window title to reflect the current file path.
   * Shows "Untitled - ShaderShow" when no file is open.
   */
  updateTitle(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const fileName = this.currentFilePath
      ? path.basename(this.currentFilePath)
      : 'Untitled';
    this.mainWindow.setTitle(`${fileName} - ShaderShow`);
  }

  // ── Fullscreen window ──────────────────────────────────────────────

  /**
   * Begin the fullscreen open flow: close any existing fullscreen window,
   * ask the main window for its current shader state, and stash the
   * target display for when the state reply arrives.
   *
   * The caller must listen for `'fullscreen-state'` from the renderer
   * and then call `createFullscreenWindow()` with the received state.
   */
  openFullscreen(display: DisplayInfo): void {
    // Close existing fullscreen window if any
    if (this.fullscreenWindow) {
      this.fullscreenWindow.close();
      this.fullscreenWindow = null;
    }

    // Request current shader state from main window
    this.sendToMain('request-fullscreen-state');

    // Store the display for when we receive the state
    this.pendingFullscreenDisplay = display;
  }

  /**
   * Return (and clear) the display that was stashed by `openFullscreen()`.
   */
  consumePendingDisplay(): DisplayInfo | null {
    const display = this.pendingFullscreenDisplay;
    this.pendingFullscreenDisplay = null;
    return display;
  }

  /**
   * Create a fullscreen BrowserWindow on the given display, load
   * `fullscreen.html`, and wire up standard events (ESC to close,
   * console piping, closed notification).
   */
  createFullscreenWindow(display: DisplayInfo, shaderState: unknown): BrowserWindow {
    const { x, y, width, height } = display.bounds;
    log.info(`Creating fullscreen window on display ${display.id} (${width}x${height})`);

    this.fullscreenWindow = new BrowserWindow({
      x,
      y,
      width,
      height,
      fullscreen: true,
      frame: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(this.appDir, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
      backgroundColor: '#000000',
    });

    this.fullscreenWindow.loadFile(path.join(this.appDir, 'fullscreen.html'));

    // Pipe fullscreen console.log to main process terminal for debugging
    this.fullscreenWindow.webContents.on('console-message', (_event, _level, message) => {
      if (message.startsWith('[Fullscreen]')) {
        console.log(message);
      }
    });

    // Send shader state once the window is ready
    this.fullscreenWindow.webContents.on('did-finish-load', () => {
      this.sendToFullscreen('init-fullscreen', shaderState);
    });

    // Handle ESC key to close
    this.fullscreenWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.key === 'Escape') {
        this.fullscreenWindow?.close();
      }
    });

    // Notify renderer which display was selected
    this.sendToMain('fullscreen-opened', display.id);

    this.fullscreenWindow.on('closed', () => {
      log.info('Fullscreen window closed');
      // Notify main window that fullscreen closed (for adaptive preview framerate)
      this.sendToMain('fullscreen-closed');
      this.fullscreenWindow = null;
    });

    return this.fullscreenWindow;
  }

  // ── Tiled fullscreen ───────────────────────────────────────────────

  /**
   * Open a tiled fullscreen window on the primary display.
   * Sends `init-tiled-fullscreen` with the supplied configuration once the
   * window finishes loading.
   */
  openTiledFullscreen(config: TileConfig): BrowserWindow {
    // Close existing fullscreen window if any
    if (this.fullscreenWindow) {
      this.fullscreenWindow.close();
      this.fullscreenWindow = null;
    }

    const displays = screen.getAllDisplays();
    // Use primary display or first display
    const display =
      displays.find((d) => d.bounds.x === 0 && d.bounds.y === 0) || displays[0];
    const { x, y, width, height } = display.bounds;
    log.info(`Creating tiled fullscreen window (${width}x${height})`);

    this.fullscreenWindow = new BrowserWindow({
      x,
      y,
      width,
      height,
      fullscreen: true,
      frame: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(this.appDir, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
      backgroundColor: '#000000',
    });

    this.fullscreenWindow.loadFile(path.join(this.appDir, 'fullscreen.html'));

    // Send tile configuration once the window is ready
    this.fullscreenWindow.webContents.on('did-finish-load', () => {
      this.sendToFullscreen('init-tiled-fullscreen', config);
      this.tiledModeActive = true;
    });

    // Handle ESC key to close
    this.fullscreenWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.key === 'Escape') {
        this.fullscreenWindow?.close();
      }
    });

    this.fullscreenWindow.on('closed', () => {
      log.info('Tiled fullscreen window closed');
      this.sendToMain('fullscreen-closed');
      this.fullscreenWindow = null;
      this.tiledModeActive = false;
    });

    return this.fullscreenWindow;
  }

  // ── Dialog windows ─────────────────────────────────────────────────

  /**
   * Show a modal dialog for entering a custom NDI resolution.
   * The dialog uses `preload-dialog.js` which exposes `window.dialogAPI.submitResolution()`.
   * The result is sent via the `'custom-ndi-resolution-from-dialog'` IPC channel.
   */
  showCustomResolutionDialog(): BrowserWindow | null {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return null;

    const dialogWindow = new BrowserWindow({
      width: 300,
      height: 180,
      parent: this.mainWindow,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: path.join(this.appDir, 'preload-dialog.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
      backgroundColor: '#1e1e1e',
      title: 'Custom NDI Resolution',
    });

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #1e1e1e;
          color: #fff;
          padding: 20px;
          margin: 0;
        }
        .row { display: flex; gap: 10px; margin-bottom: 15px; align-items: center; }
        label { width: 60px; }
        input {
          flex: 1;
          padding: 8px;
          background: #333;
          border: 1px solid #555;
          color: #fff;
          border-radius: 3px;
          font-size: 14px;
        }
        input:focus { outline: none; border-color: #0078d4; }
        .buttons { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
        button {
          padding: 8px 20px;
          border: none;
          border-radius: 3px;
          cursor: pointer;
          font-size: 14px;
        }
        .ok { background: #0078d4; color: #fff; }
        .ok:hover { background: #1084d8; }
        .cancel { background: #444; color: #fff; }
        .cancel:hover { background: #555; }
      </style>
    </head>
    <body>
      <div class="row">
        <label>Width:</label>
        <input type="number" id="width" value="1920" min="128" max="7680">
      </div>
      <div class="row">
        <label>Height:</label>
        <input type="number" id="height" value="1080" min="128" max="4320">
      </div>
      <div class="buttons">
        <button class="cancel" onclick="window.close()">Cancel</button>
        <button class="ok" onclick="submit()">OK</button>
      </div>
      <script>
        function submit() {
          const w = parseInt(document.getElementById('width').value);
          const h = parseInt(document.getElementById('height').value);
          if (w >= 128 && h >= 128 && w <= 7680 && h <= 4320) {
            window.dialogAPI.submitResolution(w, h);
          }
          window.close();
        }
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') window.close();
        });
        document.getElementById('width').focus();
        document.getElementById('width').select();
      </script>
    </body>
    </html>
  `;

    dialogWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    return dialogWindow;
  }

  /**
   * Show a modal dialog for creating textures from images.
   * The dialog uses `preload-texture-dialog.js` which exposes `window.textureAPI`.
   * Loads its UI from `texture-dialog.html` in the app directory.
   */
  showTextureCreatorDialog(): BrowserWindow | null {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return null;

    const dialogWindow = new BrowserWindow({
      width: 620,
      height: 760,
      modal: true,
      parent: this.mainWindow,
      resizable: true,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: path.join(this.appDir, 'preload-texture-dialog.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
      backgroundColor: '#1e1e1e',
      title: 'Create Texture',
      autoHideMenuBar: true,
    });

    dialogWindow.setMenu(null);

    dialogWindow.loadFile(path.join(this.appDir, 'texture-dialog.html'));

    return dialogWindow;
  }

  // ── Cleanup ────────────────────────────────────────────────────────

  /**
   * Close all managed windows. Call this during application shutdown.
   */
  closeAll(): void {
    if (this.fullscreenWindow && !this.fullscreenWindow.isDestroyed()) {
      this.fullscreenWindow.close();
    }
    this.fullscreenWindow = null;
    this.tiledModeActive = false;

    // The main window is typically closed by the user or app.quit();
    // we do not force-close it here to avoid interrupting the normal
    // Electron shutdown sequence.
  }
}
