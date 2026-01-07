const { app, BrowserWindow, Menu, dialog, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const NDISender = require('./ndi-sender');
const NDIReceiver = require('./ndi-receiver');
const SyphonSender = require('./syphon-sender');

let mainWindow;
let fullscreenWindow = null;
let currentFilePath = null;
let ndiEnabled = false;
let ndiSender = null;
let ndiResolution = { width: 1920, height: 1080, label: '1920x1080 (1080p)' };

// NDI input receivers for channels (one per channel 0-3)
let ndiReceivers = [null, null, null, null];
let ndiSourceCache = []; // Cached NDI sources for menu

// Syphon output (macOS only)
let syphonEnabled = false;
let syphonSender = null;

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

// Ensure data directory exists and migrate old data
function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(shadersDir)) {
    fs.mkdirSync(shadersDir, { recursive: true });
  }

  // Migrate old grid state from userData if exists
  const oldGridStateFile = path.join(app.getPath('userData'), 'grid-state.json');
  if (fs.existsSync(oldGridStateFile) && !fs.existsSync(gridStateFile)) {
    try {
      fs.copyFileSync(oldGridStateFile, gridStateFile);
      console.log('Migrated grid-state.json from userData to data directory');
    } catch (err) {
      console.error('Failed to migrate grid state:', err);
    }
  }
}

// Get shader file path for a slot
function getShaderFilePath(slotIndex) {
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
        ] : [])
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
      nodeIntegration: true,
      contextIsolation: false
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
        const { ipcRenderer } = require('electron');
        function submit() {
          const w = parseInt(document.getElementById('width').value);
          const h = parseInt(document.getElementById('height').value);
          if (w >= 128 && h >= 128) {
            ipcRenderer.send('custom-ndi-resolution', { width: w, height: h });
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
      // Convert buffer to base64 for IPC transfer
      const base64Data = frame.data.toString('base64');
      mainWindow.webContents.send('ndi-input-frame', {
        channel: ch,
        width: frame.width,
        height: frame.height,
        data: base64Data
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

async function sendSyphonFrame(frameData) {
  if (syphonSender && syphonEnabled) {
    try {
      const buffer = Buffer.from(frameData.rgbaData, 'base64');
      await syphonSender.sendFrame(buffer, frameData.width, frameData.height);
    } catch (e) {
      console.error('Syphon frame send error:', e.message);
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

// Save grid state (metadata only - shader code saved separately)
ipcMain.on('save-grid-state', (event, gridState) => {
  ensureDataDir();
  try {
    // Save metadata without shader code (shader code is in individual files)
    const metadata = gridState.map((slot, index) => {
      if (!slot) return null;
      return {
        filePath: slot.filePath,
        params: slot.params,
        presets: slot.presets || []
      };
    });
    fs.writeFileSync(gridStateFile, JSON.stringify(metadata, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save grid state:', err);
  }
});

// Load grid state (loads metadata and shader code from files)
ipcMain.handle('load-grid-state', async () => {
  try {
    if (fs.existsSync(gridStateFile)) {
      const data = fs.readFileSync(gridStateFile, 'utf-8');
      const metadata = JSON.parse(data);

      // Load shader code from individual files
      const state = metadata.map((slot, index) => {
        if (!slot) {
          // Check if shader file exists even without metadata
          const shaderFile = getShaderFilePath(index);
          if (fs.existsSync(shaderFile)) {
            try {
              const shaderCode = fs.readFileSync(shaderFile, 'utf-8');
              return { shaderCode, filePath: null, params: {}, presets: [] };
            } catch (err) {
              return null;
            }
          }
          return null;
        }

        // Load shader code from file
        const shaderFile = getShaderFilePath(index);
        let shaderCode = null;
        if (fs.existsSync(shaderFile)) {
          try {
            shaderCode = fs.readFileSync(shaderFile, 'utf-8');
          } catch (err) {
            console.error(`Failed to load shader from ${shaderFile}:`, err);
          }
        }

        if (!shaderCode) return null;

        return {
          shaderCode,
          filePath: slot.filePath,
          params: slot.params || {},
          presets: slot.presets || []
        };
      });

      return state;
    } else {
      // No metadata file - check for shader files
      const state = [];
      for (let i = 0; i < 16; i++) {
        const shaderFile = getShaderFilePath(i);
        if (fs.existsSync(shaderFile)) {
          try {
            const shaderCode = fs.readFileSync(shaderFile, 'utf-8');
            state[i] = { shaderCode, filePath: null, params: {}, presets: [] };
          } catch (err) {
            state[i] = null;
          }
        } else {
          state[i] = null;
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
ipcMain.on('save-presets', (event, presets) => {
  ensureDataDir();
  try {
    fs.writeFileSync(presetsFile, JSON.stringify(presets, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save presets:', err);
  }
});

// Load parameter presets
ipcMain.handle('load-presets', async () => {
  try {
    if (fs.existsSync(presetsFile)) {
      const data = fs.readFileSync(presetsFile, 'utf-8');
      return JSON.parse(data);
    }
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
  await useNDISource(channel, source);
});

// Clear NDI from channel
ipcMain.on('clear-channel-ndi', (event, { channel }) => {
  if (ndiReceivers[channel]) {
    ndiReceivers[channel].disconnect();
    ndiReceivers[channel] = null;
    createMenu();
  }
});

// Custom NDI resolution from dialog
ipcMain.on('custom-ndi-resolution', async (event, { width, height }) => {
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

// Open fullscreen on primary display
ipcMain.on('open-fullscreen-primary', () => {
  const displays = screen.getAllDisplays();
  const primaryDisplay = displays.find(d => d.bounds.x === 0 && d.bounds.y === 0) || displays[0];
  openFullscreen(primaryDisplay);
});

// Get settings
ipcMain.handle('get-settings', () => {
  // Load param ranges from settings file
  let paramRanges = null;
  try {
    if (fs.existsSync(settingsFile)) {
      const data = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      paramRanges = data.paramRanges || null;
    }
  } catch (err) {
    console.error('Failed to load param ranges:', err);
  }

  return {
    ndiResolution: ndiResolution,
    ndiResolutions: ndiResolutions,
    ndiEnabled: ndiEnabled,
    paramRanges: paramRanges
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

  // Save all settings including param ranges
  const additionalData = {};
  if (settings.paramRanges) {
    additionalData.paramRanges = settings.paramRanges;
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
      fs.writeFileSync(result.filePath, JSON.stringify(gridState, null, 2), 'utf-8');
      mainWindow.webContents.send('grid-presets-saved', { filePath: result.filePath });
    } catch (err) {
      dialog.showErrorBox('Error', `Failed to save grid presets: ${err.message}`);
    }
  }
});

app.whenReady().then(() => {
  ensureDataDir();
  loadSettings();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Load saved settings on startup
function loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      const data = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (data.ndiResolution) {
        ndiResolution = data.ndiResolution;
      }
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

// Save settings to file
function saveSettingsToFile(additionalData = {}) {
  ensureDataDir();
  try {
    // Load existing settings to preserve other data
    let existingData = {};
    if (fs.existsSync(settingsFile)) {
      existingData = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    }

    const data = {
      ...existingData,
      ndiResolution: ndiResolution,
      ...additionalData
    };
    fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

// Save shader to slot file
ipcMain.handle('save-shader-to-slot', async (event, slotIndex, shaderCode) => {
  ensureDataDir();
  try {
    const shaderFile = getShaderFilePath(slotIndex);
    fs.writeFileSync(shaderFile, shaderCode, 'utf-8');
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
    if (fs.existsSync(shaderFile)) {
      const shaderCode = fs.readFileSync(shaderFile, 'utf-8');
      return { success: true, shaderCode };
    }
    return { success: false, error: 'File not found' };
  } catch (err) {
    console.error(`Failed to load shader from slot ${slotIndex}:`, err);
    return { success: false, error: err.message };
  }
});

// Delete shader from slot file
ipcMain.handle('delete-shader-from-slot', async (event, slotIndex) => {
  try {
    const shaderFile = getShaderFilePath(slotIndex);
    if (fs.existsSync(shaderFile)) {
      fs.unlinkSync(shaderFile);
    }
    return { success: true };
  } catch (err) {
    console.error(`Failed to delete shader from slot ${slotIndex}:`, err);
    return { success: false, error: err.message };
  }
});

// Save view state
ipcMain.on('save-view-state', (event, viewState) => {
  ensureDataDir();
  try {
    fs.writeFileSync(viewStateFile, JSON.stringify(viewState, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save view state:', err);
  }
});

// Load view state
ipcMain.handle('load-view-state', async () => {
  try {
    if (fs.existsSync(viewStateFile)) {
      const data = fs.readFileSync(viewStateFile, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Failed to load view state:', err);
  }
  return null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
