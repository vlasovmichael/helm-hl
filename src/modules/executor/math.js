// ─────────────────────────────────────────────────
//  Executor Math — чистые функции без side effects
// ─────────────────────────────────────────────────
// Нет зависимостей от проекта. Тестируемы в изоляции.

// ── Торговые константы ─────────────────────────
export const FEE_RATE            = 0.0002;   // 0.02% taker
export const MAKER_FEE_RATE      = 0.00003;  // 0.003% maker (HL baseline tier, 0.3 bps)
export const SLIPPAGE            = 0.0001;   // 0.01%
export const ONE_LEG             = FEE_RATE + SLIPPAGE;  // 0.03% за одну сторону
export const BALANCE_UTILIZATION = 0.95;     // 95% от баланса (carry/fade)
// Hunter utilization вынесен в config (HUNTER_BALANCE_UTILIZATION /
// HUNTER_LONG_BALANCE_UTILIZATION) — SHORT и Long тюнятся раздельно.
export const MIN_ORDER_USD       = 11;       // Hyperliquid min ~$10, с запасом
export const MARKET_SLIPPAGE     = 0.03;     // 3% потолок IoC
export const SLIPPAGE_WARN_PCT   = 0.5;      // предупреждение
export const SLIPPAGE_BAN_PCT    = 1.5;      // бан

// ── Reconciliation ─────────────────────────────
export const RECONCILIATION_TOLERANCE_PCT = 2.0;
export const RECONCILE_INITIAL_DELAY_MS   = 3_000;
export const RECONCILE_MAX_RETRIES        = 10;
// Exponential backoff: 1с → 2с → 4с → 8с → 16с (cap).
// Сумма всех ожиданий между 10 попытками: 1+2+4+8+16+16+16+16+16 = 95с (~1.5 мин).
export const RECONCILE_BACKOFF_BASE_MS    = 1_000;
export const RECONCILE_BACKOFF_CAP_MS     = 16_000;

/**
 * Округление вниз до заданного числа десятичных знаков.
 * Важно: всегда floor, никогда ceil — иначе "Insufficient margin".
 */
export function roundDown(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.floor(value * factor) / factor;
}

/**
 * Приводит цену к формату Hyperliquid:
 *   1) ≤ 5 значащих цифр
 *   2) ≤ (MAX_DECIMALS − szDecimals) десятичных знаков (MAX_DECIMALS=6 для перпов)
 *   3) Integer цены разрешены всегда.
 *
 * Использовать для триггер-цен SL/TP в `placeOrder` — иначе биржа отвечает
 * "Order has invalid price" на низкопрайсовых монетах (REZ инцидент 2026-05-11
 * где `entry * 1.02` давало 7 значащих цифр).
 *
 * @param {number} price
 * @param {number} szDecimals — sz-decimals из universe для этой монеты
 * @param {number} [maxDecimals=6] — 6 для перпов, 8 для спота
 * @returns {number}
 */
export function formatHlPrice(price, szDecimals, maxDecimals = 6) {
  if (!Number.isFinite(price) || price <= 0) return price;
  if (Number.isInteger(price)) return price;

  const SIG_FIGS  = 5;
  const maxDp     = Math.max(0, maxDecimals - szDecimals);
  const magnitude = Math.floor(Math.log10(Math.abs(price)));
  const sigFactor = Math.pow(10, SIG_FIGS - 1 - magnitude);
  let rounded     = Math.round(price * sigFactor) / sigFactor;

  const dpFactor  = Math.pow(10, maxDp);
  rounded         = Math.round(rounded * dpFactor) / dpFactor;
  return rounded;
}

/**
 * Расчёт размера позиции.
 * @param {number} balance  — свободный баланс
 * @param {number} price    — текущая цена
 * @param {number} szDecimals — кол-во десятичных знаков для округления
 * @param {number} [utilization=BALANCE_UTILIZATION] — доля баланса к использованию
 *   (0.95 для carry/fade; hunter — config.trading.hunterBalanceUtil/hunterLongBalanceUtil).
 * @returns {{ sizeUsd: number, sz: number, tooSmall: boolean }}
 */
export function calcSize(balance, price, szDecimals, utilization = BALANCE_UTILIZATION) {
  const sizeUsd = balance * utilization;
  if (sizeUsd < MIN_ORDER_USD) {
    return { sizeUsd, sz: 0, tooSmall: true };
  }
  const sz = roundDown(sizeUsd / price, szDecimals);
  return { sizeUsd, sz, tooSmall: sz <= 0 };
}

/**
 * Risk-based размер позиции: считается от расстояния до стопа, чтобы лосс по SL
 * стоил фиксированную долю эквити независимо от монеты (узкий стоп → больше
 * позиция, широкий → меньше).
 *
 *   riskUsd     = equity × riskPct
 *   stopDistPct = |price − sl| / price
 *   sizeUsd     = clamp(riskUsd / stopDistPct, MIN_ORDER_USD, capUsd)
 *
 * @param {number} equity     — реальный баланс (база для risk $, БЕЗ leverage)
 * @param {number} price      — цена входа
 * @param {number} sl         — stop-loss price
 * @param {number} szDecimals — округление sz
 * @param {number} riskPct    — доля эквити под риском (0.01 = 1%)
 * @param {number} capUsd     — потолок размера в USD
 * @returns {{ sizeUsd: number, sz: number, tooSmall: boolean, stopDistPct: number }}
 */
export function calcRiskSize(equity, price, sl, szDecimals, riskPct, capUsd) {
  const stopDistPct = Math.abs(price - sl) / price;
  if (!Number.isFinite(stopDistPct) || stopDistPct <= 0) {
    return { sizeUsd: 0, sz: 0, tooSmall: true, stopDistPct: 0 };
  }
  let sizeUsd = (equity * riskPct) / stopDistPct;
  if (sizeUsd > capUsd) sizeUsd = capUsd;
  if (sizeUsd < MIN_ORDER_USD) {
    return { sizeUsd, sz: 0, tooSmall: true, stopDistPct };
  }
  const sz = roundDown(sizeUsd / price, szDecimals);
  return { sizeUsd, sz, tooSmall: sz <= 0, stopDistPct };
}

/**
 * Множитель размера позиции по реализованной волатильности.
 * VolIdx = stddev/mean closes за 15 мин (coefficient of variation из volatility.js).
 *
 * Формула: clamp(1 − volIdx × penalty, minMult, 1).
 *   penalty=50, minMult=0.4:
 *     volIdx=0.003 (calm)  → ×1.00
 *     volIdx=0.008 (mid)   → ×0.60
 *     volIdx=0.015 (hot)   → ×0.40 (floor)
 *
 * Применяется к carry на open, чтобы lose-trade на VVV-классе монет не съедал
 * несколько win-trades. См. memory + история сделок 2026-05-13.
 *
 * @param {number} volIdx
 * @param {number} penalty
 * @param {number} minMult
 * @returns {number} multiplier in [minMult, 1]
 */
export function calcVolSizeMultiplier(volIdx, penalty, minMult) {
  if (!Number.isFinite(volIdx) || volIdx <= 0) return 1;
  const raw = 1 - volIdx * penalty;
  return Math.max(minMult, Math.min(1, raw));
}

/**
 * Вычисляет фактическое проскальзывание.
 * Чистая функция — НЕ пишет в state, НЕ логирует.
 *
 * Для SELL (short open): slippage = (expected - fill) / expected
 * Для BUY  (close short): slippage = (fill - expected) / expected
 *
 * @param {number} expectedPrice — markPrice из сигнала
 * @param {number} fillPrice     — avgPx из fill
 * @param {string} side          — "SELL" или "BUY"
 * @returns {{ pct: number, absPct: number, warn: boolean, ban: boolean, label: string }}
 */
export function checkSlippage(expectedPrice, fillPrice, side) {
  let pct;
  if (side === "SELL") {
    pct = ((expectedPrice - fillPrice) / expectedPrice) * 100;
  } else {
    pct = ((fillPrice - expectedPrice) / expectedPrice) * 100;
  }

  const absPct = Math.abs(pct);
  const sign   = pct >= 0 ? "+" : "";
  const label  = `${sign}${pct.toFixed(3)}%`;

  return {
    pct,
    absPct,
    warn: absPct > SLIPPAGE_WARN_PCT,
    ban:  absPct > SLIPPAGE_BAN_PCT,
    label,
  };
}

/**
 * Чистый расчёт PnL/комиссий для PAPER-закрытия.
 * Нет pricePnl (в paper-режиме цена закрытия условна).
 * @param {Object} position — {size_usd, entry_apy}
 * @param {number} holdHours
 * @param {number} [exitFeeRate=ONE_LEG] — ставка комиссии выхода (ONE_LEG для market, MAKER_FEE_RATE для maker-fill)
 * @returns {{ fundingPnl: number, totalFee: number, realizedPnl: number }}
 */
export function calcPaperClose(position, holdHours, exitFeeRate = ONE_LEG) {
  // entry_apy сохраняется как abs (см. paper.js / production.js на open):
  // carry-edge всегда положительный, направление задаёт position.side.
  // Math.abs здесь — страховка для исторических записей и тестов с подписанным значением.
  const hourlyRate = Math.abs(position.entry_apy) / 100 / 365 / 24;
  const fundingPnl = position.size_usd * hourlyRate * holdHours;
  // Вход всегда ONE_LEG (taker+slippage), выход — по exitFeeRate.
  const totalFee   = position.size_usd * (ONE_LEG + exitFeeRate);
  return { fundingPnl, totalFee, realizedPnl: fundingPnl - totalFee };
}

/**
 * PnL при закрытии позиции.
 *
 * @param {Object} position   — строка из БД (size_usd, entry_price, entry_apy)
 * @param {number} fillPrice  — цена закрытия (avgPx или markPrice)
 * @param {number} holdHours  — время удержания в часах
 * @param {number|null} [realFundingUsd=null] — реальный накопленный фандинг с биржи
 *   (cumFunding.sinceOpen инвертированный для shorts). Если null/NaN — fallback
 *   на оценку через entry_apy.
 * @returns {{ pricePnl: number, fundingPnl: number, totalFee: number, realizedPnl: number, fundingSource: string }}
 */
export function calcPnl(position, fillPrice, holdHours, realFundingUsd = null, exitFeeRate = FEE_RATE) {
  // Side-aware pricePnl. short: (entry−fill); long: (fill−entry). Берём из
  // position.side, дефолт 'short' для исторических записей.
  const side = position.side || 'short';
  const priceDelta = side === 'long'
    ? fillPrice - position.entry_price
    : position.entry_price - fillPrice;
  const pricePnl   = (position.size_usd * priceDelta) / position.entry_price;

  let fundingPnl;
  let fundingSource;
  if (realFundingUsd != null && Number.isFinite(realFundingUsd)) {
    // Hyperliquid cumFunding.sinceOpen: отрицательный когда трейдер получал
    // фандинг (для shorts при положительной ставке, для longs при отрицательной).
    // Формула realFundingUsd = -sinceOpen side-agnostic — высчитывается выше.
    fundingPnl    = realFundingUsd;
    fundingSource = 'cumFunding';
  } else {
    // Fallback estimate: carry-edge всегда положительный (entry_apy сохраняется
    // как abs), направление задаёт side; для carry оба side зарабатывают
    // funding на open-снимке.
    const hourlyRate = Math.abs(position.entry_apy) / 100 / 365 / 24;
    fundingPnl    = position.size_usd * hourlyRate * holdHours;
    fundingSource = 'estimate';
  }

  // Вход всегда taker (FEE_RATE), выход — по exitFeeRate (FEE_RATE для market, MAKER_FEE_RATE для maker-fill).
  const totalFee    = position.size_usd * (FEE_RATE + exitFeeRate);
  const realizedPnl = pricePnl + fundingPnl - totalFee;

  return { pricePnl, fundingPnl, totalFee, realizedPnl, fundingSource };
}
