// Shared logger — near-zero overhead when disabled
// Levels: 0=OFF, 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG

export const LOG_LEVEL = { OFF: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4 } as const;
export type LogLevel = typeof LOG_LEVEL[keyof typeof LOG_LEVEL];

export class Logger {
  private _level: LogLevel;
  private _tag: string;

  constructor(tag: string, level: LogLevel = LOG_LEVEL.WARN) {
    this._tag = tag;
    this._level = level;
  }

  get level(): LogLevel { return this._level; }
  set level(l: LogLevel) { this._level = l; }

  debug(msg: string, ...args: unknown[]): void {
    if (this._level >= 4) console.debug(`[${this._tag}] ${msg}`, ...args);
  }

  info(msg: string, ...args: unknown[]): void {
    if (this._level >= 3) console.info(`[${this._tag}] ${msg}`, ...args);
  }

  warn(msg: string, ...args: unknown[]): void {
    if (this._level >= 2) console.warn(`[${this._tag}] ${msg}`, ...args);
  }

  error(msg: string, ...args: unknown[]): void {
    if (this._level >= 1) console.error(`[${this._tag}] ${msg}`, ...args);
  }
}

/**
 * Simple tagged logger factory — same API as the original log object
 * but supports multiple tags.
 */
export function createTaggedLogger(defaultLevel: LogLevel = LOG_LEVEL.WARN) {
  let _level = defaultLevel;

  return {
    get level() { return _level; },
    set level(l: LogLevel) { _level = l; },

    debug(tag: string, msg: string, ...args: unknown[]): void {
      if (_level >= 4) console.debug(`[${tag}] ${msg}`, ...args);
    },
    info(tag: string, msg: string, ...args: unknown[]): void {
      if (_level >= 3) console.info(`[${tag}] ${msg}`, ...args);
    },
    warn(tag: string, msg: string, ...args: unknown[]): void {
      if (_level >= 2) console.warn(`[${tag}] ${msg}`, ...args);
    },
    error(tag: string, msg: string, ...args: unknown[]): void {
      if (_level >= 1) console.error(`[${tag}] ${msg}`, ...args);
    },
  };
}
