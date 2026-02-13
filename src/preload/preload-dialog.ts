// Dialog preload script — custom NDI resolution dialog
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dialogAPI', {
  submitResolution: (width: number, height: number) => {
    if (typeof width === 'number' && typeof height === 'number') {
      ipcRenderer.send('custom-ndi-resolution-from-dialog', { width, height });
    }
  },
});
