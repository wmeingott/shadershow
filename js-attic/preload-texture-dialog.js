const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('textureAPI', {
  openImage: () => ipcRenderer.invoke('open-image-for-texture'),
  saveTexture: (name, dataUrl) => ipcRenderer.invoke('save-texture', name, dataUrl),
  close: () => ipcRenderer.send('close-texture-dialog')
});
