// IPCRegistry — wires all ipcMain.on and ipcMain.handle calls, delegating
// to the manager classes.  The fullscreen relay handlers (shader-update,
// time-sync, param-update, etc.) are handled by FullscreenRelay, NOT here.

import { ipcMain, screen, BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import { Logger } from '@shared/logger.js';
import { NDI_RESOLUTIONS } from '@shared/types/settings.js';

import type { FileManager } from './managers/file-manager.js';
import type { SettingsManager } from './managers/settings-manager.js';
import type { NDIManager } from './managers/ndi-manager.js';
import type { SyphonManager } from './managers/syphon-manager.js';
import type { RecordingManager } from './managers/recording-manager.js';
import type { ClaudeManager } from './managers/claude-manager.js';
import type { WindowManager, DisplayInfo } from './managers/window-manager.js';
import type { ExportManager } from './managers/export-manager.js';
import type { MenuBuilder } from './managers/menu-builder.js';
import type { RemoteManager } from './managers/remote-manager.js';

const fsPromises = fs.promises;
const log = new Logger('IPC');

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface IPCRegistryDeps {
  fileManager: FileManager;
  settingsManager: SettingsManager;
  ndiManager: NDIManager;
  syphonManager: SyphonManager;
  recordingManager: RecordingManager;
  claudeManager: ClaudeManager;
  windowManager: WindowManager;
  exportManager: ExportManager;
  menuBuilder: MenuBuilder;
  remoteManager: RemoteManager;
}

// ---------------------------------------------------------------------------
// IPCRegistry
// ---------------------------------------------------------------------------

export class IPCRegistry {
  private readonly deps: IPCRegistryDeps;

  constructor(deps: IPCRegistryDeps) {
    this.deps = deps;
  }

  // =========================================================================
  // registerAll — the single entry point that wires every IPC handler
  // =========================================================================

  registerAll(): void {
    this.registerFireAndForget();
    this.registerHandlers();
  }

  // =========================================================================
  // ipcMain.on  (fire-and-forget)
  // =========================================================================

  private registerFireAndForget(): void {
    const {
      fileManager,
      settingsManager,
      ndiManager,
      syphonManager,
      recordingManager,
      windowManager,
      menuBuilder,
      remoteManager,
    } = this.deps;

    // 1. remote-state-changed
    ipcMain.on('remote-state-changed', (_event, { type, data }: { type: string; data: unknown }) => {
      remoteManager.broadcast(type, data);
    });

    // 2. save-content
    ipcMain.on('save-content', async (_event, content: string) => {
      if (windowManager.currentFilePath) {
        try {
          await fsPromises.writeFile(windowManager.currentFilePath, content, 'utf-8');
        } catch (err: unknown) {
          dialog.showErrorBox('Error', `Failed to save file: ${(err as Error).message}`);
        }
      }
    });

    // 3. ndi-frame
    ipcMain.on('ndi-frame', (_event, frameData) => {
      void ndiManager.sendNDIFrame(frameData);
    });

    // 4. set-channel-ndi
    ipcMain.on('set-channel-ndi', async (_event, { channel, source }: { channel: number; source: { name: string; urlAddress: string } }) => {
      if (!Number.isInteger(channel) || channel < 0 || channel > 3) return;
      await ndiManager.useNDISource(channel, source);
    });

    // 5. clear-channel-ndi
    ipcMain.on('clear-channel-ndi', (_event, { channel }: { channel: number }) => {
      if (!Number.isInteger(channel) || channel < 0 || channel > 3) return;
      ndiManager.clearChannelNDI(channel);
      menuBuilder.buildMenu();
    });

    // 6. custom-ndi-resolution-from-dialog
    ipcMain.on('custom-ndi-resolution-from-dialog', async (_event, { width, height }: { width: number; height: number }) => {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 128 || height < 128 || width > 7680 || height > 4320) {
        return;
      }
      await ndiManager.setCustomResolution(width, height);
    });

    // 7. custom-ndi-resolution
    ipcMain.on('custom-ndi-resolution', async (_event, { width, height }: { width: number; height: number }) => {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 128 || height < 128 || width > 7680 || height > 4320) {
        return;
      }
      await ndiManager.setCustomResolution(width, height);
    });

    // 8. preview-resolution
    ipcMain.on('preview-resolution', async (_event, { width, height }: { width: number; height: number }) => {
      const res = {
        width,
        height,
        label: `${width}x${height} (Match Preview)`,
      };
      await ndiManager.setNDIResolution(res);
    });

    // 9. trigger-new-file
    ipcMain.on('trigger-new-file', (_event, fileType?: string) => {
      // Delegate to the new-file flow via window manager
      // This triggers the same logic as the menu "New" action
      const mainWindow = windowManager.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        windowManager.currentFilePath = null;
        mainWindow.webContents.send('new-file', { fileType: fileType || 'shader' });
        windowManager.updateTitle();
      }
    });

    // 10. trigger-open-file
    ipcMain.on('trigger-open-file', async () => {
      const mainWindow = windowManager.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return;

      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [
          { name: 'Shaders & Scenes', extensions: ['frag', 'glsl', 'shader', 'fs', 'jsx', 'js'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        try {
          const content = await fsPromises.readFile(filePath, 'utf-8');
          windowManager.currentFilePath = filePath;
          mainWindow.webContents.send('file-opened', { content, filePath });
          windowManager.updateTitle();
        } catch (err: unknown) {
          dialog.showErrorBox('Error', `Failed to open file: ${(err as Error).message}`);
        }
      }
    });

    // 11. toggle-ndi
    ipcMain.on('toggle-ndi', () => {
      ndiManager.toggleNDIOutput();
    });

    // 12. syphon-frame
    ipcMain.on('syphon-frame', (_event, frameData) => {
      void syphonManager.sendFrame(frameData);
    });

    // 13. toggle-syphon
    ipcMain.on('toggle-syphon', () => {
      void syphonManager.toggle();
    });

    // 14. stop-recording
    ipcMain.on('stop-recording', () => {
      recordingManager.stop();
    });

    // 15. recording-frame
    ipcMain.on('recording-frame', (_event, frameData) => {
      recordingManager.sendFrame(frameData);
    });

    // 16. open-fullscreen-primary
    ipcMain.on('open-fullscreen-primary', () => {
      const displays = screen.getAllDisplays();
      const primaryDisplay =
        displays.find((d) => d.bounds.x === 0 && d.bounds.y === 0) || displays[0];
      windowManager.openFullscreen(primaryDisplay as unknown as DisplayInfo);
    });

    // 17. open-fullscreen-on-display
    ipcMain.on('open-fullscreen-on-display', (_event, displayId: number) => {
      const display = screen.getAllDisplays().find((d) => d.id === displayId);
      if (display) windowManager.openFullscreen(display as unknown as DisplayInfo);
    });

    // 18. close-fullscreen
    ipcMain.on('close-fullscreen', () => {
      const fsWindow = windowManager.getFullscreenWindow();
      if (fsWindow) {
        fsWindow.close();
      }
    });

    // 19. save-settings
    ipcMain.on('save-settings', async (_event, settings: Record<string, unknown>) => {
      this.handleSaveSettings(settings);
    });

    // 20. save-grid-state
    ipcMain.on('save-grid-state', async (_event, gridState: unknown) => {
      await fileManager.saveGridState(gridState);
    });

    // 21. save-presets
    ipcMain.on('save-presets', async (_event, presets: unknown) => {
      await fileManager.savePresets(presets);
    });

    // 22. save-grid-presets-to-file
    ipcMain.on('save-grid-presets-to-file', async (_event, gridState: unknown) => {
      const mainWindow = windowManager.getMainWindow();
      if (!mainWindow) return;

      const result = await dialog.showSaveDialog(mainWindow, {
        filters: [
          { name: 'Grid Presets', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        defaultPath: 'grid-presets.json',
      });

      if (!result.canceled && result.filePath) {
        try {
          await fsPromises.writeFile(result.filePath, JSON.stringify(gridState, null, 2), 'utf-8');
          mainWindow.webContents.send('grid-presets-saved', { filePath: result.filePath });
        } catch (err: unknown) {
          dialog.showErrorBox('Error', `Failed to save grid presets: ${(err as Error).message}`);
        }
      }
    });

    // 23. save-view-state
    ipcMain.on('save-view-state', async (_event, viewState: unknown) => {
      await fileManager.saveViewState(viewState);
    });

    // 24. save-tile-state
    ipcMain.on('save-tile-state', async (_event, tileState: unknown) => {
      await fileManager.saveTileState(tileState);
    });

    // 25. save-tile-presets
    ipcMain.on('save-tile-presets', async (_event, presets: unknown) => {
      await fileManager.saveTilePresets(presets);
    });

    // 26. open-tiled-fullscreen
    ipcMain.on('open-tiled-fullscreen', (_event, config: unknown) => {
      windowManager.openTiledFullscreen(config as Parameters<typeof windowManager.openTiledFullscreen>[0]);
    });

    // 27. open-fullscreen-with-shader
    ipcMain.on('open-fullscreen-with-shader', (_event, shaderState: unknown) => {
      const displays = screen.getAllDisplays();
      const display =
        displays.find((d) => d.bounds.x === 0 && d.bounds.y === 0) || displays[0];

      // Close existing fullscreen window
      const fsWindow = windowManager.getFullscreenWindow();
      if (fsWindow) {
        fsWindow.close();
      }

      windowManager.createFullscreenWindow(display as unknown as DisplayInfo, shaderState);
    });

    // 28. close-texture-dialog
    ipcMain.on('close-texture-dialog', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) win.close();
    });
  }

  // =========================================================================
  // ipcMain.handle  (async, returns value)
  // =========================================================================

  private registerHandlers(): void {
    const {
      fileManager,
      settingsManager,
      ndiManager,
      recordingManager,
      claudeManager,
      windowManager,
    } = this.deps;

    // 1. get-default-shader
    ipcMain.handle('get-default-shader', async () => {
      return DEFAULT_SHADER;
    });

    // 2. get-default-scene
    ipcMain.handle('get-default-scene', async () => {
      return DEFAULT_SCENE;
    });

    // 3. load-shader-for-grid
    ipcMain.handle('load-shader-for-grid', async () => {
      const mainWindow = windowManager.getMainWindow();
      if (!mainWindow) return null;

      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [
          { name: 'Shaders & Scenes', extensions: ['frag', 'glsl', 'shader', 'fs', 'jsx', 'js'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        try {
          const content = await fsPromises.readFile(filePath, 'utf-8');
          return { content, filePath };
        } catch (err: unknown) {
          return { error: (err as Error).message };
        }
      }
      return null;
    });

    // 4. load-grid-state
    ipcMain.handle('load-grid-state', async () => {
      return fileManager.loadGridState();
    });

    // 5. load-presets
    ipcMain.handle('load-presets', async () => {
      return fileManager.loadPresets();
    });

    // 6. find-ndi-sources
    ipcMain.handle('find-ndi-sources', async () => {
      return ndiManager.refreshNDISources();
    });

    // 7. start-recording
    ipcMain.handle('start-recording', async () => {
      return this.handleStartRecording();
    });

    // 8. get-displays
    ipcMain.handle('get-displays', () => {
      const displays = screen.getAllDisplays();
      log.debug(`Enumerated ${displays.length} displays`);
      return displays.map((display, index) => ({
        id: display.id,
        label: `Display ${index + 1} (${display.size.width}x${display.size.height})`,
        primary: display.bounds.x === 0 && display.bounds.y === 0,
      }));
    });

    // 9. get-settings
    ipcMain.handle('get-settings', async () => {
      return settingsManager.getSettings();
    });

    // 10. save-shader-to-slot
    ipcMain.handle('save-shader-to-slot', async (_event, slotIndex: number, shaderCode: string) => {
      return fileManager.saveShaderToSlot(slotIndex, shaderCode);
    });

    // 11. load-shader-from-slot
    ipcMain.handle('load-shader-from-slot', async (_event, slotIndex: number) => {
      return fileManager.loadShaderFromSlot(slotIndex);
    });

    // 12. delete-shader-from-slot
    ipcMain.handle('delete-shader-from-slot', async (_event, slotIndex: number) => {
      return fileManager.deleteShaderFromSlot(slotIndex);
    });

    // 13. read-file-content
    ipcMain.handle('read-file-content', async (_event, filePath: string) => {
      return fileManager.readFileContent(filePath);
    });

    // 14. load-file-texture
    ipcMain.handle('load-file-texture', async (_event, name: string) => {
      return fileManager.loadFileTexture(name);
    });

    // 15. save-texture
    ipcMain.handle('save-texture', async (_event, name: string, dataUrl: string) => {
      try {
        if (!name || !/^[\w-]+$/.test(name)) {
          return { success: false, error: 'Invalid texture name. Use only letters, numbers, underscores, and hyphens.' };
        }
        await fileManager.ensureDataDir();
        const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
        const filePath = path.join(fileManager.texturesDir, `${name}.png`);
        await fsPromises.writeFile(filePath, Buffer.from(base64Data, 'base64'));
        return { success: true, path: filePath };
      } catch (err: unknown) {
        log.error(`Failed to save texture "${name}":`, err);
        return { success: false, error: (err as Error).message };
      }
    });

    // 16. open-image-for-texture
    ipcMain.handle('open-image-for-texture', async () => {
      const mainWindow = windowManager.getMainWindow();
      const parentWindow = BrowserWindow.getFocusedWindow() || mainWindow;
      if (!parentWindow) return { canceled: true };

      const result = await dialog.showOpenDialog(parentWindow, {
        properties: ['openFile'],
        filters: [
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tiff'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }

      const filePath = result.filePaths[0];
      try {
        const data = await fsPromises.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.bmp': 'image/bmp',
          '.webp': 'image/webp',
          '.tiff': 'image/tiff',
        };
        const mimeType = mimeTypes[ext] || 'image/png';
        const dataUrl = `data:${mimeType};base64,${data.toString('base64')}`;
        return { canceled: false, dataUrl, fileName: path.basename(filePath, ext) };
      } catch (err: unknown) {
        return { canceled: true, error: (err as Error).message };
      }
    });

    // 17. list-file-textures
    ipcMain.handle('list-file-textures', async () => {
      return fileManager.listFileTextures();
    });

    // 18. open-media-for-asset
    ipcMain.handle('open-media-for-asset', async () => {
      return fileManager.openMediaForAsset(windowManager.getMainWindow());
    });

    // 19. copy-media-to-library
    ipcMain.handle('copy-media-to-library', async (_event, sourcePath: string) => {
      return fileManager.copyMediaToLibrary(sourcePath);
    });

    // 20. get-media-absolute-path
    ipcMain.handle('get-media-absolute-path', async (_event, mediaPath: string) => {
      return fileManager.getMediaAbsolutePath(mediaPath);
    });

    // 21. load-media-data-url
    ipcMain.handle('load-media-data-url', async (_event, mediaPath: string) => {
      return fileManager.loadMediaDataUrl(mediaPath);
    });

    // 22. export-button-data
    ipcMain.handle('export-button-data', async (_event, format: string, data: unknown, defaultName: string) => {
      return this.handleExportButtonData(format, data, defaultName);
    });

    // 23. import-button-data
    ipcMain.handle('import-button-data', async (_event, format: string) => {
      return this.handleImportButtonData(format);
    });

    // 24. export-button-data-bulk
    ipcMain.handle('export-button-data-bulk', async (_event, format: string, items: Array<{ fileName: string; data: unknown }>) => {
      return this.handleExportButtonDataBulk(format, items);
    });

    // 25. import-button-data-bulk
    ipcMain.handle('import-button-data-bulk', async (_event, format: string) => {
      return this.handleImportButtonDataBulk(format);
    });

    // 26. export-textures-to-folder
    ipcMain.handle('export-textures-to-folder', async (_event, folder: string, textureNames: string[]) => {
      if (!folder || !Array.isArray(textureNames) || textureNames.length === 0) {
        return { exported: 0 };
      }

      const destDir = path.join(folder, 'textures');
      await fsPromises.mkdir(destDir, { recursive: true });

      let exported = 0;
      const errors: string[] = [];
      for (const name of textureNames) {
        if (!/^[\w-]+$/.test(name)) continue;
        const src = path.join(fileManager.texturesDir, `${name}.png`);
        const dest = path.join(destDir, `${name}.png`);
        try {
          await fsPromises.access(src);
          await fsPromises.copyFile(src, dest);
          exported++;
        } catch (err: unknown) {
          errors.push(`${name}: ${(err as Error).message}`);
        }
      }
      return { exported, errors };
    });

    // 27. import-textures-from-folder
    ipcMain.handle('import-textures-from-folder', async (_event, sourceFolder: string) => {
      if (!sourceFolder) return { imported: 0 };

      const srcDir = path.join(sourceFolder, 'textures');
      let files: string[];
      try {
        files = await fsPromises.readdir(srcDir);
      } catch {
        return { imported: 0 };
      }

      const pngFiles = files.filter((f) => f.endsWith('.png'));
      if (pngFiles.length === 0) return { imported: 0 };

      await fsPromises.mkdir(fileManager.texturesDir, { recursive: true });

      let imported = 0;
      const skipped: string[] = [];
      const errors: string[] = [];
      for (const file of pngFiles) {
        const dest = path.join(fileManager.texturesDir, file);
        const src = path.join(srcDir, file);
        try {
          await fsPromises.access(dest);
          skipped.push(file);
        } catch {
          try {
            await fsPromises.copyFile(src, dest);
            imported++;
          } catch (err: unknown) {
            errors.push(`${file}: ${(err as Error).message}`);
          }
        }
      }
      return { imported, skipped, errors };
    });

    // 28. load-view-state
    ipcMain.handle('load-view-state', async () => {
      return fileManager.loadViewState();
    });

    // 29. load-tile-state
    ipcMain.handle('load-tile-state', async () => {
      return fileManager.loadTileState();
    });

    // 30. load-tile-presets
    ipcMain.handle('load-tile-presets', async () => {
      return fileManager.loadTilePresets();
    });

    // 31. get-display-refresh-rate
    ipcMain.handle('get-display-refresh-rate', () => {
      const fsWindow = windowManager.getFullscreenWindow();
      if (fsWindow && !fsWindow.isDestroyed()) {
        const display = screen.getDisplayMatching(fsWindow.getBounds());
        return display.displayFrequency || 60;
      }
      const primaryDisplay = screen.getPrimaryDisplay();
      return primaryDisplay.displayFrequency || 60;
    });

    // ── Claude IPC handlers ────────────────────────────────────────────

    // 32. get-claude-key
    ipcMain.handle('get-claude-key', async () => {
      return claudeManager.getSettings();
    });

    // 33. save-claude-key
    ipcMain.handle('save-claude-key', async (_event, apiKey: string, model: string) => {
      return claudeManager.saveKey(apiKey, model);
    });

    // 34. get-claude-models
    ipcMain.handle('get-claude-models', async () => {
      return claudeManager.getModels();
    });

    // 35. set-claude-model
    ipcMain.handle('set-claude-model', async (_event, model: string) => {
      return claudeManager.saveKey(null, model);
    });

    // 36. stream-claude-prompt
    ipcMain.on('stream-claude-prompt', (event, data: { prompt: string; context?: { currentCode?: string; customParams?: string }; renderMode?: 'shader' | 'scene' }) => {
      const { prompt, context, renderMode } = data;
      claudeManager.streamPrompt(
        prompt,
        context,
        renderMode || 'shader',
        (text) => { event.sender.send('claude-stream-chunk', { text }); },
        () => { event.sender.send('claude-stream-end', { complete: true }); },
        (error) => { event.sender.send('claude-error', { error }); },
      );
    });

    // 37. cancel-claude-request
    ipcMain.on('cancel-claude-request', () => {
      claudeManager.cancelRequest();
    });
  }

  // =========================================================================
  // Complex handler implementations
  // =========================================================================

  /**
   * Handle the `save-settings` IPC message.
   *
   * 1. Update NDI resolution via ndiManager if changed
   * 2. Update NDI frame skip via settingsManager
   * 3. Update recording resolution via settingsManager
   * 4. Handle remote control enable/disable via remoteManager
   * 5. Save to file via settingsManager
   * 6. Send settings-changed to main window
   */
  private async handleSaveSettings(settings: Record<string, unknown>): Promise<void> {
    const { settingsManager, ndiManager, remoteManager, windowManager, menuBuilder } = this.deps;

    // 1. NDI resolution
    if (settings.ndiResolution && typeof settings.ndiResolution === 'object') {
      const ndiRes = settings.ndiResolution as { width: number; height: number; label: string };
      const known = NDI_RESOLUTIONS.find((r) => r.label === ndiRes.label);
      if (known) {
        await ndiManager.setNDIResolution(known);
      } else if (ndiRes.width > 0) {
        await ndiManager.setNDIResolution(ndiRes);
      }
    }

    // 2. NDI frame skip
    if (typeof settings.ndiFrameSkip === 'number' && (settings.ndiFrameSkip as number) >= 1) {
      const skip = Math.floor(settings.ndiFrameSkip as number);
      settingsManager.ndiFrameSkip = skip;
      ndiManager.setFrameSkip(skip);
      // Notify renderer to update its frame skip value
      windowManager.sendToMain('ndi-frame-skip-changed', skip);
    }

    // 3. Recording resolution
    if (settings.recordingResolution && typeof settings.recordingResolution === 'object') {
      settingsManager.recordingResolution = settings.recordingResolution as { width: number; height: number; label: string };
    }

    // 4. Remote control settings
    if (typeof settings.remoteEnabled === 'boolean') {
      const enabled = settings.remoteEnabled as boolean;
      settingsManager.remoteEnabled = enabled;

      if (enabled) {
        if (typeof settings.remotePort === 'number') {
          const port = settings.remotePort as number;
          if (port >= 1024 && port <= 65535) {
            // Port changed — restart server
            if (settingsManager.remotePort !== port) {
              settingsManager.remotePort = port;
              remoteManager.stop();
            }
          }
        }
        remoteManager.start(settingsManager.remotePort);
      } else {
        remoteManager.stop();
      }
    }
    if (typeof settings.remotePort === 'number') {
      const port = settings.remotePort as number;
      if (port >= 1024 && port <= 65535) {
        settingsManager.remotePort = port;
      }
    }

    // 5. Save all settings including param ranges and grid slot width
    const additionalData: Record<string, unknown> = {};
    if (settings.paramRanges) {
      additionalData.paramRanges = settings.paramRanges;
    }
    if (settings.gridSlotWidth) {
      additionalData.gridSlotWidth = settings.gridSlotWidth;
    }
    additionalData.remoteEnabled = settingsManager.remoteEnabled;
    additionalData.remotePort = settingsManager.remotePort;

    await settingsManager.save(additionalData);

    // 6. Notify renderer
    windowManager.sendToMain('settings-changed', settings);
  }

  /**
   * Handle the `start-recording` IPC handler.
   *
   * Shows a save dialog, resolves recording resolution (including the
   * "Match Preview" sentinel), then delegates to the RecordingManager.
   */
  private async handleStartRecording(): Promise<{ filePath?: string; width?: number; height?: number; error?: string; canceled?: boolean }> {
    const { recordingManager, settingsManager, windowManager } = this.deps;

    if (recordingManager.isRunning()) {
      return { error: 'Already recording' };
    }

    const mainWindow = windowManager.getMainWindow();
    if (!mainWindow) {
      return { error: 'No main window available' };
    }

    // Show save dialog
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Recording',
      defaultPath: `recording-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.mp4`,
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    // Resolve recording resolution (handle "Match Preview")
    let recWidth = settingsManager.recordingResolution.width;
    let recHeight = settingsManager.recordingResolution.height;

    if (recWidth === 0 || recHeight === 0) {
      // Match Preview — ask renderer for its current size
      const previewRes = await new Promise<{ width: number; height: number }>((resolve) => {
        const timeout = setTimeout(() => resolve({ width: 1920, height: 1080 }), 5000);
        ipcMain.once('preview-resolution-for-recording', (_event, data: { width: number; height: number }) => {
          clearTimeout(timeout);
          resolve(data);
        });
        mainWindow.webContents.send('request-preview-resolution-for-recording');
      });
      recWidth = previewRes.width;
      recHeight = previewRes.height;
    }

    // Start recording via the manager
    const startResult = recordingManager.start(
      recWidth,
      recHeight,
      result.filePath,
      (code) => {
        // Recording finished — notify renderer
        windowManager.sendToMain('recording-status', {
          enabled: false,
          filePath: result.filePath,
          exitCode: code,
        });
      },
      (err) => {
        // Recording error — notify renderer
        windowManager.sendToMain('recording-status', {
          enabled: false,
          error: err.message,
        });
      },
    );

    if (startResult.error) {
      return startResult;
    }

    // Notify renderer that recording has started
    windowManager.sendToMain('recording-status', {
      enabled: true,
      width: startResult.width,
      height: startResult.height,
      filePath: result.filePath,
    });

    return startResult;
  }

  // ── Button data export/import helpers ──────────────────────────────

  private static readonly BUTTON_DATA_FORMATS: Record<string, { ext: string; label: string }> = {
    'shadershow-shader': { ext: 'shader', label: 'ShaderShow Shader' },
    'shadershow-comp': { ext: 'comp', label: 'ShaderShow Composition' },
    'shadershow-vis': { ext: 'vis', label: 'ShaderShow Visual Preset' },
  };

  private async handleExportButtonData(
    format: string,
    data: unknown,
    defaultName: string,
  ): Promise<{ success?: boolean; filePath?: string; canceled?: boolean; error?: string }> {
    const fmt = IPCRegistry.BUTTON_DATA_FORMATS[format];
    if (!fmt) return { error: 'Unknown format' };

    const mainWindow = this.deps.windowManager.getMainWindow();
    if (!mainWindow) return { error: 'No main window' };

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: `Export ${fmt.label}`,
      defaultPath: defaultName ? `${defaultName}.${fmt.ext}` : `export.${fmt.ext}`,
      filters: [{ name: fmt.label, extensions: [fmt.ext] }],
    });
    if (canceled || !filePath) return { canceled: true };

    try {
      await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
      return { success: true, filePath };
    } catch (err: unknown) {
      log.error('Failed to export button data:', err);
      return { error: (err as Error).message };
    }
  }

  private async handleImportButtonData(
    format: string,
  ): Promise<{ success?: boolean; data?: unknown; canceled?: boolean; error?: string }> {
    const fmt = IPCRegistry.BUTTON_DATA_FORMATS[format];
    if (!fmt) return { error: 'Unknown format' };

    const mainWindow = this.deps.windowManager.getMainWindow();
    if (!mainWindow) return { error: 'No main window' };

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: `Import ${fmt.label}`,
      filters: [{ name: fmt.label, extensions: [fmt.ext] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths || filePaths.length === 0) return { canceled: true };

    try {
      const raw = await fsPromises.readFile(filePaths[0], 'utf8');
      const data = JSON.parse(raw) as { format?: string };
      if (data.format !== format) {
        return { error: `Invalid file format: expected ${format}, got ${data.format || 'unknown'}` };
      }
      return { success: true, data };
    } catch (err: unknown) {
      log.error('Failed to import button data:', err);
      return { error: (err as Error).message };
    }
  }

  private async handleExportButtonDataBulk(
    format: string,
    items: Array<{ fileName: string; data: unknown }>,
  ): Promise<{ success?: boolean; folder?: string; exported?: number; errors?: string[]; canceled?: boolean; error?: string }> {
    const fmt = IPCRegistry.BUTTON_DATA_FORMATS[format];
    if (!fmt) return { error: 'Unknown format' };

    const mainWindow = this.deps.windowManager.getMainWindow();
    if (!mainWindow) return { error: 'No main window' };

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: `Choose folder to export ${fmt.label} files`,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths || filePaths.length === 0) return { canceled: true };

    const folder = filePaths[0];
    let exported = 0;
    const errors: string[] = [];
    for (const item of items) {
      const safeName = (item.fileName || 'export').replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(folder, `${safeName}.${fmt.ext}`);
      try {
        await fsPromises.writeFile(filePath, JSON.stringify(item.data, null, 2), 'utf8');
        exported++;
      } catch (err: unknown) {
        errors.push(`${safeName}: ${(err as Error).message}`);
      }
    }
    return { success: true, folder, exported, errors };
  }

  private async handleImportButtonDataBulk(
    format: string,
  ): Promise<{ success?: boolean; items?: Array<{ data: unknown; fileName: string }>; errors?: string[]; sourceFolder?: string; canceled?: boolean; error?: string }> {
    const fmt = IPCRegistry.BUTTON_DATA_FORMATS[format];
    if (!fmt) return { error: 'Unknown format' };

    const mainWindow = this.deps.windowManager.getMainWindow();
    if (!mainWindow) return { error: 'No main window' };

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: `Choose ${fmt.label} files to import`,
      filters: [{ name: fmt.label, extensions: [fmt.ext] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (canceled || !filePaths || filePaths.length === 0) return { canceled: true };

    const items: Array<{ data: unknown; fileName: string }> = [];
    const errors: string[] = [];
    for (const fp of filePaths) {
      try {
        const raw = await fsPromises.readFile(fp, 'utf8');
        const data = JSON.parse(raw) as { format?: string };
        if (data.format !== format) {
          errors.push(`${path.basename(fp)}: wrong format (${data.format || 'unknown'})`);
          continue;
        }
        items.push({ data, fileName: path.basename(fp, `.${fmt.ext}`) });
      } catch (err: unknown) {
        errors.push(`${path.basename(fp)}: ${(err as Error).message}`);
      }
    }
    const sourceFolder = path.dirname(filePaths[0]);
    return { success: true, items, errors, sourceFolder };
  }
}

// =============================================================================
// Template constants
// =============================================================================

const DEFAULT_SHADER = `/*
 * ShaderShow - Available Uniforms
 * ================================
 * vec3  iResolution      - Viewport resolution (width, height, 1.0)
 * float iTime            - Playback time in seconds
 * float iTimeDelta       - Time since last frame in seconds
 * int   iFrame           - Current frame number
 * vec4  iMouse           - Mouse pixel coords (xy: current, zw: click)
 * vec4  iDate            - (year, month, day, time in seconds)
 *
 * sampler2D iChannel0-3  - Input textures (image, video, camera, audio, NDI)
 * vec3  iChannelResolution[4] - Resolution of each channel
 *
 * Custom Parameters (@param)
 * --------------------------
 * Define custom uniforms with UI controls using @param comments:
 *   // @param name type [default] [min, max] "description"
 *
 * Supported types: int, float, vec2, vec3, vec4, color
 *
 * Examples:
 *   // @param speed float 1.0 [0.0, 2.0] "Animation speed"
 *   // @param center vec2 0.5, 0.5 "Center position"
 *   // @param tint color [1.0, 0.5, 0.0] "Tint color"
 */

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0, 2, 4));
    fragColor = vec4(col, 1.0);
}`;

const DEFAULT_SCENE = `/*
 * ShaderShow - Three.js Scene
 * ===========================
 * Write a setup() function that creates and returns your scene.
 * Write an animate() function for per-frame updates.
 *
 * Available in setup(THREE, canvas, params):
 *   THREE   - Three.js library
 *   canvas  - The rendering canvas
 *   params  - Custom parameter values
 *
 * animate() signature:
 *   animate(time, deltaTime, params, objects, mouse, channels)
 *
 * Custom Parameters (@param)
 * --------------------------
 * Define custom uniforms with UI controls using @param comments:
 *   // @param name type [default] [min, max] "description"
 *
 * Supported types: int, float, vec2, vec3, vec4, color
 */

// @param rotationSpeed float 1.0 [0.0, 5.0] "Rotation speed"
// @param cubeColor color [0.2, 0.6, 1.0] "Cube color"

function setup(THREE, canvas, params) {
  // Create scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  // Create camera
  const camera = new THREE.PerspectiveCamera(
    60,
    canvas.width / canvas.height,
    0.1,
    1000
  );
  camera.position.set(0, 2, 5);
  camera.lookAt(0, 0, 0);

  // Create renderer
  const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
    preserveDrawingBuffer: true
  });
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.shadowMap.enabled = true;

  // Create a cube
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    color: 0x4499ff,
    roughness: 0.5,
    metalness: 0.5
  });
  const cube = new THREE.Mesh(geometry, material);
  cube.castShadow = true;
  cube.position.y = 0.5;
  scene.add(cube);

  // Create ground plane
  const groundGeometry = new THREE.PlaneGeometry(10, 10);
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x333333,
    roughness: 0.8
  });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Add lights
  const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(5, 10, 5);
  directionalLight.castShadow = true;
  scene.add(directionalLight);

  return { scene, camera, renderer, cube, material };
}

function animate(time, deltaTime, params, objects) {
  const { cube, material } = objects;

  // Rotate the cube
  const speed = params.rotationSpeed || 1.0;
  cube.rotation.x = time * speed;
  cube.rotation.y = time * speed * 0.7;

  // Update cube color from params
  if (params.cubeColor) {
    material.color.setRGB(
      params.cubeColor[0],
      params.cubeColor[1],
      params.cubeColor[2]
    );
  }
}`;
