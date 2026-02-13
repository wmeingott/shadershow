// ShaderShow — Fullscreen renderer entry point
// Wires up the fullscreen renderer module: canvas init, IPC handlers, render loop.

import { initFullscreen, registerIPCHandlers } from './fullscreen-renderer.js';

// Register IPC handlers immediately (they listen for events from the main window)
registerIPCHandlers();

// Initialize canvas, ShaderRenderer, refresh rate detection, and start render loop
initFullscreen();
