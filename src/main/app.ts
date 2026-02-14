// ShaderShow — Main process entry point
// Orchestrates all managers and wires their dependencies.

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';

import { Logger } from '@shared/logger.js';

// Managers
import { FileManager } from './managers/file-manager.js';
import { SettingsManager } from './managers/settings-manager.js';
import { NDIManager } from './managers/ndi-manager.js';
import { SyphonManager } from './managers/syphon-manager.js';
import { RecordingManager } from './managers/recording-manager.js';
import { ClaudeManager } from './managers/claude-manager.js';
import { WindowManager } from './managers/window-manager.js';
import { ExportManager } from './managers/export-manager.js';
import { RemoteManager } from './managers/remote-manager.js';
import { FullscreenRelay } from './managers/fullscreen-relay.js';
import { MenuBuilder } from './managers/menu-builder.js';
import { IPCRegistry } from './ipc-registry.js';

const fsPromises = fs.promises;
const log = new Logger('App');

// GPU optimization flags for Linux with NVIDIA
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('disable-gpu-process-crash-limit');
}

// ---------------------------------------------------------------------------
// Resolve application root directory
// ---------------------------------------------------------------------------

const appDir = __dirname.endsWith(path.join('dist', 'main'))
  ? path.resolve(__dirname, '..', '..')
  : __dirname;

// ---------------------------------------------------------------------------
// Parse CLI options
// ---------------------------------------------------------------------------

const cliOptions = {
  headless: process.argv.includes('--headless'),
  port: (() => {
    const idx = process.argv.indexOf('--port');
    if (idx !== -1 && process.argv[idx + 1]) {
      const p = parseInt(process.argv[idx + 1], 10);
      return Number.isFinite(p) && p > 0 && p < 65536 ? p : undefined;
    }
    return undefined;
  })(),
};

if (cliOptions.headless) {
  log.info(`Headless mode enabled${cliOptions.port ? `, port ${cliOptions.port}` : ''}`);
}

// ---------------------------------------------------------------------------
// Instantiate all managers
// ---------------------------------------------------------------------------

const fileManager = new FileManager(appDir);
const settingsManager = new SettingsManager(fileManager.settingsFile);
const claudeManager = new ClaudeManager(fileManager.claudeKeyFile);
const recordingManager = new RecordingManager();
const windowManager = new WindowManager(appDir);
const remoteManager = new RemoteManager({
  getMainWindow: () => windowManager.getMainWindow(),
  getWindowManager: () => windowManager,
});
const exportManager = new ExportManager({
  dataDir: fileManager.dataDir,
  getMainWindow: () => windowManager.getMainWindow(),
  getAppVersion: () => app.getVersion(),
  onRelaunch: () => { app.relaunch(); app.exit(0); },
});

const ndiManager = new NDIManager({
  onStatusUpdate: (status) => windowManager.sendToMain('ndi-status', status),
  onFrameCallback: (channel, frame) => {
    const frameBuffer = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    windowManager.sendToMain('ndi-input-frame', {
      channel,
      width: frame.width,
      height: frame.height,
      data: frameBuffer,
    });
  },
  onSourceSet: (data) => {
    windowManager.sendToMain('ndi-source-set', data);
    menuBuilder.buildMenu();
  },
  onMenuRebuild: () => menuBuilder.buildMenu(),
  onShowCustomDialog: () => windowManager.showCustomResolutionDialog(),
  onRequestPreviewResolution: () => windowManager.sendToMain('request-preview-resolution'),
});

const syphonManager = new SyphonManager({
  onStatusUpdate: (status) => windowManager.sendToMain('syphon-status', status),
  onMenuUpdate: () => menuBuilder.buildMenu(),
});

const fullscreenRelay = new FullscreenRelay({
  getMainWindow: () => windowManager.getMainWindow(),
  getFullscreenWindow: () => windowManager.getFullscreenWindow(),
  onFullscreenStateReceived: (shaderState) => {
    const pendingDisplay = windowManager.consumePendingDisplay();
    if (pendingDisplay) {
      windowManager.createFullscreenWindow(pendingDisplay, shaderState);
    }
  },
  onTiledModeChanged: (active) => {
    windowManager.tiledModeActive = active;
  },
});

const menuBuilder = new MenuBuilder({
  // File actions
  onNewFile: (fileType) => newFile(fileType),
  onOpenFile: () => openFile(),
  onSaveFile: () => saveFile(),
  onSaveFileAs: () => saveFileAs(),
  onLoadTexture: (ch) => loadTexture(ch),
  onLoadVideo: (ch) => loadVideo(ch),
  onUseCamera: (ch) => windowManager.sendToMain('camera-requested', { channel: ch }),
  onUseAudio: (ch) => windowManager.sendToMain('audio-requested', { channel: ch }),
  onClearChannel: (ch) => clearChannel(ch),

  // NDI
  onToggleNDI: () => ndiManager.toggleNDIOutput(),
  onSetNDIResolution: (res) => ndiManager.setNDIResolution(res),
  getNDIResolution: () => ndiManager.getResolution(),
  getNDIEnabled: () => ndiManager.isEnabled(),
  getNDISourceCache: () => ndiManager.getSourceCache(),
  getNDIReceiverSource: (ch) => ndiManager.getReceiver(ch)?.getSource() ?? null,

  // Syphon
  onToggleSyphon: () => syphonManager.toggle(),

  // Recording
  onToggleRecording: () => {
    if (recordingManager.isRunning()) {
      recordingManager.stop();
    } else {
      // Handled via IPC (start-recording) for dialog
      windowManager.sendToMain('trigger-start-recording');
    }
  },
  onSetRecordingResolution: (res) => {
    settingsManager.recordingResolution = res;
    log.debug(`Recording resolution set to ${res.label}`);
    settingsManager.save();
    menuBuilder.buildMenu();
  },
  getRecordingResolution: () => settingsManager.recordingResolution,
  getRecordingEnabled: () => recordingManager.isRunning(),

  // Fullscreen
  onOpenFullscreen: (display) => windowManager.openFullscreen(display as unknown as import('./managers/window-manager.js').DisplayInfo),

  // Grid presets
  onSaveGridPresetsAs: () => saveGridPresetsAs(),
  onLoadGridPresetsFrom: () => loadGridPresetsFrom(),

  // State export/import
  onExportState: () => exportManager.exportApplicationState(),
  onImportState: () => exportManager.importApplicationState(),

  // Texture creator
  onShowTextureCreator: () => windowManager.showTextureCreatorDialog(),

  // Send to renderer
  sendToMain: (channel, ...args) => windowManager.sendToMain(channel, ...args),

  // Settings
  onSaveSettings: () => settingsManager.save(),
});

const ipcRegistry = new IPCRegistry({
  fileManager,
  settingsManager,
  ndiManager,
  syphonManager,
  recordingManager,
  claudeManager,
  windowManager,
  exportManager,
  menuBuilder,
  remoteManager,
});

// ---------------------------------------------------------------------------
// File operation helpers (used by menu actions and IPC handlers)
// ---------------------------------------------------------------------------

async function newFile(fileType = 'shader'): Promise<void> {
  const mainWindow = windowManager.getMainWindow();
  if (!mainWindow) return;

  const hasChanges = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5000);
    ipcMain.once('editor-has-changes-response', (_event, result: boolean) => {
      clearTimeout(timeout);
      resolve(result);
    });
    mainWindow.webContents.send('check-editor-changes');
  });

  if (hasChanges) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Unsaved Changes',
      message: 'Do you want to save changes to the current shader?',
    });

    if (result.response === 0) {
      await saveFile();
    } else if (result.response === 2) {
      return;
    }
  }

  windowManager.currentFilePath = null;
  mainWindow.webContents.send('new-file', { fileType });
  windowManager.updateTitle();
}

async function openFile(): Promise<void> {
  const mainWindow = windowManager.getMainWindow();
  if (!mainWindow) return;

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
}

async function saveFile(): Promise<void> {
  const mainWindow = windowManager.getMainWindow();
  if (!mainWindow) return;

  if (windowManager.currentFilePath) {
    mainWindow.webContents.send('request-content-for-save');
  } else {
    await saveFileAs();
  }
}

async function saveFileAs(): Promise<void> {
  const mainWindow = windowManager.getMainWindow();
  if (!mainWindow) return;

  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: 'Fragment Shader', extensions: ['frag'] },
      { name: 'GLSL Shader', extensions: ['glsl'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (!result.canceled && result.filePath) {
    windowManager.currentFilePath = result.filePath;
    mainWindow.webContents.send('request-content-for-save');
    windowManager.updateTitle();
  }
}

async function loadTexture(channel: number): Promise<void> {
  const mainWindow = windowManager.getMainWindow();
  if (!mainWindow) return;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    try {
      const data = await fsPromises.readFile(filePath);
      const base64 = data.toString('base64');
      const ext = path.extname(filePath).toLowerCase();
      const mimeType: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
      };
      const dataUrl = `data:${mimeType[ext] || 'image/png'};base64,${base64}`;
      mainWindow.webContents.send('texture-loaded', { channel, dataUrl, filePath });
    } catch (err: unknown) {
      dialog.showErrorBox('Error', `Failed to load texture: ${(err as Error).message}`);
    }
  }
}

async function loadVideo(channel: number): Promise<void> {
  const mainWindow = windowManager.getMainWindow();
  if (!mainWindow) return;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Video Files', extensions: ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    mainWindow.webContents.send('video-loaded', { channel, filePath: result.filePaths[0] });
  }
}

function clearChannel(channel: number): void {
  if (!Number.isInteger(channel) || channel < 0 || channel > 3) return;
  ndiManager.clearChannelNDI(channel);
  windowManager.sendToMain('channel-cleared', { channel });
}

function saveGridPresetsAs(): void {
  windowManager.sendToMain('request-grid-state-for-save');
}

async function loadGridPresetsFrom(): Promise<void> {
  const mainWindow = windowManager.getMainWindow();
  if (!mainWindow) return;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Grid Presets', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    try {
      const data = await fsPromises.readFile(filePath, 'utf-8');
      const gridState = JSON.parse(data);
      mainWindow.webContents.send('load-grid-presets', { gridState, filePath });
    } catch (err: unknown) {
      dialog.showErrorBox('Error', `Failed to load grid presets: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  log.info('Starting ShaderShow (TypeScript build)');

  // Bootstrap
  await fileManager.ensureDataDir(app.getPath('userData'));
  await settingsManager.load();
  await claudeManager.loadKey();
  if (claudeManager.hasKey()) {
    claudeManager.fetchModels();
  }

  // Apply loaded settings to managers
  ndiManager.setFrameSkip(settingsManager.ndiFrameSkip);

  // Register IPC handlers and fullscreen relay
  ipcRegistry.registerAll();
  fullscreenRelay.registerAll();

  // Create main window
  windowManager.createWindow({ headless: cliOptions.headless });
  menuBuilder.buildMenu();

  // Start remote control server if enabled (forced in headless mode)
  if (settingsManager.remoteEnabled || cliOptions.headless) {
    const port = cliOptions.port ?? settingsManager.remotePort;
    remoteManager.start(port);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windowManager.createWindow();
      menuBuilder.buildMenu();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Cleanup
  ndiManager.dispose();
  syphonManager.stop();
  recordingManager.stop();
  remoteManager.stop();
});
