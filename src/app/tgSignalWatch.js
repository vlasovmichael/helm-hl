// ─────────────────────────────────────────────────
//  Форвард по чужим прогнозам: сигнал TG-канала → бумажная поза
// ─────────────────────────────────────────────────
// Мерим пользу НАПРАВЛЕНИЯ канала: монета, сторона, время. Вход по рынку в
// момент, когда пост увидели; выход ведёт нянька.
//
// 🚨 Три предохранителя от подглядывания:
//   1. ВОЗРАСТ — лента отдаёт два десятка постов разом, и без потолка первый
//      запуск открыл бы позы по прогнозам с известным исходом;
//   2. ЖУРНАЛ ОТКАЗОВ — иначе «канал молчал» неотличимо от «не смогли открыть»;
//   3. ДЕДУП — канал дублирует пост, и без окна прогноз получил бы двойной вес.
//
// Тихо: в ntfy ничего не уходит.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  recordTgSignal,
  isTgPostSeen,
  hasRecentTgSignal,
  getActiveTgSignalPositions,
} from '../core/database.js';
import { fetchChannelSignals } from '../modules/tgSignalFeed.js';
import { openPaperPosition } from '../modules/paperEntry.js';
import { getUniverse } from '../core/universe.js';

let lastPollAt = 0;

/** Торгуется ли монета на Hyperliquid. Пустой universe → не гадаем, отвечаем false. */
function tradableOnHl(coin) {
  const uni = getUniverse();
  if (!Array.isArray(uni) || uni.length === 0) return false;
  return uni.some((a) => String(a?.name || '').toUpperCase() === String(coin).toUpperCase());
}

/**
 * Решение по сигналу. Чистая функция от состояния — отсюда же и тесты.
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function judgeSignal(sig, state) {
  const ageMin = (state.now - sig.postedAt) / 60_000;
  if (ageMin > state.maxAgeMin) return { ok: false, reason: `stale (${Math.round(ageMin)} min)` };
  if (ageMin < -5) return { ok: false, reason: 'posted in the future' };
  if (!state.tradable) return { ok: false, reason: 'not listed on Hyperliquid' };
  if (state.duplicate) return { ok: false, reason: 'same call already open' };
  if (state.openSameCoin) return { ok: false, reason: 'position already open on this coin' };
  if (state.slotsUsed >= state.maxSlots) return { ok: false, reason: `slot limit (${state.maxSlots})` };
  return { ok: true };
}

/**
 * Один проход опроса всех настроенных каналов.
 * Best-effort: молчащий канал или упавший вход не мешают остальным.
 * @param {(channel:string)=>Promise<Array>} [fetcher] — инжектится в тестах
 * @returns {Promise<{checked:number, opened:number, skipped:number}>}
 */
export async function pollTgSignals(fetcher = fetchChannelSignals) {
  const t = config.trading;
  if (!t.tgSignalEnabled || t.tgSignalChannels.length === 0) {
    return { checked: 0, opened: 0, skipped: 0 };
  }

  let checked = 0;
  let opened = 0;
  let skipped = 0;

  for (const { handle } of t.tgSignalChannels) {
    let signals;
    try {
      signals = await fetcher(handle);
    } catch (err) {
      logger.debug(`[TgSignal] ${handle}: опрос не удался — ${err.message}`);
      continue;
    }

    for (const sig of signals) {
      if (isTgPostSeen(sig.channel, sig.postId)) continue;
      checked++;

      const openPositions = getActiveTgSignalPositions();
      const verdict = judgeSignal(sig, {
        now: Date.now(),
        maxAgeMin: t.tgSignalMaxAgeMin,
        tradable: tradableOnHl(sig.coin),
        duplicate: hasRecentTgSignal(sig.coin, sig.side, t.tgSignalDedupHours * 3_600_000),
        openSameCoin: openPositions.some((p) => p.coin === sig.coin),
        slotsUsed: openPositions.length,
        maxSlots: t.tgSignalMaxSlots,
      });

      if (!verdict.ok) {
        recordTgSignal({ ...sig, status: 'skipped', skipReason: verdict.reason });
        skipped++;
        logger.info(`[TgSignal] ${sig.channel} #${sig.coin} ${sig.side.toUpperCase()} — пропуск: ${verdict.reason}`);
        continue;
      }

      let res;
      try {
        res = await openPaperPosition({
          coin: sig.coin,
          side: sig.side,
          sizeUsd: t.tgSignalSizeUsd,
          leverage: t.tgSignalLeverage,
          strategyId: 'tg_signal',
          tag: `TgSignal ${sig.channel}`,
        });
      } catch (err) {
        res = { ok: false, error: err.message };
      }

      if (res.ok) {
        recordTgSignal({ ...sig, status: 'opened', positionId: res.id, entryPrice: res.entryPrice });
        opened++;
      } else {
        recordTgSignal({ ...sig, status: 'skipped', skipReason: res.error });
        skipped++;
        logger.warn(`[TgSignal] ${sig.channel} #${sig.coin}: вход не открылся — ${res.error}`);
      }
    }
  }

  if (checked) logger.info(`[TgSignal] круг: ${checked} новых, открыто ${opened}, пропущено ${skipped}`);
  return { checked, opened, skipped };
}

/** Тик вотчера: опрос не чаще TG_SIGNAL_POLL_MIN. Своего таймера нет намеренно —
 *  опрос не должен жить дольше бота. */
export async function tgSignalTick() {
  const t = config.trading;
  if (!t.tgSignalEnabled) return { checked: 0, opened: 0, skipped: 0 };
  const now = Date.now();
  if (now - lastPollAt < t.tgSignalPollMin * 60_000) return { checked: 0, opened: 0, skipped: 0 };
  lastPollAt = now;
  try {
    return await pollTgSignals();
  } catch (err) {
    logger.error(`[TgSignal] круг опроса упал: ${err.message}`);
    return { checked: 0, opened: 0, skipped: 0 };
  }
}

/** Сброс шага опроса — нужен тестам. */
export function resetTgSignalTimer() {
  lastPollAt = 0;
}
