const { app, BrowserWindow, Menu, dialog, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const NDISender = require('./ndi-sender');

let mainWindow;
let fullscreenWindow = null;
let currentFilePath = null;
let ndiEnabled = false;
let ndiSender = null;

// Grid state file path
const gridStateFile = path.join(app.getPath('userData'), 'grid-state.json');

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
        { type: 'separator' },
        {
          label: 'Start NDI Output',
          id: 'ndi-toggle',
          click: () => toggleNDIOutput()
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

  fullscreenWindow.on('closed', () => {
    fullscreenWindow = null;
  });
}

async function newFile() {
  currentFilePath = null;
  mainWindow.webContents.send('new-file');
  updateTitle();
}

async function openFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Shader Files', extensions: ['frag', 'glsl', 'shader', 'fs'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
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
      const data = fs.readFileSync(filePath);
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
  mainWindow.webContents.send('channel-cleared', { channel });
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

  // Get current resolution from renderer
  const resolution = { width: 1920, height: 1080 };

  const success = await ndiSender.start({
    width: resolution.width,
    height: resolution.height,
    frameRateN: 60,
    frameRateD: 1
  });

  if (success) {
    ndiEnabled = true;
    mainWindow.webContents.send('ndi-status', { enabled: true, native: true });
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

async function sendNDIFrame(frameData) {
  if (ndiSender && ndiEnabled) {
    try {
      // frameData is { rgbaData: base64, width, height }
      const buffer = Buffer.from(frameData.rgbaData, 'base64');
      await ndiSender.sendFrame(buffer, frameData.width, frameData.height);
    } catch (e) {
      console.error('NDI frame send error:', e.message);
    }
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
      const data = fs.readFileSync(filePath, 'utf-8');
      const gridState = JSON.parse(data);
      mainWindow.webContents.send('load-grid-presets', { gridState, filePath });
    } catch (err) {
      dialog.showErrorBox('Error', `Failed to load grid presets: ${err.message}`);
    }
  }
}

function updateTitle() {
  const fileName = currentFilePath ? path.basename(currentFilePath) : 'Untitled';
  mainWindow.setTitle(`${fileName} - ShaderShow`);
}

// IPC Handlers
ipcMain.on('save-content', (event, content) => {
  if (currentFilePath) {
    try {
      fs.writeFileSync(currentFilePath, content, 'utf-8');
    } catch (err) {
      dialog.showErrorBox('Error', `Failed to save file: ${err.message}`);
    }
  }
});

ipcMain.handle('get-default-shader', async () => {
  const defaultPath = path.join(__dirname, 'examples', 'default.frag');
  try {
    return fs.readFileSync(defaultPath, 'utf-8');
  } catch (err) {
    // Return a basic shader if default doesn't exist
    return `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0, 2, 4));
    fragColor = vec4(col, 1.0);
}`;
  }
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

// Load shader for grid slot
ipcMain.handle('load-shader-for-grid', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Shader Files', extensions: ['frag', 'glsl', 'shader', 'fs'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
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

// Save grid state
ipcMain.on('save-grid-state', (event, gridState) => {
  try {
    fs.writeFileSync(gridStateFile, JSON.stringify(gridState, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save grid state:', err);
  }
});

// Load grid state
ipcMain.handle('load-grid-state', async () => {
  try {
    if (fs.existsSync(gridStateFile)) {
      const data = fs.readFileSync(gridStateFile, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Failed to load grid state:', err);
  }
  return null;
});

// NDI frame receiver
ipcMain.on('ndi-frame', (event, frameData) => {
  sendNDIFrame(frameData);
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
      fs.writeFileSync(result.filePath, JSON.stringify(gridState, null, 2), 'utf-8');
      mainWindow.webContents.send('grid-presets-saved', { filePath: result.filePath });
    } catch (err) {
      dialog.showErrorBox('Error', `Failed to save grid presets: ${err.message}`);
    }
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
