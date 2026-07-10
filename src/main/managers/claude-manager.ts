// AIManager — manages AI provider keys, model selection, and streaming prompts.
// Supports Anthropic and OpenRouter providers.

import https from 'https';
import fs from 'fs';
import path from 'path';
import { Logger } from '@shared/logger.js';
import type { AISettings, AIProvider, ClaudeModel } from '@shared/types/settings.js';

const fsPromises = fs.promises;
const log = new Logger('AI');

const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';
const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-5';

// Models that no longer exist at the API — migrate persisted settings on load
const DEAD_ANTHROPIC_MODELS = new Set([
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-3-5-haiku-20241022',
  'claude-3-5-sonnet-20241022',
  'claude-3-7-sonnet-20250219',
]);

/** Default system prompt — the static instructions sent with every request.
 *  Users can override it in Settings → AI Assistant; the CURRENT MODE line and
 *  live context (code, params, channels, errors) are always appended after it. */
export const DEFAULT_SYSTEM_PROMPT = `You are an expert GLSL shader and Three.js developer helping with ShaderShow, a real-time shader visualization tool.

IMPORTANT RULES:
1. For a NEW shader/scene or a full rewrite: output ONLY the complete code in a single fenced code block - no explanations unless asked.
2. For MODIFICATIONS to the CURRENT CODE: output one or more SEARCH/REPLACE edit blocks instead of the whole file, inside a single fenced code block:

<<<<<<< SEARCH
(a contiguous run of lines copied EXACTLY from the current code, enough to be unique)
=======
(the replacement lines)
>>>>>>> REPLACE

3. Edit block rules: the SEARCH text must match the current code character-for-character, including whitespace and comments. Use multiple SEARCH/REPLACE blocks for multiple separate changes. Never mix edit blocks and full-file output in one response.
4. The resulting code must compile and run immediately. Preserve any existing @param comments for custom uniforms.
5. For shaders: Use Shadertoy-compatible uniforms and mainImage function
6. For scenes: Use setup() and animate() function patterns

CUSTOM PARAMETERS (@param syntax, same for shaders and scenes):
Define custom values with UI sliders using @param comments at the top of the file:
  // @param name type [default] [min, max] "description"

Supported types: int, float, vec2, vec3, vec4, color

Examples:
  // @param speed float 1.0 [0.0, 5.0] "Animation speed"
  // @param center vec2 0.5, 0.5 "Center position"
  // @param tint color [1.0, 0.5, 0.0] "Tint color"

In shaders each @param becomes a uniform of that type. In scenes the values arrive on the params object (e.g. params.speed).

=== GLSL FRAGMENT SHADER MODE (Shadertoy-compatible) ===

AVAILABLE UNIFORMS:
- vec3 iResolution      - Viewport resolution (width, height, 1.0)
- float iTime           - Playback time in seconds
- float iTimeDelta      - Time since last frame
- int iFrame            - Current frame number
- vec4 iMouse           - Mouse coords (xy: current, zw: click position)
- vec4 iDate            - (year, month, day, seconds)
- sampler2D iChannel0-3 - Input textures
- vec3 iChannelResolution[4] - Resolution of each channel

SHADER STRUCTURE:
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    // Your shader code here
    fragColor = vec4(color, 1.0);
}

=== THREE.JS SCENE MODE (JavaScript) ===

The scene must define two functions:

1. setup(THREE, canvas, params) - Called once to initialize the scene
   - THREE: The Three.js library
   - canvas: The rendering canvas element
   - params: Object containing custom parameter values
   - Must return: { scene, camera, renderer, ...anyOtherObjects }

2. animate(time, deltaTime, params, objects, mouse, channels) - Called every frame
   - time: Current time in seconds
   - deltaTime: Time since last frame
   - params: Current parameter values
   - objects: The object returned from setup()
   - mouse/channels: Optional input state (same semantics as shader renderer)

Example scene:
// @param rotationSpeed float 1.0 [0.0, 5.0] "Rotation speed"
// @param cubeColor color [0.2, 0.6, 1.0] "Cube color"

function setup(THREE, canvas, params) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, canvas.width/canvas.height, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // Create objects...
  return { scene, camera, renderer, mesh };
}

function animate(time, deltaTime, params, objects) {
  objects.mesh.rotation.y = time * params.rotationSpeed;
}`;

const ANTHROPIC_HOSTNAME = 'api.anthropic.com';
const OPENROUTER_HOSTNAME = 'openrouter.ai';
const API_VERSION = '2023-06-01';
const REQUEST_TIMEOUT = 10000;
const STREAM_IDLE_TIMEOUT = 60000; // no bytes for 60s → treat as stalled

/** An image/video-frame attachment sent with a prompt */
export interface AIAttachment {
  dataUrl: string;      // data:image/png;base64,...
  name: string;         // filename or "Preview Capture"
  mediaType: string;    // image/png, image/jpeg, etc.
}

/** Context passed alongside a prompt */
export interface ClaudePromptContext {
  currentCode?: string;
  customParams?: string;
  compileError?: string;
  channels?: string;
  paramValues?: string;
}

/** Render mode determines the system prompt flavour */
export type RenderMode = 'shader' | 'scene';

/** A completed user/assistant exchange for multi-turn history */
export interface ChatTurn { role: 'user' | 'assistant'; content: string; }

/** Persisted key-file structure */
interface KeyFileData {
  apiKey?: string | null;
  model?: string;
  provider?: AIProvider;
  openrouterApiKey?: string | null;
  openrouterModel?: string;
  systemPrompt?: string | null;
}

export class ClaudeManager {
  // Anthropic
  private apiKey: string | null = null;
  private model: string = DEFAULT_ANTHROPIC_MODEL;
  private models: ClaudeModel[] = [];

  // OpenRouter
  private openrouterApiKey: string | null = null;
  private openrouterModel: string = DEFAULT_OPENROUTER_MODEL;
  private openrouterModels: ClaudeModel[] = [];

  // Active provider
  private provider: AIProvider = 'anthropic';

  // Custom system prompt (null = use DEFAULT_SYSTEM_PROMPT)
  private systemPrompt: string | null = null;

  private activeRequest: ReturnType<typeof https.request> | null = null;
  private readonly keyFilePath: string;

  constructor(claudeKeyFile: string) {
    this.keyFilePath = claudeKeyFile;
  }

  // ---------------------------------------------------------------------------
  // Key management
  // ---------------------------------------------------------------------------

  /** Load all settings from the key file on disk */
  async loadKey(): Promise<void> {
    try {
      const raw = await this.readFileOrNull(this.keyFilePath);
      if (raw) {
        const data: KeyFileData = JSON.parse(raw);
        this.apiKey = data.apiKey || null;
        this.model = data.model || DEFAULT_ANTHROPIC_MODEL;
        if (DEAD_ANTHROPIC_MODELS.has(this.model)) this.model = DEFAULT_ANTHROPIC_MODEL;
        this.provider = data.provider || 'anthropic';
        this.openrouterApiKey = data.openrouterApiKey || null;
        this.openrouterModel = data.openrouterModel || DEFAULT_OPENROUTER_MODEL;
        if (data.openrouterModel === 'anthropic/claude-sonnet-4') this.openrouterModel = DEFAULT_OPENROUTER_MODEL;
        this.systemPrompt = data.systemPrompt || null;
      }
    } catch (err) {
      log.error('Failed to load AI settings:', err);
    }
  }

  /** Persist all settings to the key file */
  private async saveToFile(): Promise<void> {
    const dir = path.dirname(this.keyFilePath);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(this.keyFilePath, JSON.stringify({
      apiKey: this.apiKey,
      model: this.model,
      provider: this.provider,
      openrouterApiKey: this.openrouterApiKey,
      openrouterModel: this.openrouterModel,
      systemPrompt: this.systemPrompt,
    } satisfies KeyFileData, null, 2), 'utf-8');
  }

  /** Save Anthropic API key and model.  If `key` is falsy the existing key is kept. */
  async saveKey(key: string | null, model: string | null): Promise<{ success: boolean; error?: string }> {
    try {
      if (key) this.apiKey = key;
      this.model = model || DEFAULT_ANTHROPIC_MODEL;
      await this.saveToFile();
      if (this.apiKey) await this.fetchModels();
      return { success: true };
    } catch (err: any) {
      log.error('Failed to save Anthropic API key:', err);
      return { success: false, error: err.message };
    }
  }

  /** Save OpenRouter API key.  If `key` is falsy the existing key is kept. */
  async saveOpenRouterKey(key: string | null): Promise<{ success: boolean; error?: string }> {
    try {
      if (key) this.openrouterApiKey = key;
      await this.saveToFile();
      if (this.openrouterApiKey) await this.fetchOpenRouterModels();
      return { success: true };
    } catch (err: any) {
      log.error('Failed to save OpenRouter API key:', err);
      return { success: false, error: err.message };
    }
  }

  /** Whether the *active* provider has a key */
  hasKey(): boolean {
    return this.provider === 'anthropic' ? !!this.apiKey : !!this.openrouterApiKey;
  }

  /** Return full AI settings for the renderer */
  getSettings(): AISettings {
    return {
      provider: this.provider,
      hasKey: !!this.apiKey,
      maskedKey: this.apiKey ? '****' + this.apiKey.slice(-4) : '',
      model: this.model,
      models: this.models,
      hasOpenrouterKey: !!this.openrouterApiKey,
      maskedOpenrouterKey: this.openrouterApiKey ? '****' + this.openrouterApiKey.slice(-4) : '',
      openrouterModel: this.openrouterModel,
      openrouterModels: this.openrouterModels,
      systemPrompt: this.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    };
  }

  // ---------------------------------------------------------------------------
  // Provider / model switching (called from AI dialog)
  // ---------------------------------------------------------------------------

  async setProvider(provider: AIProvider): Promise<void> {
    this.provider = provider;
    await this.saveToFile();
  }

  async setModel(provider: AIProvider, modelId: string): Promise<void> {
    if (provider === 'anthropic') {
      this.model = modelId;
    } else {
      this.openrouterModel = modelId;
    }
    await this.saveToFile();
  }

  /** Set a custom system prompt. Empty or default text reverts to the built-in default. */
  async setSystemPrompt(text: string): Promise<void> {
    const trimmed = text.trim();
    this.systemPrompt = trimmed && trimmed !== DEFAULT_SYSTEM_PROMPT.trim() ? text : null;
    await this.saveToFile();
  }

  // ---------------------------------------------------------------------------
  // API key validation
  // ---------------------------------------------------------------------------

  /** Test an Anthropic API key (or the stored key) */
  testKey(key?: string | null): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const testKey = key || this.apiKey;
      if (!testKey) {
        resolve({ success: false, error: 'No API key provided' });
        return;
      }

      // Model-independent auth check: GET /v1/models never rots when model IDs retire
      const options: https.RequestOptions = {
        hostname: ANTHROPIC_HOSTNAME,
        port: 443,
        path: '/v1/models',
        method: 'GET',
        headers: {
          'x-api-key': testKey,
          'anthropic-version': API_VERSION,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve({ success: true });
          } else {
            try {
              const errorData = JSON.parse(data);
              resolve({ success: false, error: errorData.error?.message || `HTTP ${res.statusCode}` });
            } catch {
              resolve({ success: false, error: `HTTP ${res.statusCode}` });
            }
          }
        });
      });

      req.on('error', (err: Error) => resolve({ success: false, error: err.message }));
      req.setTimeout(REQUEST_TIMEOUT, () => { req.destroy(); resolve({ success: false, error: 'Request timeout' }); });
      req.end();
    });
  }

  /** Test an OpenRouter API key (or the stored key) */
  testOpenRouterKey(key?: string | null): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const testKey = key || this.openrouterApiKey;
      if (!testKey) {
        resolve({ success: false, error: 'No API key provided' });
        return;
      }

      const postData = JSON.stringify({
        model: 'openai/gpt-4o-mini',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }],
      });

      const options: https.RequestOptions = {
        hostname: OPENROUTER_HOSTNAME,
        port: 443,
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testKey}`,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve({ success: true });
          } else {
            try {
              const errorData = JSON.parse(data);
              resolve({ success: false, error: errorData.error?.message || `HTTP ${res.statusCode}` });
            } catch {
              resolve({ success: false, error: `HTTP ${res.statusCode}` });
            }
          }
        });
      });

      req.on('error', (err: Error) => resolve({ success: false, error: err.message }));
      req.setTimeout(REQUEST_TIMEOUT, () => { req.destroy(); resolve({ success: false, error: 'Request timeout' }); });
      req.write(postData);
      req.end();
    });
  }

  // ---------------------------------------------------------------------------
  // Model listing
  // ---------------------------------------------------------------------------

  /** Fetch available Anthropic models */
  async fetchModels(): Promise<ClaudeModel[]> {
    if (!this.apiKey) return this.models;

    return new Promise((resolve) => {
      const options: https.RequestOptions = {
        hostname: ANTHROPIC_HOSTNAME,
        port: 443,
        path: '/v1/models',
        method: 'GET',
        headers: {
          'x-api-key': this.apiKey!,
          'anthropic-version': API_VERSION,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              if (Array.isArray(parsed.data)) {
                this.models = parsed.data.map((m: any) => ({
                  id: m.id,
                  display_name: m.display_name || m.id,
                }));
                log.debug(`Fetched ${this.models.length} Anthropic models`);
              }
            } catch (err: any) {
              log.warn('Failed to parse Anthropic models response:', err.message);
            }
          } else {
            log.warn(`Failed to fetch Anthropic models: HTTP ${res.statusCode}`);
          }
          resolve(this.models);
        });
      });

      req.on('error', (err: Error) => { log.warn('Failed to fetch Anthropic models:', err.message); resolve(this.models); });
      req.setTimeout(REQUEST_TIMEOUT, () => { req.destroy(); log.warn('Anthropic models fetch timed out'); resolve(this.models); });
      req.end();
    });
  }

  /** Fetch available OpenRouter models */
  async fetchOpenRouterModels(): Promise<ClaudeModel[]> {
    if (!this.openrouterApiKey) return this.openrouterModels;

    return new Promise((resolve) => {
      const options: https.RequestOptions = {
        hostname: OPENROUTER_HOSTNAME,
        port: 443,
        path: '/api/v1/models',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.openrouterApiKey!}`,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              if (Array.isArray(parsed.data)) {
                this.openrouterModels = parsed.data.map((m: any) => ({
                  id: m.id,
                  display_name: m.name || m.id,
                }));
                log.debug(`Fetched ${this.openrouterModels.length} OpenRouter models`);
              }
            } catch (err: any) {
              log.warn('Failed to parse OpenRouter models response:', err.message);
            }
          } else {
            log.warn(`Failed to fetch OpenRouter models: HTTP ${res.statusCode}`);
          }
          resolve(this.openrouterModels);
        });
      });

      req.on('error', (err: Error) => { log.warn('Failed to fetch OpenRouter models:', err.message); resolve(this.openrouterModels); });
      req.setTimeout(REQUEST_TIMEOUT, () => { req.destroy(); log.warn('OpenRouter models fetch timed out'); resolve(this.openrouterModels); });
      req.end();
    });
  }

  /** Return the cached models list for a provider */
  getModels(provider?: AIProvider): ClaudeModel[] {
    return (provider || this.provider) === 'anthropic' ? this.models : this.openrouterModels;
  }

  /** Fetch models for a given provider (triggers API request) */
  async fetchModelsForProvider(provider: AIProvider): Promise<ClaudeModel[]> {
    return provider === 'anthropic' ? this.fetchModels() : this.fetchOpenRouterModels();
  }

  // ---------------------------------------------------------------------------
  // Streaming prompt
  // ---------------------------------------------------------------------------

  /**
   * Stream a prompt via the active provider.
   */
  streamPrompt(
    prompt: string,
    context: ClaudePromptContext | undefined,
    renderMode: RenderMode,
    onChunk: (text: string) => void,
    onEnd: (info?: { truncated?: boolean }) => void,
    onError: (error: string) => void,
    attachments?: AIAttachment[],
    history?: ChatTurn[],
  ): void {
    if (this.provider === 'anthropic') {
      this.streamAnthropicPrompt(prompt, context, renderMode, onChunk, onEnd, onError, attachments, history);
    } else {
      this.streamOpenRouterPrompt(prompt, context, renderMode, onChunk, onEnd, onError, attachments, history);
    }
  }

  /** Stream via Anthropic API */
  private streamAnthropicPrompt(
    prompt: string,
    context: ClaudePromptContext | undefined,
    renderMode: RenderMode,
    onChunk: (text: string) => void,
    onEnd: (info?: { truncated?: boolean }) => void,
    onError: (error: string) => void,
    attachments?: AIAttachment[],
    history?: ChatTurn[],
  ): void {
    if (!this.apiKey) {
      onError('No Anthropic API key configured. Please add your key in Settings.');
      return;
    }

    const systemPrompt = this.buildSystemPrompt(context, renderMode);

    // Build user content — plain string if no attachments, array if attachments present
    let userContent: string | unknown[];
    if (attachments && attachments.length > 0) {
      userContent = [];
      for (const att of attachments) {
        const base64 = att.dataUrl.replace(/^data:[^;]+;base64,/, '');
        (userContent as unknown[]).push({
          type: 'image',
          source: { type: 'base64', media_type: att.mediaType, data: base64 },
        });
      }
      (userContent as unknown[]).push({ type: 'text', text: prompt });
    } else {
      userContent = prompt;
    }

    const messages = [
      ...(history ?? []),
      { role: 'user', content: userContent },
    ];

    const postData = JSON.stringify({
      model: this.model,
      max_tokens: 16384,
      stream: true,
      system: systemPrompt,
      messages,
    });

    const options: https.RequestOptions = {
      hostname: ANTHROPIC_HOSTNAME,
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': API_VERSION,
      },
    };

    let finished = false;
    let truncated = false;

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', (chunk: Buffer) => errorData += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(errorData);
            if (!finished) { finished = true; onError(parsed.error?.message || `HTTP ${res.statusCode}`); }
          } catch {
            if (!finished) { finished = true; onError(`HTTP ${res.statusCode}`); }
          }
        });
        return;
      }

      let buffer = '';
      let streamEndSent = false;

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
            if (jsonStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(jsonStr);
              if (parsed.type === 'content_block_delta') {
                const text = parsed.delta?.text;
                if (text) onChunk(text);
              } else if (parsed.type === 'message_delta') {
                if (parsed.delta?.stop_reason === 'max_tokens') truncated = true;
              } else if (parsed.type === 'message_stop') {
                streamEndSent = true;
                if (!finished) { finished = true; onEnd({ truncated }); }
              } else if (parsed.type === 'error') {
                if (!finished) { finished = true; onError(parsed.error?.message || 'Stream error'); }
              }
            } catch {
              // Ignore parse errors for incomplete chunks
            }
          }
        }
      });

      res.on('end', () => {
        if (buffer.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(buffer.slice(6));
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              onChunk(parsed.delta.text);
            }
          } catch { /* Ignore */ }
        }
        if (!streamEndSent && !finished) { finished = true; onEnd({ truncated }); }
        this.activeRequest = null;
      });
    });

    req.on('error', (err: Error) => { if (!finished) { finished = true; onError(err.message); } this.activeRequest = null; });
    req.setTimeout(STREAM_IDLE_TIMEOUT, () => {
      if (!finished) { finished = true; req.destroy(); this.activeRequest = null; onError('AI request stalled (no data for 60s)'); }
    });
    this.activeRequest = req;
    req.write(postData);
    req.end();
  }

  /** Stream via OpenRouter API (OpenAI-compatible SSE) */
  private streamOpenRouterPrompt(
    prompt: string,
    context: ClaudePromptContext | undefined,
    renderMode: RenderMode,
    onChunk: (text: string) => void,
    onEnd: (info?: { truncated?: boolean }) => void,
    onError: (error: string) => void,
    attachments?: AIAttachment[],
    history?: ChatTurn[],
  ): void {
    if (!this.openrouterApiKey) {
      onError('No OpenRouter API key configured. Please add your key in Settings.');
      return;
    }

    const systemPrompt = this.buildSystemPrompt(context, renderMode);

    // Build user content — plain string if no attachments, array if attachments present
    let userContent: string | unknown[];
    if (attachments && attachments.length > 0) {
      userContent = [];
      for (const att of attachments) {
        (userContent as unknown[]).push({
          type: 'image_url',
          image_url: { url: att.dataUrl },
        });
      }
      (userContent as unknown[]).push({ type: 'text', text: prompt });
    } else {
      userContent = prompt;
    }

    const postData = JSON.stringify({
      model: this.openrouterModel,
      max_tokens: 16384,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        ...(history ?? []),
        { role: 'user', content: userContent },
      ],
    });

    const options: https.RequestOptions = {
      hostname: OPENROUTER_HOSTNAME,
      port: 443,
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.openrouterApiKey}`,
      },
    };

    let finished = false;
    let truncated = false;

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', (chunk: Buffer) => errorData += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(errorData);
            if (!finished) { finished = true; onError(parsed.error?.message || `HTTP ${res.statusCode}`); }
          } catch {
            if (!finished) { finished = true; onError(`HTTP ${res.statusCode}`); }
          }
        });
        return;
      }

      let buffer = '';
      let streamEndSent = false;

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6).trim();
            if (jsonStr === '[DONE]') {
              if (!streamEndSent && !finished) { streamEndSent = true; finished = true; onEnd({ truncated }); }
              continue;
            }
            try {
              const parsed = JSON.parse(jsonStr);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) onChunk(content);
              if (parsed.choices?.[0]?.finish_reason === 'length') truncated = true;
            } catch {
              // Ignore parse errors for incomplete chunks
            }
          }
        }
      });

      res.on('end', () => {
        // Process remaining buffer
        if (buffer.startsWith('data: ')) {
          const jsonStr = buffer.slice(6).trim();
          if (jsonStr === '[DONE]') {
            if (!streamEndSent && !finished) { streamEndSent = true; finished = true; onEnd({ truncated }); }
          } else {
            try {
              const parsed = JSON.parse(jsonStr);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) onChunk(content);
              if (parsed.choices?.[0]?.finish_reason === 'length') truncated = true;
            } catch { /* Ignore */ }
          }
        }
        if (!streamEndSent && !finished) { finished = true; onEnd({ truncated }); }
        this.activeRequest = null;
      });
    });

    req.on('error', (err: Error) => { if (!finished) { finished = true; onError(err.message); } this.activeRequest = null; });
    req.setTimeout(STREAM_IDLE_TIMEOUT, () => {
      if (!finished) { finished = true; req.destroy(); this.activeRequest = null; onError('AI request stalled (no data for 60s)'); }
    });
    this.activeRequest = req;
    req.write(postData);
    req.end();
  }

  // ---------------------------------------------------------------------------
  // Cancellation
  // ---------------------------------------------------------------------------

  cancelRequest(): void {
    if (this.activeRequest) {
      this.activeRequest.destroy();
      this.activeRequest = null;
    }
  }

  // ---------------------------------------------------------------------------
  // System prompt construction
  // ---------------------------------------------------------------------------

  buildSystemPrompt(context: ClaudePromptContext | undefined, renderMode: RenderMode): string {
    const base = this.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const mode = renderMode === 'shader'
      ? 'CURRENT MODE: GLSL Fragment Shader (Shadertoy-compatible)'
      : 'CURRENT MODE: Three.js Scene (JavaScript)';

    return `${base}

${mode}

${context?.channels ? `\nCHANNEL BINDINGS (live session state):\n${context.channels}` : ''}
${context?.paramValues ? `\nCURRENT PARAM VALUES (as dialed in by the user):\n${context.paramValues}` : ''}
${context?.customParams ? `\nCURRENT CUSTOM PARAMS:\n${context.customParams}` : ''}
${context?.currentCode ? `\nCURRENT CODE:\n${context.currentCode}` : ''}
${context?.compileError ? `\nCURRENT ERROR (the code above currently fails with this — if the user asks for a fix, fix exactly this):\n${context.compileError}` : ''}`;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async readFileOrNull(filePath: string): Promise<string | null> {
    try {
      return await fsPromises.readFile(filePath, 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      log.error(`Failed to read ${filePath}:`, err);
      return null;
    }
  }
}
