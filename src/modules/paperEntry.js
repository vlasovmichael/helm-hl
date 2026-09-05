// ─────────────────────────────────────────────────
//  Открытие бумажной позы под нянькой — общий путь для руки и для сигнала
// ─────────────────────────────────────────────────
// Рука ('manual_paper') и автомат по сигналу канала ('tg_signal') входят одним
// кодом: разъехавшиеся копии сделали бы два потока несравнимыми.
// План выхода считается на входе и ложится в строку позиции — как у adopt.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { savePosition } from '../core/database.js';
import { getLivePrice } from '../core/priceFeed.js';
import { getLivePriceMap } from './exchange.js';
import { getAccountEquity } from './wallet.js';
import { computeStopDistPct, computeAdoptTp } from '../app/adoptReconcile.js';
import { buildTpGrid } from './tpGrid.js';

/** Свежая цена монеты: WS-фид → fallback на кэш price-map. null если нет. */
export async function resolvePrice(coin) {
  const c = String(coin || '').toUpperCase();
  const live = getLivePrice(c); // {price, ts} | null
  if (live && Number.isFinite(live.price) && live.price > 0) return live.price;
  try {
    const map = await getLivePriceMap(); // Map<coin, px>
    const p = map?.get?.(c);
    if (Number.isFinite(p) && p > 0) return p;
  } catch {
    /* price-map недоступен — вернём null, вызывающий решит */
  }
  return null;
}

/** Депо для слайдера/журнала. 0 при ошибке. */
export async function safeEquity() {
  try {
    const eq = await getAccountEquity();
    return Number.isFinite(eq) && eq > 0 ? eq : 0;
  } catch {
    return 0;
  }
}

/**
 * Выходной план: то же, что adopt выставил бы ордерами. Чистая функция.
 *
 * @param {Object} p
 * @param {'long'|'short'} p.side
 * @param {number} p.entry
 * @param {number} p.stopDistPct — дистанция вход→стоп в %, это и есть 1R
 * @param {number} p.sizeUsd
 * @returns {{slPrice:number, tpPrice:number|null, tpDistPct:number|null,
 *            rungs:Array<{px:number, usd:number, r:number}>}}
 */
export function planPaperExit({ side, entry, stopDistPct, sizeUsd }) {
  const isShort = side === 'short';
  const slPrice = isShort
    ? entry * (1 + stopDistPct / 100)
    : entry * (1 - stopDistPct / 100);

  const t = config.trading;
  const tp = t.adoptTpEnabled
    ? computeAdoptTp({ side, entry, stopDistPct, rr: t.adoptTpRr, maxPct: t.adoptTpMaxPct })
    : null;

  // На бумаге считаем в долларах: контрактов и минимума ордера тут нет.
  const legs = t.adoptTpGridLegs || [];
  const rungs = legs.length
    ? buildTpGrid({ legs, entry, stopDistPct, isShort, sizeSz: sizeUsd })
        .map((r) => ({ px: r.px, usd: r.sz, r: r.r }))
    : [];

  return {
    slPrice,
    tpPrice: tp?.tpPrice ?? null,
    tpDistPct: tp?.distPct ?? null,
    rungs,
  };
}

/**
 * Открыть бумажную позу под нянькой.
 *
 * @param {Object} p
 * @param {string} p.coin
 * @param {'long'|'short'} p.side
 * @param {number} p.sizeUsd — нотионал
 * @param {number} p.leverage
 * @param {string} p.strategyId — 'manual_paper' | 'tg_signal'
 * @param {number} [p.entryPrice] — запасная цена, если фид молчит
 * @param {string} [p.tag] — что писать в лог (источник входа)
 * @returns {Promise<{ok:true, id:number, entryPrice:number, slPrice:number|null,
 *                     tpPrice:number|null, rungs:Array}|{ok:false, error:string}>}
 */
export async function openPaperPosition({
  coin, side, sizeUsd, leverage, strategyId, entryPrice, tag = 'paper',
}) {
  const c = String(coin || '').toUpperCase().replace(/-PERP$/i, '').replace(/^@/, '');
  if (!c) return { ok: false, error: 'coin required' };
  if (side !== 'long' && side !== 'short') return { ok: false, error: 'side must be long|short' };
  if (!(sizeUsd > 0)) return { ok: false, error: 'sizeUsd must be > 0' };

  let price = await resolvePrice(c);
  if (price == null && Number(entryPrice) > 0) price = Number(entryPrice);
  if (price == null) return { ok: false, error: `no live price for ${c}` };

  // Нянька выключена — позу всё равно открываем, но без плана выхода: держать
  // её будет оператор руками, и врать строке позиции про стоп нельзя.
  let plan = { slPrice: null, tpPrice: null, rungs: [] };
  let planLabel = 'no stop (nanny off)';
  if (config.trading.manualPaperAdoptEnabled) {
    try {
      const { distPct, basis } = await computeStopDistPct(c);
      plan = planPaperExit({ side, entry: price, stopDistPct: distPct, sizeUsd });
      planLabel =
        `SL ${plan.slPrice.toPrecision(6)} (−${distPct.toFixed(2)}% ${basis === 'atr' ? 'ATR' : 'fixed'})` +
        (plan.tpPrice ? ` · TP ${plan.tpPrice.toPrecision(6)} (+${plan.tpDistPct.toFixed(2)}%)` : '') +
        (plan.rungs.length ? ` · сетка ${plan.rungs.length} ступ.` : '');
    } catch (err) {
      // Fail-soft: не посчитали стоп — открываем без него, мягкий выход отработает.
      logger.warn(`[${tag}] расчёт стопа #${c} не удался: ${err.message} — открываю без жёсткого стопа`);
    }
  }

  const equity = await safeEquity();
  const id = savePosition({
    coin: c,
    size_usd: sizeUsd,
    entry_price: price,
    entry_apy: 0,                 // нет funding-edge — чистый price-журнал
    entry_time: Date.now(),
    mode: 'PAPER',
    strategy_id: strategyId,
    side,
    leverage,
    entry_equity: equity || null,
    sl_price: plan.slPrice,
    tp_price: plan.tpPrice,
  });
  logger.info(
    `[${tag}] OPEN ${side} #${c} ${leverage}x $${sizeUsd.toFixed(2)} @ ${price} · ${planLabel}`,
  );
  return { ok: true, id, entryPrice: price, slPrice: plan.slPrice, tpPrice: plan.tpPrice, rungs: plan.rungs };
}
