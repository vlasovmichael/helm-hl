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
import { getPositionsCached } from '../../exchange.js';
import { getCoinOfDayPicks, getHistorySince } from '../../../core/database.js';
import { scanCoinOfDay, COD } from '../../coinOfDay.js';
import { logScanPicks, buildForwardStats, warsawDate } from '../../coinOfDayLog.js';

const TTL_MS = 5 * 60_000;
let cache = { payload: null, at: 0, inflight: null };

/**
 * COIN → позиция оператора. Источник правды — биржа (getPositionsCached, тот же
 * коалесцированный clearinghouseState, что читают integrity/reconcile), а не БД:
 * позиция может быть ещё не усыновлена adopt'ом, но она уже есть, и карточка
 * обязана её видеть.
 */
async function loadPositions() {
  try {
    const raw = await getPositionsCached();
    const map = new Map();
    for (const ap of raw || []) {
      const p = ap?.position;
      const szi = parseFloat(p?.szi ?? NaN);
      if (!p?.coin || !Number.isFinite(szi) || szi === 0) continue;
      map.set(p.coin.toUpperCase(), {
        side: szi < 0 ? 'SHORT' : 'LONG',
        entryPx: parseFloat(p.entryPx),
        szi,
        notionalUsd: Math.abs(parseFloat(p.positionValue ?? 0)),
        unrealizedPnl: parseFloat(p.unrealizedPnl ?? 0),
      });
    }
    return map;
  } catch (err) {
    logger.debug(`[CoinOfDay] positions read failed: ${err.message}`);
    return new Map();
  }
}

/** COIN → пик карточки за сегодня (чтобы сверить позицию с планом входа). */
function loadTodayPicks(now) {
  const date = warsawDate(now);
  const map = new Map();
  for (const r of getCoinOfDayPicks(60)) {
    if (r.date === date) map.set(r.coin.toUpperCase(), r);
  }
  return map;
}

/**
 * COIN → итог дня по РЕАЛЬНЫМ сделкам (закрытым сегодня). Нужен, чтобы карточка
 * не предлагала повторный вход в монету, которую оператор сегодня уже отторговал.
 * manual_paper исключён: бумажный журнал не расходует дневной лимит по монете.
 * Границу дня берём по Варшаве — те же сутки, что у форвард-лога и day_journal.
 */
function loadTradedToday(now) {
  const date = warsawDate(now);
  const start = new Date(`${date}T00:00:00`).getTime();
  const map = new Map();
  for (const t of getHistorySince(start)) {
    if (!t?.coin || t.strategy_id === 'manual_paper') continue;
    const c = t.coin.toUpperCase();
    const prev = map.get(c) || { pnl: 0, count: 0, lastCloseAt: 0, side: null };
    prev.pnl += t.realized_pnl ?? 0;
    prev.count += 1;
    if (t.closed_at > prev.lastCloseAt) {
      prev.lastCloseAt = t.closed_at;
      prev.side = (t.side || '').toUpperCase() || null;
    }
    map.set(c, prev);
  }
  return map;
}

async function build(now) {
  const positions = await loadPositions();
  const picks = loadTodayPicks(now);
  const tradedToday = loadTradedToday(now);
  const scan = await scanCoinOfDay(state.latestHunter, now, { positions, picks, tradedToday });
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
