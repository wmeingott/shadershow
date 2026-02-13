import fs from 'fs';
import path from 'path';
import { dialog, BrowserWindow } from 'electron';
import { Logger, LOG_LEVEL } from '@shared/logger.js';

const fsPromises = fs.promises;

const log = new Logger('FileManager', LOG_LEVEL.WARN);

/**
 * FileManager — centralises all file I/O that was previously scattered
 * across `main.js` helper functions and IPC handlers.
 *
 * Owns the canonical directory / file paths and every read/write operation
 * that touches the `data/` tree.
 */
export class FileManager {
  // ── Directory & file paths ──────────────────────────────────────────
  readonly dataDir: string;
  readonly shadersDir: string;
  readonly gridStateFile: string;
  readonly presetsFile: string;
  readonly settingsFile: string;
  readonly viewStateFile: string;
  readonly tileStateFile: string;
  readonly tilePresetsFile: string;
  readonly texturesDir: string;
  readonly mediaDir: string;
  readonly claudeKeyFile: string;

  constructor(appDir: string) {
    this.dataDir = path.join(appDir, 'data');
    this.shadersDir = path.join(this.dataDir, 'shaders');
    this.gridStateFile = path.join(this.dataDir, 'grid-state.json');
    this.presetsFile = path.join(this.dataDir, 'presets.json');
    this.settingsFile = path.join(this.dataDir, 'settings.json');
    this.viewStateFile = path.join(this.dataDir, 'view-state.json');
    this.tileStateFile = path.join(this.dataDir, 'tile-state.json');
    this.tilePresetsFile = path.join(this.dataDir, 'tile-presets.json');
    this.texturesDir = path.join(this.dataDir, 'textures');
    this.mediaDir = path.join(this.dataDir, 'media');
    this.claudeKeyFile = path.join(this.dataDir, 'claude-key.json');
  }

  // ── Bootstrap ───────────────────────────────────────────────────────

  /**
   * Create required data directories and migrate legacy state from
   * Electron's `userData` folder (if present).
   */
  async ensureDataDir(userDataPath?: string): Promise<void> {
    await fsPromises.mkdir(this.dataDir, { recursive: true });
    await fsPromises.mkdir(this.shadersDir, { recursive: true });
    await fsPromises.mkdir(this.texturesDir, { recursive: true });
    await fsPromises.mkdir(this.mediaDir, { recursive: true });

    // Migrate old grid state from userData if it exists
    if (userDataPath) {
      const oldGridStateFile = path.join(userDataPath, 'grid-state.json');
      try {
        await fsPromises.access(oldGridStateFile);
        try {
          await fsPromises.access(this.gridStateFile);
        } catch {
          // gridStateFile doesn't exist yet — migrate
          try {
            await fsPromises.copyFile(oldGridStateFile, this.gridStateFile);
            log.info('Migrated grid-state.json from userData to data directory');
          } catch (err) {
            log.error('Failed to migrate grid state:', err);
          }
        }
      } catch {
        // oldGridStateFile doesn't exist, nothing to migrate
      }
    }
  }

  // ── Low-level utilities ─────────────────────────────────────────────

  /**
   * Read a UTF-8 text file and return its contents, or `null` when the
   * file does not exist or cannot be read.
   */
  async readFileOrNull(filePath: string): Promise<string | null> {
    try {
      return await fsPromises.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      log.error(`Failed to read ${filePath}:`, err);
      return null;
    }
  }

  /**
   * Compute the canonical `.glsl` file path for a grid slot index.
   * Slot indices are zero-based; filenames are 1-based (`button1.glsl`).
   */
  getShaderFilePath(slotIndex: number): string {
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 999) {
      throw new Error(`Invalid slot index: ${slotIndex}`);
    }
    return path.join(this.shadersDir, `button${slotIndex + 1}.glsl`);
  }

  // ── Grid state ──────────────────────────────────────────────────────

  /**
   * Persist the shader-grid state (tabbed v2 or legacy array format).
   *
   * For the v2 tabbed format the embedded `shaderCode` for each slot is
   * read back from the individual `.glsl` files so the JSON always
   * contains the latest code on disk.
   */
  async saveGridState(gridState: any): Promise<void> {
    log.info('Saving grid state...');
    await this.ensureDataDir();
    try {
      if (gridState.version === 2 && gridState.tabs) {
        // New tabbed format — save with embedded shader code
        const tabs: any[] = [];
        let globalSlotIndex = 0;

        for (const tab of gridState.tabs) {
          // Mix tabs: pass through directly (no shader files to read)
          if (tab.type === 'mix') {
            tabs.push({ name: tab.name, type: 'mix', mixPresets: tab.mixPresets || [] });
            continue;
          }

          // Asset tabs: pass through directly (no shader files)
          if (tab.type === 'assets') {
            tabs.push({ name: tab.name, type: 'assets', slots: tab.slots || [] });
            continue;
          }

          const slots: any[] = [];
          for (let i = 0; i < tab.slots.length; i++) {
            const slot = tab.slots[i];
            if (!slot) {
              slots.push(null);
            } else {
              const shaderFile = this.getShaderFilePath(globalSlotIndex);
              const shaderCode = await this.readFileOrNull(shaderFile);
              slots.push({
                shaderCode,
                filePath: slot.filePath,
                params: slot.params,
                customParams: slot.customParams || {},
                presets: slot.presets || [],
                type: slot.type || 'shader',
              });
            }
            globalSlotIndex++;
          }
          tabs.push({ name: tab.name, type: tab.type || 'shaders', slots });
        }

        const saveData = {
          version: 2,
          activeTab: gridState.activeTab,
          activeSection: gridState.activeSection || 'shaders',
          tabs,
          visualPresets: gridState.visualPresets || [],
        };
        await fsPromises.writeFile(this.gridStateFile, JSON.stringify(saveData, null, 2), 'utf-8');
        log.debug('Grid state saved', String(tabs.length), 'tabs');
      } else {
        // Legacy format — save metadata without shader code
        const metadata = (gridState as any[]).map((slot: any) => {
          if (!slot) return null;
          return {
            filePath: slot.filePath,
            params: slot.params,
            presets: slot.presets || [],
          };
        });
        await fsPromises.writeFile(this.gridStateFile, JSON.stringify(metadata, null, 2), 'utf-8');
        log.debug('Grid state saved (legacy)', String(metadata.length), 'slots');
      }
    } catch (err) {
      log.error('Failed to save grid state:', err);
    }
  }

  /**
   * Load the grid state.  Handles v2 (tabbed), legacy array, and the
   * fall-back scan of shader files when no metadata file exists.
   */
  async loadGridState(): Promise<any> {
    log.info('Loading grid state...');
    try {
      const raw = await this.readFileOrNull(this.gridStateFile);
      if (raw) {
        const savedData = JSON.parse(raw);

        // v2 tabbed format — fill in missing shaderCode from .glsl files
        if (savedData.version === 2 && savedData.tabs) {
          let globalSlotIndex = 0;
          for (const tab of savedData.tabs) {
            if (!tab.slots || tab.type === 'assets') continue;
            for (let i = 0; i < tab.slots.length; i++) {
              const slot = tab.slots[i];
              if (slot && !slot.shaderCode) {
                const shaderFile = this.getShaderFilePath(globalSlotIndex);
                const code = await this.readFileOrNull(shaderFile);
                if (code) {
                  slot.shaderCode = code;
                  // Auto-detect scene type if not already set
                  if (
                    slot.type !== 'scene' &&
                    code.includes('function setup') &&
                    (code.includes('THREE') || code.includes('scene'))
                  ) {
                    slot.type = 'scene';
                  }
                }
              }
              globalSlotIndex++;
            }
          }
          log.debug('Grid state loaded (v2)', String(savedData.tabs.length), 'tabs');
          return savedData;
        }

        // Legacy format — load shader code from individual files
        const metadata = savedData as any[];
        const state = await Promise.all(
          metadata.map(async (slot: any, index: number) => {
            if (!slot) {
              // Check if shader file exists even without metadata
              const shaderFile = this.getShaderFilePath(index);
              const shaderCode = await this.readFileOrNull(shaderFile);
              if (shaderCode) {
                return { shaderCode, filePath: null, params: {}, presets: [] };
              }
              return null;
            }

            const shaderFile = this.getShaderFilePath(index);
            const shaderCode = await this.readFileOrNull(shaderFile);
            if (!shaderCode) return null;

            // Detect type from content if not saved in metadata
            let type = slot.type || 'shader';
            if (
              type === 'shader' &&
              shaderCode.includes('function setup') &&
              (shaderCode.includes('THREE') || shaderCode.includes('scene'))
            ) {
              type = 'scene';
            }

            return {
              shaderCode,
              filePath: slot.filePath,
              params: slot.params || {},
              customParams: slot.customParams || {},
              presets: slot.presets || [],
              paramNames: slot.paramNames || {},
              type,
            };
          }),
        );

        log.debug('Grid state loaded (legacy)', String(state.filter(Boolean).length), 'slots');
        return state;
      } else {
        // No metadata file — scan for shader files dynamically
        const state: any[] = [];
        const MAX_SLOTS = 64;
        for (let i = 0; i < MAX_SLOTS; i++) {
          const shaderFile = this.getShaderFilePath(i);
          const shaderCode = await this.readFileOrNull(shaderFile);
          if (shaderCode) {
            const isScene =
              shaderCode.includes('function setup') &&
              (shaderCode.includes('THREE') || shaderCode.includes('scene'));
            state.push({
              shaderCode,
              filePath: null,
              params: {},
              presets: [],
              type: isScene ? 'scene' : 'shader',
            });
          } else {
            break;
          }
        }
        log.debug('Grid state loaded (scan)', String(state.length), 'slots');
        return state;
      }
    } catch (err) {
      log.error('Failed to load grid state:', err);
    }
    return null;
  }

  // ── Shader slot files ───────────────────────────────────────────────

  async saveShaderToSlot(
    slotIndex: number,
    code: string,
  ): Promise<{ success: boolean; path?: string; error?: string }> {
    await this.ensureDataDir();
    try {
      const shaderFile = this.getShaderFilePath(slotIndex);
      await fsPromises.writeFile(shaderFile, code, 'utf-8');
      log.info(`Shader saved to slot ${slotIndex} (${code.length} chars)`);
      return { success: true, path: shaderFile };
    } catch (err: unknown) {
      log.error(`Failed to save shader to slot ${slotIndex}:`, err);
      return { success: false, error: (err as Error).message };
    }
  }

  async loadShaderFromSlot(
    slotIndex: number,
  ): Promise<{ success: boolean; shaderCode?: string; error?: string }> {
    try {
      const shaderFile = this.getShaderFilePath(slotIndex);
      const shaderCode = await fsPromises.readFile(shaderFile, 'utf-8');
      return { success: true, shaderCode };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: false, error: 'File not found' };
      }
      log.error(`Failed to load shader from slot ${slotIndex}:`, err);
      return { success: false, error: (err as Error).message };
    }
  }

  async deleteShaderFromSlot(
    slotIndex: number,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const shaderFile = this.getShaderFilePath(slotIndex);
      await fsPromises.unlink(shaderFile);
      return { success: true };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: true }; // Already deleted
      }
      log.error(`Failed to delete shader from slot ${slotIndex}:`, err);
      return { success: false, error: (err as Error).message };
    }
  }

  // ── Arbitrary file read ─────────────────────────────────────────────

  async readFileContent(
    filePath: string,
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      return { success: true, content };
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ── Presets ─────────────────────────────────────────────────────────

  async savePresets(data: unknown): Promise<void> {
    await this.ensureDataDir();
    try {
      await fsPromises.writeFile(this.presetsFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      log.error('Failed to save presets:', err);
    }
  }

  async loadPresets(): Promise<any[]> {
    try {
      const raw = await this.readFileOrNull(this.presetsFile);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      log.error('Failed to load presets:', err);
    }
    return [];
  }

  // ── View state ──────────────────────────────────────────────────────

  async saveViewState(data: unknown): Promise<void> {
    await this.ensureDataDir();
    try {
      await fsPromises.writeFile(this.viewStateFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      log.debug('Failed to save view state:', err);
    }
  }

  async loadViewState(): Promise<any | null> {
    try {
      const raw = await this.readFileOrNull(this.viewStateFile);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      log.debug('Failed to load view state:', err);
    }
    return null;
  }

  // ── Tile state ──────────────────────────────────────────────────────

  async saveTileState(data: unknown): Promise<void> {
    await this.ensureDataDir();
    try {
      await fsPromises.writeFile(this.tileStateFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      log.error('Failed to save tile state:', err);
    }
  }

  async loadTileState(): Promise<any | null> {
    try {
      const raw = await this.readFileOrNull(this.tileStateFile);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      log.error('Failed to load tile state:', err);
    }
    return null;
  }

  // ── Tile presets ────────────────────────────────────────────────────

  async saveTilePresets(data: unknown): Promise<void> {
    await this.ensureDataDir();
    try {
      await fsPromises.writeFile(this.tilePresetsFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      log.error('Failed to save tile presets:', err);
    }
  }

  async loadTilePresets(): Promise<any | null> {
    try {
      const raw = await this.readFileOrNull(this.tilePresetsFile);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      log.error('Failed to load tile presets:', err);
    }
    return null;
  }

  // ── Settings ────────────────────────────────────────────────────────

  /**
   * Merge `data` into the settings file on disk, preserving any existing
   * keys that are not overwritten.
   */
  async saveSettings(data: Record<string, unknown>): Promise<void> {
    await this.ensureDataDir();
    try {
      let existingData: Record<string, unknown> = {};
      const raw = await this.readFileOrNull(this.settingsFile);
      if (raw) {
        existingData = JSON.parse(raw);
      }
      const merged = { ...existingData, ...data };
      await fsPromises.writeFile(this.settingsFile, JSON.stringify(merged, null, 2), 'utf-8');
    } catch (err) {
      log.error('Failed to save settings:', err);
    }
  }

  /**
   * Load settings from disk.  Returns `null` when the file does not
   * exist or is malformed.
   */
  async loadSettings(): Promise<any | null> {
    log.debug('Loading settings...');
    try {
      const raw = await this.readFileOrNull(this.settingsFile);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      log.error('Failed to load settings:', err);
    }
    return null;
  }

  // ── File textures ───────────────────────────────────────────────────

  /**
   * Load a PNG texture by name from `data/textures/` and return it as a
   * base-64 data URL.
   */
  async loadFileTexture(
    name: string,
  ): Promise<{ success: boolean; dataUrl?: string; error?: string }> {
    try {
      if (!name || !/^[\w-]+$/.test(name)) {
        return { success: false, error: 'Invalid texture name' };
      }
      const filePath = path.join(this.texturesDir, `${name}.png`);
      const data = await fsPromises.readFile(filePath);
      const dataUrl = `data:image/png;base64,${data.toString('base64')}`;
      return { success: true, dataUrl };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: false, error: `Texture "${name}" not found` };
      }
      log.error(`Failed to load file texture "${name}":`, err);
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Return the list of texture names available in `data/textures/`
   * (without the `.png` extension).
   */
  async listFileTextures(): Promise<string[]> {
    try {
      await this.ensureDataDir();
      const files = await fsPromises.readdir(this.texturesDir);
      return files.filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, ''));
    } catch (err) {
      log.error('Failed to list file textures:', err);
      return [];
    }
  }

  // ── Media (asset images / videos) ───────────────────────────────────

  /**
   * Load an image from the media library and return it as a base-64 data URL.
   */
  async loadMediaDataUrl(
    mediaPath: string,
  ): Promise<{ success: boolean; dataUrl?: string; error?: string }> {
    try {
      const filePath = path.join(this.mediaDir, mediaPath);
      const data = await fsPromises.readFile(filePath);
      const ext = path.extname(mediaPath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.webp': 'image/webp',
      };
      const mimeType = mimeTypes[ext] || 'image/png';
      return { success: true, dataUrl: `data:${mimeType};base64,${data.toString('base64')}` };
    } catch (err: unknown) {
      log.error('Failed to load media data URL:', err);
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Resolve a relative media path (filename inside `data/media/`) to an
   * absolute file system path.
   */
  getMediaAbsolutePath(mediaPath: string): string {
    return path.join(this.mediaDir, mediaPath);
  }

  /**
   * Copy a media file into `data/media/` if it is not already there.
   * Handles filename collisions by appending a counter suffix.
   *
   * Returns the relative media path and the absolute path on success.
   */
  async copyMediaToLibrary(
    sourcePath: string,
  ): Promise<{ mediaPath?: string; absolutePath?: string; error?: string }> {
    try {
      await this.ensureDataDir();
      const fileName = path.basename(sourcePath);
      const destPath = path.join(this.mediaDir, fileName);

      // Check if source is already inside media dir
      const resolvedSource = path.resolve(sourcePath);
      const resolvedMedia = path.resolve(this.mediaDir);
      if (resolvedSource.startsWith(resolvedMedia + path.sep)) {
        return { mediaPath: fileName, absolutePath: resolvedSource };
      }

      // Handle name collisions by appending a number
      let finalName = fileName;
      let finalPath = destPath;
      let counter = 1;
      const ext = path.extname(fileName);
      const base = path.basename(fileName, ext);
      while (true) {
        try {
          await fsPromises.access(finalPath);
          // File exists — try next name
          finalName = `${base}_${counter}${ext}`;
          finalPath = path.join(this.mediaDir, finalName);
          counter++;
        } catch {
          // File doesn't exist — we can use this name
          break;
        }
      }

      await fsPromises.copyFile(sourcePath, finalPath);
      return { mediaPath: finalName, absolutePath: finalPath };
    } catch (err: unknown) {
      log.error('Failed to copy media to library:', err);
      return { error: (err as Error).message };
    }
  }

  /**
   * Open a native file dialog for selecting an image or video asset.
   *
   * For images the file is read and returned as a base-64 data URL.
   * For videos only the file path is returned (the renderer loads them
   * via a `<video>` element).
   */
  async openMediaForAsset(
    mainWindow: BrowserWindow | null,
  ): Promise<{
    canceled: boolean;
    filePath?: string;
    dataUrl?: string;
    type?: string;
    error?: string;
  }> {
    const parentWindow = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!parentWindow) {
      return { canceled: true, error: 'No window available' };
    }

    const result = await dialog.showOpenDialog(parentWindow, {
      properties: ['openFile'],
      filters: [
        {
          name: 'Images & Videos',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'mp4', 'webm', 'mov', 'avi', 'mkv'],
        },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] },
        { name: 'Videos', extensions: ['mp4', 'webm', 'mov', 'avi', 'mkv'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).toLowerCase();
    const videoExts = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
    const isVideo = videoExts.includes(ext);
    const assetType = isVideo ? 'video' : 'image';

    if (isVideo) {
      // For videos, return file path only (loaded via <video> element)
      return { canceled: false, filePath, type: assetType };
    }

    // For images, read and return as data URL
    try {
      const data = await fsPromises.readFile(filePath);
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.webp': 'image/webp',
      };
      const mimeType = mimeTypes[ext] || 'image/png';
      const dataUrl = `data:${mimeType};base64,${data.toString('base64')}`;
      return { canceled: false, filePath, dataUrl, type: assetType };
    } catch (err: unknown) {
      return { canceled: true, error: (err as Error).message };
    }
  }
}
