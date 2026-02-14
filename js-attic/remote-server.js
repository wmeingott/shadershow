// Remote Control Server — Express + WebSocket server for web-based remote control
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

class RemoteServer {
  constructor({ queryRenderer, dispatchAction }) {
    this.queryRenderer = queryRenderer;
    this.dispatchAction = dispatchAction;
    this.server = null;
    this.wss = null;
    this.app = null;
    this.port = 9876;
  }

  start(port = 9876) {
    if (this.server) return;
    this.port = port;

    this.app = express();
    this.app.use(express.json());

    // Serve static files from web/ directory
    this.app.use(express.static(path.join(__dirname, 'web')));

    this._setupRoutes();

    this.server = http.createServer(this.app);
    this._setupWebSocket();

    this.server.listen(port, '0.0.0.0', () => {
      console.log(`[Remote] Server listening on http://0.0.0.0:${port}`);
    });
  }

  stop() {
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
    console.log('[Remote] Server stopped');
  }

  broadcast(type, data) {
    if (!this.wss) return;
    const msg = JSON.stringify({ type, data });
    for (const client of this.wss.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(msg);
      }
    }
  }

  _setupRoutes() {
    const app = this.app;

    // ---- State queries ----
    app.get('/api/state', async (req, res) => {
      try {
        const state = await this.queryRenderer('remote-get-state');
        res.json(state);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.get('/api/thumbnail/:tabIndex/:slotIndex', async (req, res) => {
      try {
        const tabIndex = parseInt(req.params.tabIndex, 10);
        const slotIndex = parseInt(req.params.slotIndex, 10);
        const result = await this.queryRenderer('remote-get-thumbnail', { tabIndex, slotIndex });
        if (result && result.dataUrl) {
          // Send as JPEG
          const base64 = result.dataUrl.replace(/^data:image\/\w+;base64,/, '');
          const buf = Buffer.from(base64, 'base64');
          res.set('Content-Type', 'image/jpeg');
          res.set('Cache-Control', 'no-cache');
          res.send(buf);
        } else {
          res.status(404).json({ error: 'No thumbnail available' });
        }
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ---- Action dispatch ----
    const actions = {
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
      '/api/blackout': 'remote-blackout'
    };

    for (const [route, channel] of Object.entries(actions)) {
      app.post(route, (req, res) => {
        this.dispatchAction(channel, req.body || {});
        res.json({ ok: true });
      });
    }
  }

  _setupWebSocket() {
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      console.log('[Remote] WebSocket client connected');

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this._handleWsMessage(msg);
        } catch (err) {
          console.warn('[Remote] Invalid WS message:', err.message);
        }
      });

      ws.on('close', () => {
        console.log('[Remote] WebSocket client disconnected');
      });
    });
  }

  _handleWsMessage(msg) {
    if (!msg || !msg.type) return;

    // Map WebSocket action types to IPC channels
    const wsActions = {
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
      'blackout': 'remote-blackout'
    };

    const channel = wsActions[msg.type];
    if (channel) {
      this.dispatchAction(channel, msg.data || {});
    }
  }
}

module.exports = RemoteServer;
