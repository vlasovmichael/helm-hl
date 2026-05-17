// ─────────────────────────────────────────────────
//  Entry sizing — выбор balance-based vs risk-based
// ─────────────────────────────────────────────────

import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { calcSize, calcRiskSize } from './math.js';

/**
 * Выбирает размер входа: старый balance-based (size = capBase × capUtil)
 * либо risk-based (size = equity × RISK_PCT / стоп-дистанция).
 *
 * Управление флагами (config.trading):
 *  - riskBasedSizing=false → всегда balance-based (поведение по умолчанию).
 *  - riskBasedSizing=true, riskSizingShadow=true → считает risk-size, ЛОГИРУЕТ
 *    сравнение, но возвращает balance-size (торговля не меняется).
 *  - riskBasedSizing=true, riskSizingShadow=false → возвращает risk-size.
 *
 * Risk-based требует валидный SL; без него (carry, кривой sl) — молча
 * откатывается на balance-based.
 *
 * @param {object} p
 * @param {string} p.coin
 * @param {string} p.tag        — лейбл стратегии для лога ('ChillBoy' и т.п.)
 * @param {number} p.equity     — реальный баланс (база для risk $, БЕЗ leverage)
 * @param {number} p.capBase    — база потолка (balance в PAPER, balance×lev в PROD)
 * @param {number} p.capUtil    — доля capBase = потолок размера
 * @param {number} p.price
 * @param {number} p.sl
 * @param {number} p.szDecimals
 * @returns {{ sizeUsd: number, sz: number, tooSmall: boolean }}
 */
export function resolveEntrySize({ coin, tag, equity, capBase, capUtil, price, sl, szDecimals }) {
  const { riskBasedSizing, riskSizingShadow, riskPctPerTrade } = config.trading;
  const balanceBased = calcSize(capBase, price, szDecimals, capUtil);

  const slValid = Number.isFinite(sl) && sl > 0 && Math.abs(price - sl) / price > 0;
  if (!riskBasedSizing || !slValid) {
    return balanceBased;
  }

  const capUsd    = capBase * capUtil;
  const riskBased = calcRiskSize(equity, price, sl, szDecimals, riskPctPerTrade, capUsd);

  if (riskSizingShadow) {
    logger.info(
      `[RiskSizing SHADOW] [${tag}] #${coin} — balance-size $${balanceBased.sizeUsd.toFixed(2)} ` +
        `→ risk-size $${riskBased.sizeUsd.toFixed(2)} ` +
        `(stop ${(riskBased.stopDistPct * 100).toFixed(2)}%, risk $${(equity * riskPctPerTrade).toFixed(2)})`,
    );
    return balanceBased;
  }
  return riskBased;
}
