# Repository Guidelines

## Project Structure

- `main.js`: Electron **main process** (menus, file I/O, dialogs, fullscreen window, NDI/Syphon/recording orchestration).
- `preload.js`: context-bridge API exposed to the renderer (`window.electronAPI`, etc.).
- `index.html` / `fullscreen.html`: renderer entrypoints.
- `js/`: renderer modules (UI, editor, IPC wiring, WebGL/Three rendering, grid/mixer/params).
- `css/`: UI stylesheets.
- `data/`: app runtime data (grid state, settings, presets, shaders, textures/media). Avoid committing personal/local state unless it’s an intentional default/sample change.
- `web/`: lightweight remote-control web UI served by the app.

For a deeper architecture overview and platform notes (NDI setup), see `CLAUDE.md`.

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npm start`: launch the Electron app.
- `npm run dev`: launch with extra logging enabled.

Optional features:
- NDI/Syphon support uses optional dependencies and degrades gracefully when unavailable.

## Coding Style & Naming Conventions

- Indentation: 2 spaces; use semicolons; prefer single quotes to match existing code.
- Module style: keep CommonJS (`require`) in Electron main-process files and ES modules (`import`) in `js/`.
- Names: files are typically `kebab-case.js`; functions/vars `camelCase`; classes `PascalCase`.
- IPC/event naming: prefer kebab-case channels (e.g., `save-grid-state`) and async handlers via `ipcRenderer.invoke`/`ipcMain.handle`.

## Testing Guidelines

There is no dedicated automated test suite. Before opening a PR, do a quick manual smoke pass:
- start the app, edit/compile a shader, verify error annotations/status messages
- test fullscreen rendering, asset loading (image/video), and basic grid/tab flows
- if you touched them, sanity-check scene mode (Three.js) and optional NDI/Syphon/recording paths on your platform

## Commit & Pull Request Guidelines

- Commits commonly use short imperative subjects: `Add …`, `Fix …`, `Update …`, `Optimize …`, `Refactor …`.
- Prefer one focused change per commit; include a scope when helpful (e.g., `IPC: Fix …`).
- PRs should include: what/why, how tested, and screenshots/GIFs for UI changes; call out platform-specific behavior (macOS/Linux/Windows) when touching NDI/Syphon/FFmpeg.

## Security & Configuration Tips

- Don’t commit secrets: `data/claude-key.json` is gitignored for API keys.
- Don’t commit `node_modules/`; dependency lockfile changes are typically not tracked (`package-lock.json` is ignored).
