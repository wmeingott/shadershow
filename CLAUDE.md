# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm install        # Install dependencies
npm start          # Launch Electron app
npm run dev        # Launch with logging enabled
```

## Platform Support

- **macOS**: Full support (uses `grandiose-mac` for NDI)
- **Linux**: Requires NDI SDK runtime installed, uses `grandiose` (optional dependency)
- **Windows**: Supported, uses `grandiose` (optional dependency)

### Linux NDI Setup

1. Download NDI SDK from https://ndi.video/tools/
2. Install runtime libraries:
   ```bash
   sudo cp -r "NDI SDK/lib/x86_64-linux-gnu/"* /usr/local/lib/
   sudo ldconfig
   ```
3. The app will gracefully degrade if NDI is unavailable

### Windows NDI Setup

1. Download and install NDI Tools from https://ndi.video/tools/
2. The NDI runtime DLLs are included with NDI Tools
3. The app will gracefully degrade if NDI is unavailable

## Architecture Overview

ShaderShow is an Electron-based GLSL shader editor with Shadertoy compatibility. It uses WebGL2 for real-time rendering and supports multi-channel inputs (textures, video, camera, audio FFT, NDI).

### Process Model

- **Main Process** (`main.js`) - Handles file I/O, menus, dialogs, NDI management, fullscreen windows
- **Renderer Process** (`js/` modules) - UI, WebGL rendering, parameter controls
- **Preload Bridge** (`preload.js`) - Exposes `electronAPI` to renderer via context bridge

### Renderer Modules (ES6)

The renderer uses modular architecture with a shared state object:

- `state.js` - Single source of truth for editor, renderer, UI state, channels, grid slots
- `ipc.js` - IPC handlers for Electron communication
- `editor.js` - Ace editor setup and shader compilation with error annotations
- `shader-grid.js` - 16-slot shader grid with thumbnails and context menus
- `params.js` - Parameter sliders (speed, P0-P4, 10 RGB colors)
- `presets.js` - Local (per-shader) and global parameter presets
- `controls.js` - Toolbar button handlers
- `view-state.js` - Persistent UI layout (editor width, panel visibility)

### Key Classes

- `ShaderRenderer` (`shader-renderer.js`) - WebGL2 rendering pipeline, uniform management, channel textures
- `NDISender` / `NDIReceiver` - NDI streaming via grandiose-mac SDK

### Data Storage

All persistent data lives in `data/` directory:
- `grid-state.json` - Shader grid metadata (params, presets)
- `shaders/buttonX.glsl` - Individual shader files for grid slots
- `presets.json` - Global parameter presets
- `settings.json` - NDI resolution, parameter ranges
- `view-state.json` - UI layout state

### Channel System

Each of the 4 channels (iChannel0-3) can hold: empty, image, video, camera, audio FFT, or NDI source. Channel textures are updated every frame for video/camera/audio/NDI types.

## Key Patterns

- **Debounced compilation** - Shader edits auto-compile after 500ms delay
- **IPC naming** - Use kebab-case for channel names (e.g., `save-grid-state`)
- **Async file ops** - Use `ipcRenderer.invoke`/`ipcMain.handle` for async operations
- **Status feedback** - Use `setStatus(message, 'success'|'error')` for user feedback
- **State mutations** - Import `state` from `state.js`, modify properties directly
