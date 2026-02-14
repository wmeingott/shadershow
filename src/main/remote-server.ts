// Remote Control Server — Express + WebSocket server for web-based remote control

import express, { Express, Request, Response } from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { Logger } from '@shared/logger.js';

const log = new Logger('Remote');

const MAX_THUMBNAIL_CACHE = 200;

const WS_ACTIONS: Record<string, string> = {
  'select-tab': 'remote-select-tab',
  'select-slot': 'remote-select-slot',
  'set-param': 'remote-set-param',
  'recall-preset': 'remote-recall-preset',
  'mixer-assign': 'remote-mixer-assign',
  'mixer-clear': 'remote-mixer-clear',
  'mixer-alpha': 'remote-mixer-alpha',
  'mixer-select': 'remote-mixer-select',
  'mixer-blend': 'remote-mixer-blend',
  'mixer-reset': 'remote-mixer-reset',
  'mixer-toggle': 'remote-mixer-toggle',
  'recall-mix-preset': 'remote-recall-mix-preset',
  'toggle-playback': 'remote-toggle-playback',
  'reset-time': 'remote-reset-time',
  'blackout': 'remote-blackout',
  'recall-visual-preset': 'remote-recall-visual-preset',
  'reorder-visual-preset': 'remote-reorder-visual-preset',
};

export type QueryRendererFn = (channel: string, data?: unknown) => Promise<unknown>;
export type DispatchActionFn = (channel: string, data: unknown) => void;

export interface DisplayInfoDTO {
  id: number;
  label: string;
  primary: boolean;
  hasFullscreen: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface RemoteServerOptions {
  queryRenderer: QueryRendererFn;
  dispatchAction: DispatchActionFn;
  getDisplays?: () => DisplayInfoDTO[];
  openFullscreenOnDisplay?: (displayId: number) => void;
  closeFullscreen?: () => void;
  getPreviewFrame?: () => Promise<Buffer | null>;
}

export class RemoteServer {
  private queryRenderer: QueryRendererFn;
  private dispatchAction: DispatchActionFn;
  private getDisplays?: () => DisplayInfoDTO[];
  private openFullscreenOnDisplay?: (displayId: number) => void;
  private closeFullscreen?: () => void;
  private getPreviewFrame?: () => Promise<Buffer | null>;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private app: Express | null = null;
  private thumbnailCache = new Map<string, Buffer>();
  private previewClients = new Set<Response>();
  private previewTimer: ReturnType<typeof setInterval> | null = null;
  port = 9876;

  constructor(opts: RemoteServerOptions) {
    this.queryRenderer = opts.queryRenderer;
    this.dispatchAction = opts.dispatchAction;
    this.getDisplays = opts.getDisplays;
    this.openFullscreenOnDisplay = opts.openFullscreenOnDisplay;
    this.closeFullscreen = opts.closeFullscreen;
    this.getPreviewFrame = opts.getPreviewFrame;
  }

  start(port = 9876): void {
    if (this.server) return;
    this.port = port;

    this.app = express();
    this.app.use(express.json());

    // Serve static files from web/ directory
    this.app.use(express.static(path.join(__dirname, '..', '..', 'web')));

    this.setupRoutes();

    this.server = http.createServer(this.app);
    this.setupWebSocket();

    this.server.listen(port, '0.0.0.0', () => {
      log.info(`Server listening on http://0.0.0.0:${port}`);
    });
  }

  stop(): void {
    this.stopPreviewTimer();
    for (const client of this.previewClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.previewClients.clear();
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close();
      }
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.app = null;
    this.thumbnailCache.clear();
    log.info('Server stopped');
  }

  broadcast(type: string, data: unknown): void {
    if (!this.wss) return;
    // Clear thumbnail cache on state updates so stale images are re-fetched
    if (type === 'state-update') {
      this.thumbnailCache.clear();
    }
    const msg = JSON.stringify({ type, data });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  private setupRoutes(): void {
    const app = this.app!;

    // State queries
    app.get('/api/state', async (_req: Request, res: Response) => {
      try {
        const state = await this.queryRenderer('remote-get-state');
        res.json(state);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    app.get('/api/thumbnail/:tabIndex/:slotIndex', async (req: Request, res: Response) => {
      try {
        const tabIndex = parseInt(req.params.tabIndex as string, 10);
        const slotIndex = parseInt(req.params.slotIndex as string, 10);
        const cacheKey = `${tabIndex}-${slotIndex}`;

        // Serve from cache if available
        const cached = this.thumbnailCache.get(cacheKey);
        if (cached) {
          res.set('Content-Type', 'image/jpeg');
          res.set('Cache-Control', 'no-cache');
          res.send(cached);
          return;
        }

        // Cache miss — query renderer
        const result = await this.queryRenderer('remote-get-thumbnail', { tabIndex, slotIndex }) as any;
        if (result && result.dataUrl) {
          const base64 = result.dataUrl.replace(/^data:image\/\w+;base64,/, '');
          const buf = Buffer.from(base64, 'base64');
          if (this.thumbnailCache.size >= MAX_THUMBNAIL_CACHE) {
            // Evict oldest entry (first key in Map iteration order)
            const oldest = this.thumbnailCache.keys().next().value;
            if (oldest !== undefined) this.thumbnailCache.delete(oldest);
          }
          this.thumbnailCache.set(cacheKey, buf);
          res.set('Content-Type', 'image/jpeg');
          res.set('Cache-Control', 'no-cache');
          res.send(buf);
        } else {
          res.status(404).json({ error: 'No thumbnail available' });
        }
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Action dispatch routes
    const actions: Record<string, string> = {
      '/api/tab/select': 'remote-select-tab',
      '/api/slot/select': 'remote-select-slot',
      '/api/param': 'remote-set-param',
      '/api/preset/recall': 'remote-recall-preset',
      '/api/mixer/assign': 'remote-mixer-assign',
      '/api/mixer/clear': 'remote-mixer-clear',
      '/api/mixer/alpha': 'remote-mixer-alpha',
      '/api/mixer/select': 'remote-mixer-select',
      '/api/mixer/blend': 'remote-mixer-blend',
      '/api/mixer/reset': 'remote-mixer-reset',
      '/api/mixer/toggle': 'remote-mixer-toggle',
      '/api/mixer/recall-preset': 'remote-recall-mix-preset',
      '/api/playback/toggle': 'remote-toggle-playback',
      '/api/playback/reset': 'remote-reset-time',
      '/api/blackout': 'remote-blackout',
      '/api/vp/recall': 'remote-recall-visual-preset',
      '/api/vp/reorder': 'remote-reorder-visual-preset',
    };

    for (const [route, channel] of Object.entries(actions)) {
      app.post(route, (req: Request, res: Response) => {
        this.dispatchAction(channel, req.body || {});
        res.json({ ok: true });
      });
    }

    // ---- Display / fullscreen management ----

    app.get('/api/displays', (_req: Request, res: Response) => {
      if (!this.getDisplays) {
        res.status(501).json({ error: 'Not available' });
        return;
      }
      res.json(this.getDisplays());
    });

    app.post('/api/fullscreen/open', (req: Request, res: Response) => {
      if (!this.openFullscreenOnDisplay) {
        res.status(501).json({ error: 'Not available' });
        return;
      }
      const { displayId } = req.body || {};
      if (typeof displayId !== 'number') {
        res.status(400).json({ error: 'displayId required' });
        return;
      }
      this.openFullscreenOnDisplay(displayId);
      res.json({ ok: true });
    });

    app.post('/api/fullscreen/close', (_req: Request, res: Response) => {
      if (!this.closeFullscreen) {
        res.status(501).json({ error: 'Not available' });
        return;
      }
      this.closeFullscreen();
      res.json({ ok: true });
    });

    // ---- Live MJPEG preview stream ----

    app.get('/api/preview/stream', (req: Request, res: Response) => {
      if (!this.getPreviewFrame) {
        res.status(501).json({ error: 'Not available' });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Connection': 'close',
      });

      this.previewClients.add(res);
      this.startPreviewTimer();

      req.on('close', () => {
        this.previewClients.delete(res);
        if (this.previewClients.size === 0) {
          this.stopPreviewTimer();
        }
      });
    });

    app.get('/api/preview/status', (_req: Request, res: Response) => {
      res.json({
        streaming: this.previewClients.size > 0,
        clients: this.previewClients.size,
      });
    });
  }

  private setupWebSocket(): void {
    this.wss = new WebSocketServer({ server: this.server!, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket) => {
      log.info('WebSocket client connected');

      ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleWsMessage(msg);
        } catch (err: any) {
          log.warn(`Invalid WS message: ${err.message}`);
        }
      });

      ws.on('close', () => {
        log.info('WebSocket client disconnected');
      });
    });
  }

  private startPreviewTimer(): void {
    if (this.previewTimer) return;
    this.previewTimer = setInterval(() => this.pushPreviewFrame(), 100); // ~10fps
  }

  private stopPreviewTimer(): void {
    if (this.previewTimer) {
      clearInterval(this.previewTimer);
      this.previewTimer = null;
    }
  }

  private async pushPreviewFrame(): Promise<void> {
    if (this.previewClients.size === 0 || !this.getPreviewFrame) return;

    try {
      const buf = await this.getPreviewFrame();
      if (!buf || buf.length === 0) return;

      const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`;
      const dead: Response[] = [];

      for (const client of this.previewClients) {
        try {
          client.write(header);
          client.write(buf);
          client.write('\r\n');
        } catch {
          dead.push(client);
        }
      }

      for (const d of dead) {
        this.previewClients.delete(d);
      }
      if (this.previewClients.size === 0) {
        this.stopPreviewTimer();
      }
    } catch (err: any) {
      log.warn(`Preview frame error: ${err.message}`);
    }
  }

  private handleWsMessage(msg: { type?: string; data?: unknown }): void {
    if (!msg || !msg.type) return;

    // Handle thumbnail cache invalidation
    if (msg.type === 'invalidate-thumbnail') {
      const { tab, slot } = msg.data as { tab: number; slot: number };
      this.thumbnailCache.delete(`${tab}-${slot}`);
      return;
    }

    const channel = WS_ACTIONS[msg.type];
    if (channel) {
      this.dispatchAction(channel, msg.data || {});
    }
  }
}
