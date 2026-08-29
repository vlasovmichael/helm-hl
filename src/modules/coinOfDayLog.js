// ─────────────────────────────────────────────────
//  Монета дня — форвард-лог и резолвер исходов
// ─────────────────────────────────────────────────
// Версия 2 (30.08.2026). Первая мерила исход по стопу/цели с таймаутом 2ч и
// упёрлась в собственную конструкцию: цель бралась 1 раз из 103.
//
// 🚨 Здесь меряется ДРУГОЕ: чистый ход цены на 4 / 8 / 24 часа, без стопа и
// без срока. Юзер прямо сказал, какие горизонты смотрел: «нужно было подождать
// 4-6-8 часов и монета пошла по карточке».
//
// 🚨 Рядом пишется ход BTC за ТО ЖЕ окно, и это половина смысла лога. Его же
// вопрос: «или повезло, или так совпало с ценой битка — хер угадаешь». Без
// колонки BTC отличить одно от другого нельзя: падение альты на общем сливе
// выглядит как отработавший фейд. Решение принимается по excess = ход монеты
// в сторону сетапа минус ход BTC в ту же сторону.
//
// В базу пишутся СЫРЫЕ проценты, со знаком как есть. Приведение к стороне
// сделки (для SHORT выигрыш = падение) происходит при чтении, в toSide().
// Так в таблице лежат факты, а не уже интерпретированные числа.
//
// Measurement-only: ничего не торгует.

import { logger } from '../core/logger.js';
import { HL_PRIORITY } from '../core/hlClient.js';
import { getFifteenMinCandles } from './candleCache.js';
import {
  recordCodPick,
  getUnresolvedCodPicks,
  resolveCodPick,
  getCodPicks,
} from '../core/database.js';
import { COD } from './coinOfDay.js';

const BENCHMARK = 'BTC';

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
 * Пишем ли этот разбор в форвард-лог.
 *
 * Гейт по score, а не по вердикту: вердикт теперь мягче (гейт R:R снят), и
 * привязка к нему сделала бы порог логирования плавающим. Нужны уровни —
 * без entry замер не определён.
 */
export function isLoggablePick(p) {
  if (!p?.levels?.entry) return false;
  return (p.score ?? 0) >= COD.LOG_MIN_SCORE;
}

/**
 * Записывает пики скана. btcPrice — цена бенчмарка на момент пика, нужна
 * резолверу как база отсчёта.
 */
export function logScanPicks(scan, btcPrice, now = Date.now()) {
  const date = warsawDate(now);
  let written = 0;
  // signals, а не picks: в picks нет монет, в которых оператор уже сидит, и лог
  // потерял бы ровно те сигналы, по которым он успел войти → смещённая выборка.
  for (const p of scan?.signals ?? []) {
    if (!isLoggablePick(p)) continue;
    const ok = recordCodPick({
      date,
      coin: p.coin,
      side: p.side,
      created_at: now,
      score: p.score,
      entry: p.levels.entry,
      stop: p.levels.stop ?? null,
      risk_pct: p.levels.riskPct ?? null,
      chg24h_at: p.features?.chg24h ?? null,
      flags: JSON.stringify((p.flags ?? []).map((f) => f.key)),
      btc_at: Number.isFinite(btcPrice) ? btcPrice : null,
    });
    if (ok) {
      written++;
      logger.info(
        `[CoinOfDay] pick logged: ${p.coin} ${p.side} score=${p.score}/5 entry=${p.levels.entry}`,
      );
    }
  }
  return written;
}

/**
 * Цена на момент `targetTs` по 15m-свечам: последняя свеча, закрывшаяся НЕ
 * позже него. Если таких нет — null (окно ещё не созрело или дыра в данных).
 */
export function priceAt(candles, targetTs) {
  if (!Array.isArray(candles) || !candles.length) return null;
  let best = null;
  for (const c of candles) {
    const t = c.time ?? c.t;
    if (t == null || t > targetTs) continue;
    if (!best || t > (best.time ?? best.t)) best = c;
  }
  return best ? best.close : null;
}

const pctChange = (from, to) => (from > 0 && to > 0 ? ((to - from) / from) * 100 : null);

/**
 * Считает ход монеты и бенчмарка на всех созревших горизонтах.
 * Чистая функция — ядро замера, отделено от сети ради теста.
 */
export function computeHorizons(pick, coinCandles, btcCandles, now = Date.now()) {
  const out = {};
  for (const h of COD.HORIZONS_H) {
    const key = `chg_${h}h`;
    const btcKey = `btc_${h}h`;
    if (pick[key] != null) continue;                  // уже посчитано
    const ts = pick.created_at + h * 3_600_000;
    if (now < ts) continue;                           // горизонт не наступил
    const px = priceAt(coinCandles, ts);
    if (px == null) continue;
    out[key] = pctChange(pick.entry, px);
    if (pick.btc_at > 0) {
      const bpx = priceAt(btcCandles, ts);
      if (bpx != null) out[btcKey] = pctChange(pick.btc_at, bpx);
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Догоняет исходы по всем незакрытым пикам. Дёргается кроном.
 */
export async function resolveOpenPicks(now = Date.now()) {
  const open = getUnresolvedCodPicks();
  if (!open.length) return 0;

  const maxH = Math.max(...COD.HORIZONS_H);
  let done = 0;
  let btcCandles = null;

  for (const pick of open) {
    const ageH = (now - pick.created_at) / 3_600_000;
    if (ageH < COD.HORIZONS_H[0]) continue;           // даже первый горизонт не созрел
    try {
      const lookbackMin = Math.ceil(Math.min(ageH, maxH + 2) * 60) + 60;
      const coinCandles = await getFifteenMinCandles(pick.coin, lookbackMin, now, HL_PRIORITY.LOW);
      if (!coinCandles?.length) continue;
      // BTC тянем один раз на весь проход: свечи бенчмарка общие для всех пиков.
      if (!btcCandles) {
        btcCandles = await getFifteenMinCandles(
          BENCHMARK, Math.ceil((maxH + 26) * 60), now, HL_PRIORITY.LOW,
        );
      }
      const res = computeHorizons(pick, coinCandles, btcCandles, now);
      if (res) {
        resolveCodPick(pick.date, pick.coin, res);
        done++;
        const parts = Object.entries(res).map(([k, v]) => `${k}=${v?.toFixed(2)}%`);
        logger.info(`[CoinOfDay] resolved ${pick.coin} ${pick.side} ${parts.join(' ')}`);
      }
    } catch (err) {
      logger.warn(`[CoinOfDay] resolve ${pick.coin} failed: ${err.message}`);
    }
  }
  return done;
}

/** Ход, приведённый к стороне сетапа: для SHORT падение цены — это плюс. */
export function toSide(chgPct, side) {
  if (chgPct == null) return null;
  return side === 'SHORT' ? -chgPct : chgPct;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * Сводка по горизонтам. n показываем громко: при n < 20 любой вывод об эдже —
 * самообман (правило из docs/TRADING_RULES.md).
 *
 * 🚨 Главное число здесь — excess, а не raw. raw отвечает «монета пошла в мою
 * сторону?», excess — «пошла ли она туда СИЛЬНЕЕ, чем весь рынок». Первое без
 * второго ничего не значит.
 */
export function buildForwardStats(limit = 300) {
  const rows = getCodPicks(limit);
  const horizons = {};

  for (const h of COD.HORIZONS_H) {
    const key = `chg_${h}h`;
    const btcKey = `btc_${h}h`;
    const done = rows.filter((r) => r[key] != null);
    const raw = done.map((r) => toSide(r[key], r.side));
    const excess = done
      .filter((r) => r[btcKey] != null)
      .map((r) => toSide(r[key], r.side) - toSide(r[btcKey], r.side));

    horizons[`h${h}`] = {
      n: done.length,
      avgPct: mean(raw),
      medianPct: raw.length
        ? [...raw].sort((a, b) => a - b)[Math.floor(raw.length / 2)]
        : null,
      winRate: raw.length ? (raw.filter((x) => x > 0).length / raw.length) * 100 : null,
      nExcess: excess.length,
      avgExcessPct: mean(excess),
      excessWinRate: excess.length
        ? (excess.filter((x) => x > 0).length / excess.length) * 100
        : null,
    };
  }

  const maxH = Math.max(...COD.HORIZONS_H);
  return {
    total: rows.length,
    pending: rows.filter((r) => r[`chg_${maxH}h`] == null).length,
    horizons,
    // Ниже этого n карточка обязана говорить «выводов нет».
    enoughForVerdict: (horizons[`h${maxH}`]?.nExcess ?? 0) >= 20,
    recent: rows.slice(0, 15).map((r) => ({
      date: r.date, coin: r.coin, side: r.side, score: r.score,
      chg24hAt: r.chg24h_at,
      chg4h: r.chg_4h, chg8h: r.chg_8h, chg24h: r.chg_24h,
      btc4h: r.btc_4h, btc8h: r.btc_8h, btc24h: r.btc_24h,
    })),
  };
}
