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

## UI Parts & Abbreviations

### Main Electron App

| Part | Abbr | Description |
|---|---|---|
| Toolbar | TB | Top bar: file ops, playback, channels, stats |
| Editor Panel | EP | Left side, Ace code editor with tabs |
| Preview Panel | PP | Right side top, WebGL canvas showing active shader |
| Shader Grid | SG | Bottom-left, grid of slot thumbnails with tabs |
| Parameter Panel | PAR | Bottom-right, speed + custom param sliders + presets |
| Visual Presets Sidebar | VP | Right edge, resizable sidebar with tabbed preset groups |
| Mixer Bar | MIX | Horizontal row between preview and grid, channel buttons + alpha sliders |
| Status Bar | SB | Bottom strip, status messages + cursor position |
| State Presets Row | SP | Below toolbar, 8 numbered recall buttons |
| Channel Slots | CH | In toolbar, 4 iChannel indicators |

### Grid-specific terms

| Term | Abbr | Description |
|---|---|---|
| Grid Tab | GT | Named tab in SG (e.g. "My Shaders", "Saved") |
| Grid Slot | GS | Single cell in SG with thumbnail canvas + label |
| Mix Tab | MT | Special tab type showing composition presets |
| Asset Tab | AT | Special tab type for image/video assets |

### Preset types

| Term | Abbr | Description |
|---|---|---|
| Local Presets | LP | Per-shader param presets (shown in PAR) |
| Visual Presets | VP | Full-state snapshots with thumbnails |
| VP Tab/Group | VPG | Named group within VP (e.g. "Favorites") |
| Mix/Composition Presets | CMP | Saved mixer channel configurations |
| State Presets | SP | Global 1-8 quick-recall slots |

### Web Remote UI

| Part | Abbr | Description |
|---|---|---|
| Status Bar | WSB | Top bar: connection, display select, playback, preview toggle |
| Preview Stream | WPV | Floating PiP MJPEG preview |
| Mixer Section | WMIX | Desktop: compact bar above grid. Mobile: separate view |
| Slot Grid | WSG | Shader thumbnail grid with tab bar |
| Params Sidebar | WPAR | Desktop: right sidebar with speed, params, presets |
| Inline VP | WVP | Desktop: VP buttons below slot grid |
| Bottom Nav | WNAV | Mobile only: Grid / Mixer / Params / Presets tabs |

### Processes

| Term | Abbr | Description |
|---|---|---|
| Main Process | MAIN | Electron main, file I/O, IPC routing, NDI |
| Renderer Process | REN | UI + WebGL rendering |
| Fullscreen Process | FS | Separate window for output display |
| Remote Server | RS | Express + WebSocket server for web remote |

### Other

- **T3S** — Three.js Scene
- **GS** — GLSL Shaders

## Architecture Overview

ShaderShow is an Electron-based GLSL shader editor with Shadertoy compatibility. It uses WebGL2 for real-time rendering and supports multi-channel inputs (textures, video, camera, audio FFT, NDI).

### Process Model

- **Main Process** (`src/main/app.ts` → `dist/main/app.js`) - File I/O, menus, dialogs, NDI, fullscreen windows
- **Renderer Process** (`src/renderer/` → `dist/renderer/app.js`) - UI, WebGL rendering, parameter controls
- **Fullscreen Process** (`src/fullscreen/` → `dist/fullscreen/app.js`) - Fullscreen/tiled output window
- **Preload Bridge** (`src/preload/` → `dist/preload/`) - Exposes `electronAPI` to renderer via context bridge

### TypeScript Source Layout (`src/`)

- `src/renderer/core/` — state, render loop, renderer manager
- `src/renderer/ui/` — editor, controls, params, presets, mixer, tabs, view-state, settings, console
- `src/renderer/grid/` — shader-grid, grid-persistence, grid-tabs, grid-renderer, visual-presets, mix-presets, asset-grid
- `src/renderer/ipc/` — IPC handlers, frame sender
- `src/renderer/renderers/` — ShaderRenderer, MiniShaderRenderer, AssetRenderer, ThreeSceneRenderer, BeatDetector, TileRenderer
- `src/renderer/tiles/` — tile-config, tile-state
- `src/main/managers/` — window-manager, menu-manager, ndi-manager, recording-manager, settings-manager
- `src/shared/` — logger, param-parser, shared types

### Key Classes

- `ShaderRenderer` (`src/renderer/renderers/shader-renderer.ts`) - WebGL2 rendering pipeline, uniform management, channel textures
- `MiniShaderRenderer` (`src/renderer/renderers/mini-shader-renderer.ts`) - Lightweight renderer for SG thumbnails
- `AssetRenderer` (`src/renderer/renderers/asset-renderer.ts`) - Image/video asset renderer
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
