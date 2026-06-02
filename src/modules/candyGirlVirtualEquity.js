// ─────────────────────────────────────────────────
//  Candy Girl virtual equity (compound sandbox)
// ─────────────────────────────────────────────────
// Виртуальный «счёт» под Iter 2 paper-слот Candy Girl: стартует с
// CANDY_GIRL_PAPER_VIRTUAL_BALANCE, после каждой закрытой candy_girl paper-сделки
// прибавляется net P&L. Хранится в data/candy_virtual.json. Зеркало
// chillBoyVirtualEquity.js. План: memory/candy_girl_strategy_plan.md.
//
// Активен только когда CANDY_GIRL_PAPER_VIRTUAL_BALANCE > 0.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const FILE = 'data/candy_virtual.json';

let state = null;  // { equity, startEquity, updatedAt, tradesApplied }

function ensureLoaded() {
  if (state) return state;
  const seed = config.trading.candyGirlPaperVirtualBalance;

  if (existsSync(FILE)) {
    try {
      state = JSON.parse(readFileSync(FILE, 'utf8'));
      if (typeof state.equity !== 'number' || !Number.isFinite(state.equity)) {
        throw new Error('corrupt equity field');
      }
    } catch (e) {
      logger.warn(`[CandyGirlVirtual] Failed to load ${FILE} (${e.message}) — re-seeding from $${seed}`);
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
    logger.error(`[CandyGirlVirtual] persist failed: ${e.message}`);
  }
}

export function getCandyGirlVirtualEquity() {
  return ensureLoaded().equity;
}

export function getCandyGirlVirtualEquitySnapshot() {
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

export function applyCandyGirlVirtualPnl(netPnl, ctx = {}) {
  const s = ensureLoaded();
  const before = s.equity;
  s.equity        += netPnl;
  s.tradesApplied += 1;
  s.updatedAt      = Date.now();
  persist();
  logger.info(
    `[CandyGirlVirtual] equity $${before.toFixed(2)} → $${s.equity.toFixed(2)} ` +
      `(${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}` +
      (ctx.coin ? ` · ${ctx.coin}` : '') +
      (ctx.reason ? ` · ${ctx.reason}` : '') +
      ')',
  );
}

/** Тестовый хук: сброс in-memory state (re-load из файла/seed на следующем вызове). */
export function _resetCandyGirlVirtualEquityForTest() {
  state = null;
}
