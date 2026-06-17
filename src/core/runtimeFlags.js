// Runtime flag overrides — applied on top of env-based config without restart.
// Persisted to data/runtime_flags.json so flags survive container restarts.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { logger } from './logger.js';

const FLAGS_PATH = 'data/runtime_flags.json';

const DEFAULTS = {
  paused:     false,   // true = no new entries (exits still managed)
  hunter:     null,    // null = follow env; true/false = explicit override
  hunterLong: null,
  chillBoy:   null,
};

let _flags = { ...DEFAULTS };

try {
  if (existsSync(FLAGS_PATH)) {
    _flags = { ...DEFAULTS, ...JSON.parse(readFileSync(FLAGS_PATH, 'utf8')) };
    const active = Object.entries(_flags).filter(([k, v]) => v !== DEFAULTS[k]);
    if (active.length) {
      logger.info(`[RuntimeFlags] Loaded overrides: ${active.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
  }
} catch (err) {
  logger.warn(`[RuntimeFlags] Failed to load ${FLAGS_PATH}: ${err.message}`);
}

function persist() {
  try {
    writeFileSync(FLAGS_PATH, JSON.stringify(_flags, null, 2));
  } catch (err) {
    logger.warn(`[RuntimeFlags] Save failed: ${err.message}`);
  }
}

export function getFlags() {
  return { ..._flags };
}

export function setFlag(key, value) {
  _flags[key] = value;
  persist();
  logger.info(`[RuntimeFlags] Set ${key} = ${value}`);
}

export function isPaused() {
  return _flags.paused === true;
}

// Returns effective bool: runtime override (if set) otherwise config default.
export function isEnabled(key, configDefault) {
  const v = _flags[key];
  return (v !== null && v !== undefined) ? Boolean(v) : configDefault;
}
