// ─────────────────────────────────────────────────
//  Executor Math — чистые функции без side effects
// ─────────────────────────────────────────────────
// Нет зависимостей от проекта. Тестируемы в изоляции.

// ── Торговые константы ─────────────────────────
export const FEE_RATE            = 0.0002;   // 0.02% taker
export const SLIPPAGE            = 0.0001;   // 0.01%
export const ONE_LEG             = FEE_RATE + SLIPPAGE;  // 0.03% за одну сторону
export const BALANCE_UTILIZATION = 0.95;     // 95% от баланса
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
 * Расчёт размера позиции.
 * @param {number} balance  — свободный баланс
 * @param {number} price    — текущая цена
 * @param {number} szDecimals — кол-во десятичных знаков для округления
 * @returns {{ sizeUsd: number, sz: number, tooSmall: boolean }}
 */
export function calcSize(balance, price, szDecimals) {
  const sizeUsd = balance * BALANCE_UTILIZATION;
  if (sizeUsd < MIN_ORDER_USD) {
    return { sizeUsd, sz: 0, tooSmall: true };
  }
  const sz = roundDown(sizeUsd / price, szDecimals);
  return { sizeUsd, sz, tooSmall: sz <= 0 };
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
export function calcPnl(position, fillPrice, holdHours, realFundingUsd = null) {
  const pricePnl   = (position.size_usd * (position.entry_price - fillPrice)) / position.entry_price;

  let fundingPnl;
  let fundingSource;
  if (realFundingUsd != null && Number.isFinite(realFundingUsd)) {
    fundingPnl    = realFundingUsd;
    fundingSource = 'cumFunding';
  } else {
    const hourlyRate = position.entry_apy / 100 / 365 / 24;
    fundingPnl    = position.size_usd * hourlyRate * holdHours;
    fundingSource = 'estimate';
  }

  const totalFee    = position.size_usd * FEE_RATE * 2;
  const realizedPnl = pricePnl + fundingPnl - totalFee;

  return { pricePnl, fundingPnl, totalFee, realizedPnl, fundingSource };
}
