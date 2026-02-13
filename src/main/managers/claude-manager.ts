// ClaudeManager — manages Claude API key, model selection, and streaming prompts
// Extracted from main.js Claude-related code

import https from 'https';
import fs from 'fs';
import path from 'path';
import { Logger } from '@shared/logger.js';
import type { ClaudeSettings, ClaudeModel } from '@shared/types/settings.js';

const fsPromises = fs.promises;
const log = new Logger('Claude');

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const API_HOSTNAME = 'api.anthropic.com';
const API_VERSION = '2023-06-01';
const REQUEST_TIMEOUT = 10000;

/** Context passed alongside a Claude prompt */
export interface ClaudePromptContext {
  currentCode?: string;
  customParams?: string;
}

/** Render mode determines the system prompt flavour */
export type RenderMode = 'shader' | 'scene';

export class ClaudeManager {
  private apiKey: string | null = null;
  private model: string = DEFAULT_MODEL;
  private models: ClaudeModel[] = [];
  private activeRequest: ReturnType<typeof https.request> | null = null;
  private readonly keyFilePath: string;

  constructor(claudeKeyFile: string) {
    this.keyFilePath = claudeKeyFile;
  }

  // ---------------------------------------------------------------------------
  // Key management
  // ---------------------------------------------------------------------------

  /** Load API key and model from the key file on disk */
  async loadKey(): Promise<void> {
    try {
      const raw = await this.readFileOrNull(this.keyFilePath);
      if (raw) {
        const data = JSON.parse(raw);
        this.apiKey = data.apiKey || null;
        this.model = data.model || DEFAULT_MODEL;
      }
    } catch (err) {
      log.error('Failed to load Claude API key:', err);
    }
  }

  /** Save API key and model to the key file.
   *  If `key` is falsy the existing key is kept. */
  async saveKey(key: string | null, model: string | null): Promise<{ success: boolean; error?: string }> {
    try {
      if (key) {
        this.apiKey = key;
      }
      this.model = model || DEFAULT_MODEL;

      // Ensure parent directory exists
      const dir = path.dirname(this.keyFilePath);
      await fsPromises.mkdir(dir, { recursive: true });

      await fsPromises.writeFile(this.keyFilePath, JSON.stringify({
        apiKey: this.apiKey,
        model: this.model,
      }, null, 2), 'utf-8');

      // Refresh model list if we have a key
      if (this.apiKey) {
        await this.fetchModels();
      }
      return { success: true };
    } catch (err: any) {
      log.error('Failed to save Claude API key:', err);
      return { success: false, error: err.message };
    }
  }

  /** Whether an API key is currently loaded */
  hasKey(): boolean {
    return !!this.apiKey;
  }

  /** Return settings suitable for the renderer settings dialog */
  getSettings(): ClaudeSettings {
    return {
      hasKey: !!this.apiKey,
      model: this.model,
      models: this.models,
      maskedKey: this.apiKey ? '****' + this.apiKey.slice(-4) : '',
    };
  }

  // ---------------------------------------------------------------------------
  // API key validation
  // ---------------------------------------------------------------------------

  /** Test an API key (or the stored key) by sending a minimal request */
  testKey(key?: string | null): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const testKey = key || this.apiKey;
      if (!testKey) {
        resolve({ success: false, error: 'No API key provided' });
        return;
      }

      const postData = JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }],
      });

      const options: https.RequestOptions = {
        hostname: API_HOSTNAME,
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
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

      req.on('error', (err: Error) => {
        resolve({ success: false, error: err.message });
      });

      req.setTimeout(REQUEST_TIMEOUT, () => {
        req.destroy();
        resolve({ success: false, error: 'Request timeout' });
      });

      req.write(postData);
      req.end();
    });
  }

  // ---------------------------------------------------------------------------
  // Model listing
  // ---------------------------------------------------------------------------

  /** Fetch the list of available Claude models from the API */
  async fetchModels(): Promise<ClaudeModel[]> {
    if (!this.apiKey) return this.models;

    return new Promise((resolve) => {
      const options: https.RequestOptions = {
        hostname: API_HOSTNAME,
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
                log.debug(`Fetched ${this.models.length} Claude models from API`);
              }
            } catch (err: any) {
              log.warn('Failed to parse Claude models response:', err.message);
            }
          } else {
            log.warn(`Failed to fetch Claude models: HTTP ${res.statusCode}`);
          }
          resolve(this.models);
        });
      });

      req.on('error', (err: Error) => {
        log.warn('Failed to fetch Claude models:', err.message);
        resolve(this.models);
      });

      req.setTimeout(REQUEST_TIMEOUT, () => {
        req.destroy();
        log.warn('Claude models fetch timed out');
        resolve(this.models);
      });

      req.end();
    });
  }

  /** Return the cached models list */
  getModels(): ClaudeModel[] {
    return this.models;
  }

  // ---------------------------------------------------------------------------
  // Streaming prompt
  // ---------------------------------------------------------------------------

  /**
   * Stream a Claude prompt.
   *
   * @param prompt      User message to send
   * @param context     Optional shader context (current code, custom params)
   * @param renderMode  'shader' or 'scene' — determines system prompt flavour
   * @param onChunk     Called with each text chunk as it arrives
   * @param onEnd       Called when the stream completes
   * @param onError     Called on error
   */
  streamPrompt(
    prompt: string,
    context: ClaudePromptContext | undefined,
    renderMode: RenderMode,
    onChunk: (text: string) => void,
    onEnd: () => void,
    onError: (error: string) => void,
  ): void {
    if (!this.apiKey) {
      onError('No API key configured. Please add your Claude API key in Settings.');
      return;
    }

    const systemPrompt = this.buildSystemPrompt(context, renderMode);

    const postData = JSON.stringify({
      model: this.model,
      max_tokens: 8192,
      stream: true,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });

    const options: https.RequestOptions = {
      hostname: API_HOSTNAME,
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': API_VERSION,
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', (chunk: Buffer) => errorData += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(errorData);
            onError(parsed.error?.message || `HTTP ${res.statusCode}`);
          } catch {
            onError(`HTTP ${res.statusCode}`);
          }
        });
        return;
      }

      let buffer = '';
      let streamEndSent = false;

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();

        // Process complete SSE events
        const lines = buffer.split('\n');
        buffer = lines.pop()!; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
            if (jsonStr === '[DONE]') continue;

            try {
              const parsed = JSON.parse(jsonStr);

              if (parsed.type === 'content_block_delta') {
                const text = parsed.delta?.text;
                if (text) {
                  onChunk(text);
                }
              } else if (parsed.type === 'message_stop') {
                streamEndSent = true;
                onEnd();
              } else if (parsed.type === 'error') {
                onError(parsed.error?.message || 'Stream error');
              }
            } catch {
              // Ignore parse errors for incomplete chunks
            }
          }
        }
      });

      res.on('end', () => {
        // Process any remaining buffer
        if (buffer.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(buffer.slice(6));
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              onChunk(parsed.delta.text);
            }
          } catch {
            // Ignore
          }
        }
        if (!streamEndSent) {
          onEnd();
        }
        this.activeRequest = null;
      });
    });

    req.on('error', (err: Error) => {
      onError(err.message);
      this.activeRequest = null;
    });

    // Store reference for cancellation
    this.activeRequest = req;

    req.write(postData);
    req.end();
  }

  // ---------------------------------------------------------------------------
  // Cancellation
  // ---------------------------------------------------------------------------

  /** Cancel the currently active streaming request, if any */
  cancelRequest(): void {
    if (this.activeRequest) {
      this.activeRequest.destroy();
      this.activeRequest = null;
    }
  }

  // ---------------------------------------------------------------------------
  // System prompt construction
  // ---------------------------------------------------------------------------

  /** Build the system prompt for Claude based on render mode and context */
  buildSystemPrompt(context: ClaudePromptContext | undefined, renderMode: RenderMode): string {
    const basePrompt = `You are an expert GLSL shader and Three.js developer helping with ShaderShow, a real-time shader visualization tool.

IMPORTANT RULES:
1. When providing code, include ONLY the complete shader or scene code - no explanations before or after unless asked
2. The code should be ready to compile and run immediately
3. Preserve any existing @param comments for custom uniforms
4. For shaders: Use Shadertoy-compatible uniforms and mainImage function
5. For scenes: Use setup() and animate() function patterns

`;

    if (renderMode === 'shader') {
      return basePrompt + `CURRENT MODE: GLSL Fragment Shader (Shadertoy-compatible)

AVAILABLE UNIFORMS:
- vec3 iResolution      - Viewport resolution (width, height, 1.0)
- float iTime           - Playback time in seconds
- float iTimeDelta      - Time since last frame
- int iFrame            - Current frame number
- vec4 iMouse           - Mouse coords (xy: current, zw: click position)
- vec4 iDate            - (year, month, day, seconds)
- sampler2D iChannel0-3 - Input textures
- vec3 iChannelResolution[4] - Resolution of each channel

CUSTOM PARAMETERS (@param syntax):
Define custom uniforms with UI sliders using @param comments:
  // @param name type [default] [min, max] "description"

Supported types: int, float, vec2, vec3, vec4, color

Examples:
  // @param speed float 1.0 [0.0, 5.0] "Animation speed"
  // @param center vec2 0.5, 0.5 "Center position"
  // @param tint color [1.0, 0.5, 0.0] "Tint color"

SHADER STRUCTURE:
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    // Your shader code here
    fragColor = vec4(color, 1.0);
}

${context?.customParams ? `\nCURRENT CUSTOM PARAMS:\n${context.customParams}` : ''}
${context?.currentCode ? `\nCURRENT CODE:\n${context.currentCode}` : ''}`;
    } else {
      return basePrompt + `CURRENT MODE: Three.js Scene (JavaScript)

SCENE STRUCTURE:
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

CUSTOM PARAMETERS (@param syntax):
Same as shaders - define with @param comments at the top of the file

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
}

${context?.customParams ? `\nCURRENT CUSTOM PARAMS:\n${context.customParams}` : ''}
${context?.currentCode ? `\nCURRENT CODE:\n${context.currentCode}` : ''}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Read a file and return its contents, or null if missing/error */
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
