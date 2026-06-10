// ─────────────────────────────────────────────────
//  Setup Scanner — Swing-сигналы (карточка B)
// ─────────────────────────────────────────────────
// План: plans/setup-scanner-signals-plan.md.
//
// ⚠️ Это ИНСТРУМЕНТ (биас/контекст для ручной торговли), НЕ светофор и НЕ
// торговая стратегия. Карточка даёт направление; вход и инвалидацию ставит
// оператор сам. Бот-логику не трогает.
//
// Логика v1 (прозрачная, объяснимая словами):
//   - Направление задаёт ТРЕНД: 4h (главный) + 1h (подтверждение).
//   - OI подтверждает реальность: LONG требует OI↑ при цене↑ за 7д (реальный
//     спрос), SHORT — OI↑ при цене↓ (давят шорты, не short-covering).
//   - Funding = флаг осторожности: LONG блокируется в эйфории (экстрим-плюс),
//     SHORT — в панике (экстрим-минус).
//   - Всё остальное = WAIT (тренды разошлись / OI не подтверждает).
//
// EMA-параметры: 1h = EMA20 vs EMA200 (классика). На 4h — EMA20 vs EMA50:
// покрывает те же ~200 часов, что EMA200@1h, не требует 35 дней истории
// (новые листинги HL) и совпадает с HTF-параметрами Candy Girl → общий
// candleCache не флапает между разными lookback'ами.

import { logger } from '../core/logger.js';
import { getHourlyCandles, getFourHourCandles } from './candleCache.js';
import { emaSeries } from './candyGirlEma.js';

// Lookback'и совпадают с Candy Girl (SLOW+SLOPE+5): кэш свечей переиспользуется.
const TF_1H = { fast: 20, slow: 200, lookbackHours: 215 };
const TF_4H = { fast: 20, slow: 50,  lookbackHours: 240 };

// |APY| > 30 — определение «экстрима», то же что в fundingPersist (database.js).
const FUNDING_EXTREME_APY = 30;

// ── Pure-функции ─────────────────────────────────────────────────────────────

/**
 * Тренд по плану: up = цена>EMAslow И EMAfast>EMAslow; down — зеркало; иначе none.
 * (Без slope-условия classifyTrend из candyGirlEma — для свинг-биаса позиция
 * цены относительно EMA важнее наклона, меньше ложных 'none'.)
 *
 * @param {Array<{close:number}>} candles — oldest→newest
 * @param {{fast:number, slow:number}} params
 * @returns {{trend:'up'|'down'|'none', emaFast:number|null, emaSlow:number|null, reason:string}}
 */
export function classifySwingTrend(candles, { fast, slow }) {
  if (!Array.isArray(candles) || candles.length < slow) {
    return { trend: 'none', emaFast: null, emaSlow: null, reason: 'insufficient_history' };
  }
  const closes = candles.map((c) => c.close);
  const emaFast = emaSeries(closes, fast).at(-1);
  const emaSlow = emaSeries(closes, slow).at(-1);
  const price = closes.at(-1);
  if (emaFast == null || emaSlow == null) {
    return { trend: 'none', emaFast: null, emaSlow: null, reason: 'insufficient_history' };
  }
  if (price > emaSlow && emaFast > emaSlow) return { trend: 'up', emaFast, emaSlow, reason: 'trend_up' };
  if (price < emaSlow && emaFast < emaSlow) return { trend: 'down', emaFast, emaSlow, reason: 'trend_down' };
  return { trend: 'none', emaFast, emaSlow, reason: 'mixed' };
}

const fmtPct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`;

/**
 * Свинг-вердикт по монете. trend4h/trend1h = 'up'|'down'|'none'|null (null =
 * тренд ещё не посчитан, кэш пустой).
 *
 * @param {{trend4h:string|null, trend1h:string|null, oi7d:Object|null, fundingApy:number|null}} x
 * @returns {{signal:'LONG'|'SHORT'|'WAIT', strength:number, reasons:string[]}}
 */
export function scoreSwingSignal({ trend4h, trend1h, oi7d, fundingApy }) {
  const reasons = [];

  if (trend4h == null || trend1h == null) {
    return { signal: 'WAIT', strength: 0, reasons: ['computing trend…'] };
  }

  const arrow = (t) => (t === 'up' ? '↑' : t === 'down' ? '↓' : '−');
  reasons.push(`4h${arrow(trend4h)} 1h${arrow(trend1h)}`);

  const aligned = trend4h !== 'none' && trend4h === trend1h;
  if (!aligned) {
    reasons.push(trend4h === 'none' ? 'no 4h trend' : '4h/1h trends diverge');
    return { signal: 'WAIT', strength: 0, reasons };
  }

  const dir = trend4h; // 'up' | 'down'

  // OI-подтверждение за 7д
  const oiReady = oi7d && oi7d.deltaOi != null;
  let oiConfirm = false;
  if (!oiReady) {
    reasons.push('OI: collecting history');
  } else {
    const { deltaOi, deltaPx } = oi7d;
    const oiStr = `OI ${fmtPct(deltaOi)} / Px ${deltaPx != null ? fmtPct(deltaPx) : '—'} 7d`;
    if (dir === 'up') {
      oiConfirm = deltaOi > 0 && deltaPx != null && deltaPx > 0;
      reasons.push(oiConfirm ? `${oiStr} — real demand` : `${oiStr} — OI doesn't confirm long`);
    } else {
      oiConfirm = deltaOi > 0 && deltaPx != null && deltaPx < 0;
      reasons.push(oiConfirm ? `${oiStr} — shorts pressing` : `${oiStr} — OI doesn't confirm short`);
    }
  }
  if (!oiConfirm) return { signal: 'WAIT', strength: 0, reasons };

  // Funding: флаг осторожности против направления
  if (fundingApy != null) {
    if (dir === 'up' && fundingApy > FUNDING_EXTREME_APY) {
      reasons.push(`funding euphoric (+${fundingApy.toFixed(0)}% APY)`);
      return { signal: 'WAIT', strength: 0, reasons };
    }
    if (dir === 'down' && fundingApy < -FUNDING_EXTREME_APY) {
      reasons.push(`funding panicked (${fundingApy.toFixed(0)}% APY)`);
      return { signal: 'WAIT', strength: 0, reasons };
    }
    reasons.push(`funding ok (${fundingApy >= 0 ? '+' : ''}${fundingApy.toFixed(0)}% APY)`);
  }

  // Сила — для сортировки LONG/SHORT между собой: вес хода цены + роста OI.
  const strength = Math.abs((oi7d.deltaPx ?? 0) * 100) + Math.abs(oi7d.deltaOi * 50);
  return { signal: dir === 'up' ? 'LONG' : 'SHORT', strength, reasons };
}

// ── Trend-кэш + фоновое обновление ───────────────────────────────────────────
// Дашборд поллит /api/setup-scanner раз в 60с. Ответ всегда мгновенный: отдаём
// кэш, stale-монеты обновляем в фоне (concurrency 3, поверх TTL-кэша свечей).

const TREND_TTL_MS = 10 * 60_000;
const trendCache = new Map(); // coin → { ts, t1h, t4h }
let refreshInflight = null;

async function refreshCoin(coin, now) {
  try {
    const [c1h, c4h] = await Promise.all([
      getHourlyCandles(coin, TF_1H.lookbackHours, now),
      getFourHourCandles(coin, TF_4H.lookbackHours, now),
    ]);
    trendCache.set(coin, {
      ts: Date.now(),
      t1h: classifySwingTrend(c1h ?? [], TF_1H),
      t4h: classifySwingTrend(c4h ?? [], TF_4H),
    });
  } catch (err) {
    logger.warn(`[SetupSwing] #${coin} trend refresh failed: ${err.message}`);
  }
}

/** Фоновое обновление трендов для stale-монет. Не блокирует ответ API. */
export function requestSwingTrendRefresh(coins, now = Date.now()) {
  if (refreshInflight) return refreshInflight;
  const stale = coins.filter((c) => {
    const t = trendCache.get(c);
    return !t || now - t.ts > TREND_TTL_MS;
  });
  if (!stale.length) return null;

  refreshInflight = (async () => {
    const CONCURRENCY = 3;
    for (let i = 0; i < stale.length; i += CONCURRENCY) {
      await Promise.all(stale.slice(i, i + CONCURRENCY).map((c) => refreshCoin(c, now)));
    }
  })().finally(() => {
    refreshInflight = null;
  });
  return refreshInflight;
}

/**
 * Обогащает строки getSetupScannerRows() свинг-сигналом. Синхронно: тренды из
 * кэша (null пока не посчитаны), refresh уходит в фон.
 *
 * @param {Array<Object>} rows
 * @returns {Array<Object>} rows + { swing: { signal, strength, reasons, trend4h, trend1h, pending } }
 */
export function enrichSwingSignals(rows, now = Date.now()) {
  requestSwingTrendRefresh(rows.map((r) => r.coin), now);
  return rows.map((r) => {
    const t = trendCache.get(r.coin);
    const trend4h = t?.t4h?.trend ?? null;
    const trend1h = t?.t1h?.trend ?? null;
    const scored = scoreSwingSignal({ trend4h, trend1h, oi7d: r.oi7d, fundingApy: r.fundingApy });
    return { ...r, swing: { ...scored, trend4h, trend1h, pending: !t } };
  });
}

/** Сброс кэша (тесты). */
export function clearSwingTrendCache() {
  trendCache.clear();
}
