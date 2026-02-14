// Remote Control Server — Express + WebSocket server for web-based remote control

import express, { Express, Request, Response } from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { Logger } from '@shared/logger.js';

const log = new Logger('Remote');

export type QueryRendererFn = (channel: string, data?: unknown) => Promise<unknown>;
export type DispatchActionFn = (channel: string, data: unknown) => void;

export interface RemoteServerOptions {
  queryRenderer: QueryRendererFn;
  dispatchAction: DispatchActionFn;
}

export class RemoteServer {
  private queryRenderer: QueryRendererFn;
  private dispatchAction: DispatchActionFn;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private app: Express | null = null;
  private thumbnailCache = new Map<string, Buffer>();
  port = 9876;

  constructor({ queryRenderer, dispatchAction }: RemoteServerOptions) {
    this.queryRenderer = queryRenderer;
    this.dispatchAction = dispatchAction;
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
    log.info('Server stopped');
  }

  broadcast(type: string, data: unknown): void {
    if (!this.wss) return;
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
          res.set('Cache-Control', 'public, max-age=86400');
          res.send(cached);
          return;
        }

        // Cache miss — query renderer
        const result = await this.queryRenderer('remote-get-thumbnail', { tabIndex, slotIndex }) as any;
        if (result && result.dataUrl) {
          const base64 = result.dataUrl.replace(/^data:image\/\w+;base64,/, '');
          const buf = Buffer.from(base64, 'base64');
          this.thumbnailCache.set(cacheKey, buf);
          res.set('Content-Type', 'image/jpeg');
          res.set('Cache-Control', 'public, max-age=86400');
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
    };

    for (const [route, channel] of Object.entries(actions)) {
      app.post(route, (req: Request, res: Response) => {
        this.dispatchAction(channel, req.body || {});
        res.json({ ok: true });
      });
    }
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

  private handleWsMessage(msg: { type?: string; data?: unknown }): void {
    if (!msg || !msg.type) return;

    const wsActions: Record<string, string> = {
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
    };

    // Handle thumbnail cache invalidation
    if (msg.type === 'invalidate-thumbnail') {
      const { tab, slot } = msg.data as { tab: number; slot: number };
      this.thumbnailCache.delete(`${tab}-${slot}`);
      return;
    }

    const channel = wsActions[msg.type];
    if (channel) {
      this.dispatchAction(channel, msg.data || {});
    }
  }
}
