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

  // ── Atomic writes ───────────────────────────────────────────────────

  private _writeQueue: Promise<void> = Promise.resolve();

  /**
   * Write a file atomically (tmp + rename) and strictly sequentially.
   * Prevents corruption from crashes mid-write and from overlapping
   * writes to the same file.
   */
  private writeFileAtomic(filePath: string, data: string): Promise<void> {
    this._writeQueue = this._writeQueue.then(async () => {
      const tmp = `${filePath}.tmp`;
      await fsPromises.writeFile(tmp, data, 'utf-8');
      await fsPromises.rename(tmp, filePath);
    }).catch((err) => {
      log.error(`Atomic write failed for ${filePath}:`, err);
    });
    return this._writeQueue;
  }

  /** Read + parse a JSON file, returning `fallback` when missing/malformed. */
  private async readJson<T>(filePath: string, fallback: T): Promise<T> {
    try {
      const raw = await this.readFileOrNull(filePath);
      if (raw) return JSON.parse(raw) as T;
    } catch (err) {
      log.error(`Failed to parse ${filePath}:`, err);
    }
    return fallback;
  }

  /** Atomically write `data` as pretty-printed JSON. */
  private async writeJson(filePath: string, data: unknown): Promise<void> {
    await this.ensureDataDir();
    await this.writeFileAtomic(filePath, JSON.stringify(data, null, 2));
  }

  // ── Grid state ──────────────────────────────────────────────────────

  /**
   * Persist the shader-grid state (tabbed v2 format).
   *
   * The renderer embeds `shaderCode` directly in each slot — this method
   * simply writes the incoming data to disk as the single source of truth.
   */
  async saveGridState(gridState: any): Promise<void> {
    log.info('Saving grid state...');
    await this.ensureDataDir();
    await this.writeFileAtomic(this.gridStateFile, JSON.stringify(gridState, null, 2));
    log.debug('Grid state saved');
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

  // ── File read (path-validated) ──────────────────────────────────────

  private static readonly ALLOWED_READ_EXTENSIONS = /\.(frag|glsl|vert|js|jsx|ts|json|scene\.js)$/i;

  async readFileContent(
    filePath: string,
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      if (!filePath) {
        return { success: false, error: 'No file path provided' };
      }
      // Only allow shader / scene / config file extensions
      if (!FileManager.ALLOWED_READ_EXTENSIONS.test(filePath)) {
        return { success: false, error: 'File type not allowed' };
      }
      // Resolve and restrict to the app directory tree
      const appDir = path.dirname(this.dataDir);
      const resolved = path.resolve(appDir, filePath);
      if (!resolved.startsWith(appDir + path.sep) && resolved !== appDir) {
        return { success: false, error: 'Path outside application directory' };
      }
      const content = await fsPromises.readFile(resolved, 'utf-8');
      return { success: true, content };
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ── Presets ─────────────────────────────────────────────────────────

  async savePresets(data: unknown): Promise<void> {
    await this.writeJson(this.presetsFile, data);
  }

  async loadPresets(): Promise<any[]> {
    return this.readJson<any[]>(this.presetsFile, []);
  }

  // ── View state ──────────────────────────────────────────────────────

  async saveViewState(data: unknown): Promise<void> {
    await this.writeJson(this.viewStateFile, data);
  }

  async loadViewState(): Promise<any | null> {
    return this.readJson<any | null>(this.viewStateFile, null);
  }

  // ── Tile state ──────────────────────────────────────────────────────

  async saveTileState(data: unknown): Promise<void> {
    await this.writeJson(this.tileStateFile, data);
  }

  async loadTileState(): Promise<any | null> {
    return this.readJson<any | null>(this.tileStateFile, null);
  }

  // ── Tile presets ────────────────────────────────────────────────────

  async saveTilePresets(data: unknown): Promise<void> {
    await this.writeJson(this.tilePresetsFile, data);
  }

  async loadTilePresets(): Promise<any | null> {
    return this.readJson<any | null>(this.tilePresetsFile, null);
  }

  // ── Settings ────────────────────────────────────────────────────────
  // settings.json is owned exclusively by SettingsManager (atomic writer).
  // FileManager keeps only the canonical `settingsFile` path.

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

  // ── Shader texture files ────────────────────────────────────────────

  /**
   * Load a shader file (.frag/.glsl) by path relative to the app root.
   * Validates the path to prevent directory traversal.
   */
  async loadShaderFile(
    relPath: string,
  ): Promise<{ success: boolean; source?: string; error?: string }> {
    try {
      if (!relPath || !/\.(frag|glsl|vert)$/.test(relPath)) {
        return { success: false, error: 'Invalid shader file extension (must be .frag, .glsl, or .vert)' };
      }
      // Resolve relative to app root (parent of dataDir)
      const appDir = path.dirname(this.dataDir);
      const resolved = path.resolve(appDir, relPath);
      // Security: ensure resolved path is within the app directory
      if (!resolved.startsWith(appDir + path.sep) && resolved !== appDir) {
        return { success: false, error: 'Path traversal not allowed' };
      }
      const source = await fsPromises.readFile(resolved, 'utf-8');
      return { success: true, source };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: false, error: `Shader file "${relPath}" not found` };
      }
      log.error(`Failed to load shader file "${relPath}":`, err);
      return { success: false, error: (err as Error).message };
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
      const filePath = path.resolve(this.mediaDir, mediaPath);
      if (!filePath.startsWith(path.resolve(this.mediaDir) + path.sep)) {
        return { success: false, error: 'Path traversal not allowed' };
      }
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
    const resolved = path.resolve(this.mediaDir, mediaPath);
    const resolvedMedia = path.resolve(this.mediaDir);
    if (!resolved.startsWith(resolvedMedia + path.sep) && resolved !== resolvedMedia) {
      throw new Error('Path traversal not allowed');
    }
    return resolved;
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
