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

/**
 * Закрытие последней ПОЛНОСТЬЮ ЗАКРЫТОЙ минутной свечи.
 *
 * Нужно для решения о выходе по трейлу. Пик считаем по фитилям (это честный
 * MFE), но выходить по фитилю нельзя: цена, которую видел один принт, — это не
 * цена, по которой можно продать. Откат от пика меряем по закрытию бара — оно
 * пережило целую минуту торговли.
 *
 * Незакрытый бар отбрасываем: его close = последняя сделка, то есть тот же тик,
 * от которого мы и уходим.
 *
 * @returns {{px:number, time:number}|null}
 */
export function lastClosedClose(candles, now = Date.now()) {
  if (!Array.isArray(candles)) return null;
  let best = null;
  for (const c of candles) {
    if (!Number.isFinite(c?.time) || !(c.close > 0)) continue;
    if (c.time + 60_000 > now) continue; // бар ещё идёт
    if (best == null || c.time > best.time) best = { px: c.close, time: c.time };
  }
  return best;
}

// Троттл на позицию: свечи спрашиваем не чаще, чем закрывается бар. Кэш свечей
// держит свой TTL (20с), этот — про то, чтобы не дёргать getOneMinCandles на
// каждый тик няньки по каждой позе. Между обновлениями отдаём ПОСЛЕДНЕЕ
// известное значение, а не null: решение о выходе должно опираться на закрытие
// бара в каждом тике, а не только в том, где мы сходили в сеть.
const REFRESH_GAP_MS = 30_000;
const lastTruth = new Map(); // positionId → { at, peakPct, close }

/** Сброс кэша по позиции (закрылась) или целиком (тесты). */
export function clearPeakTruth(positionId) {
  if (positionId == null) lastTruth.clear();
  else lastTruth.delete(positionId);
}

/**
 * Правда биржи о позиции: пик хода (по фитилям) и закрытие последнего бара
 * (для решения о выходе). Сети касается не чаще REFRESH_GAP_MS на позицию, в
 * остальные тики отдаёт последнее известное.
 *
 * Ошибки глушим намеренно: свечной источник — УТОЧНЕНИЕ тикового, и если HL
 * недоступен или бюджет занят, правило обязано продолжить работать на тиковой
 * цене, а не упасть.
 *
 * @param {object} position — row из positions (coin, entry_price, entry_time, side, id)
 * @param {number} [now]
 * @returns {Promise<{peakPct:number|null, close:{px:number,time:number}|null}|null>}
 */
export async function candleTruth(position, now = Date.now()) {
  const { id, coin, entry_price: entry, entry_time: entryTime } = position || {};
  if (!(entry > 0) || !Number.isFinite(entryTime)) return null;

  const prev = lastTruth.get(id);
  if (prev != null && now - prev.at < REFRESH_GAP_MS) {
    return { peakPct: prev.peakPct, close: prev.close };
  }

  try {
    const candles = await getOneMinCandles(coin, lookbackMinutesFor(entryTime, now), now);
    const peakPct = peakPctFromCandles({
      candles,
      entry,
      entryTime,
      isShort: (position.side || 'short') === 'short',
    });
    const close = lastClosedClose(candles, now);
    lastTruth.set(id, { at: now, peakPct, close });
    return { peakPct, close };
  } catch (err) {
    logger.debug(`[AdoptPeakTruth] #${coin} candle truth failed: ${err.message}`);
    // Протухшее лучше пустого: закрытие бара минутной давности всё ещё честнее
    // тика, а пик не убывает по определению.
    return prev ? { peakPct: prev.peakPct, close: prev.close } : null;
  }
}
