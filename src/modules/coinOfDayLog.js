// ─────────────────────────────────────────────────
//  Монета дня — форвард-лог и резолвер исходов
// ─────────────────────────────────────────────────
// Половина фичи, которой не было у четырёх предыдущих оракулов входа. Пик
// записывается в момент срабатывания (по ценам ТОГО момента) и потом честно
// прогоняется по 15m-свечам: что случилось раньше — стоп или цель, какой был
// максимальный ход в плюс (MFE) и в минус (MAE).
//
// Правила замера, намеренно консервативные:
//   • внутри одного бара, задевшего И стоп, И цель, засчитываем СТОП — в
//     реальности порядок неизвестен, и оптимистичный выбор красит статистику;
//   • горизонт = time-stop сетапа (2ч) → выход по цене на этот момент. Это и
//     есть правило выхода, которое лежит в карточке, а не «держим до победы»;
//   • комиссии не моделируем — считаем в R и %, не в долларах.
//
// Measurement-only: ничего не торгует.

import { logger } from '../core/logger.js';
import { HL_PRIORITY } from '../core/hlClient.js';
import { getFifteenMinCandles } from './candleCache.js';
import {
  recordCoinOfDayPick,
  getOpenCoinOfDayPicks,
  resolveCoinOfDayPick,
  getCoinOfDayPicks,
} from '../core/database.js';
import { COD } from './coinOfDay.js';

/** Локальная дата (Варшава) — сутки оператора, не UTC. */
export function warsawDate(ts = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts));
}

/**
 * Записывает пики скана в форвард-лог. Пишем только то, что карточка подаёт
 * как сложившийся сетап (verdict.tone === 'setup') — иначе лог наполнится
 * «наблюдениями», по которым оператор входить и не собирался, и статистика будет
 * мерить не тот процесс.
 */
export function logScanPicks(scan, now = Date.now()) {
  const date = warsawDate(now);
  let written = 0;
  for (const p of scan?.picks ?? []) {
    // Гейт = ровно вердикт карточки. Если лог писать шире («наблюдения»), он
    // измерит не тот процесс, по которому оператор входит, и цифры будут не про то.
    if (p.verdict?.tone !== 'setup') continue;
    if (!p.levels || !(p.levels.rr >= COD.MIN_RR)) continue;
    const ok = recordCoinOfDayPick({
      date,
      coin: p.coin,
      side: p.side,
      created_at: now,
      score: p.score,
      entry: p.levels.entry,
      stop: p.levels.stop,
      target: p.levels.target,
      rr: p.levels.rr,
      risk_pct: p.levels.riskPct,
      flags: JSON.stringify(p.flags.map((f) => f.key)),
    });
    if (ok) {
      written++;
      logger.info(
        `[CoinOfDay] pick logged: ${p.coin} ${p.side} score=${p.score} entry=${p.levels.entry} stop=${p.levels.stop} rr=${p.levels.rr?.toFixed(2)}`,
      );
    }
  }
  return written;
}

/**
 * Прогон одного пика по свечам после входа — чистая функция, ядро замера.
 * @returns {Object|null} исход или null, если горизонт ещё не истёк
 */
export function simulateOutcome(pick, candles) {
  const isShort = pick.side === 'SHORT';
  const horizonMs = COD.TIME_STOP_MIN * 60_000;
  const deadline = pick.created_at + horizonMs;
  const bars = candles.filter((c) => c.time >= pick.created_at);
  if (!bars.length) return null;

  const risk = Math.abs(pick.stop - pick.entry);
  const gain = (px) => (isShort ? pick.entry - px : px - pick.entry);
  const pctOf = (px) => (gain(px) / pick.entry) * 100;

  let mfe = 0;
  let mae = 0;
  for (const c of bars) {
    const best = isShort ? c.low : c.high;
    const worst = isShort ? c.high : c.low;
    mfe = Math.max(mfe, pctOf(best));
    mae = Math.min(mae, pctOf(worst));

    const hitStop = isShort ? c.high >= pick.stop : c.low <= pick.stop;
    const hitTarget = isShort ? c.low <= pick.target : c.high >= pick.target;
    // Оба в одном баре → консервативно засчитываем стоп.
    if (hitStop) {
      return {
        status: 'stop', resolved_at: c.time, exit_price: pick.stop,
        exit_pct: pctOf(pick.stop), outcome_r: risk > 0 ? gain(pick.stop) / risk : null,
        mfe_pct: mfe, mae_pct: mae,
      };
    }
    if (hitTarget) {
      return {
        status: 'target', resolved_at: c.time, exit_price: pick.target,
        exit_pct: pctOf(pick.target), outcome_r: risk > 0 ? gain(pick.target) / risk : null,
        mfe_pct: mfe, mae_pct: mae,
      };
    }
    if (c.time >= deadline) {
      return {
        status: 'timeout', resolved_at: c.time, exit_price: c.close,
        exit_pct: pctOf(c.close), outcome_r: risk > 0 ? gain(c.close) / risk : null,
        mfe_pct: mfe, mae_pct: mae,
      };
    }
  }
  return null; // горизонт ещё не истёк — оставляем open
}

/**
 * Догоняет исходы всех открытых пиков. Зовётся по таймеру; идемпотентна.
 */
export async function resolveOpenPicks(now = Date.now()) {
  const open = getOpenCoinOfDayPicks();
  if (!open.length) return 0;
  let done = 0;
  for (const pick of open) {
    const ageMin = (now - pick.created_at) / 60_000;
    if (ageMin < 15) continue; // ещё ни одной закрытой свечи
    try {
      const lookback = Math.ceil(ageMin) + 30;
      const candles = await getFifteenMinCandles(pick.coin, lookback, now, HL_PRIORITY.LOW);
      if (!candles?.length) continue;
      const res = simulateOutcome(pick, candles);
      if (res) {
        resolveCoinOfDayPick(pick.date, pick.coin, res);
        done++;
        logger.info(
          `[CoinOfDay] resolved ${pick.coin} ${pick.side} → ${res.status} ${res.outcome_r?.toFixed(2)}R (mfe ${res.mfe_pct.toFixed(2)}% / mae ${res.mae_pct.toFixed(2)}%)`,
        );
      } else if (ageMin > COD.TIME_STOP_MIN + 180) {
        // Горизонт давно прошёл, а свечей нет (делистинг/дыра в данных).
        resolveCoinOfDayPick(pick.date, pick.coin, {
          status: 'expired', resolved_at: now, exit_price: null,
          exit_pct: null, outcome_r: null, mfe_pct: null, mae_pct: null,
        });
        done++;
      }
    } catch (err) {
      logger.warn(`[CoinOfDay] resolve ${pick.coin} failed: ${err.message}`);
    }
  }
  return done;
}

/**
 * Сводка форвард-статистики для карточки. Показываем n громко: при n < 20
 * любой вывод об эдже — самообман (правило из docs/TRADING_RULES.md).
 */
export function buildForwardStats(limit = 200) {
  const rows = getCoinOfDayPicks(limit);
  const closed = rows.filter((r) => r.status !== 'open' && r.outcome_r != null);
  const wins = closed.filter((r) => r.outcome_r > 0);
  const sumR = closed.reduce((a, r) => a + r.outcome_r, 0);
  const avgMfe = closed.length
    ? closed.reduce((a, r) => a + (r.mfe_pct ?? 0), 0) / closed.length
    : null;
  return {
    total: rows.length,
    open: rows.filter((r) => r.status === 'open').length,
    closed: closed.length,
    wins: wins.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : null,
    sumR,
    expR: closed.length ? sumR / closed.length : null,
    avgMfePct: avgMfe,
    byStatus: {
      target: closed.filter((r) => r.status === 'target').length,
      stop: closed.filter((r) => r.status === 'stop').length,
      timeout: closed.filter((r) => r.status === 'timeout').length,
    },
    // Ниже этого n карточка обязана говорить «выводов нет».
    enoughForVerdict: closed.length >= 20,
    recent: rows.slice(0, 15).map((r) => ({
      date: r.date, coin: r.coin, side: r.side, score: r.score,
      status: r.status, outcomeR: r.outcome_r, exitPct: r.exit_pct,
      mfePct: r.mfe_pct, maePct: r.mae_pct,
    })),
  };
}
