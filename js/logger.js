// Logger module — near-zero overhead when disabled
// Levels: 0=OFF, 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG

export const LOG_LEVEL = { OFF: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4 };

let _level = LOG_LEVEL.WARN;

// Fast path: level check short-circuits before any string work
export const log = {
  get level() { return _level; },
  set level(l) { _level = l; },

  debug(tag, msg, ...args) { if (_level >= 4) console.debug(`[${tag}] ${msg}`, ...args); },
  info(tag, msg, ...args)  { if (_level >= 3) console.info(`[${tag}] ${msg}`, ...args); },
  warn(tag, msg, ...args)  { if (_level >= 2) console.warn(`[${tag}] ${msg}`, ...args); },
  error(tag, msg, ...args) { if (_level >= 1) console.error(`[${tag}] ${msg}`, ...args); },
};
