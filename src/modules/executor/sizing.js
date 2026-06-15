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
/**
 * Целевой НОТИОНАЛ от полного депо с потолком по свободной марже.
 *
 *   желаемая маржа = equity(весь депо) × util
 *   потолок маржи  = free(свободно) × safety   (буфер под комиссии/округление)
 *   маржа          = min(желаемая, потолок)
 *   нотионал       = маржа × leverage
 *
 * Когда других позиций нет, free ≈ equity → нотионал = equity × util × lev,
 * т.е. ровно как старый free-based (equity × util × lev при free=equity). Разница
 * включается только когда часть депо уже занята (free < equity): бот держит
 * стабильный размер «util от всего депо», не ужимаясь дважды, но не выходит за
 * свободную маржу. См. memory: hunter sizing from equity.
 *
 * @returns {number} нотионал в USD (0 если нет свободной маржи)
 */
export function equityCappedNotional(free, equity, util, leverage, safety = 0.97) {
  if (!(free > 0) || !(equity > 0)) return 0;
  const desiredMargin = equity * util;
  const marginCap     = free * safety;
  const margin        = Math.min(desiredMargin, marginCap);
  return Math.max(0, margin * leverage);
}

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
