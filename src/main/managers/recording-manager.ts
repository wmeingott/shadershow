// RecordingManager — H.265 MP4 recording via FFmpeg
// Manages an FFmpeg child process that receives raw RGBA frames on stdin
// and encodes them to an H.265 MP4 file.

import { spawn, ChildProcess } from 'child_process';
import { Logger } from '@shared/logger.js';

const ffmpegPath = require('ffmpeg-static');

const log = new Logger('Recording');

export interface RecordingResolution {
  width: number;
  height: number;
  label: string;
}

export const RECORDING_RESOLUTIONS: RecordingResolution[] = [
  { width: 640, height: 360, label: '640x360 (360p)' },
  { width: 854, height: 480, label: '854x480 (480p)' },
  { width: 1280, height: 720, label: '1280x720 (720p)' },
  { width: 1536, height: 864, label: '1536x864' },
  { width: 1920, height: 1080, label: '1920x1080 (1080p)' },
  { width: 2560, height: 1440, label: '2560x1440 (1440p)' },
  { width: 3072, height: 1824, label: '3072x1824' },
  { width: 3840, height: 2160, label: '3840x2160 (4K)' },
  { width: 0, height: 0, label: 'Match Preview' },
];

export interface RecordingStartResult {
  filePath?: string;
  width?: number;
  height?: number;
  error?: string;
  canceled?: boolean;
}

export interface RecordingFrameData {
  data: Uint8Array | Buffer;
  width: number;
  height: number;
}

export class RecordingManager {
  private process: ChildProcess | null = null;
  private enabled = false;
  private resolution: RecordingResolution = { width: 1920, height: 1080, label: '1920x1080 (1080p)' };
  private flipBuffer: Buffer | null = null;
  private lastWidth = 0;
  private lastHeight = 0;
  private filePath: string | null = null;
  private backpressure = false;

  /**
   * Start recording to an MP4 file using FFmpeg.
   *
   * @param recWidth  - Recording width in pixels (must be > 0, will be rounded to even)
   * @param recHeight - Recording height in pixels (must be > 0, will be rounded to even)
   * @param outputPath - Absolute path for the output MP4 file
   * @param onClose   - Callback invoked when FFmpeg exits (code may be null on error)
   * @param onError   - Callback invoked on FFmpeg spawn error
   */
  start(
    recWidth: number,
    recHeight: number,
    outputPath: string,
    onClose?: (code: number | null) => void,
    onError?: (err: Error) => void,
  ): RecordingStartResult {
    if (this.enabled) {
      return { error: 'Already recording' };
    }

    this.filePath = outputPath;

    // Ensure even dimensions (required by H.265)
    recWidth = recWidth % 2 === 0 ? recWidth : recWidth + 1;
    recHeight = recHeight % 2 === 0 ? recHeight : recHeight + 1;

    // Choose encoder: hevc_videotoolbox on macOS, libx265 elsewhere
    const isMac = process.platform === 'darwin';
    const encoder = isMac ? 'hevc_videotoolbox' : 'libx265';

    const ffmpegArgs = [
      '-y',
      '-f', 'rawvideo',
      '-pixel_format', 'rgba',
      '-video_size', `${recWidth}x${recHeight}`,
      '-framerate', '60',
      '-i', 'pipe:0',
      '-c:v', encoder,
      ...(isMac ? ['-preset', 'fast'] : ['-preset', 'fast', '-crf', '23']),
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputPath,
    ];

    log.info(`Starting recording: ${recWidth}x${recHeight} to ${outputPath}`);

    this.process = spawn(ffmpegPath, ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        log.error('FFmpeg error:', msg);
      }
    });

    this.process.on('close', (code: number | null) => {
      log.info(`FFmpeg exited with code ${code}`);
      this.enabled = false;
      this.process = null;
      this.backpressure = false;
      onClose?.(code);
    });

    this.process.on('error', (err: Error) => {
      log.error('FFmpeg spawn error:', err);
      this.enabled = false;
      this.process = null;
      this.backpressure = false;
      onError?.(err);
    });

    // Handle broken pipe gracefully
    this.process.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') {
        log.error('FFmpeg stdin error:', err);
      }
    });

    this.enabled = true;

    return {
      filePath: outputPath,
      width: recWidth,
      height: recHeight,
    };
  }

  /**
   * Stop the current recording. Signals FFmpeg to finalize the file
   * by closing stdin. Falls back to killing the process on error.
   */
  stop(): void {
    if (!this.process) return;

    log.info('Stopping recording...');

    // Close stdin to signal FFmpeg to finalize the file
    try {
      this.process.stdin?.end();
    } catch (err) {
      log.error('Error closing FFmpeg stdin:', err);
      // Force kill if stdin close fails (avoid SIGTERM on Windows where it hard-kills)
      if (process.platform === 'win32') {
        this.process.kill();
      } else {
        this.process.kill('SIGTERM');
      }
    }

    // The 'close' event handler will update state
  }

  /**
   * Send a single RGBA frame to the FFmpeg process.
   * Frames are vertically flipped (WebGL readPixels gives bottom-to-top,
   * video expects top-to-bottom) and piped to FFmpeg stdin.
   * Frames are silently dropped during back-pressure.
   */
  sendFrame(frameData: RecordingFrameData): void {
    if (!this.process || !this.enabled) return;

    try {
      const { data, width, height } = frameData;

      let sourceBuffer: Buffer;
      if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
        sourceBuffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      } else {
        log.warn('Recording frame: invalid data format');
        return;
      }

      const rowSize = width * 4;
      const bufferSize = width * height * 4;

      // Reallocate flip buffer only if resolution changed
      if (width !== this.lastWidth || height !== this.lastHeight) {
        this.flipBuffer = Buffer.allocUnsafe(bufferSize);
        this.lastWidth = width;
        this.lastHeight = height;
      }

      // Flip vertically (WebGL readPixels gives bottom-to-top, video expects top-to-bottom)
      for (let y = 0; y < height; y++) {
        const srcOffset = (height - 1 - y) * rowSize;
        const dstOffset = y * rowSize;
        sourceBuffer.copy(this.flipBuffer!, dstOffset, srcOffset, srcOffset + rowSize);
      }

      // Write to FFmpeg stdin
      if (this.backpressure) return; // Drop frame during back-pressure
      const canWrite = this.process.stdin!.write(this.flipBuffer!);
      if (!canWrite) {
        this.backpressure = true;
        this.process.stdin!.once('drain', () => {
          this.backpressure = false;
        });
      }
    } catch (err: any) {
      log.error('Recording frame error:', err.message);
    }
  }

  /**
   * Returns true if a recording is currently in progress.
   */
  isRunning(): boolean {
    return this.enabled && this.process !== null;
  }

  /** Get the current recording file path, or null if not recording. */
  getFilePath(): string | null {
    return this.filePath;
  }

  /** Get/set the target recording resolution. */
  getResolution(): RecordingResolution {
    return this.resolution;
  }

  setResolution(res: RecordingResolution): void {
    this.resolution = res;
  }
}
