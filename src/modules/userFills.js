// ─────────────────────────────────────────────────
//  userFills — Hyperliquid fills source of truth
// ─────────────────────────────────────────────────
// Обёртка над POST /info { type: userFillsByTime } с in-memory кешем.
// Используется:
//   1. Cause detection при external close (production.js, integrity.js) — matched
//      oid против hunter_sl_oid/hunter_tp_oid даёт точный ответ TP/SL/прочее.
//   2. Реконструкция ручных трейдов для дашборда (server.js: pnl-summary, activity,
//      trade-markers) — fills, которые НЕ покрыты bot DB positions, складываются
//      в "manual trades".
//
// Контракт fill (HL):
//   { coin, px, sz, side: 'A'|'B', time, dir, closedPnl, hash, oid, crossed,
//     fee, tid, liquidation?, feeToken, startPosition }
//   side 'A' = ask (sell), 'B' = bid (buy)
//   dir: "Open Long" | "Open Short" | "Close Long" | "Close Short" | "Long > Short" | ...
//   closedPnl: realized PnL для этого fill (строка с float)

import { logger } from '../core/logger.js';
import { config } from '../core/config.js';
import { hlInfo } from '../core/hlClient.js';

const CACHE_TTL_MS = 30_000;  // 30с: fills меняются редко, без смысла спамить API
const MAX_LOOKBACK_MS = 60 * 24 * 3_600_000;  // 60d — покрывает 30d period с запасом

let cache = { ts: 0, startTime: 0, fills: [] };

/**
 * @param {number} startTime — unix ms. Если 0/undefined — последние 60d.
 * @returns {Promise<Array>} массив fills (newest last по time)
 */
export async function fetchUserFills(startTime = 0) {
  if (!config.isProduction) return [];

  const now = Date.now();
  const effectiveStart = startTime > 0 ? startTime : now - MAX_LOOKBACK_MS;

  // Кеш валиден если: TTL не истёк И запрашиваемое окно не шире кешированного.
  if (
    now - cache.ts < CACHE_TTL_MS &&
    cache.fills.length >= 0 &&
    cache.startTime <= effectiveStart
  ) {
    return cache.fills.filter((f) => f.time >= effectiveStart);
  }

  try {
    const data = await hlInfo(
      {
        type: 'userFillsByTime',
        user: config.wallet.address,
        startTime: effectiveStart,
      },
      { label: 'userFills', timeoutMs: 10_000 },
    );

    if (!Array.isArray(data)) {
      logger.debug(`[userFills] unexpected response shape: ${typeof data}`);
      return cache.fills.filter((f) => f.time >= effectiveStart);
    }

    const normalized = data.map(normalizeFill).filter(Boolean);
    cache = { ts: now, startTime: effectiveStart, fills: normalized };
    return normalized;
  } catch (err) {
    logger.debug(`[userFills] fetch failed: ${err.message}`);
    return cache.fills.filter((f) => f.time >= effectiveStart);
  }
}

function normalizeFill(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const time = Number(raw.time);
  if (!Number.isFinite(time)) return null;
  return {
    coin:          String(raw.coin || '').replace(/^@/, ''),
    px:            parseFloat(raw.px),
    sz:            parseFloat(raw.sz),
    side:          raw.side,  // 'A' sell / 'B' buy
    time,
    dir:           String(raw.dir || ''),
    closedPnl:     parseFloat(raw.closedPnl ?? '0'),
    fee:           parseFloat(raw.fee ?? '0'),
    feeToken:      raw.feeToken,
    oid:           raw.oid != null ? Number(raw.oid) : null,
    tid:           raw.tid != null ? Number(raw.tid) : null,
    hash:          raw.hash,
    startPosition: parseFloat(raw.startPosition ?? '0'),
    liquidation:   raw.liquidation || null,
    crossed:       Boolean(raw.crossed),
  };
}

/**
 * Определяет причину закрытия позиции по fills.
 * @param {Object} position — row из positions table
 * @param {Array}  fills    — отфильтрованные fills (по coin), отсортированные по time asc
 * @returns {{ reason: string, pnl: number|null, closePx: number|null, closedAt: number|null }}
 *   reason ∈ 'tp_trigger' | 'sl_trigger' | 'liquidation' | 'manual_close' | 'external_unknown'
 */
export function classifyClose(position, fills) {
  const result = { reason: 'external_unknown', pnl: null, closePx: null, closedAt: null };
  if (!Array.isArray(fills) || fills.length === 0) return result;

  // Берём fills ПОСЛЕ entry_time и проверяем их dir на "Close".
  const candidates = fills.filter(
    (f) => f.time >= position.entry_time && f.dir.startsWith('Close '),
  );
  if (candidates.length === 0) return result;

  // Closing fills могут быть split на несколько partial — берём все подряд до
  // нулевой накопленной позиции. Для cause detection достаточно первого.
  const first = candidates[0];

  // 1. Liquidation: HL ставит liquidation объект на fill.
  if (first.liquidation) {
    result.reason = 'liquidation';
  }
  // 2. SL/TP trigger: oid совпадает с сохранённым в DB.
  else if (position.hunter_sl_oid && first.oid === position.hunter_sl_oid) {
    result.reason = 'sl_trigger';
  } else if (position.hunter_tp_oid && first.oid === position.hunter_tp_oid) {
    result.reason = 'tp_trigger';
  } else {
    // 3. Иначе — manual или внешний market close через UI.
    result.reason = 'manual_close';
  }

  // Aggregate PnL/price/closedAt по всем closing fills вплоть до нулевой позиции.
  let totalSz = 0, weightedPx = 0, totalPnl = 0, lastTime = 0;
  for (const f of candidates) {
    const absSz = Math.abs(f.sz);
    totalSz   += absSz;
    weightedPx += absSz * f.px;
    totalPnl  += f.closedPnl;
    if (f.time > lastTime) lastTime = f.time;
    // Эвристика остановки: после первого close-fill startPosition должен дойти
    // до 0. Не идеально для re-opens, но для одиночного close работает.
    // Без startPosition tracking просто агрегируем все Close-* после entry_time.
  }
  result.pnl      = totalPnl;
  result.closePx  = totalSz > 0 ? weightedPx / totalSz : null;
  result.closedAt = lastTime || null;
  return result;
}

/**
 * Извлекает ручные трейды (НЕ принадлежащие боту) из fills.
 *
 * Бот ведёт positions table — все его OPEN/CLOSE fills известны по entry_time
 * (open) и closed_at (close) ± grace window. Всё, что не попадает в bot windows,
 * считается manual.
 *
 * Группировка: позиция = последовательность fills для coin, начинающаяся с
 * dir 'Open *' и заканчивающаяся когда running |position| вернулась в ~0.
 *
 * @param {Array} fills    — все fills (sorted by time asc).
 * @param {Array} botTrades — closed bot trades (history rows) + open bot positions.
 *                           Каждый: { coin, entry_time, closed_at|null }.
 * @returns {Array<{ coin, side: 'long'|'short', entryTime, closeTime|null,
 *                   entryPrice, closePrice|null, sizeUsd, pnl, status: 'open'|'closed',
 *                   sl|null, tp|null }>}
 */
export function reconstructManualTrades(fills, botTrades, botOidSet = null) {
  if (!Array.isArray(fills) || fills.length === 0) return [];
  const botByCoin = new Map();
  for (const bt of botTrades || []) {
    if (!bt?.coin) continue;
    const c = bt.coin.toUpperCase();
    if (!botByCoin.has(c)) botByCoin.set(c, []);
    botByCoin.get(c).push({
      entry: bt.entry_time,
      close: bt.closed_at || (bt.status === 'OPEN' ? Number.POSITIVE_INFINITY : bt.entry_time),
    });
  }

  // OID-based фильтр (2026-05-22): новые bot fills имеют oid в bot_oid_log →
  // фильтруются точно. Без legacy time-based window'а: bot.entry_time лагает
  // относительно фактического fill.time (PURR incident — 518ms skew).
  const useOidFilter = botOidSet instanceof Set && botOidSet.size > 0;

  const GRACE_MS = 60_000;
  // Fallback для старых записей (до OID-логирования): time-based с extended
  // leading grace, чтобы compensate skew. Применяется ТОЛЬКО когда нет oid в
  // bot_oid_log (старые fills/trades до фикса).
  const LEADING_GRACE_MS = 10_000;

  function inBotWindow(coin, ts) {
    const ranges = botByCoin.get(coin.toUpperCase()) || [];
    return ranges.some((r) => ts >= (r.entry - LEADING_GRACE_MS) && ts <= r.close + GRACE_MS);
  }

  // Дедуп adopt-позиций: усыновлённая поза открыта вручную, но бот хранит её в
  // history с entry_time = временем того же ручного open-fill. Если ручная нога
  // ТОЧНО совпадает по entry (±ENTRY_MATCH_MS) с бот-сделкой — она уже в history
  // как 'adopt', не дублируем как ручную. Точный матч (а НЕ 60с-grace inBotWindow):
  // быстрый ручной re-open сразу после bot-close той же монеты иначе глотался бы
  // грейсом (XPL 35с, ср. commit 7e76034).
  const ENTRY_MATCH_MS = 3000;
  function isBotOwnedEntry(coin, entryTime) {
    const ranges = botByCoin.get(coin.toUpperCase()) || [];
    return ranges.some((r) => Math.abs(r.entry - entryTime) <= ENTRY_MATCH_MS);
  }

  function isBotFill(f) {
    // OID присутствует и фильтр активен → oid решает ОДНОЗНАЧНО (и для bot,
    // и для НЕ-bot fills). Раньше тут срабатывал только positive-match, а любой
    // не-совпавший fill всё равно проваливался в time-fallback ниже — и ручной
    // re-open в течение GRACE_MS (60с) после бот-закрытия той же монеты
    // ошибочно глотался как «ботовский» → adopt не видел свежий вход → поза
    // оставалась без стопа. Time-fallback теперь ТОЛЬКО для fills без oid
    // (legacy). См. tests/userFills.test.js.
    if (useOidFilter && f.oid != null) {
      return botOidSet.has(Number(f.oid));
    }
    // Fallback: для старых fills (oid не записан в log) — time-based.
    return inBotWindow(f.coin, f.time);
  }

  // Группируем ВСЕ fills по coin (бот + ручные). Позиция на бирже = знаковая
  // сумма всех fills, поэтому бот-закрытие усыновлённой позы естественно обнуляет
  // net и схлопывает ручную ногу — без фантомных «висящих» ног, которые копила
  // фильтрация бот-fills по oid (XPL incident 2026-06-17: ручная нога не
  // закрывалась на adopt_trail_tp → −$7.36 не попадал в Recent Activities).
  const byCoin = new Map();
  for (const f of fills) {
    if (!f.coin) continue;
    if (!byCoin.has(f.coin)) byCoin.set(f.coin, []);
    byCoin.get(f.coin).push(f);
  }

  const trades = [];
  const EPS = 1e-9;
  for (const [coin, list] of byCoin) {
    list.sort((a, b) => a.time - b.time);
    let cur = null;  // ручная нога: { side, entryTime, entryPxNum, entryPxDen, pnl, fee, lastClose* }
    let net = 0;     // знаковый размер позиции на бирже (по ВСЕМ fills): >0 long, <0 short

    for (const f of list) {
      const sz     = Math.abs(Number(f.sz) || 0);
      const isOpen = f.dir.startsWith('Open ');
      const isLong = f.dir.includes('Long');
      const bot    = isBotFill(f);
      net += isOpen === isLong ? sz : -sz;   // long-open/short-close → +; иначе −

      if (isOpen && !bot) {
        // Ручное открытие — старт или усреднение ручной ноги.
        if (!cur) {
          cur = { coin, side: isLong ? 'long' : 'short', entryTime: f.time,
                  entryPxNum: f.px * sz, entryPxDen: sz, pnl: 0, fee: f.fee };
        } else {
          cur.entryPxNum += f.px * sz; cur.entryPxDen += sz; cur.fee += f.fee;
        }
      } else if (!isOpen && cur) {
        // Закрытие (бот ИЛИ ручное) — относим pnl/комиссию к ручной ноге.
        cur.pnl += f.closedPnl; cur.fee += f.fee;
        cur.lastClosePx = f.px; cur.lastCloseTime = f.time;
      }

      // Биржевая позиция схлопнулась → ручная нога завершена.
      if (Math.abs(net) < EPS && cur) {
        // Усыновлённая ботом поза (точный матч entry) уже в history как 'adopt' —
        // не дублируем её как ручную. Чисто ручная нога → эмитим в ленту.
        if (!isBotOwnedEntry(coin, cur.entryTime)) {
          const entryPrice = cur.entryPxDen > 0 ? cur.entryPxNum / cur.entryPxDen : 0;
          trades.push({
            coin, side: cur.side, entryTime: cur.entryTime, closeTime: cur.lastCloseTime,
            entryPrice, closePrice: cur.lastClosePx, sizeUsd: entryPrice * cur.entryPxDen,
            pnl: cur.pnl, fee: cur.fee, status: 'closed',
          });
        }
        cur = null;
      }
    }

    if (cur && !isBotOwnedEntry(coin, cur.entryTime)) {
      const entryPrice = cur.entryPxDen > 0 ? cur.entryPxNum / cur.entryPxDen : 0;
      trades.push({
        coin, side: cur.side, entryTime: cur.entryTime, closeTime: null,
        entryPrice, closePrice: null, sizeUsd: entryPrice * cur.entryPxDen,
        pnl: cur.pnl, fee: cur.fee, status: 'open',
      });
    }
  }

  trades.sort((a, b) => (a.closeTime || a.entryTime) - (b.closeTime || b.entryTime));
  return trades;
}
