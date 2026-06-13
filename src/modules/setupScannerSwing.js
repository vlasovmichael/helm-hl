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

// Entry-зона: где цена относительно 1h EMA20 (зоны отката). Отвечает на
// «можно прямо сейчас?»: zone = цена откатила к EMA20, ищи вход по тренду;
// extended = растянута от EMA — гнаться поздно, жди отката; mid = между.
// Таймингом входа (5m reclaim) НЕ занимается — это работа оператора/Candy Girl.
const ENTRY_ZONE_PCT     = 0.5; // |ext| ≤ 0.5% от EMA20 (или откат за неё) = зона
const ENTRY_EXTENDED_PCT = 2.5; // растяжка ≥ 2.5% по тренду = chase

/**
 * @param {'LONG'|'SHORT'|'WAIT'} signal
 * @param {number|null} extPct — (price − ema20_1h) / ema20_1h × 100
 * @returns {'zone'|'mid'|'extended'|null} null для WAIT/нет данных
 */
export function classifyEntryZone(signal, extPct) {
  if (extPct == null || !Number.isFinite(extPct)) return null;
  if (signal === 'LONG') {
    if (extPct <= ENTRY_ZONE_PCT) return 'zone';        // у/ниже EMA20 — откат
    if (extPct >= ENTRY_EXTENDED_PCT) return 'extended'; // улетела вверх — chase
    return 'mid';
  }
  if (signal === 'SHORT') {
    if (extPct >= -ENTRY_ZONE_PCT) return 'zone';
    if (extPct <= -ENTRY_EXTENDED_PCT) return 'extended';
    return 'mid';
  }
  return null;
}

// ── Связка с Candy Girl (слой 5m-тайминга) ───────────────────────────────────
// Свинг даёт направление + зону (1h), Candy Girl — «5m reclaim напечатался».
// Свежий сигнал Candy Girl по той же монете и в ту же сторону = тайминг входа
// созрел. Старше окна / нет сигнала → связки нет (UI покажет «ждём»).
const CANDY_FRESH_MS = 90 * 60_000;

/**
 * Ищет свежее подтверждение Candy Girl для свинг-сигнала.
 *
 * @param {string} coin
 * @param {'LONG'|'SHORT'|'WAIT'} signal — свинг-вердикт
 * @param {Array<{coin:string, direction:string, ts:number}>} candySignals — newest-first
 * @returns {{confirmed:true, ageMin:number}|null}
 */
export function findCandyConfirm(coin, signal, candySignals, now = Date.now(), freshMs = CANDY_FRESH_MS) {
  if (signal !== 'LONG' && signal !== 'SHORT') return null;
  if (!Array.isArray(candySignals)) return null;
  for (const c of candySignals) {            // newest-first: первый матч = самый свежий
    if (c?.coin !== coin) continue;
    if ((c.direction || '').toUpperCase() !== signal) continue;
    const age = now - (c.ts ?? 0);
    return age <= freshMs ? { confirmed: true, ageMin: Math.max(0, Math.round(age / 60_000)) } : null;
  }
  return null;
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
      // close текущей 1h-свечи = почти live-цена (TTL кэша 5 мин) — для Entry-зоны
      px: c1h?.at(-1)?.close ?? null,
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

const SWING_SL_MIN_PCT = 1.2;  // тесный стоп душит свинг
const SWING_SL_MAX_PCT = 8;    // глубже — сетап слишком растянут
const SWING_RR = 2;            // таргет 2R (правило R:R ≥ 2:1)

/**
 * План входа для свинг-сигнала: стоп за 1h slow-EMA (инвалидация тренда),
 * таргет 2R. Зажат в [MIN, MAX]%. Размер позиции НЕ считаем — фронт берёт от
 * живого equity × риск%. null, если сигнал не направленный или нет данных.
 * @returns {{ sl:number, slPct:number, tp:number, tpPct:number, rr:number }|null}
 */
function buildSwingPlan(signal, price, emaSlow) {
  if (signal !== 'LONG' && signal !== 'SHORT') return null;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(emaSlow)) return null;
  const isLong = signal === 'LONG';
  let slPct = isLong ? ((price - emaSlow) / price) * 100 : ((emaSlow - price) / price) * 100;
  // EMA не с той стороны / вплотную → фолбэк на минимальный стоп.
  if (!(slPct > 0) || slPct < SWING_SL_MIN_PCT) slPct = SWING_SL_MIN_PCT;
  if (slPct > SWING_SL_MAX_PCT) slPct = SWING_SL_MAX_PCT;
  const sl = isLong ? price * (1 - slPct / 100) : price * (1 + slPct / 100);
  const tpPct = slPct * SWING_RR;
  const tp = isLong ? price * (1 + tpPct / 100) : price * (1 - tpPct / 100);
  return { sl, slPct, tp, tpPct, rr: SWING_RR };
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
    const ema20 = t?.t1h?.emaFast;
    const ext1h = t?.px != null && ema20 ? ((t.px - ema20) / ema20) * 100 : null;
    const entryZone = classifyEntryZone(scored.signal, ext1h);
    // План входа (стоп/таргет) для сигнала ДО входа: стоп за 1h slow-EMA
    // (инвалидация тренда), таргет 2R. Зажат в [1.2%, 8%]; size считает фронт
    // от equity × риск%. Размер позиции тут НЕ считаем — нужен живой баланс.
    const plan = buildSwingPlan(scored.signal, t?.px, t?.t1h?.emaSlow);
    return { ...r, swing: { ...scored, trend4h, trend1h, ext1h, entryZone, plan, pending: !t } };
  });
}

/** Сброс кэша (тесты). */
export function clearSwingTrendCache() {
  trendCache.clear();
}
