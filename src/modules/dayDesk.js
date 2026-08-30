// ─────────────────────────────────────────────────
//  Day Desk — состояние торгового дня и соблюдение правил
// ─────────────────────────────────────────────────
// Три вопроса, на которые отвечает витрина, и ровно в этом порядке:
//   1. Сколько я сегодня уже сделал и сколько мне ещё можно (дисциплина).
//   2. Защищены ли открытые позы прямо сейчас (риск).
//   3. Насколько я следую собственным правилам за последний месяц (стратегия).
//
// Почему день, а не сделка: аудит 60 дней fills показал, что минус делают ДНИ с
// несколькими входами, а не отдельные сделки — 8 худших дней дали −$130 при
// общем минусе −$83. Отдельная сделка почти всегда нормальная; тильт-день — нет.
//
// Комиссии считаются первоклассной метрикой, а не строкой в отчёте: на истории
// они составили 100%+ всего минуса. Поэтому здесь они есть и в долларах, и в
// базисных пунктах от оборота, и долей от gross-результата.
//
// Всё считается из HL fills — той же правды, что кормит Ledger. history-таблица
// используется только там, где нужен side/страта закрытой сделки.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { fetchUserFills, reconstructRoundTrips } from './userFills.js';
import { getLastDailyRiskStatus, localDayKey } from './dailyRisk.js';
import {
  getBotOidsSince,
  getHistorySince,
  getArchivedHistorySince,
  getActivePosition,
  getActiveAdoptPositions,
} from '../core/database.js';

const DAY_MS = 86_400_000;
// Окно оценки правил. 30 дней — компромисс: достаточно сделок, чтобы доля не
// прыгала от одной сделки, и достаточно свежо, чтобы отражать текущую манеру.
const ADHERENCE_WINDOW_DAYS = 30;

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/**
 * Комиссии в базисных пунктах от оборота.
 * bp = fees / notional × 10000. Оборот — сумма обеих ног, поэтому это прямой
 * ответ на «сколько стоит один круг», сравнимый между размерами позиции.
 */
export function feesInBp(feesUsd, notionalUsd) {
  if (!(notionalUsd > 0)) return null;
  return round2((feesUsd / notionalUsd) * 10_000);
}

/**
 * Чистая: срез дня из сырых fills.
 * gross = Σ closedPnl (до комиссий), net = gross − fees.
 * notional = Σ |px × sz| по всем филлам дня — оборот, от которого считаются bp.
 */
export function computeDayDesk(fills, dayKey) {
  let gross = 0, fees = 0, notional = 0, fillCount = 0;
  const coins = new Set();
  for (const f of fills || []) {
    if (!f?.time || localDayKey(f.time) !== dayKey) continue;
    gross += Number(f.closedPnl) || 0;
    fees += Number(f.fee) || 0;
    notional += Math.abs((Number(f.px) || 0) * (Number(f.sz) || 0));
    fillCount++;
    if (f.coin) coins.add(f.coin);
  }
  const net = gross - fees;
  return {
    gross: round2(gross),
    fees: round2(fees),
    net: round2(net),
    notional: round2(notional),
    fillCount,
    coins: [...coins],
    feesBp: feesInBp(fees, notional),
    // Какую долю валового результата съели комиссии. > 1 означает, что сделки
    // были прибыльными до издержек и убыточными после — самый частый мой случай.
    feeShareOfGross: gross > 0 ? round2(fees / gross) : null,
  };
}

/**
 * Чистая: соблюдение правил по закрытым round-trip'ам.
 * Каждое правило возвращает { value, target, ok } — доля/число, цель и вердикт,
 * чтобы фронт не решал, что считать нормой.
 */
export function computeAdherence(trips, { blacklist = new Set(), days = ADHERENCE_WINDOW_DAYS } = {}) {
  const n = trips.length;
  if (n === 0) return { n: 0, days, rules: [] };

  const byDay = new Map();
  for (const t of trips) {
    const k = localDayKey(t.closeTime || t.entryTime);
    byDay.set(k, (byDay.get(k) || 0) + 1);
  }
  const tradingDays = byDay.size;
  const perDay = round2(n / Math.max(1, tradingDays));
  const overCapDays = [...byDay.values()].filter((c) => c > config.trading.screenTradesPerDay).length;

  const longs = trips.filter((t) => (t.side || '').toLowerCase() === 'long').length;
  const withStop = trips.filter((t) => t.hadStop).length;
  const blacklisted = trips.filter((t) => blacklist.has((t.coin || '').toUpperCase())).length;
  const botExits = trips.filter((t) => t.source === 'adopted' || t.source === 'bot').length;

  const rules = [
    {
      n: 1,
      title: 'Fewer trades, bigger size',
      metric: `${perDay} trades/day · ${overCapDays} of ${tradingDays} days over budget`,
      value: perDay,
      target: config.trading.screenTradesPerDay,
      ok: perDay <= config.trading.screenTradesPerDay,
    },
    {
      n: 2,
      title: 'Stop as a number, before entry',
      metric: `${withStop}/${n} trades had a stop on the exchange`,
      value: round2(withStop / n),
      target: 1,
      ok: withStop / n >= 0.9,
    },
    {
      n: 3,
      title: 'No longs',
      metric: `${longs}/${n} were longs`,
      value: round2(longs / n),
      target: 0,
      ok: longs / n <= 0.1,
    },
    {
      n: 4,
      title: 'Ban the black-hole coins',
      metric: blacklist.size
        ? `${blacklisted} ${blacklisted === 1 ? 'trade' : 'trades'} in blacklisted coins`
        : 'blacklist is empty',
      value: blacklisted,
      target: 0,
      ok: blacklisted === 0,
    },
    {
      n: 5,
      title: 'Once in, hand the exit to the bot',
      metric: `${botExits}/${n} exits were run by the nanny`,
      value: round2(botExits / n),
      target: 1,
      ok: botExits / n >= 0.7,
    },
  ];

  return { n, days, tradingDays, rules, followed: rules.filter((r) => r.ok).length };
}

/**
 * Полный срез для витрины. Fail-soft: любая часть может отвалиться,
 * остальные всё равно доедут до экрана.
 */
export async function buildDayDesk(now = Date.now()) {
  const dayKey = localDayKey(now);
  const limitUsd = config.trading.dailyLossLimitUsd;
  const cap = config.trading.screenTradesPerDay;

  let fills = [];
  try {
    fills = await fetchUserFills(now - (ADHERENCE_WINDOW_DAYS + 1) * DAY_MS);
  } catch (err) {
    logger.debug(`[DayDesk] fills failed: ${err.message}`);
  }

  const day = computeDayDesk(fills, dayKey);

  // Round-trip'ы: нужны, чтобы считать СДЕЛКИ, а не филлы (частичные исполнения
  // раздувают счётчик втрое и делают лимит бессмысленным).
  let trips = [];
  try {
    const botOids = getBotOidsSince(0);
    const botTrades = [...getHistorySince(0), ...getArchivedHistorySince(0)].map((r) => ({
      coin: r.coin, entry_time: r.entry_time, closed_at: r.closed_at,
    }));
    trips = reconstructRoundTrips(fills, botTrades, botOids).filter((t) => t.status === 'closed');
  } catch (err) {
    logger.debug(`[DayDesk] round-trips failed: ${err.message}`);
  }

  const tradesToday = trips.filter((t) => localDayKey(t.closeTime || t.entryTime) === dayKey).length;

  // Открытые позиции и их защита. Стоп читается с биржи няней; здесь достаточно
  // знать, у скольких он записан — панель на /oi показывает подробности.
  let open = [], unprotected = 0;
  try {
    const active = getActivePosition();
    open = [...getActiveAdoptPositions(), ...(active ? [active] : [])];
    unprotected = open.filter((p) => !p.sl_price && !p.hunter_sl_oid).length;
  } catch (err) {
    logger.debug(`[DayDesk] positions failed: ${err.message}`);
  }

  const risk = getLastDailyRiskStatus();
  const halted = !!risk?.halted;

  // Соблюдение правил считаем по тем же round-trip'ам за окно.
  const since = now - ADHERENCE_WINDOW_DAYS * DAY_MS;
  const windowTrips = trips
    .filter((t) => (t.closeTime || t.entryTime) >= since)
    .map((t) => ({
      ...t,
      // Стоп «был», если сделку вела нянька: она ставит его на бирже до записи
      // в БД, поэтому adopted/bot ⇒ защита была, manual ⇒ её не было.
      hadStop: t.source === 'adopted' || t.source === 'bot',
    }));

  return {
    dayKey,
    trades: { today: tradesToday, cap, over: tradesToday > cap },
    money: {
      gross: day.gross,
      net: day.net,
      fees: day.fees,
      feesBp: day.feesBp,
      feeShareOfGross: day.feeShareOfGross,
      notional: day.notional,
    },
    stop: {
      limitUsd,
      // Запас не накапливаем в плюс: «сегодня заработал, значит можно рискнуть
      // больше» — ровно та техника, из-за которой появился дневной лимит.
      remainingUsd: round2(Math.max(0, limitUsd + Math.min(0, day.net))),
      halted,
      known: !!risk,
    },
    protection: { open: open.length, unprotected },
    adherence: computeAdherence(windowTrips, { blacklist: config.trading.coinBlacklist }),
    generatedAt: now,
  };
}
