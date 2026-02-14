// Typed IPC channel definitions — single source of truth for all IPC communication
//
// Three categories:
// - IPCInvokeChannels: request/response (ipcRenderer.invoke → ipcMain.handle)
// - IPCSendChannels: fire-and-forget (ipcRenderer.send → ipcMain.on)
// - IPCOnChannels: main→renderer push (mainWindow.webContents.send → ipcRenderer.on)

import type { ParamValues } from './params.js';
import type { Resolution, SettingsDialogData, ClaudeSettings, ClaudeModel } from './settings.js';
import type { GridSlotData, ShaderTabData, TileData, TileLayout, MixerChannelData, BlendMode } from './state.js';

// ── Invoke channels (renderer calls main, expects response) ─────────────────

export interface IPCInvokeChannels {
  'get-default-shader': { request: void; response: string };
  'get-default-scene': { request: void; response: string };
  'load-shader-for-grid': { request: void; response: { source: string; filePath: string; fileType: string } | null };
  'load-grid-state': { request: void; response: unknown };
  'get-displays': { request: void; response: Array<{ id: number; label: string; bounds: { x: number; y: number; width: number; height: number } }> };
  'get-display-refresh-rate': { request: void; response: number };
  'get-settings': { request: void; response: SettingsDialogData };
  'load-presets': { request: void; response: unknown };
  'load-view-state': { request: void; response: unknown };
  'save-shader-to-slot': { request: [number, string]; response: string };
  'load-shader-from-slot': { request: [number]; response: string | null };
  'delete-shader-from-slot': { request: [number]; response: boolean };
  'read-file-content': { request: [string]; response: string | null };
  'find-ndi-sources': { request: void; response: Array<{ name: string; urlAddress: string }> };
  'start-recording': { request: void; response: { success: boolean; error?: string } };
  'load-tile-state': { request: void; response: unknown };
  'load-tile-presets': { request: void; response: unknown };
  'load-file-texture': { request: [string]; response: string | null };
  'list-file-textures': { request: void; response: string[] };
  'open-media-for-asset': { request: void; response: { filePath: string; dataUrl: string; mimeType: string } | null };
  'copy-media-to-library': { request: [string]; response: string };
  'get-media-absolute-path': { request: [string]; response: string };
  'load-media-data-url': { request: [string]; response: string | null };
  'export-button-data': { request: [string, unknown, string]; response: boolean };
  'import-button-data': { request: [string]; response: unknown | null };
  'export-button-data-bulk': { request: [string, unknown[]]; response: boolean };
  'import-button-data-bulk': { request: [string]; response: unknown[] | null };
  'export-textures-to-folder': { request: [string, string[]]; response: boolean };
  'import-textures-from-folder': { request: [string]; response: boolean };
  'save-claude-key': { request: [string | null, string]; response: boolean };
  'has-claude-key': { request: void; response: boolean };
  'get-claude-settings': { request: void; response: ClaudeSettings };
  'test-claude-key': { request: [string | null]; response: { success: boolean; error?: string } };
  'get-claude-models': { request: void; response: ClaudeModel[] };
}

// ── Send channels (renderer → main, fire and forget) ───────────────────────

export interface IPCSendChannels {
  'trigger-new-file': string;
  'trigger-open-file': void;
  'save-content': string;
  'editor-has-changes-response': boolean;
  'save-grid-state': unknown;
  'toggle-ndi': void;
  'open-fullscreen-primary': void;
  'open-fullscreen-on-display': number;
  'close-fullscreen': void;
  'toggle-syphon': void;
  'stop-recording': void;
  'ndi-frame': ArrayBuffer;
  'syphon-frame': ArrayBuffer;
  'recording-frame': ArrayBuffer;
  'preview-resolution': { width: number; height: number };
  'preview-resolution-for-recording': { width: number; height: number };
  'save-settings': unknown;
  'save-presets': unknown;
  'save-view-state': unknown;
  'shader-update': { source: string; mode?: string };
  'time-sync': { time: number; frame: number; playing: boolean };
  'param-update': { name: string; value: unknown };
  'batch-param-update': ParamValues;
  'preset-sync': { type: string; index: number; params: ParamValues };
  'blackout': boolean;
  'fullscreen-state': unknown;
  'fullscreen-fps': number;
  'set-channel-ndi': { channel: number; source: unknown };
  'clear-channel-ndi': { channel: number };
  'mixer-param-update': { channelIndex: number; name: string; value: unknown };
  'mixer-alpha-update': { channelIndex: number; alpha: number };
  'mixer-blend-mode': { blendMode: BlendMode };
  'mixer-channel-update': { channelIndex: number; slotIndex: number | null; shaderCode: string | null; params: ParamValues; customParams: ParamValues };
  'init-tiled-fullscreen': { layout: TileLayout; tiles: TileData[] };
  'tile-layout-update': TileLayout;
  'tile-assign': { tileIndex: number; shaderCode: string; params: ParamValues };
  'tile-param-update': { tileIndex: number; name: string; value: unknown };
  'exit-tiled-mode': void;
  'open-tiled-fullscreen': unknown;
  'save-tile-state': unknown;
  'save-tile-presets': unknown;
  'remote-state-changed': unknown;
  'remote-get-state-response': unknown;
  'remote-get-thumbnail-response': unknown;
  'remote-get-preview-frame-response': { dataUrl: string } | null;
  'save-grid-presets-to-file': unknown;
  'open-fullscreen-with-shader': unknown;
  'claude-prompt': { prompt: string; shaderCode?: string; systemPrompt?: string };
  'claude-cancel': void;
  'asset-update': { type: string; dataUrl?: string; mediaPath?: string };
}

// ── On channels (main → renderer push notifications) ────────────────────────

export interface IPCOnChannels {
  'file-opened': { source: string; filePath: string; fileType: string };
  'new-file': { source: string; fileType: string };
  'request-content-for-save': void;
  'check-editor-changes': void;
  'texture-loaded': { channel: number; dataUrl: string };
  'video-loaded': { channel: number; filePath: string };
  'camera-requested': { channel: number };
  'audio-requested': { channel: number; fftSize?: number };
  'channel-cleared': { channel: number };
  'compile-shader': void;
  'toggle-playback': void;
  'reset-time': void;
  'run-benchmark': void;
  'restart-render': void;
  'request-fullscreen-state': void;
  'init-fullscreen': unknown;
  'shader-update': { source: string; mode?: string };
  'time-sync': { time: number; frame: number; playing: boolean };
  'param-update': { name: string; value: unknown };
  'batch-param-update': ParamValues;
  'preset-sync': { type: string; index: number; params: ParamValues };
  'blackout': boolean;
  'ndi-status': { enabled: boolean; error?: string };
  'syphon-status': { enabled: boolean; error?: string };
  'recording-status': { enabled: boolean; error?: string; filePath?: string };
  'request-preview-resolution': void;
  'request-preview-resolution-for-recording': void;
  'ndi-frame-skip-changed': number;
  'ndi-input-frame': { channel: number; data: ArrayBuffer; width: number; height: number };
  'ndi-source-set': { channel: number; source: string };
  'settings-changed': unknown;
  'fullscreen-fps': number;
  'fullscreen-closed': void;
  'fullscreen-opened': number;
  'mixer-param-update': { channelIndex: number; name: string; value: unknown };
  'mixer-alpha-update': { channelIndex: number; alpha: number };
  'mixer-blend-mode': { blendMode: BlendMode };
  'mixer-channel-update': { channelIndex: number; slotIndex: number | null; shaderCode: string | null; params: ParamValues; customParams: ParamValues };
  'init-tiled-fullscreen': { layout: TileLayout; tiles: TileData[] };
  'tile-layout-update': TileLayout;
  'tile-assign': { tileIndex: number; shaderCode: string; params: ParamValues };
  'tile-param-update': { tileIndex: number; name: string; value: unknown };
  'exit-tiled-mode': void;
  'open-tile-config': void;
  'request-grid-state-for-save': void;
  'grid-presets-saved': { success: boolean };
  'load-grid-presets': unknown;
  'remote-get-state': unknown;
  'remote-get-thumbnail': { slotIndex: number };
  'remote-select-tab': { tabIndex: number };
  'remote-select-slot': { slotIndex: number };
  'remote-set-param': { name: string; value: unknown };
  'remote-recall-preset': { presetIndex: number };
  'remote-mixer-assign': { channelIndex: number; slotIndex: number };
  'remote-mixer-clear': { channelIndex: number };
  'remote-mixer-alpha': { channelIndex: number; alpha: number };
  'remote-mixer-select': { channelIndex: number };
  'remote-mixer-blend': { blendMode: BlendMode };
  'remote-mixer-reset': void;
  'remote-mixer-toggle': { enabled: boolean };
  'remote-recall-mix-preset': { presetIndex: number };
  'remote-toggle-playback': void;
  'remote-reset-time': void;
  'remote-blackout': { enabled: boolean };
  'remote-recall-visual-preset': { vpTabIndex: number; presetIndex: number };
  'remote-get-preview-frame': void;
  'remote-reorder-visual-preset': { vpTabIndex: number; fromIndex: number; toIndex: number };
  'claude-stream-chunk': { text: string };
  'claude-stream-end': { text: string };
  'claude-error': { error: string };
  'asset-update': { type: string; dataUrl?: string; mediaPath?: string };
}

/** Helper type to get the payload type for an invoke channel */
export type InvokeRequest<K extends keyof IPCInvokeChannels> = IPCInvokeChannels[K]['request'];
export type InvokeResponse<K extends keyof IPCInvokeChannels> = IPCInvokeChannels[K]['response'];

/** Helper type to get the payload type for a send channel */
export type SendPayload<K extends keyof IPCSendChannels> = IPCSendChannels[K];

/** Helper type to get the payload type for an on channel */
export type OnPayload<K extends keyof IPCOnChannels> = IPCOnChannels[K];
