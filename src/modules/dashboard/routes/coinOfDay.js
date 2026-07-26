// ─────────────────────────────────────────────────
//  Монета дня — JSON для карточки на /oi.html
// ─────────────────────────────────────────────────
// Скан идёт по снапшоту рынка, который бот и так поллит (state.latestHunter),
// свечи тянутся только для 6 кандидатов с LOW-приоритетом. Результат кэшируется
// на 5 минут: карточка живая, но открытие страницы не устраивает шторм
// candleSnapshot (грабли 429 / голодания пула HL).
//
// Побочный эффект скана — запись пиков в форвард-лог (logScanPicks).
// Идемпотентна: PK date+coin, первое срабатывание за сутки выигрывает.

import { state } from '../../../app/state.js';
import { logger } from '../../../core/logger.js';
import { scanCoinOfDay, COD } from '../../coinOfDay.js';
import { logScanPicks, buildForwardStats } from '../../coinOfDayLog.js';

const TTL_MS = 5 * 60_000;
let cache = { payload: null, at: 0, inflight: null };

async function build(now) {
  const scan = await scanCoinOfDay(state.latestHunter, now);
  try {
    logScanPicks(scan, now);
  } catch (err) {
    logger.warn(`[CoinOfDay] forward log failed: ${err.message}`);
  }
  return {
    ...scan,
    marketAgeSec: state.latestHunterAt ? Math.round((now - state.latestHunterAt) / 1000) : null,
    thresholds: COD,
    forward: buildForwardStats(),
  };
}

export async function handleCoinOfDay(req, res) {
  const now = Date.now();
  const force = req.query?.refresh === '1';
  try {
    if (!force && cache.payload && now - cache.at < TTL_MS) {
      return res.json({ ...cache.payload, cached: true, ageSec: Math.round((now - cache.at) / 1000) });
    }
    // Параллельные открытия страницы не должны запускать несколько сканов.
    if (cache.inflight) {
      const payload = await cache.inflight;
      return res.json({ ...payload, cached: true, ageSec: 0 });
    }
    cache.inflight = build(now);
    const payload = await cache.inflight;
    cache = { payload, at: Date.now(), inflight: null };
    res.json({ ...payload, cached: false, ageSec: 0 });
  } catch (err) {
    cache.inflight = null;
    logger.warn(`[CoinOfDay] scan failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}
