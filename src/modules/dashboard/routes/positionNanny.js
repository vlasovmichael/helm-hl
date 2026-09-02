// ─────────────────────────────────────────────────
//  Нянька — JSON для панели открытых позиций на /oi.html
// ─────────────────────────────────────────────────
// Заменила /api/coin-of-day (генератор входов «Монета дня» снят 29.08.2026 —
// причины в шапке src/modules/positionNanny.js).
//
// Ни одного запроса свечей: панель читает только позиции, ордера и цены —
// всё коалесцированное и уже поллится ботом. Поэтому TTL короткий (30с, а не
// 5 минут как у скана): данные про защиту позиции обязаны быть свежими, а
// стоить они почти ничего не стоят.

import { logger } from '../../../core/logger.js';
import { getPositionsCached, getFrontendOpenOrders, getLivePriceMap } from '../../exchange.js';
import { buildNannyView } from '../../positionNanny.js';
import { getBuilderPositions } from '../../builderPositions.js';

const TTL_MS = 30_000;
let cache = { payload: null, at: 0, inflight: null };

/**
 * COIN → позиция оператора. Источник правды — биржа, а не БД: позиция может быть
 * ещё не усыновлена adopt'ом, но она уже открыта, и нянька обязана её видеть.
 */
async function loadPositions() {
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
}

async function loadPrices() {
  const map = new Map();
  try {
    const live = await getLivePriceMap();
    for (const [coin, px] of Object.entries(live || {})) {
      const n = parseFloat(px);
      if (Number.isFinite(n) && n > 0) map.set(coin.toUpperCase(), n);
    }
  } catch (err) {
    logger.debug(`[Nanny] price map failed: ${err.message}`);
  }
  return map;
}

async function build(now) {
  const [positions, prices] = await Promise.all([loadPositions(), loadPrices()]);

  // Ордера читаем отдельно и НЕ роняем панель, если чтение не удалось:
  // «не знаю, защищена ли позиция» — это отдельный статус, а не пустой экран.
  let orders = [];
  let ordersKnown = true;
  try {
    orders = await getFrontendOpenOrders();
  } catch (err) {
    ordersKnown = false;
    logger.warn(`[Nanny] open orders read failed: ${err.message}`);
  }

  const view = buildNannyView({ positions, prices, orders, ordersKnown, now });

  // Позиции на builder-DEX'ах (HIP-3) идут ОТДЕЛЬНЫМ блоком: бот их не ведёт,
  // плана у них нет по определению. Отказ чтения не роняет панель — основные
  // позиции важнее, чем полнота по площадкам.
  try {
    view.builder = await getBuilderPositions();
  } catch (err) {
    view.builder = { error: err.message };
    logger.debug(`[Nanny] builder-dex read failed: ${err.message}`);
  }
  return view;
}

export async function handlePositionNanny(req, res) {
  const now = Date.now();
  const force = req.query?.refresh === '1';
  try {
    if (!force && cache.payload && now - cache.at < TTL_MS) {
      return res.json({ ...cache.payload, cached: true, ageSec: Math.round((now - cache.at) / 1000) });
    }
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
    logger.warn(`[Nanny] build failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}
