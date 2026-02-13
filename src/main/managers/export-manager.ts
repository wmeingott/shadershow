// ExportManager — application state export/import (gzipped .shadershow bundles)
// Extracted from main.js lines 1376-1558

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { dialog, app } from 'electron';
import { Logger } from '@shared/logger.js';

const fsPromises = fs.promises;
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const log = new Logger('ExportManager');

/** Text file extensions that are stored as UTF-8 in the bundle. */
const TEXT_EXTENSIONS = /\.(json|glsl|frag|vert|txt|jsx|js)$/i;

/** Maximum number of files accepted during import. */
const MAX_IMPORT_FILES = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileEntry {
  encoding: 'utf8' | 'base64';
  content: string;
}

interface StateBundle {
  version: number;
  exportedAt: string;
  appVersion: string;
  files: Record<string, FileEntry>;
}

export interface ExportManagerDeps {
  dataDir: string;
  getMainWindow: () => Electron.BrowserWindow | null;
  getAppVersion: () => string;
  onRelaunch: () => void;
}

// ---------------------------------------------------------------------------
// ExportManager
// ---------------------------------------------------------------------------

/**
 * Manages full application state export (to `.shadershow` gzip bundles)
 * and import (decompress, validate, write back to data directory).
 */
export class ExportManager {
  private readonly dataDir: string;
  private readonly getMainWindow: () => Electron.BrowserWindow | null;
  private readonly getAppVersion: () => string;
  private readonly onRelaunch: () => void;

  constructor(deps: ExportManagerDeps) {
    this.dataDir = deps.dataDir;
    this.getMainWindow = deps.getMainWindow;
    this.getAppVersion = deps.getAppVersion;
    this.onRelaunch = deps.onRelaunch;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Show a save dialog, read all files from `dataDir` recursively,
   * exclude sensitive files (`claude-key.json`), compress with gzip,
   * and write the result to a `.shadershow` file.
   */
  async exportApplicationState(): Promise<void> {
    const mainWindow = this.getMainWindow();
    if (!mainWindow) {
      log.error('Cannot export: no main window available');
      return;
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `shadershow-state-${new Date().toISOString().slice(0, 10)}.shadershow`,
      filters: [
        { name: 'ShaderShow State', extensions: ['shadershow'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return;
    }

    try {
      // Read all files from data directory
      const dataContents = await this.readDirectoryContents(this.dataDir, '');

      // Exclude sensitive files from export
      delete dataContents['claude-key.json'];

      // Build state bundle
      const stateBundle: StateBundle = {
        version: 1,
        exportedAt: new Date().toISOString(),
        appVersion: this.getAppVersion(),
        files: dataContents,
      };

      // Convert to JSON and compress with gzip
      const jsonData = JSON.stringify(stateBundle, null, 2);
      const compressed = await gzip(Buffer.from(jsonData, 'utf8'));

      // Write to file
      await fsPromises.writeFile(result.filePath, compressed);

      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Export Complete',
        message: 'Application state exported successfully.',
        detail: `Saved to: ${result.filePath}\n\nIncluded ${Object.keys(dataContents).length} files.`,
      });
    } catch (err: unknown) {
      dialog.showErrorBox(
        'Export Error',
        `Failed to export application state: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Show an open dialog, confirm overwrite, decompress a `.shadershow`
   * bundle, validate its structure, write files back to `dataDir`, and
   * offer an application restart.
   */
  async importApplicationState(): Promise<void> {
    const mainWindow = this.getMainWindow();
    if (!mainWindow) {
      log.error('Cannot import: no main window available');
      return;
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'ShaderShow State', extensions: ['shadershow'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return;
    }

    const filePath = result.filePaths[0];

    // Confirm before overwriting
    const confirmResult = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Import Application State',
      message: 'This will replace your current application state.',
      detail:
        'All existing shaders, presets, and settings will be overwritten. ' +
        'This action cannot be undone.\n\nDo you want to continue?',
      buttons: ['Cancel', 'Import'],
      defaultId: 0,
      cancelId: 0,
    });

    if (confirmResult.response !== 1) {
      return;
    }

    try {
      // Read and decompress file
      const compressed = await fsPromises.readFile(filePath);
      const decompressed = await gunzip(compressed);
      const stateBundle: unknown = JSON.parse(decompressed.toString('utf8'));

      // Validate bundle structure
      if (
        !stateBundle ||
        typeof stateBundle !== 'object' ||
        !('version' in stateBundle) ||
        !('files' in stateBundle) ||
        typeof (stateBundle as StateBundle).files !== 'object' ||
        (stateBundle as StateBundle).files === null
      ) {
        throw new Error('Invalid state file format');
      }

      const bundle = stateBundle as StateBundle;

      // Validate file count
      const fileKeys = Object.keys(bundle.files);
      if (fileKeys.length > MAX_IMPORT_FILES) {
        throw new Error('State file contains too many files');
      }

      // Write files to data directory
      await this.writeDirectoryContents(this.dataDir, bundle.files);

      const importResult = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Import Complete',
        message: 'Application state imported successfully.',
        detail:
          `Imported ${fileKeys.length} files.\n\n` +
          'Please restart the application for changes to take effect.',
        buttons: ['Restart Now', 'Restart Later'],
      });

      if (importResult.response === 0) {
        this.onRelaunch();
      }
    } catch (err: unknown) {
      dialog.showErrorBox(
        'Import Error',
        `Failed to import application state: ${(err as Error).message}`,
      );
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Recursively read all files under `dirPath` into a flat object keyed
   * by their path relative to `basePath`.
   *
   * Text files (`.json`, `.glsl`, `.frag`, `.vert`, `.txt`, `.jsx`, `.js`)
   * are stored as UTF-8 strings; all other files are stored as base64.
   */
  private async readDirectoryContents(
    dirPath: string,
    basePath: string,
  ): Promise<Record<string, FileEntry>> {
    const contents: Record<string, FileEntry> = {};

    try {
      await fsPromises.access(dirPath);
    } catch {
      return contents;
    }

    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      const relativePath = basePath ? basePath + '/' + entry.name : entry.name;

      if (entry.isDirectory()) {
        // Recursively read subdirectory
        const subContents = await this.readDirectoryContents(entryPath, relativePath);
        Object.assign(contents, subContents);
      } else if (entry.isFile()) {
        try {
          const data = await fsPromises.readFile(entryPath);
          const isText = TEXT_EXTENSIONS.test(entry.name);
          contents[relativePath] = {
            encoding: isText ? 'utf8' : 'base64',
            content: isText ? data.toString('utf8') : data.toString('base64'),
          };
        } catch (err: unknown) {
          log.error(`Failed to read ${entryPath}:`, err);
        }
      }
    }

    return contents;
  }

  /**
   * Write files from a flat `{ relativePath: FileEntry }` object back
   * into `dirPath`, creating subdirectories as needed.
   *
   * Includes path traversal prevention: any relative path that resolves
   * outside `dirPath` is silently skipped.
   */
  private async writeDirectoryContents(
    dirPath: string,
    contents: Record<string, FileEntry>,
  ): Promise<void> {
    const resolvedBase = path.resolve(dirPath) + path.sep;

    for (const [relativePath, fileData] of Object.entries(contents)) {
      const fullPath = path.resolve(dirPath, relativePath);

      // Prevent path traversal
      if (!fullPath.startsWith(resolvedBase)) {
        log.error(`Path traversal blocked: ${relativePath}`);
        continue;
      }

      // Validate encoding
      if (fileData.encoding !== 'utf8' && fileData.encoding !== 'base64') {
        log.error(`Invalid encoding for ${relativePath}: ${String(fileData.encoding)}`);
        continue;
      }

      const parentDir = path.dirname(fullPath);
      await fsPromises.mkdir(parentDir, { recursive: true });

      const content =
        fileData.encoding === 'base64'
          ? Buffer.from(fileData.content, 'base64')
          : fileData.content;

      await fsPromises.writeFile(fullPath, content);
    }
  }
}
