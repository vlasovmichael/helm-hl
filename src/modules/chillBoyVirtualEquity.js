// ─────────────────────────────────────────────────
//  ChillBoy virtual equity (compound sandbox)
// ─────────────────────────────────────────────────
// Виртуальный «счёт» под shadow-эксперимент: стартует с
// CHILL_BOY_PAPER_VIRTUAL_BALANCE, после каждой закрытой trend_follow
// paper-сделки прибавляется net P&L. Хранится в data/chillboy_virtual.json.
//
// Активен только когда CHILL_BOY_PAPER_VIRTUAL_BALANCE > 0.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const FILE = 'data/chillboy_virtual.json';

let state = null;  // { equity, startEquity, updatedAt, tradesApplied }

function ensureLoaded() {
  if (state) return state;
  const seed = config.trading.chillBoyPaperVirtualBalance;

  if (existsSync(FILE)) {
    try {
      state = JSON.parse(readFileSync(FILE, 'utf8'));
      if (typeof state.equity !== 'number' || !Number.isFinite(state.equity)) {
        throw new Error('corrupt equity field');
      }
    } catch (e) {
      logger.warn(`[ChillBoyVirtual] Failed to load ${FILE} (${e.message}) — re-seeding from $${seed}`);
      state = null;
    }
  }

  if (!state) {
    state = {
      equity:         seed,
      startEquity:    seed,
      updatedAt:      Date.now(),
      tradesApplied:  0,
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
    logger.error(`[ChillBoyVirtual] persist failed: ${e.message}`);
  }
}

export function getVirtualEquity() {
  return ensureLoaded().equity;
}

export function getVirtualEquitySnapshot() {
  const s = ensureLoaded();
  return {
    equity:         s.equity,
    startEquity:    s.startEquity,
    pnlTotal:       s.equity - s.startEquity,
    pnlPct:         s.startEquity > 0 ? (s.equity - s.startEquity) / s.startEquity : 0,
    tradesApplied:  s.tradesApplied,
    updatedAt:      s.updatedAt,
  };
}

export function applyVirtualPnl(netPnl, ctx = {}) {
  const s = ensureLoaded();
  const before = s.equity;
  s.equity        += netPnl;
  s.tradesApplied += 1;
  s.updatedAt      = Date.now();
  persist();
  logger.info(
    `[ChillBoyVirtual] equity $${before.toFixed(2)} → $${s.equity.toFixed(2)} ` +
      `(${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}` +
      (ctx.coin ? ` · ${ctx.coin}` : '') +
      (ctx.reason ? ` · ${ctx.reason}` : '') +
      ')',
  );
}
