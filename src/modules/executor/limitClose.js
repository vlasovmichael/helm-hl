// ─────────────────────────────────────────────────
//  Limit-first close — выход мейкером, с фолбэком в маркет
// ─────────────────────────────────────────────────
// Комиссии и спред — самый крупный известный отток депо (медиана спреда ~16 бп
// поверх тейкерской ставки). Эджа выход мейкером не создаёт, но отток убирает.
//
// Порядок: reduce-only Alo (post-only) на СВОЮ сторону книги → ждём до
// CLOSE_LIMIT_WAIT_MS, опрашивая остаток позиции → не налилось (или налилось
// частично) → отменяем ордер и добиваем остаток маркетом.
//
// Фолбэк не опция: BE-храповик и стоп существуют ради того, чтобы выйти, а не
// ради того, чтобы выйти дёшево. Лимитка без добивки превратила бы их в «может
// быть выйдем».
//
// Цена fill'а берётся из userFills, а не из ответа биржи: у resting-ордера
// ответ не содержит цены исполнения, а PnL считается именно по ней.

import { logger } from '../../core/logger.js';
import { retryWithBackoff } from '../../core/retry.js';
import { config } from '../../core/config.js';
import {
  placeLimit, cancelOrderFor, closeMarket, getOrderBook, getPositions,
} from '../exchange.js';
import { parseFillResponse, resolveAsset } from './fill-parser.js';
import { formatHlPrice, MARKET_SLIPPAGE } from './math.js';
import { fetchUserFills } from '../userFills.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Абсолютный размер открытой позиции по монете (0 — позиции нет). */
async function readOpenSize(coin) {
  const positions = await getPositions();
  const found = (positions || []).find(
    (x) => String(x?.position?.coin || '').toUpperCase() === coin.toUpperCase(),
  );
  const szi = parseFloat(found?.position?.szi ?? '0');
  return Number.isFinite(szi) ? Math.abs(szi) : 0;
}

/** Лучшие bid/ask из L2. levels[0] — биды, levels[1] — аски. */
async function readBestPrices(coin) {
  const book = await getOrderBook(coin);
  const bestBid = parseFloat(book?.levels?.[0]?.[0]?.px);
  const bestAsk = parseFloat(book?.levels?.[1]?.[0]?.px);
  return {
    bestBid: Number.isFinite(bestBid) ? bestBid : null,
    bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
  };
}

/**
 * VWAP наших close-fill'ов по монете с момента sinceTs.
 * Индексатор HL лагает на 10-30с, поэтому force:true и терпимость к пустому ответу.
 * @returns {Promise<{ totalSz: number, avgPx: number|null }>}
 */
async function readCloseFills(coin, sinceTs) {
  try {
    const fills = await fetchUserFills(sinceTs - 5000, { force: true });
    const mine = (fills || []).filter(
      (f) => String(f.coin || '').toUpperCase() === coin.toUpperCase() && f.time >= sinceTs - 5000,
    );
    if (mine.length === 0) return { totalSz: 0, avgPx: null };
    let sz = 0, notional = 0;
    for (const f of mine) {
      if (!Number.isFinite(f.sz) || !Number.isFinite(f.px)) continue;
      sz += f.sz;
      notional += f.sz * f.px;
    }
    return sz > 0 ? { totalSz: sz, avgPx: notional / sz } : { totalSz: 0, avgPx: null };
  } catch (err) {
    logger.warn(`[LimitClose] #${coin} — не смог прочитать fills: ${err.message}`);
    return { totalSz: 0, avgPx: null };
  }
}

/**
 * Закрытие позиции: сначала мейкером, потом (если надо) тейкером.
 *
 * Бросает Error('No position found'), если позиции на бирже уже нет — вызывающий
 * код в productionClose ловит это сообщение и уходит в external-close ветку.
 *
 * @param {Object} p
 * @param {string} p.coin — "ETH"
 * @param {'short'|'long'} p.side — сторона ОТКРЫТОЙ позиции
 * @returns {Promise<{ ok, avgPx?, totalSz?, oid?, kind?, error? }>} — форма fill'а
 *   как у parseFillResponse, чтобы productionClose работал без развилок.
 */
export async function closeLimitFirst({ coin, side }) {
  const t0 = Date.now();
  const isBuy = side === 'short'; // закрытие шорта = BUY

  const startSz = await readOpenSize(coin);
  if (!(startSz > 0)) {
    // Ровно то сообщение, которое ждёт isPositionGoneRejection/productionClose.
    throw new Error('No position found');
  }

  const { szDecimals } = resolveAsset(coin);
  const { bestBid, bestAsk } = await readBestPrices(coin);
  const rawPx = isBuy ? bestBid : bestAsk;
  if (!(rawPx > 0)) {
    logger.warn(`[LimitClose] #${coin} — нет стакана (bid=${bestBid} ask=${bestAsk}), иду маркетом`);
    return await marketFallback(coin, t0);
  }

  // Пассивная сторона книги: BUY кладём по bестBid, SELL по bestAsk — Alo так
  // гарантированно не пересечёт рынок и не отвалится с post-only reject.
  const px = formatHlPrice(rawPx, szDecimals);

  let oid = null;
  try {
    const result = await retryWithBackoff(
      () => placeLimit({ coin, isBuy, sz: startSz, px, tif: 'Alo', reduceOnly: true }),
      { label: `close-limit-${coin}`, maxRetries: 2, baseDelayMs: 1000 },
    );
    const status = result?.response?.data?.statuses?.[0];
    if (typeof status === 'string') throw new Error(status);
    if (status?.error) throw new Error(status.error);
    if (status?.filled) {
      logger.info(
        `[LimitClose] ✅ #${coin} maker-fill сразу: ${status.filled.totalSz} @ $${status.filled.avgPx}`,
      );
      return {
        ok: true,
        oid: status.filled.oid,
        totalSz: parseFloat(status.filled.totalSz),
        avgPx: parseFloat(status.filled.avgPx),
        kind: 'limit',
      };
    }
    oid = status?.resting?.oid ?? null;
    logger.info(`[LimitClose] 📝 #${coin} reduce-only Alo sz=${startSz} @ ${px} oid=${oid}`);
  } catch (err) {
    if (/no position found/i.test(err.message || '')) throw err;
    logger.warn(`[LimitClose] #${coin} — лимитка не встала (${err.message}), иду маркетом`);
    return await marketFallback(coin, t0);
  }

  // ── Ждём налива, глядя на остаток позиции ──
  const deadline = t0 + config.trading.closeLimitWaitMs;
  let remaining = startSz;
  while (Date.now() < deadline) {
    await sleep(config.trading.closeLimitPollMs);
    try {
      remaining = await readOpenSize(coin);
    } catch (err) {
      logger.debug(`[LimitClose] #${coin} — опрос позиции упал: ${err.message}`);
      continue;
    }
    if (remaining <= 0) {
      const { totalSz, avgPx } = await readCloseFills(coin, t0);
      logger.info(
        `[LimitClose] ✅ #${coin} налилось мейкером за ${((Date.now() - t0) / 1000).toFixed(1)}с ` +
          `@ $${avgPx ?? px}`,
      );
      return {
        ok: true,
        oid,
        totalSz: totalSz > 0 ? totalSz : startSz,
        avgPx: avgPx ?? parseFloat(px),
        kind: 'limit',
      };
    }
  }

  // ── Дедлайн: снимаем лимитку и добиваем остаток маркетом ──
  if (oid != null) {
    try {
      await cancelOrderFor(coin, oid);
    } catch (err) {
      // Ордер мог налиться между опросом и отменой — это не ошибка.
      logger.debug(`[LimitClose] #${coin} — cancel oid=${oid} не прошёл: ${err.message}`);
    }
  }

  try {
    remaining = await readOpenSize(coin);
  } catch { /* пусть решает маркет-путь */ }

  if (remaining <= 0) {
    const { totalSz, avgPx } = await readCloseFills(coin, t0);
    logger.info(`[LimitClose] ✅ #${coin} налилось мейкером на дедлайне @ $${avgPx ?? px}`);
    return {
      ok: true, oid,
      totalSz: totalSz > 0 ? totalSz : startSz,
      avgPx: avgPx ?? parseFloat(px),
      kind: 'limit',
    };
  }

  const partialPct = ((startSz - remaining) / startSz) * 100;
  logger.warn(
    `[LimitClose] ⏱ #${coin} за ${(config.trading.closeLimitWaitMs / 1000).toFixed(0)}с налилось ` +
      `${partialPct.toFixed(0)}% (остаток ${remaining}) — добиваю маркетом`,
  );
  return await marketFallback(coin, t0, { startSz });
}

/**
 * Маркет-закрытие остатка + пересчёт средней цены по всем fill'ам с t0
 * (иначе при частичном наливе avgPx показал бы только тейкерскую ногу).
 */
async function marketFallback(coin, t0, { startSz = null } = {}) {
  const result = await retryWithBackoff(
    () => closeMarket(coin, undefined, MARKET_SLIPPAGE), // size undefined → закрыть полностью
    { label: `close-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
  );
  const fill = parseFillResponse(result, 'CLOSE');
  if (!fill.ok) return fill;

  const { totalSz, avgPx } = await readCloseFills(coin, t0);
  const mixed = startSz != null && totalSz > 0 && totalSz > fill.totalSz + 1e-12;
  return {
    ok: true,
    oid: fill.oid,
    totalSz: totalSz > 0 ? totalSz : fill.totalSz,
    avgPx: avgPx ?? fill.avgPx,
    kind: mixed ? 'mixed' : 'market',
  };
}
