// ─────────────────────────────────────────────────
//  Fader virtual equity (compound sandbox)
// ─────────────────────────────────────────────────
// Виртуальный счёт под Fader (Strategy #5) — мирная копия chillBoyVirtualEquity.
// Стартует с FADER_VIRTUAL_BALANCE, после каждой закрытой fader paper-сделки
// прибавляется net P&L (после модельных fees+slippage). Хранится в
// data/fader_virtual.json. Активен только когда FADER_VIRTUAL_BALANCE > 0.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const FILE = 'data/fader_virtual.json';

let state = null;

function ensureLoaded() {
  if (state) return state;
  const seed = config.trading.faderVirtualBalance;

  if (existsSync(FILE)) {
    try {
      state = JSON.parse(readFileSync(FILE, 'utf8'));
      if (typeof state.equity !== 'number' || !Number.isFinite(state.equity)) {
        throw new Error('corrupt equity field');
      }
    } catch (e) {
      logger.warn(`[FaderVirtual] Failed to load ${FILE} (${e.message}) — re-seeding from $${seed}`);
      state = null;
    }
  }

  if (!state) {
    state = {
      equity:        seed,
      startEquity:   seed,
      updatedAt:     Date.now(),
      tradesApplied: 0,
    };
    persist();
  }

  return state;
}

function persist() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    logger.error(`[FaderVirtual] persist failed: ${e.message}`);
  }
}

export function getFaderVirtualEquity() {
  return ensureLoaded().equity;
}

export function getFaderVirtualSnapshot() {
  const s = ensureLoaded();
  return {
    equity:        s.equity,
    startEquity:   s.startEquity,
    pnlTotal:      s.equity - s.startEquity,
    pnlPct:        s.startEquity > 0 ? (s.equity - s.startEquity) / s.startEquity : 0,
    tradesApplied: s.tradesApplied,
    updatedAt:     s.updatedAt,
  };
}

export function applyFaderVirtualPnl(netPnl, ctx = {}) {
  const s = ensureLoaded();
  const before = s.equity;
  s.equity        += netPnl;
  s.tradesApplied += 1;
  s.updatedAt      = Date.now();
  persist();
  logger.info(
    `[FaderVirtual] equity $${before.toFixed(2)} → $${s.equity.toFixed(2)} ` +
      `(${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}` +
      (ctx.coin ? ` · ${ctx.coin}` : '') +
      (ctx.reason ? ` · ${ctx.reason}` : '') +
      ')',
  );
}
