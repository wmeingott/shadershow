// Texture dialog preload script
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('textureAPI', {
  openImage: () => ipcRenderer.invoke('open-image-for-texture'),
  saveTexture: (name: string, dataUrl: string) => ipcRenderer.invoke('save-texture', name, dataUrl),
  close: () => ipcRenderer.send('close-texture-dialog'),
});
