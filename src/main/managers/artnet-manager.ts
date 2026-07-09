// ArtNetManager — receives Art-Net DMX data over UDP and maps channels to app controls
// Uses Node.js built-in dgram module (no external dependencies)

import dgram from 'dgram';
import { Logger } from '@shared/logger.js';
import { isThresholdTarget } from '@shared/types/artnet.js';
import type { ArtNetMapping, ArtNetChange, ArtNetStatus } from '@shared/types/artnet.js';

const log = new Logger('ArtNet');

/** Art-Net protocol constants */
const ARTNET_PORT = 6454;
const ARTNET_MAGIC = Buffer.from('Art-Net\0');
const ARTNET_OPCODE_DMX = 0x5000;

/** Minimum IPC batch interval (ms) — caps DMX→renderer updates at ~30fps */
const BATCH_INTERVAL = 33;

/** Callbacks for communicating with the main process */
export interface ArtNetManagerCallbacks {
  onDmxUpdate: (changes: ArtNetChange[]) => void;
  onStatusUpdate: (status: ArtNetStatus) => void;
}

/**
 * Receives Art-Net ArtDmx packets, diffs channel values, and emits
 * mapped changes via callbacks.  All socket work runs in the main
 * (Node.js) process; the renderer receives batched changes via IPC.
 */
export class ArtNetManager {
  private socket: dgram.Socket | null = null;
  private enabled = false;
  private universe = 0;
  private mappings: ArtNetMapping[] = [];

  // 512-byte DMX frame buffers for diffing
  private dmxValues = new Uint8Array(512);
  private prevDmxValues = new Uint8Array(512);

  // Rising-edge state for threshold triggers (keyed by mapping index)
  private triggerState = new Map<number, boolean>();

  // Batching
  private pendingChanges: ArtNetChange[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  // Stats
  private packetsReceived = 0;
  private lastPacketTime = 0;
  private error: string | undefined;

  private readonly callbacks: ArtNetManagerCallbacks;

  // Pre-built lookup: dmxChannel (0-indexed) → mapping index in this.mappings
  private channelToMapping = new Map<number, number>();

  constructor(callbacks: ArtNetManagerCallbacks) {
    this.callbacks = callbacks;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.socket) return;
    this.enabled = true;
    this.error = undefined;
    this.packetsReceived = 0;

    try {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('message', (msg, _rinfo) => this.handlePacket(msg));

      this.socket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this.error = `Port ${ARTNET_PORT} already in use`;
        } else {
          this.error = err.message;
        }
        log.error('Socket error:', err.message);
        this.emitStatus();
      });

      this.socket.bind(ARTNET_PORT, () => {
        log.info(`Listening on UDP port ${ARTNET_PORT}, universe ${this.universe}`);
        this.emitStatus();
      });
    } catch (err) {
      this.error = (err as Error).message;
      log.error('Failed to create socket:', this.error);
      this.emitStatus();
    }
  }

  stop(): void {
    this.enabled = false;
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch { /* already closed */ }
      this.socket = null;
    }
    this.dmxValues.fill(0);
    this.prevDmxValues.fill(0);
    this.triggerState.clear();
    this.pendingChanges.length = 0;
    log.info('Stopped');
    this.emitStatus();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setUniverse(universe: number): void {
    this.universe = Math.max(0, Math.min(32767, universe | 0));
    log.info(`Universe set to ${this.universe}`);
    this.emitStatus();
  }

  setMappings(mappings: ArtNetMapping[]): void {
    this.mappings = mappings;
    this.rebuildLookup();
    this.triggerState.clear();
    log.info(`${mappings.length} mapping(s) configured`);
  }

  getMappings(): ArtNetMapping[] {
    return this.mappings;
  }

  getUniverse(): number {
    return this.universe;
  }

  getStatus(): ArtNetStatus {
    return {
      enabled: this.enabled,
      universe: this.universe,
      packetsReceived: this.packetsReceived,
      lastPacketTime: this.lastPacketTime,
      error: this.error,
    };
  }

  /** Return current 512-byte DMX frame (for monitor UI) */
  getDmxValues(): Uint8Array {
    return this.dmxValues;
  }

  // ---------------------------------------------------------------------------
  // Packet parsing
  // ---------------------------------------------------------------------------

  private handlePacket(msg: Buffer): void {
    // Minimum ArtDmx packet: 18 header + 2 data = 20 bytes
    if (msg.length < 20) return;

    // Check magic "Art-Net\0"
    if (msg.compare(ARTNET_MAGIC, 0, 8, 0, 8) !== 0) return;

    // Opcode (little-endian at bytes 8-9)
    const opcode = msg[8]! | (msg[9]! << 8);
    if (opcode !== ARTNET_OPCODE_DMX) return;

    // Universe (little-endian at bytes 14-15)
    const pktUniverse = msg[14]! | (msg[15]! << 8);
    if (pktUniverse !== this.universe) return;

    // Data length (big-endian at bytes 16-17)
    const dataLen = (msg[16]! << 8) | msg[17]!;
    const actualLen = Math.min(dataLen, msg.length - 18, 512);

    // Copy DMX data into our buffer
    msg.copy(this.dmxValues as unknown as Buffer, 0, 18, 18 + actualLen);

    this.packetsReceived++;
    this.lastPacketTime = Date.now();

    // Diff against previous frame and collect changes
    this.diffAndEmit(actualLen);

    // Store current as previous
    this.prevDmxValues.set(this.dmxValues);
  }

  private diffAndEmit(length: number): void {
    for (let i = 0; i < length; i++) {
      if (this.dmxValues[i] === this.prevDmxValues[i]) continue;

      const mappingIdx = this.channelToMapping.get(i);
      if (mappingIdx === undefined) continue;

      const mapping = this.mappings[mappingIdx]!;
      const dmxValue = this.dmxValues[i]!;
      const target = mapping.target;

      // For threshold-based targets, only emit on rising edge
      if (isThresholdTarget(target)) {
        const threshold = (target as { threshold?: number }).threshold ?? 127;
        const wasHigh = this.triggerState.get(mappingIdx) ?? false;
        const isHigh = dmxValue > threshold;
        this.triggerState.set(mappingIdx, isHigh);
        if (isHigh && !wasHigh) {
          this.pendingChanges.push({ target, dmxValue });
        }
        continue;
      }

      this.pendingChanges.push({ target, dmxValue });
    }

    // Schedule batched IPC emission
    if (this.pendingChanges.length > 0 && !this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flushBatch(), BATCH_INTERVAL);
    }
  }

  private flushBatch(): void {
    this.batchTimer = null;
    if (this.pendingChanges.length === 0) return;

    const changes = this.pendingChanges.splice(0);
    this.callbacks.onDmxUpdate(changes);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private rebuildLookup(): void {
    this.channelToMapping.clear();
    for (let i = 0; i < this.mappings.length; i++) {
      // DMX channels are 1-based in the config, 0-based in the buffer
      const ch0 = this.mappings[i]!.dmxChannel - 1;
      if (ch0 >= 0 && ch0 < 512) {
        this.channelToMapping.set(ch0, i);
      }
    }
  }

  private emitStatus(): void {
    this.callbacks.onStatusUpdate(this.getStatus());
  }
}
