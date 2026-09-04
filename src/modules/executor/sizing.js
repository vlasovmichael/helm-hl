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
 * Разница видна только когда часть депо уже занята (free < equity): размер
 * остаётся «util от всего депо» и не ужимается дважды, но за свободную маржу
 * не выходит.
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

/**
 * Бюджет входа от полного депо + решение «стоит ли вообще открывать».
 *
 * intended  = нормальный размер бота (equity × util × lev) — что он взял бы на
 *             пустом депо.
 * available = реально доступный размер с потолком по свободной марже.
 * ok        = available ≥ intended × minFraction. Не привязано к $: масштабируется
 *             под депо. Когда свободного мало (занят ручными позами), доступный
 *             размер падает — и ниже доли minFraction бот ЖДЁТ, а не лезет пылью.
 *
 * @returns {{ available:number, intended:number, ok:boolean }}
 */
export function sizeBudgetFromEquity(free, equity, util, leverage, minFraction, safety = 0.97) {
  const intended  = Math.max(0, equity * util * leverage);
  const available = equityCappedNotional(free, equity, util, leverage, safety);
  const ok = intended > 0 && available >= intended * minFraction;
  return { available, intended, ok };
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
