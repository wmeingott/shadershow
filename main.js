const { app, BrowserWindow, Menu, dialog, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

// GPU optimization flags for Linux with NVIDIA
if (process.platform === 'linux') {
  // Force hardware acceleration
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-zero-copy');

  // Disable GPU process crash limit (helps with driver issues)
  app.commandLine.appendSwitch('disable-gpu-process-crash-limit');
}
const fsPromises = fs.promises;
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const NDISender = require('./ndi-sender');
const NDIReceiver = require('./ndi-receiver');
const SyphonSender = require('./syphon-sender');

let mainWindow;
let fullscreenWindow = null;
let currentFilePath = null;
let ndiEnabled = false;
let ndiSender = null;
let ndiResolution = { width: 1920, height: 1080, label: '1920x1080 (1080p)' };
let ndiFrameSkip = 4;  // Send every Nth frame (4 = 15fps at 60fps render, 1 = 60fps, 2 = 30fps)

// NDI input receivers for channels (one per channel 0-3)
let ndiReceivers = [null, null, null, null];
let ndiSourceCache = []; // Cached NDI sources for menu

// Syphon output (macOS only)
let syphonEnabled = false;
let syphonSender = null;

// Recording output (H.265 MP4 via FFmpeg)
let recordingProcess = null;
let recordingEnabled = false;
let recordingResolution = { width: 1920, height: 1080, label: '1920x1080 (1080p)' };
let recordingFlipBuffer = null;
let recordingLastWidth = 0;
let recordingLastHeight = 0;
let recordingFilePath = null;
let recordingBackpressure = false;

// Recording resolution presets (same as NDI)
const recordingResolutions = [
  { width: 640, height: 360, label: '640x360 (360p)' },
  { width: 854, height: 480, label: '854x480 (480p)' },
  { width: 1280, height: 720, label: '1280x720 (720p)' },
  { width: 1536, height: 864, label: '1536x864' },
  { width: 1920, height: 1080, label: '1920x1080 (1080p)' },
  { width: 2560, height: 1440, label: '2560x1440 (1440p)' },
  { width: 3072, height: 1824, label: '3072x1824' },
  { width: 3840, height: 2160, label: '3840x2160 (4K)' },
  { width: 0, height: 0, label: 'Match Preview' }
];

// NDI resolution presets
const ndiResolutions = [
  { width: 640, height: 360, label: '640x360 (360p)' },
  { width: 854, height: 480, label: '854x480 (480p)' },
  { width: 1280, height: 720, label: '1280x720 (720p)' },
  { width: 1536, height: 864, label: '1536x864' },
  { width: 1920, height: 1080, label: '1920x1080 (1080p)' },
  { width: 2560, height: 1440, label: '2560x1440 (1440p)' },
  { width: 3072, height: 1824, label: '3072x1824' },
  { width: 3840, height: 2160, label: '3840x2160 (4K)' },
  { width: 0, height: 0, label: 'Match Preview' },
  { width: -1, height: -1, label: 'Custom...' }
];

// Data directory in app folder
const dataDir = path.join(__dirname, 'data');
const shadersDir = path.join(dataDir, 'shaders');
const gridStateFile = path.join(dataDir, 'grid-state.json');
const presetsFile = path.join(dataDir, 'presets.json');
const settingsFile = path.join(dataDir, 'settings.json');
const viewStateFile = path.join(dataDir, 'view-state.json');
const tileStateFile = path.join(dataDir, 'tile-state.json');
const tilePresetsFile = path.join(dataDir, 'tile-presets.json');
const claudeKeyFile = path.join(dataDir, 'claude-key.json');

// Claude AI state
let claudeApiKey = null;
let claudeModel = 'claude-sonnet-4-20250514';
let claudeActiveRequest = null;

// Track tiled mode state
let tiledFullscreenWindow = null;
let tiledModeActive = false;

// Ensure data directory exists and migrate old data
async function ensureDataDir() {
  await fsPromises.mkdir(dataDir, { recursive: true });
  await fsPromises.mkdir(shadersDir, { recursive: true });

  // Migrate old grid state from userData if exists
  const oldGridStateFile = path.join(app.getPath('userData'), 'grid-state.json');
  try {
    await fsPromises.access(oldGridStateFile);
    try {
      await fsPromises.access(gridStateFile);
    } catch {
      // gridStateFile doesn't exist, migrate
      try {
        await fsPromises.copyFile(oldGridStateFile, gridStateFile);
        console.log('Migrated grid-state.json from userData to data directory');
      } catch (err) {
        console.error('Failed to migrate grid state:', err);
      }
    }
  } catch {
    // oldGridStateFile doesn't exist, nothing to migrate
  }
}

// Read a file and return its contents, or null if missing/error
async function readFileOrNull(filePath) {
  try {
    return await fsPromises.readFile(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.error(`Failed to read ${filePath}:`, err);
    return null;
  }
}

// Get shader file path for a slot
function getShaderFilePath(slotIndex) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 999) {
    throw new Error(`Invalid slot index: ${slotIndex}`);
  }
  return path.join(shadersDir, `button${slotIndex + 1}.glsl`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#1e1e1e',
    title: 'ShaderShow'
  });

  mainWindow.loadFile('index.html');

  // Update title when file changes
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
  });

  createMenu();
}

function createMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => newFile()
        },
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
          click: () => openFile()
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => saveFile()
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => saveFileAs()
        },
        { type: 'separator' },
        {
          label: 'Load Texture to Channel 0',
          click: () => loadTexture(0)
        },
        {
          label: 'Load Texture to Channel 1',
          click: () => loadTexture(1)
        },
        {
          label: 'Load Texture to Channel 2',
          click: () => loadTexture(2)
        },
        {
          label: 'Load Texture to Channel 3',
          click: () => loadTexture(3)
        },
        { type: 'separator' },
        {
          label: 'Load Video to Channel 0',
          click: () => loadVideo(0)
        },
        {
          label: 'Load Video to Channel 1',
          click: () => loadVideo(1)
        },
        {
          label: 'Load Video to Channel 2',
          click: () => loadVideo(2)
        },
        {
          label: 'Load Video to Channel 3',
          click: () => loadVideo(3)
        },
        { type: 'separator' },
        {
          label: 'Use Camera for Channel 0',
          click: () => useCamera(0)
        },
        {
          label: 'Use Camera for Channel 1',
          click: () => useCamera(1)
        },
        {
          label: 'Use Camera for Channel 2',
          click: () => useCamera(2)
        },
        {
          label: 'Use Camera for Channel 3',
          click: () => useCamera(3)
        },
        { type: 'separator' },
        {
          label: 'Use Audio Input (FFT) for Channel 0',
          click: () => useAudio(0)
        },
        {
          label: 'Use Audio Input (FFT) for Channel 1',
          click: () => useAudio(1)
        },
        {
          label: 'Use Audio Input (FFT) for Channel 2',
          click: () => useAudio(2)
        },
        {
          label: 'Use Audio Input (FFT) for Channel 3',
          click: () => useAudio(3)
        },
        { type: 'separator' },
        {
          label: 'NDI Source for Channel 0',
          submenu: buildNDISourceSubmenu(0)
        },
        {
          label: 'NDI Source for Channel 1',
          submenu: buildNDISourceSubmenu(1)
        },
        {
          label: 'NDI Source for Channel 2',
          submenu: buildNDISourceSubmenu(2)
        },
        {
          label: 'NDI Source for Channel 3',
          submenu: buildNDISourceSubmenu(3)
        },
        { type: 'separator' },
        {
          label: 'Clear Channel 0',
          click: () => clearChannel(0)
        },
        {
          label: 'Clear Channel 1',
          click: () => clearChannel(1)
        },
        {
          label: 'Clear Channel 2',
          click: () => clearChannel(2)
        },
        {
          label: 'Clear Channel 3',
          click: () => clearChannel(3)
        },
        { type: 'separator' },
        {
          label: 'Save Grid Presets...',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: () => saveGridPresetsAs()
        },
        {
          label: 'Load Grid Presets...',
          accelerator: 'CmdOrCtrl+Alt+G',
          click: () => loadGridPresetsFrom()
        },
        { type: 'separator' },
        {
          label: 'Export Application State...',
          click: () => exportApplicationState()
        },
        {
          label: 'Import Application State...',
          click: () => importApplicationState()
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
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
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Shader',
      submenu: [
        {
          label: 'Compile',
          accelerator: 'CmdOrCtrl+Enter',
          click: () => mainWindow.webContents.send('compile-shader')
        },
        {
          label: 'Play/Pause',
          accelerator: 'Space',
          click: () => mainWindow.webContents.send('toggle-playback')
        },
        {
          label: 'Reset Time',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow.webContents.send('reset-time')
        },
        { type: 'separator' },
        {
          label: 'Fullscreen Preview',
          submenu: buildFullscreenSubmenu()
        },
        {
          label: 'Configure Tiled Display...',
          click: () => mainWindow.webContents.send('open-tile-config')
        },
        { type: 'separator' },
        {
          label: 'Start NDI Output',
          id: 'ndi-toggle',
          click: () => toggleNDIOutput()
        },
        {
          label: 'NDI Resolution',
          id: 'ndi-resolution-menu',
          submenu: buildNDIResolutionSubmenu()
        },
        ...(isMac ? [
          { type: 'separator' },
          {
            label: 'Start Syphon Output',
            id: 'syphon-toggle',
            click: () => toggleSyphonOutput()
          }
        ] : []),
        { type: 'separator' },
        {
          label: 'Start Recording',
          id: 'recording-toggle',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            if (recordingEnabled) {
              stopRecording();
            } else {
              startRecording();
            }
          }
        },
        {
          label: 'Recording Resolution',
          id: 'recording-resolution-menu',
          submenu: buildRecordingResolutionSubmenu()
        },
        { type: 'separator' },
        {
          label: 'Run Benchmark...',
          click: () => mainWindow.webContents.send('run-benchmark')
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function buildFullscreenSubmenu() {
  const displays = screen.getAllDisplays();
  return displays.map((display, index) => ({
    label: `Display ${index + 1} (${display.size.width}x${display.size.height})`,
    accelerator: index === 0 ? 'CmdOrCtrl+F' : undefined,
    click: () => openFullscreen(display)
  }));
}

function buildNDIResolutionSubmenu() {
  return ndiResolutions.map((res) => ({
    label: res.label,
    type: 'radio',
    checked: ndiResolution.label === res.label,
    click: () => setNDIResolution(res)
  }));
}

function buildRecordingResolutionSubmenu() {
  return recordingResolutions.map((res) => ({
    label: res.label,
    type: 'radio',
    checked: recordingResolution.label === res.label,
    click: () => {
      recordingResolution = res;
      console.log(`Recording resolution set to ${res.label}`);
      saveSettingsToFile();
      createMenu();
    }
  }));
}

function buildNDISourceSubmenu(channel) {
  const items = [
    {
      label: 'Refresh Sources...',
      click: async () => {
        await refreshNDISources();
        createMenu(); // Rebuild menu with new sources
      }
    },
    { type: 'separator' }
  ];

  if (ndiSourceCache.length === 0) {
    items.push({
      label: '(No sources found)',
      enabled: false
    });
  } else {
    const currentSource = ndiReceivers[channel]?.getSource();
    ndiSourceCache.forEach(source => {
      items.push({
        label: source.name,
        type: 'radio',
        checked: currentSource && currentSource.name === source.name,
        click: () => useNDISource(channel, source)
      });
    });
  }

  return items;
}

async function setNDIResolution(res) {
  if (res.width === -1) {
    // Custom resolution - show dialog
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Custom NDI Resolution',
      message: 'Enter custom resolution',
      detail: 'Format: WIDTHxHEIGHT (e.g., 1280x720)',
      buttons: ['Cancel', 'OK'],
      defaultId: 1,
      cancelId: 0,
      inputPlaceholder: '1920x1080'
    });

    // Electron's showMessageBox doesn't support input, use a prompt window
    showCustomResolutionDialog();
    return;
  }

  if (res.width === 0) {
    // Match preview - get from renderer
    mainWindow.webContents.send('request-preview-resolution');
    return;
  }

  ndiResolution = res;
  console.log(`NDI resolution set to ${res.label}`);

  // If NDI is running, restart with new resolution
  if (ndiEnabled) {
    await restartNDIWithNewResolution();
  }

  // Rebuild menu to update radio buttons
  createMenu();
}

async function showCustomResolutionDialog() {
  // Create a simple dialog window for custom resolution
  const dialogWindow = new BrowserWindow({
    width: 300,
    height: 180,
    parent: mainWindow,
    modal: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-dialog.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#1e1e1e',
    title: 'Custom NDI Resolution'
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
}

async function restartNDIWithNewResolution() {
  if (ndiSender) {
    ndiSender.stop();
  }
  await startNDIOutput();
}

function openFullscreen(display) {
  // Close existing fullscreen window if any
  if (fullscreenWindow) {
    fullscreenWindow.close();
    fullscreenWindow = null;
  }

  // Request current shader state from main window
  mainWindow.webContents.send('request-fullscreen-state');

  // Store the display for when we receive the state
  pendingFullscreenDisplay = display;
}

let pendingFullscreenDisplay = null;

function createFullscreenWindow(display, shaderState) {
  const { x, y, width, height } = display.bounds;

  fullscreenWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    fullscreen: true,
    frame: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#000000'
  });

  fullscreenWindow.loadFile('fullscreen.html');

  // Pipe fullscreen console.log to main process terminal for debugging
  fullscreenWindow.webContents.on('console-message', (event, level, message) => {
    if (message.startsWith('[Fullscreen]')) {
      console.log(message);
    }
  });

  // Send shader state once the window is ready
  fullscreenWindow.webContents.on('did-finish-load', () => {
    fullscreenWindow.webContents.send('init-fullscreen', shaderState);
  });

  // Handle ESC key to close
  fullscreenWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      fullscreenWindow.close();
    }
  });

  // Notify renderer which display was selected
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fullscreen-opened', display.id);
  }

  fullscreenWindow.on('closed', () => {
    // Notify main window that fullscreen closed (for adaptive preview framerate)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fullscreen-closed');
    }
    fullscreenWindow = null;
  });
}

async function newFile(fileType = 'shader') {
  // Ask the renderer if there are unsaved changes
  const hasChanges = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5000);
    ipcMain.once('editor-has-changes-response', (event, result) => {
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
      message: 'Do you want to save changes to the current shader?'
    });

    if (result.response === 0) {
      // Save
      await saveFile();
    } else if (result.response === 2) {
      // Cancel
      return;
    }
    // Don't Save continues to new file
  }

  currentFilePath = null;
  mainWindow.webContents.send('new-file', { fileType });
  updateTitle();
}

async function openFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Shaders & Scenes', extensions: ['frag', 'glsl', 'shader', 'fs', 'jsx', 'js'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      currentFilePath = filePath;
      mainWindow.webContents.send('file-opened', { content, filePath });
      updateTitle();
    } catch (err) {
      dialog.showErrorBox('Error', `Failed to open file: ${err.message}`);
    }
  }
}

async function saveFile() {
  if (currentFilePath) {
    mainWindow.webContents.send('request-content-for-save');
  } else {
    saveFileAs();
  }
}

async function saveFileAs() {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: 'Fragment Shader', extensions: ['frag'] },
      { name: 'GLSL Shader', extensions: ['glsl'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!result.canceled && result.filePath) {
    currentFilePath = result.filePath;
    mainWindow.webContents.send('request-content-for-save');
    updateTitle();
  }
}

async function loadTexture(channel) {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    try {
      const data = await fsPromises.readFile(filePath);
      const base64 = data.toString('base64');
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.webp': 'image/webp'
      }[ext] || 'image/png';

      const dataUrl = `data:${mimeType};base64,${base64}`;
      mainWindow.webContents.send('texture-loaded', { channel, dataUrl, filePath });
    } catch (err) {
      dialog.showErrorBox('Error', `Failed to load texture: ${err.message}`);
    }
  }
}

async function loadVideo(channel) {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Video Files', extensions: ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    mainWindow.webContents.send('video-loaded', { channel, filePath });
  }
}

function useCamera(channel) {
  mainWindow.webContents.send('camera-requested', { channel });
}

function useAudio(channel) {
  mainWindow.webContents.send('audio-requested', { channel });
}

function clearChannel(channel) {
  if (!Number.isInteger(channel) || channel < 0 || channel > 3) return;
  // Also disconnect any NDI receiver on this channel
  if (ndiReceivers[channel]) {
    ndiReceivers[channel].disconnect();
    ndiReceivers[channel] = null;
  }
  mainWindow.webContents.send('channel-cleared', { channel });
}

// NDI Source functions
async function refreshNDISources() {
  console.log('Searching for NDI sources...');
  ndiSourceCache = await NDIReceiver.findSources(3000);
  console.log(`Found ${ndiSourceCache.length} NDI sources:`, ndiSourceCache.map(s => s.name));
  return ndiSourceCache;
}

async function useNDISource(channel, source) {
  console.log(`Connecting channel ${channel} to NDI source "${source.name}"...`);

  // Disconnect existing receiver on this channel
  if (ndiReceivers[channel]) {
    await ndiReceivers[channel].disconnect();
  }

  // Create new receiver
  const receiver = new NDIReceiver(channel);

  // Set up frame callback to forward frames to renderer
  receiver.onFrame = (ch, frame) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Send raw buffer via IPC (structured clone handles typed arrays efficiently)
      const frameBuffer = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
      mainWindow.webContents.send('ndi-input-frame', {
        channel: ch,
        width: frame.width,
        height: frame.height,
        data: frameBuffer
      });
    }
  };

  const success = await receiver.connect(source);

  if (success) {
    ndiReceivers[channel] = receiver;
    mainWindow.webContents.send('ndi-source-set', {
      channel,
      source: source.name,
      width: receiver.lastFrame?.width || 0,
      height: receiver.lastFrame?.height || 0
    });
    createMenu(); // Update menu to show checked state
  } else {
    console.error(`Failed to connect to NDI source "${source.name}"`);
  }
}

function toggleNDIOutput() {
  if (ndiEnabled) {
    stopNDIOutput();
  } else {
    startNDIOutput();
  }
}

async function startNDIOutput() {
  if (!ndiSender) {
    ndiSender = new NDISender('ShaderShow');
  }

  // Use selected NDI resolution
  const success = await ndiSender.start({
    width: ndiResolution.width,
    height: ndiResolution.height,
    frameRateN: 60,
    frameRateD: 1
  });

  if (success) {
    ndiEnabled = true;
    mainWindow.webContents.send('ndi-status', {
      enabled: true,
      native: true,
      width: ndiResolution.width,
      height: ndiResolution.height
    });
    updateNDIMenu();
    console.log('Native NDI output started');
  } else {
    mainWindow.webContents.send('ndi-status', { enabled: false, error: 'Failed to start NDI' });
  }
}

function stopNDIOutput() {
  if (ndiSender) {
    ndiSender.stop();
  }

  ndiEnabled = false;
  mainWindow.webContents.send('ndi-status', { enabled: false });
  updateNDIMenu();
  console.log('NDI output stopped');
}

function updateNDIMenu() {
  const menu = Menu.getApplicationMenu();
  const ndiItem = menu.getMenuItemById('ndi-toggle');
  if (ndiItem) {
    ndiItem.label = ndiEnabled ? 'Stop NDI Output' : 'Start NDI Output';
  }
}

// Pre-allocated buffers for NDI frame flipping (avoid allocation per frame)
let ndiFlipBuffer = null;
let ndiLastWidth = 0;
let ndiLastHeight = 0;

async function sendNDIFrame(frameData) {
  if (ndiSender && ndiEnabled) {
    try {
      const { data, width, height, flipped } = frameData;

      // Handle both raw Uint8Array and legacy base64 format
      let sourceBuffer;
      if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
        sourceBuffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      } else if (frameData.rgbaData) {
        // Legacy base64 format fallback
        sourceBuffer = Buffer.from(frameData.rgbaData, 'base64');
      } else {
        console.error('NDI frame: invalid data format');
        return;
      }

      // If already flipped by renderer (async PBO readback), send directly
      if (flipped) {
        await ndiSender.sendFrame(sourceBuffer, width, height);
        return;
      }

      // Otherwise flip vertically (sync readback path)
      const rowSize = width * 4;
      const bufferSize = width * height * 4;

      // Reallocate flip buffer only if resolution changed
      if (width !== ndiLastWidth || height !== ndiLastHeight) {
        ndiFlipBuffer = Buffer.allocUnsafe(bufferSize);
        ndiLastWidth = width;
        ndiLastHeight = height;
      }

      // Flip vertically using Buffer.copy (native, much faster than JS loops)
      // WebGL readPixels gives bottom-to-top, NDI expects top-to-bottom
      for (let y = 0; y < height; y++) {
        const srcOffset = (height - 1 - y) * rowSize;
        const dstOffset = y * rowSize;
        sourceBuffer.copy(ndiFlipBuffer, dstOffset, srcOffset, srcOffset + rowSize);
      }

      await ndiSender.sendFrame(ndiFlipBuffer, width, height);
    } catch (e) {
      console.error('NDI frame send error:', e.message);
    }
  }
}

// Syphon output functions (macOS only)
function toggleSyphonOutput() {
  if (syphonEnabled) {
    stopSyphonOutput();
  } else {
    startSyphonOutput();
  }
}

async function startSyphonOutput() {
  if (process.platform !== 'darwin') {
    console.log('Syphon is only available on macOS');
    return;
  }

  if (!syphonSender) {
    syphonSender = new SyphonSender('ShaderShow');
  }

  const success = await syphonSender.start({
    width: 1920,
    height: 1080
  });

  if (success) {
    syphonEnabled = true;
    mainWindow.webContents.send('syphon-status', { enabled: true });
    updateSyphonMenu();
    console.log('Syphon output started');
  } else {
    mainWindow.webContents.send('syphon-status', { enabled: false, error: 'Failed to start Syphon' });
  }
}

function stopSyphonOutput() {
  if (syphonSender) {
    syphonSender.stop();
  }

  syphonEnabled = false;
  mainWindow.webContents.send('syphon-status', { enabled: false });
  updateSyphonMenu();
  console.log('Syphon output stopped');
}

function updateSyphonMenu() {
  const menu = Menu.getApplicationMenu();
  const syphonItem = menu.getMenuItemById('syphon-toggle');
  if (syphonItem) {
    syphonItem.label = syphonEnabled ? 'Stop Syphon Output' : 'Start Syphon Output';
  }
}

// Pre-allocated buffers for Syphon frame flipping
let syphonFlipBuffer = null;
let syphonLastWidth = 0;
let syphonLastHeight = 0;

async function sendSyphonFrame(frameData) {
  if (syphonSender && syphonEnabled) {
    try {
      const { data, width, height } = frameData;

      // Handle both raw Uint8Array and legacy base64 format
      let sourceBuffer;
      if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
        sourceBuffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      } else if (frameData.rgbaData) {
        // Legacy base64 format fallback
        sourceBuffer = Buffer.from(frameData.rgbaData, 'base64');
      } else {
        console.error('Syphon frame: invalid data format');
        return;
      }

      const rowSize = width * 4;
      const bufferSize = width * height * 4;

      // Reallocate flip buffer only if resolution changed
      if (width !== syphonLastWidth || height !== syphonLastHeight) {
        syphonFlipBuffer = Buffer.allocUnsafe(bufferSize);
        syphonLastWidth = width;
        syphonLastHeight = height;
      }

      // Flip vertically using Buffer.copy (native, much faster than JS loops)
      for (let y = 0; y < height; y++) {
        const srcOffset = (height - 1 - y) * rowSize;
        const dstOffset = y * rowSize;
        sourceBuffer.copy(syphonFlipBuffer, dstOffset, srcOffset, srcOffset + rowSize);
      }

      await syphonSender.sendFrame(syphonFlipBuffer, width, height);
    } catch (e) {
      console.error('Syphon frame send error:', e.message);
    }
  }
}

// =============================================================================
// Recording (H.265 MP4 via FFmpeg)
// =============================================================================

async function startRecording() {
  if (recordingEnabled) {
    return { error: 'Already recording' };
  }

  // Show save dialog
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Recording',
    defaultPath: `recording-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.mp4`,
    filters: [
      { name: 'MP4 Video', extensions: ['mp4'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  recordingFilePath = result.filePath;

  // Resolve recording resolution (handle "Match Preview")
  let recWidth = recordingResolution.width;
  let recHeight = recordingResolution.height;

  if (recWidth === 0 || recHeight === 0) {
    // Match Preview - get from renderer via sync IPC
    const previewRes = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ width: 1920, height: 1080 }), 5000);
      ipcMain.once('preview-resolution-for-recording', (event, data) => {
        clearTimeout(timeout);
        resolve(data);
      });
      mainWindow.webContents.send('request-preview-resolution-for-recording');
    });
    recWidth = previewRes.width;
    recHeight = previewRes.height;
  }

  // Ensure even dimensions (required by H.265)
  recWidth = recWidth % 2 === 0 ? recWidth : recWidth + 1;
  recHeight = recHeight % 2 === 0 ? recHeight : recHeight + 1;

  // Choose encoder: hevc_videotoolbox on macOS, libx265 elsewhere
  const isMac = process.platform === 'darwin';
  const encoder = isMac ? 'hevc_videotoolbox' : 'libx265';

  const ffmpegArgs = [
    '-y',
    '-f', 'rawvideo',
    '-pixel_format', 'rgba',
    '-video_size', `${recWidth}x${recHeight}`,
    '-framerate', '60',
    '-i', 'pipe:0',
    '-c:v', encoder,
    ...(isMac ? ['-preset', 'fast'] : ['-preset', 'fast', '-crf', '23']),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    recordingFilePath
  ];

  console.log(`Starting recording: ${ffmpegPath} ${ffmpegArgs.join(' ')}`);

  recordingProcess = spawn(ffmpegPath, ffmpegArgs, {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  recordingProcess.stderr.on('data', (data) => {
    // FFmpeg outputs progress info to stderr
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('error')) {
      console.error('FFmpeg error:', msg);
    }
  });

  recordingProcess.on('close', (code) => {
    console.log(`FFmpeg exited with code ${code}`);
    recordingEnabled = false;
    recordingProcess = null;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-status', {
        enabled: false,
        filePath: recordingFilePath,
        exitCode: code
      });
    }

    updateRecordingMenu();
  });

  recordingProcess.on('error', (err) => {
    console.error('FFmpeg spawn error:', err);
    recordingEnabled = false;
    recordingProcess = null;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-status', {
        enabled: false,
        error: err.message
      });
    }
  });

  // Handle broken pipe gracefully
  recordingProcess.stdin.on('error', (err) => {
    if (err.code !== 'EPIPE') {
      console.error('FFmpeg stdin error:', err);
    }
  });

  recordingEnabled = true;

  mainWindow.webContents.send('recording-status', {
    enabled: true,
    width: recWidth,
    height: recHeight,
    filePath: recordingFilePath
  });

  updateRecordingMenu();

  return {
    filePath: recordingFilePath,
    width: recWidth,
    height: recHeight
  };
}

function stopRecording() {
  if (!recordingProcess) return;

  console.log('Stopping recording...');

  // Close stdin to signal FFmpeg to finalize the file
  try {
    recordingProcess.stdin.end();
  } catch (err) {
    console.error('Error closing FFmpeg stdin:', err);
    // Force kill if stdin close fails
    recordingProcess.kill('SIGTERM');
  }

  // The 'close' event handler above will update state and notify renderer
}

function sendRecordingFrame(frameData) {
  if (!recordingProcess || !recordingEnabled) return;

  try {
    const { data, width, height } = frameData;

    let sourceBuffer;
    if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
      sourceBuffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    } else {
      console.error('Recording frame: invalid data format');
      return;
    }

    const rowSize = width * 4;
    const bufferSize = width * height * 4;

    // Reallocate flip buffer only if resolution changed
    if (width !== recordingLastWidth || height !== recordingLastHeight) {
      recordingFlipBuffer = Buffer.allocUnsafe(bufferSize);
      recordingLastWidth = width;
      recordingLastHeight = height;
    }

    // Flip vertically (WebGL readPixels gives bottom-to-top, video expects top-to-bottom)
    for (let y = 0; y < height; y++) {
      const srcOffset = (height - 1 - y) * rowSize;
      const dstOffset = y * rowSize;
      sourceBuffer.copy(recordingFlipBuffer, dstOffset, srcOffset, srcOffset + rowSize);
    }

    // Write to FFmpeg stdin
    if (recordingBackpressure) return; // Drop frame during back-pressure
    const canWrite = recordingProcess.stdin.write(recordingFlipBuffer);
    if (!canWrite) {
      recordingBackpressure = true;
      recordingProcess.stdin.once('drain', () => { recordingBackpressure = false; });
    }
  } catch (err) {
    console.error('Recording frame error:', err.message);
  }
}

function updateRecordingMenu() {
  const menu = Menu.getApplicationMenu();
  const recordItem = menu.getMenuItemById('recording-toggle');
  if (recordItem) {
    recordItem.label = recordingEnabled ? 'Stop Recording' : 'Start Recording';
  }
}

async function saveGridPresetsAs() {
  mainWindow.webContents.send('request-grid-state-for-save');
}

async function loadGridPresetsFrom() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Grid Presets', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    try {
      const data = await fsPromises.readFile(filePath, 'utf-8');
      const gridState = JSON.parse(data);
      mainWindow.webContents.send('load-grid-presets', { gridState, filePath });
    } catch (err) {
      dialog.showErrorBox('Error', `Failed to load grid presets: ${err.message}`);
    }
  }
}

// =============================================================================
// Application State Export/Import
// =============================================================================

// Recursively read all files in a directory into an object
async function readDirectoryContents(dirPath, basePath = '') {
  const contents = {};

  try {
    await fsPromises.access(dirPath);
  } catch {
    return contents;
  }

  const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      // Recursively read subdirectory
      const subContents = await readDirectoryContents(entryPath, relativePath);
      Object.assign(contents, subContents);
    } else if (entry.isFile()) {
      // Read file content
      try {
        const data = await fsPromises.readFile(entryPath);
        // Store as base64 for binary files, utf-8 for text
        const isText = /\.(json|glsl|frag|vert|txt|jsx|js)$/i.test(entry.name);
        contents[relativePath] = {
          encoding: isText ? 'utf8' : 'base64',
          content: isText ? data.toString('utf8') : data.toString('base64')
        };
      } catch (err) {
        console.error(`Failed to read ${entryPath}:`, err);
      }
    }
  }

  return contents;
}

// Write files from an object back to a directory
async function writeDirectoryContents(dirPath, contents) {
  const resolvedBase = path.resolve(dirPath) + path.sep;
  for (const [relativePath, fileData] of Object.entries(contents)) {
    const fullPath = path.resolve(dirPath, relativePath);

    // Prevent path traversal
    if (!fullPath.startsWith(resolvedBase)) {
      console.error(`Path traversal blocked: ${relativePath}`);
      continue;
    }

    // Validate encoding
    if (fileData.encoding !== 'utf8' && fileData.encoding !== 'base64') {
      console.error(`Invalid encoding for ${relativePath}: ${fileData.encoding}`);
      continue;
    }

    const parentDir = path.dirname(fullPath);
    await fsPromises.mkdir(parentDir, { recursive: true });

    const content = fileData.encoding === 'base64'
      ? Buffer.from(fileData.content, 'base64')
      : fileData.content;

    await fsPromises.writeFile(fullPath, content);
  }
}

async function exportApplicationState() {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `shadershow-state-${new Date().toISOString().slice(0, 10)}.shadershow`,
    filters: [
      { name: 'ShaderShow State', extensions: ['shadershow'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return;
  }

  try {
    // Read all files from data directory
    const dataContents = await readDirectoryContents(dataDir);

    // Exclude sensitive files from export
    delete dataContents['claude-key.json'];

    // Build state bundle
    const stateBundle = {
      version: 1,
      exportedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      files: dataContents
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
      detail: `Saved to: ${result.filePath}\n\nIncluded ${Object.keys(dataContents).length} files.`
    });
  } catch (err) {
    dialog.showErrorBox('Export Error', `Failed to export application state: ${err.message}`);
  }
}

async function importApplicationState() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'ShaderShow State', extensions: ['shadershow'] },
      { name: 'All Files', extensions: ['*'] }
    ]
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
    detail: 'All existing shaders, presets, and settings will be overwritten. This action cannot be undone.\n\nDo you want to continue?',
    buttons: ['Cancel', 'Import'],
    defaultId: 0,
    cancelId: 0
  });

  if (confirmResult.response !== 1) {
    return;
  }

  try {
    // Read and decompress file
    const compressed = await fsPromises.readFile(filePath);
    const decompressed = await gunzip(compressed);
    const stateBundle = JSON.parse(decompressed.toString('utf8'));

    // Validate bundle
    if (!stateBundle.version || !stateBundle.files || typeof stateBundle.files !== 'object') {
      throw new Error('Invalid state file format');
    }
    // Validate file count
    const fileKeys = Object.keys(stateBundle.files);
    if (fileKeys.length > 1000) {
      throw new Error('State file contains too many files');
    }

    // Write files to data directory
    await writeDirectoryContents(dataDir, stateBundle.files);

    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Import Complete',
      message: 'Application state imported successfully.',
      detail: `Imported ${Object.keys(stateBundle.files).length} files.\n\nPlease restart the application for changes to take effect.`,
      buttons: ['Restart Now', 'Restart Later']
    }).then(({ response }) => {
      if (response === 0) {
        app.relaunch();
        app.exit(0);
      }
    });
  } catch (err) {
    dialog.showErrorBox('Import Error', `Failed to import application state: ${err.message}`);
  }
}

function updateTitle() {
  const fileName = currentFilePath ? path.basename(currentFilePath) : 'Untitled';
  mainWindow.setTitle(`${fileName} - ShaderShow`);
}

// IPC Handlers
ipcMain.on('save-content', async (event, content) => {
  if (currentFilePath) {
    try {
      await fsPromises.writeFile(currentFilePath, content, 'utf-8');
    } catch (err) {
      dialog.showErrorBox('Error', `Failed to save file: ${err.message}`);
    }
  }
});

ipcMain.handle('get-default-shader', async () => {
  // Return a new shader with prologue comment listing all uniforms
  return `/*
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
});

ipcMain.handle('get-default-scene', async () => {
  // Return a new Three.js scene template
  return `/*
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

function animate(context, time, deltaTime, params) {
  const { cube, material } = context;

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
});

// Fullscreen state handler
ipcMain.on('fullscreen-state', (event, shaderState) => {
  if (pendingFullscreenDisplay) {
    createFullscreenWindow(pendingFullscreenDisplay, shaderState);
    pendingFullscreenDisplay = null;
  }
});

// Forward shader updates to fullscreen window
ipcMain.on('shader-update', (event, data) => {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.webContents.send('shader-update', data);
  }
});

// Forward time sync to fullscreen window
ipcMain.on('time-sync', (event, data) => {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.webContents.send('time-sync', data);
  }
});

// Forward param updates to fullscreen window
ipcMain.on('param-update', (event, data) => {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.webContents.send('param-update', data);
  }
});

// Forward batched param updates to fullscreen window (reduces IPC overhead)
ipcMain.on('batch-param-update', (event, params) => {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    // Send all params in a single IPC call
    fullscreenWindow.webContents.send('batch-param-update', params);
  }
});

// Blackout fullscreen
ipcMain.on('blackout', (event, enabled) => {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.webContents.send('blackout', enabled);
  }
});

// Get display refresh rate for fullscreen window
ipcMain.handle('get-display-refresh-rate', (event) => {
  const { screen } = require('electron');
  // Get the display where the fullscreen window is located
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    const display = screen.getDisplayMatching(fullscreenWindow.getBounds());
    return display.displayFrequency || 60;
  }
  // Default to primary display
  const primaryDisplay = screen.getPrimaryDisplay();
  return primaryDisplay.displayFrequency || 60;
});

// Forward fullscreen FPS to main window
ipcMain.on('fullscreen-fps', (event, fps) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fullscreen-fps', fps);
  }
});

// Bidirectional preset sync between main and fullscreen windows
ipcMain.on('preset-sync', (event, data) => {
  const senderId = event.sender.id;

  // Forward to fullscreen if sender is main window
  if (mainWindow && !mainWindow.isDestroyed() && senderId === mainWindow.webContents.id) {
    if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
      fullscreenWindow.webContents.send('preset-sync', data);
    }
  }

  // Forward to main if sender is fullscreen window
  if (fullscreenWindow && !fullscreenWindow.isDestroyed() && senderId === fullscreenWindow.webContents.id) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('preset-sync', data);
    }
  }
});

// Load shader or scene for grid slot
ipcMain.handle('load-shader-for-grid', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Shaders & Scenes', extensions: ['frag', 'glsl', 'shader', 'fs', 'jsx', 'js'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      return { content, filePath };
    } catch (err) {
      return { error: err.message };
    }
  }
  return null;
});

// Open fullscreen with shader from grid
ipcMain.on('open-fullscreen-with-shader', (event, shaderState) => {
  const displays = screen.getAllDisplays();
  // Use primary display or first display
  const display = displays.find(d => d.bounds.x === 0 && d.bounds.y === 0) || displays[0];

  if (fullscreenWindow) {
    fullscreenWindow.close();
    fullscreenWindow = null;
  }

  createFullscreenWindow(display, shaderState);
});

// Save grid state (supports both legacy array format and new tabbed format)
ipcMain.on('save-grid-state', async (event, gridState) => {
  await ensureDataDir();
  try {
    // Check if this is the new tabbed format (version 2)
    if (gridState.version === 2 && gridState.tabs) {
      // New tabbed format - save with embedded shader code
      const tabs = [];
      let globalSlotIndex = 0;
      for (const tab of gridState.tabs) {
        // Mix tabs: pass through directly (no shader files to read)
        if (tab.type === 'mix') {
          tabs.push({ name: tab.name, type: 'mix', mixPresets: tab.mixPresets || [] });
          continue;
        }

        const slots = [];
        for (let i = 0; i < tab.slots.length; i++) {
          const slot = tab.slots[i];
          if (!slot) {
            slots.push(null);
          } else {
            // Use global slot index for file mapping across tabs
            const shaderFile = getShaderFilePath(globalSlotIndex);
            const shaderCode = await readFileOrNull(shaderFile);
            slots.push({
              shaderCode: shaderCode,
              filePath: slot.filePath,
              params: slot.params,
              customParams: slot.customParams || {},
              presets: slot.presets || [],
              type: slot.type || 'shader'
            });
          }
          globalSlotIndex++;
        }
        tabs.push({ name: tab.name, type: tab.type || 'shaders', slots });
      }
      const saveData = {
        version: 2,
        activeTab: gridState.activeTab,
        tabs
      };
      await fsPromises.writeFile(gridStateFile, JSON.stringify(saveData, null, 2), 'utf-8');
    } else {
      // Legacy format - save metadata without shader code
      const metadata = gridState.map((slot, index) => {
        if (!slot) return null;
        return {
          filePath: slot.filePath,
          params: slot.params,
          presets: slot.presets || []
        };
      });
      await fsPromises.writeFile(gridStateFile, JSON.stringify(metadata, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('Failed to save grid state:', err);
  }
});

// Load grid state (loads metadata and shader code)
ipcMain.handle('load-grid-state', async () => {
  try {
    const raw = await readFileOrNull(gridStateFile);
    if (raw) {
      const savedData = JSON.parse(raw);

      // Check if this is the new tabbed format (version 2)
      if (savedData.version === 2 && savedData.tabs) {
        // New tabbed format — fill in missing shaderCode from .glsl files
        let globalSlotIndex = 0;
        for (const tab of savedData.tabs) {
          if (!tab.slots) continue;
          for (let i = 0; i < tab.slots.length; i++) {
            const slot = tab.slots[i];
            if (slot && !slot.shaderCode) {
              const shaderFile = getShaderFilePath(globalSlotIndex);
              const code = await readFileOrNull(shaderFile);
              if (code) {
                slot.shaderCode = code;
                // Auto-detect scene type if not already set
                if (slot.type !== 'scene' && code.includes('function setup') &&
                    (code.includes('THREE') || code.includes('scene'))) {
                  slot.type = 'scene';
                }
              }
            }
            globalSlotIndex++;
          }
        }
        return savedData;
      }

      // Legacy format - load shader code from individual files
      const metadata = savedData;
      const state = await Promise.all(metadata.map(async (slot, index) => {
        if (!slot) {
          // Check if shader file exists even without metadata
          const shaderFile = getShaderFilePath(index);
          const shaderCode = await readFileOrNull(shaderFile);
          if (shaderCode) {
            return { shaderCode, filePath: null, params: {}, presets: [] };
          }
          return null;
        }

        // Load shader code from file
        const shaderFile = getShaderFilePath(index);
        const shaderCode = await readFileOrNull(shaderFile);

        if (!shaderCode) return null;

        // Detect type from content if not saved in metadata
        let type = slot.type || 'shader';
        if (type === 'shader' && shaderCode.includes('function setup') &&
            (shaderCode.includes('THREE') || shaderCode.includes('scene'))) {
          type = 'scene';
        }

        return {
          shaderCode,
          filePath: slot.filePath,
          params: slot.params || {},
          customParams: slot.customParams || {},
          presets: slot.presets || [],
          paramNames: slot.paramNames || {},
          type
        };
      }));

      return state;
    } else {
      // No metadata file - scan for shader files dynamically
      const state = [];
      const MAX_SLOTS = 64;
      for (let i = 0; i < MAX_SLOTS; i++) {
        const shaderFile = getShaderFilePath(i);
        const shaderCode = await readFileOrNull(shaderFile);
        if (shaderCode) {
          const isScene = shaderCode.includes('function setup') &&
            (shaderCode.includes('THREE') || shaderCode.includes('scene'));
          state.push({ shaderCode, filePath: null, params: {}, presets: [], type: isScene ? 'scene' : 'shader' });
        } else {
          break;
        }
      }
      return state;
    }
  } catch (err) {
    console.error('Failed to load grid state:', err);
  }
  return null;
});

// Save parameter presets
ipcMain.on('save-presets', async (event, presets) => {
  await ensureDataDir();
  try {
    await fsPromises.writeFile(presetsFile, JSON.stringify(presets, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save presets:', err);
  }
});

// Load parameter presets
ipcMain.handle('load-presets', async () => {
  try {
    const raw = await readFileOrNull(presetsFile);
    if (raw) return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load presets:', err);
  }
  return [];
});

// NDI frame receiver (output)
ipcMain.on('ndi-frame', (event, frameData) => {
  sendNDIFrame(frameData);
});

// NDI source discovery (input)
ipcMain.handle('find-ndi-sources', async () => {
  return await refreshNDISources();
});

// Set channel to NDI source
ipcMain.on('set-channel-ndi', async (event, { channel, source }) => {
  if (!Number.isInteger(channel) || channel < 0 || channel > 3) return;
  await useNDISource(channel, source);
});

// Clear NDI from channel
ipcMain.on('clear-channel-ndi', (event, { channel }) => {
  if (!Number.isInteger(channel) || channel < 0 || channel > 3) return;
  if (ndiReceivers[channel]) {
    ndiReceivers[channel].disconnect();
    ndiReceivers[channel] = null;
    createMenu();
  }
});

// Custom NDI resolution from dialog
ipcMain.on('custom-ndi-resolution-from-dialog', async (event, { width, height }) => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 128 || height < 128 || width > 7680 || height > 4320) {
    return;
  }
  ndiResolution = {
    width,
    height,
    label: `${width}x${height} (Custom)`
  };
  console.log(`NDI resolution set to ${ndiResolution.label}`);
  if (ndiEnabled) {
    await restartNDIWithNewResolution();
  }
  createMenu();
});

ipcMain.on('custom-ndi-resolution', async (event, { width, height }) => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 128 || height < 128 || width > 7680 || height > 4320) {
    return;
  }
  ndiResolution = {
    width,
    height,
    label: `${width}x${height} (Custom)`
  };
  console.log(`NDI resolution set to ${ndiResolution.label}`);

  if (ndiEnabled) {
    await restartNDIWithNewResolution();
  }

  createMenu();
});

// Preview resolution for "Match Preview" option
ipcMain.on('preview-resolution', async (event, { width, height }) => {
  ndiResolution = {
    width,
    height,
    label: `${width}x${height} (Match Preview)`
  };
  console.log(`NDI resolution set to ${ndiResolution.label}`);

  if (ndiEnabled) {
    await restartNDIWithNewResolution();
  }

  createMenu();
});

// Trigger new file from toolbar
ipcMain.on('trigger-new-file', (event, fileType) => {
  newFile(fileType || 'shader');
});

// Trigger open file from toolbar
ipcMain.on('trigger-open-file', () => {
  openFile();
});

// Toggle NDI from toolbar
ipcMain.on('toggle-ndi', () => {
  toggleNDIOutput();
});

// Syphon frame receiver (output)
ipcMain.on('syphon-frame', (event, frameData) => {
  sendSyphonFrame(frameData);
});

// Toggle Syphon from toolbar
ipcMain.on('toggle-syphon', () => {
  toggleSyphonOutput();
});

// Recording IPC handlers
ipcMain.handle('start-recording', async () => {
  return await startRecording();
});

ipcMain.on('stop-recording', () => {
  stopRecording();
});

ipcMain.on('recording-frame', (event, frameData) => {
  sendRecordingFrame(frameData);
});

// Preview resolution for "Match Preview" recording option
ipcMain.on('preview-resolution-for-recording', (event, data) => {
  // Handled via ipcMain.once in startRecording
});

// Open fullscreen on primary display
ipcMain.on('open-fullscreen-primary', () => {
  const displays = screen.getAllDisplays();
  const primaryDisplay = displays.find(d => d.bounds.x === 0 && d.bounds.y === 0) || displays[0];
  openFullscreen(primaryDisplay);
});

// Get available displays for the fullscreen selector
ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays().map((display, index) => ({
    id: display.id,
    label: `Display ${index + 1} (${display.size.width}x${display.size.height})`,
    primary: display.bounds.x === 0 && display.bounds.y === 0
  }));
});

// Open fullscreen on a specific display by ID
ipcMain.on('open-fullscreen-on-display', (event, displayId) => {
  const display = screen.getAllDisplays().find(d => d.id === displayId);
  if (display) openFullscreen(display);
});

// Close fullscreen window
ipcMain.on('close-fullscreen', () => {
  if (fullscreenWindow) {
    fullscreenWindow.close();
    fullscreenWindow = null;
  }
});

// Get settings
ipcMain.handle('get-settings', async () => {
  // Load param ranges from settings file
  let paramRanges = null;
  try {
    const raw = await readFileOrNull(settingsFile);
    if (raw) {
      const data = JSON.parse(raw);
      paramRanges = data.paramRanges || null;
    }
  } catch (err) {
    console.error('Failed to load param ranges:', err);
  }

  // Load grid slot width from settings file
  let gridSlotWidth = null;
  try {
    const rawSettings = await readFileOrNull(settingsFile);
    if (rawSettings) {
      const parsed = JSON.parse(rawSettings);
      gridSlotWidth = parsed.gridSlotWidth || null;
    }
  } catch (err) { /* ignore */ }

  return {
    ndiResolution: ndiResolution,
    ndiResolutions: ndiResolutions,
    ndiEnabled: ndiEnabled,
    ndiFrameSkip: ndiFrameSkip,
    recordingResolution: recordingResolution,
    recordingResolutions: recordingResolutions,
    paramRanges: paramRanges,
    gridSlotWidth: gridSlotWidth
  };
});

// Save settings
ipcMain.on('save-settings', async (event, settings) => {
  if (settings.ndiResolution) {
    const res = ndiResolutions.find(r => r.label === settings.ndiResolution.label);
    if (res) {
      await setNDIResolution(res);
    } else if (settings.ndiResolution.width > 0) {
      ndiResolution = settings.ndiResolution;
      if (ndiEnabled) {
        await restartNDIWithNewResolution();
      }
      createMenu();
    }
  }

  // Handle NDI frame skip
  if (typeof settings.ndiFrameSkip === 'number' && settings.ndiFrameSkip >= 1) {
    ndiFrameSkip = Math.floor(settings.ndiFrameSkip);
    // Notify renderer to update its frame skip value
    mainWindow.webContents.send('ndi-frame-skip-changed', ndiFrameSkip);
  }

  // Handle recording resolution
  if (settings.recordingResolution) {
    recordingResolution = settings.recordingResolution;
  }

  // Save all settings including param ranges and grid slot width
  const additionalData = {};
  if (settings.paramRanges) {
    additionalData.paramRanges = settings.paramRanges;
  }
  if (settings.gridSlotWidth) {
    additionalData.gridSlotWidth = settings.gridSlotWidth;
  }
  saveSettingsToFile(additionalData);

  mainWindow.webContents.send('settings-changed', settings);
});

// Save grid presets to custom file
ipcMain.on('save-grid-presets-to-file', async (event, gridState) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: 'Grid Presets', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    defaultPath: 'grid-presets.json'
  });

  if (!result.canceled && result.filePath) {
    try {
      await fsPromises.writeFile(result.filePath, JSON.stringify(gridState, null, 2), 'utf-8');
      mainWindow.webContents.send('grid-presets-saved', { filePath: result.filePath });
    } catch (err) {
      dialog.showErrorBox('Error', `Failed to save grid presets: ${err.message}`);
    }
  }
});

app.whenReady().then(async () => {
  await ensureDataDir();
  await loadSettings();
  await loadClaudeKey();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Load saved settings on startup
async function loadSettings() {
  try {
    const raw = await readFileOrNull(settingsFile);
    if (raw) {
      const data = JSON.parse(raw);
      if (data.ndiResolution) {
        ndiResolution = data.ndiResolution;
      }
      if (data.recordingResolution) {
        recordingResolution = data.recordingResolution;
      }
      if (typeof data.ndiFrameSkip === 'number' && data.ndiFrameSkip >= 1) {
        ndiFrameSkip = data.ndiFrameSkip;
      }
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

// Save settings to file (async, non-blocking)
async function saveSettingsToFile(additionalData = {}) {
  await ensureDataDir();
  try {
    // Load existing settings to preserve other data
    let existingData = {};
    const raw = await readFileOrNull(settingsFile);
    if (raw) {
      existingData = JSON.parse(raw);
    }

    const data = {
      ...existingData,
      ndiResolution: ndiResolution,
      ndiFrameSkip: ndiFrameSkip,
      recordingResolution: recordingResolution,
      ...additionalData
    };
    await fsPromises.writeFile(settingsFile, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

// Save shader to slot file
ipcMain.handle('save-shader-to-slot', async (event, slotIndex, shaderCode) => {
  await ensureDataDir();
  try {
    const shaderFile = getShaderFilePath(slotIndex);
    await fsPromises.writeFile(shaderFile, shaderCode, 'utf-8');
    return { success: true, path: shaderFile };
  } catch (err) {
    console.error(`Failed to save shader to slot ${slotIndex}:`, err);
    return { success: false, error: err.message };
  }
});

// Load shader from slot file
ipcMain.handle('load-shader-from-slot', async (event, slotIndex) => {
  try {
    const shaderFile = getShaderFilePath(slotIndex);
    const shaderCode = await fsPromises.readFile(shaderFile, 'utf-8');
    return { success: true, shaderCode };
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: 'File not found' };
    console.error(`Failed to load shader from slot ${slotIndex}:`, err);
    return { success: false, error: err.message };
  }
});

// Delete shader from slot file
ipcMain.handle('delete-shader-from-slot', async (event, slotIndex) => {
  try {
    const shaderFile = getShaderFilePath(slotIndex);
    await fsPromises.unlink(shaderFile);
    return { success: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { success: true }; // Already deleted
    console.error(`Failed to delete shader from slot ${slotIndex}:`, err);
    return { success: false, error: err.message };
  }
});

// Save view state
ipcMain.on('save-view-state', async (event, viewState) => {
  await ensureDataDir();
  try {
    await fsPromises.writeFile(viewStateFile, JSON.stringify(viewState, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save view state:', err);
  }
});

// Load view state
ipcMain.handle('load-view-state', async () => {
  try {
    const raw = await readFileOrNull(viewStateFile);
    if (raw) return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load view state:', err);
  }
  return null;
});

// =============================================================================
// Tiled Display IPC Handlers
// =============================================================================

// Save tile state
ipcMain.on('save-tile-state', async (event, tileState) => {
  await ensureDataDir();
  try {
    await fsPromises.writeFile(tileStateFile, JSON.stringify(tileState, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save tile state:', err);
  }
});

// Load tile state
ipcMain.handle('load-tile-state', async () => {
  try {
    const raw = await readFileOrNull(tileStateFile);
    if (raw) return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load tile state:', err);
  }
  return null;
});

// Save tile presets (full snapshots with embedded shader code)
ipcMain.on('save-tile-presets', async (event, presets) => {
  await ensureDataDir();
  try {
    await fsPromises.writeFile(tilePresetsFile, JSON.stringify(presets, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save tile presets:', err);
  }
});

// Load tile presets
ipcMain.handle('load-tile-presets', async () => {
  try {
    const raw = await readFileOrNull(tilePresetsFile);
    if (raw) return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load tile presets:', err);
  }
  return null;
});

// Open tiled fullscreen window
ipcMain.on('open-tiled-fullscreen', (event, config) => {
  openTiledFullscreen(config);
});

// Initialize tiled fullscreen (forward to fullscreen window)
ipcMain.on('init-tiled-fullscreen', (event, config) => {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.webContents.send('init-tiled-fullscreen', config);
    tiledModeActive = true;
  }
});

// Update tile layout (forward to fullscreen window)
ipcMain.on('tile-layout-update', (event, layout) => {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.webContents.send('tile-layout-update', layout);
  }
});

// Assign shader to tile (forward to fullscreen window)
ipcMain.on('tile-assign', (event, data) => {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.webContents.send('tile-assign', data);
  }
});

// Update tile parameter (forward to fullscreen window)
ipcMain.on('tile-param-update', (event, data) => {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.webContents.send('tile-param-update', data);
  }
});

// Mixer fullscreen forwarding (main window → fullscreen window)
ipcMain.on('mixer-param-update', (event, data) => {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.webContents.send('mixer-param-update', data);
  }
});

ipcMain.on('mixer-alpha-update', (event, data) => {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.webContents.send('mixer-alpha-update', data);
  }
});

ipcMain.on('mixer-blend-mode', (event, data) => {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.webContents.send('mixer-blend-mode', data);
  }
});

ipcMain.on('mixer-channel-update', (event, data) => {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.webContents.send('mixer-channel-update', data);
  }
});

// Exit tiled mode (forward to fullscreen window)
ipcMain.on('exit-tiled-mode', () => {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.webContents.send('exit-tiled-mode');
    tiledModeActive = false;
  }
});

// Create tiled fullscreen window
function openTiledFullscreen(config) {
  // Close existing fullscreen window if any
  if (fullscreenWindow) {
    fullscreenWindow.close();
    fullscreenWindow = null;
  }

  const displays = screen.getAllDisplays();
  // Use primary display or first display
  const display = displays.find(d => d.bounds.x === 0 && d.bounds.y === 0) || displays[0];
  const { x, y, width, height } = display.bounds;

  fullscreenWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    fullscreen: true,
    frame: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#000000'
  });

  fullscreenWindow.loadFile('fullscreen.html');

  // Send tile configuration once the window is ready
  fullscreenWindow.webContents.on('did-finish-load', () => {
    fullscreenWindow.webContents.send('init-tiled-fullscreen', config);
    tiledModeActive = true;
  });

  // Handle ESC key to close
  fullscreenWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      fullscreenWindow.close();
    }
  });

  fullscreenWindow.on('closed', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fullscreen-closed');
    }
    fullscreenWindow = null;
    tiledModeActive = false;
  });
}

// =============================================================================
// Claude AI Integration
// =============================================================================

// Load Claude API key on startup
async function loadClaudeKey() {
  try {
    const raw = await readFileOrNull(claudeKeyFile);
    if (raw) {
      const data = JSON.parse(raw);
      claudeApiKey = data.apiKey || null;
      claudeModel = data.model || 'claude-sonnet-4-20250514';
    }
  } catch (err) {
    console.error('Failed to load Claude API key:', err);
  }
}

// Save Claude API key
ipcMain.handle('save-claude-key', async (event, key, model) => {
  try {
    // Only update key if provided, otherwise keep existing
    if (key) {
      claudeApiKey = key;
    }
    claudeModel = model || 'claude-sonnet-4-20250514';
    await ensureDataDir();
    await fsPromises.writeFile(claudeKeyFile, JSON.stringify({
      apiKey: claudeApiKey,
      model: claudeModel
    }, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    console.error('Failed to save Claude API key:', err);
    return { success: false, error: err.message };
  }
});

// Check if Claude API key exists
ipcMain.handle('has-claude-key', async () => {
  return !!claudeApiKey;
});

// Get Claude settings
ipcMain.handle('get-claude-settings', async () => {
  return {
    hasKey: !!claudeApiKey,
    model: claudeModel,
    // Return masked key for display
    maskedKey: claudeApiKey ? '****' + claudeApiKey.slice(-4) : null
  };
});

// Test Claude API key
ipcMain.handle('test-claude-key', async (event, key) => {
  return new Promise((resolve) => {
    const testKey = key || claudeApiKey;
    if (!testKey) {
      resolve({ success: false, error: 'No API key provided' });
      return;
    }

    const postData = JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Hi' }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': testKey,
        'anthropic-version': '2023-06-01'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ success: true });
        } else {
          try {
            const errorData = JSON.parse(data);
            resolve({ success: false, error: errorData.error?.message || `HTTP ${res.statusCode}` });
          } catch {
            resolve({ success: false, error: `HTTP ${res.statusCode}` });
          }
        }
      });
    });

    req.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ success: false, error: 'Request timeout' });
    });

    req.write(postData);
    req.end();
  });
});

// Handle Claude prompt with streaming
ipcMain.on('claude-prompt', (event, data) => {
  if (!claudeApiKey) {
    event.sender.send('claude-error', { error: 'No API key configured. Please add your Claude API key in Settings.' });
    return;
  }

  const { prompt, context, renderMode } = data;

  // Build system prompt with context
  const systemPrompt = buildClaudeSystemPrompt(context, renderMode);

  const postData = JSON.stringify({
    model: claudeModel,
    max_tokens: 8192,
    stream: true,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }]
  });

  const options = {
    hostname: 'api.anthropic.com',
    port: 443,
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': claudeApiKey,
      'anthropic-version': '2023-06-01'
    }
  };

  const req = https.request(options, (res) => {
    if (res.statusCode !== 200) {
      let errorData = '';
      res.on('data', chunk => errorData += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(errorData);
          event.sender.send('claude-error', { error: parsed.error?.message || `HTTP ${res.statusCode}` });
        } catch {
          event.sender.send('claude-error', { error: `HTTP ${res.statusCode}` });
        }
      });
      return;
    }

    let buffer = '';
    let streamEndSent = false;

    res.on('data', (chunk) => {
      buffer += chunk.toString();

      // Process complete SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(jsonStr);

            if (parsed.type === 'content_block_delta') {
              const text = parsed.delta?.text;
              if (text) {
                event.sender.send('claude-stream-chunk', { text });
              }
            } else if (parsed.type === 'message_stop') {
              streamEndSent = true;
              event.sender.send('claude-stream-end', { complete: true });
            } else if (parsed.type === 'error') {
              event.sender.send('claude-error', { error: parsed.error?.message || 'Stream error' });
            }
          } catch (e) {
            // Ignore parse errors for incomplete chunks
          }
        }
      }
    });

    res.on('end', () => {
      // Process any remaining buffer
      if (buffer.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(buffer.slice(6));
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            event.sender.send('claude-stream-chunk', { text: parsed.delta.text });
          }
        } catch {
          // Ignore
        }
      }
      if (!streamEndSent) {
        event.sender.send('claude-stream-end', { complete: true });
      }
      claudeActiveRequest = null;
    });
  });

  req.on('error', (err) => {
    event.sender.send('claude-error', { error: err.message });
    claudeActiveRequest = null;
  });

  // Store reference for cancellation
  claudeActiveRequest = req;

  req.write(postData);
  req.end();
});

// Cancel active Claude request
ipcMain.on('claude-cancel', () => {
  if (claudeActiveRequest) {
    claudeActiveRequest.destroy();
    claudeActiveRequest = null;
  }
});

// Build system prompt for Claude based on render mode
function buildClaudeSystemPrompt(context, renderMode) {
  const basePrompt = `You are an expert GLSL shader and Three.js developer helping with ShaderShow, a real-time shader visualization tool.

IMPORTANT RULES:
1. When providing code, include ONLY the complete shader or scene code - no explanations before or after unless asked
2. The code should be ready to compile and run immediately
3. Preserve any existing @param comments for custom uniforms
4. For shaders: Use Shadertoy-compatible uniforms and mainImage function
5. For scenes: Use setup() and animate() function patterns

`;

  if (renderMode === 'shader') {
    return basePrompt + `CURRENT MODE: GLSL Fragment Shader (Shadertoy-compatible)

AVAILABLE UNIFORMS:
- vec3 iResolution      - Viewport resolution (width, height, 1.0)
- float iTime           - Playback time in seconds
- float iTimeDelta      - Time since last frame
- int iFrame            - Current frame number
- vec4 iMouse           - Mouse coords (xy: current, zw: click position)
- vec4 iDate            - (year, month, day, seconds)
- sampler2D iChannel0-3 - Input textures
- vec3 iChannelResolution[4] - Resolution of each channel

CUSTOM PARAMETERS (@param syntax):
Define custom uniforms with UI sliders using @param comments:
  // @param name type [default] [min, max] "description"

Supported types: int, float, vec2, vec3, vec4, color

Examples:
  // @param speed float 1.0 [0.0, 5.0] "Animation speed"
  // @param center vec2 0.5, 0.5 "Center position"
  // @param tint color [1.0, 0.5, 0.0] "Tint color"

SHADER STRUCTURE:
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    // Your shader code here
    fragColor = vec4(color, 1.0);
}

${context?.customParams ? `\nCURRENT CUSTOM PARAMS:\n${context.customParams}` : ''}
${context?.currentCode ? `\nCURRENT CODE:\n${context.currentCode}` : ''}`;
  } else {
    return basePrompt + `CURRENT MODE: Three.js Scene (JavaScript)

SCENE STRUCTURE:
The scene must define two functions:

1. setup(THREE, canvas, params) - Called once to initialize the scene
   - THREE: The Three.js library
   - canvas: The rendering canvas element
   - params: Object containing custom parameter values
   - Must return: { scene, camera, renderer, ...anyOtherObjects }

2. animate(context, time, deltaTime, params) - Called every frame
   - context: The object returned from setup()
   - time: Current time in seconds
   - deltaTime: Time since last frame
   - params: Current parameter values

CUSTOM PARAMETERS (@param syntax):
Same as shaders - define with @param comments at the top of the file

Example scene:
// @param rotationSpeed float 1.0 [0.0, 5.0] "Rotation speed"
// @param cubeColor color [0.2, 0.6, 1.0] "Cube color"

function setup(THREE, canvas, params) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, canvas.width/canvas.height, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // Create objects...
  return { scene, camera, renderer, mesh };
}

function animate(context, time, deltaTime, params) {
  context.mesh.rotation.y = time * params.rotationSpeed;
}

${context?.customParams ? `\nCURRENT CUSTOM PARAMS:\n${context.customParams}` : ''}
${context?.currentCode ? `\nCURRENT CODE:\n${context.currentCode}` : ''}`;
  }
}

app.on('before-quit', () => {
  // Cancel any active Claude request
  if (claudeActiveRequest) {
    claudeActiveRequest.destroy();
    claudeActiveRequest = null;
  }

  // Finalize recording if active
  if (recordingProcess) {
    try {
      recordingProcess.stdin.end();
    } catch (err) {
      recordingProcess.kill('SIGTERM');
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
