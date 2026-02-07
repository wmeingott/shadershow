const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dialogAPI', {
  submitResolution: (width, height) => {
    if (typeof width === 'number' && typeof height === 'number') {
      ipcRenderer.send('custom-ndi-resolution-from-dialog', { width, height });
    }
  }
});
