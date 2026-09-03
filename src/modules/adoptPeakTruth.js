// ─────────────────────────────────────────────────
//  Adopt Peak Truth — пик хода по свечам, а не по WS-мидам
// ─────────────────────────────────────────────────
// ЗАЧЕМ. Пик (MFE) adopt-позы считался ровно по одному источнику: цене из
// allMids, которую strategistAdopt получает раз в тик. Кадров приходит ~22/мин,
// и быстрый прокол между ними в пик не попадает.
//
// 03.09.2026, HEMI SHORT: трекер записал пик 2.06% (0.83R) при пороге взвода
// target-trail 0.9R. Правило не сработало ни разу. При этом цена реально
// торговалась на 0.015726 — ход 3.12% = 1.25R, вдвое выше порога, и это не
// оценка, а факт: там исполнилась reduce-only лимитка. Лимитка лежит на бирже,
// ей тики не нужны — движение она поймала, трекер пика нет.
//
// Low/high минутных свечей такие проколы видят: свечу рисует сама биржа по
// сделкам. Поэтому пик берём как МАКСИМУМ двух источников — тикового и
// свечного. Максимум, а не замена: тик свежее (свеча догоняет до минуты), а
// свеча полнее. Ни один из них не обязан быть прав в одиночку.
//
// ⚠️ ЧЕМ ЗА ЭТО ПЛАТИМ. Пик растёт → растёт и откат от пика, а на нём считается
// give-back трейла. Фитиль в один принт теперь может взвести трейл и тут же
// закрыть позу «по откату» от цены, по которой реально было не выйти. Это
// честный MFE, но правило от него становится нервнее — при разборе гипотезы
// adopt-target-trail это надо держать в голове.
//
// Чистые функции (без сети и БД) вынесены отдельно, чтобы тест не требовал ни
// кошелька, ни HL.

import { logger } from '../core/logger.js';
import { getOneMinCandles } from './candleCache.js';

// 🚨 HL отдаёт максимум 5000 баров на интервал — на 1m это ~3.5 суток. Дольше
// живущую позу свечами не восстановить, и просить больше просто незачем:
// нянька не держит позы сутками (ADOPT_MAX_AGE_MIN=360 на подхвате).
export const MAX_LOOKBACK_MIN = 24 * 60;

/**
 * Лучший ход в МОЮ сторону по свечам, в % от входа.
 *
 * Для SHORT это самый низкий low, для LONG — самый высокий high, среди свечей
 * НЕ РАНЬШЕ входа. Свечу входа берём целиком: её экстремум мог случиться и до
 * сделки, но отбросить её нельзя — именно в ней чаще всего живёт первый импульс.
 * Это сознательный перекос в сторону завышения пика; занижение опаснее, оно как
 * раз и есть чинимый баг.
 *
 * @param {object} p
 * @param {Array<{time:number, high:number, low:number}>|null} p.candles — oldest→newest
 * @param {number} p.entry — цена входа
 * @param {number} p.entryTime — ts входа (мс)
 * @param {boolean} p.isShort
 * @returns {number|null} favorable % (≥0), либо null если считать не из чего
 */
export function peakPctFromCandles({ candles, entry, entryTime, isShort }) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  if (!(entry > 0) || !Number.isFinite(entryTime)) return null;

  let best = null; // цена, наиболее выгодная мне
  for (const c of candles) {
    // Свеча целиком раньше входа — не моя (её экстремум я не пережил).
    // Граница по времени ОТКРЫТИЯ свечи: минутная свеча, открывшаяся до входа,
    // всё ещё содержит минуты после него.
    if (!Number.isFinite(c.time) || c.time + 60_000 <= entryTime) continue;
    const px = isShort ? c.low : c.high;
    if (!Number.isFinite(px) || px <= 0) continue;
    if (best == null || (isShort ? px < best : px > best)) best = px;
  }
  if (best == null) return null;

  const pct = ((isShort ? entry - best : best - entry) / entry) * 100;
  // Ход против меня пиком не является: MFE по определению ≥ 0.
  return pct > 0 ? pct : 0;
}

/**
 * Сколько минут истории просить под позицию: от входа до сейчас, с запасом на
 * незакрытую свечу, но не больше потолка ретеншена HL.
 */
export function lookbackMinutesFor(entryTime, now = Date.now()) {
  const ageMin = Math.ceil((now - entryTime) / 60_000) + 2;
  return Math.min(Math.max(ageMin, 5), MAX_LOOKBACK_MIN);
}

// Троттл на позицию: свечи спрашиваем не чаще, чем закрывается бар. Кэш свечей
// держит свой TTL (20с), этот — про то, чтобы не дёргать getOneMinCandles на
// каждый тик няньки по каждой позе.
const REFRESH_GAP_MS = 30_000;
const lastSyncAt = new Map(); // positionId → ts

/** Сброс троттла (тесты + closeHandler). */
export function clearPeakTruth(positionId) {
  if (positionId == null) lastSyncAt.clear();
  else lastSyncAt.delete(positionId);
}

/**
 * Досчитать пик позиции по свечам и вернуть его. Сети касается не чаще
 * REFRESH_GAP_MS на позицию; в остальные тики возвращает null («нечего добавить»).
 *
 * Ошибки глушим намеренно: свечной источник — УТОЧНЕНИЕ тикового, и если HL
 * недоступен или бюджет занят, правило обязано продолжить работать на тиковом
 * пике, а не упасть.
 *
 * @param {object} position — row из positions (coin, entry_price, entry_time, side, id)
 * @param {number} [now]
 * @returns {Promise<number|null>} favorable % или null
 */
export async function candlePeakPct(position, now = Date.now()) {
  const { id, coin, entry_price: entry, entry_time: entryTime } = position || {};
  if (!(entry > 0) || !Number.isFinite(entryTime)) return null;

  const prev = lastSyncAt.get(id);
  if (prev != null && now - prev < REFRESH_GAP_MS) return null;
  lastSyncAt.set(id, now);

  try {
    const candles = await getOneMinCandles(coin, lookbackMinutesFor(entryTime, now), now);
    return peakPctFromCandles({
      candles,
      entry,
      entryTime,
      isShort: (position.side || 'short') === 'short',
    });
  } catch (err) {
    logger.debug(`[AdoptPeakTruth] #${coin} candle peak failed: ${err.message}`);
    return null;
  }
}
