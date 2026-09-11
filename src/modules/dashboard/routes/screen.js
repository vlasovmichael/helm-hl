// ─────────────────────────────────────────────────
//  Screen — экран торгуемых монет + бюджет дня
// ─────────────────────────────────────────────────
// Монета попадает в список ПО ЛИКВИДНОСТИ, а не по движению: на мелком депо
// спред съедает риск раньше, чем цена куда-то пойдёт. Движение — колонка
// внутри списка, а не критерий отбора.
//
// 🔒 ЗДЕСЬ НЕТ И НЕ ДОЛЖНО БЫТЬ ПРЕДСКАЗАНИЙ: ни скоринга, ни tier'ов, ни
// «setup», ни подсветки «сигнал» — всё это меряли, эджа нет. Карточка говорит
// две вещи, обе факты: что произошло с ценой и сколько стоит вход. Выбор
// монеты остаётся дискреционным.
//
// GET /api/screen — {coins[], budget{}, threshold,...}

import { config } from "../../../core/config.js";
import { logger } from "../../../core/logger.js";
import { hlInfo, HL_PRIORITY } from "../../../core/hlClient.js";
import { getPriceNMinAgo, getLatestPrice, getSamplesSince } from "../../../core/priceHistory.js";
import { getHistory, getActiveAdoptPositions, getActivePosition } from "../../../core/database.js";
import { getLastDailyRiskStatus } from "../../dailyRisk.js";
import { getCachedAccountValueSync } from "../../../core/balanceCache.js";
import {
  getPositioning,
  getHourProfile,
  sweepPositioning,
} from "../../binancePositioning.js";

// Комиссии HL по факту наших филлов. Круг = вход + выход.
const TAKER_FEE_BP = 4.32;
const ROUND_TRIP_FEE_BP = TAKER_FEE_BP * 2;
// Лимитка стоит в книге и спред не платит вовсе — отсюда и разрыв с тейкером
// втрое. Показываем обе цифры рядом: это цена одного и того же входа.
const MAKER_FEE_BP = 1.44;
const MAKER_ROUND_TRIP_BP = MAKER_FEE_BP * 2;

// metaAndAssetCtxs весит 20 (не в списке лёгких). Кэш 120с → 10 веса/мин из
// бюджета 1000. Ликвидность за две минуты не меняется, а колонки движения
// считаются локально из буфера цен и живут своей свежестью.
const CACHE_TTL_MS = 120_000;

let cache = { payload: null, builtAt: 0 };

// Порог трения (SCREEN_MAX_FRICTION_BP, дефолт 25бп): монета попадает на экран
// по ЦЕНЕ ВХОДА, а не по движению. 25бп ≈ 89 монет из 177 с живой книгой —
// TRUMP/ZEC/PENGU/kPEPE внутри, PURR(29бп) и HMSTR(52бп) снаружи.
function frictionThresholdBp() {
  return config.trading.screenMaxFrictionBp;
}

/**
 * Impact-спред монеты в базисных пунктах.
 *
 * impactPxs у HL — цены покупки/продажи фиксированного нотионала (~$20k), то
 * есть уже с учётом глубины книги, а не «лучшая цена». Для нашего $10-ордера
 * это заведомо ПЕССИМИСТИЧНАЯ оценка — и правильно: как ранжирование она
 * честнее touch-спреда, который на неликвиде бывает узким при пустой книге.
 *
 * @returns {number|null} null — контекста нет либо цифры мусорные
 */
export function impactSpreadBp(ctx, midPx) {
  const mid = Number(midPx);
  if (!Number.isFinite(mid) || mid <= 0) return null;
  const imp = Array.isArray(ctx?.impactPxs) ? ctx.impactPxs.map(Number) : [];
  if (imp.length < 2) return null;
  const [bid, ask] = imp;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  if (ask < bid) return null;
  return ((ask - bid) / mid) * 10000;
}

/**
 * Во что обходится круг (вход+выход) и какую долю бюджета риска он съедает.
 *
 * Это ЕДИНСТВЕННОЕ число, ради которого карточка существует: на BTC круг стоит
 * 4% бюджета риска, на HMSTR — 31%. Разница между «нормальная монета» и «хлам»
 * тут измеримая, а не вкусовая.
 *
 * @param {number} spreadBp    — трение книги
 * @param {number} notionalUsd — размер позиции
 * @param {number} riskUsd     — сколько оператор готов потерять на этой сделке
 */
export function frictionCost({ spreadBp, notionalUsd, riskUsd }) {
  const bp = Number(spreadBp);
  const n = Number(notionalUsd);
  if (!Number.isFinite(bp) || bp < 0 || !Number.isFinite(n) || n <= 0) return null;
  const totalBp = bp + ROUND_TRIP_FEE_BP;
  const costUsd = (n * totalBp) / 10000;
  const r = Number(riskUsd);
  return {
    totalBp,
    costUsd,
    pctOfRisk: Number.isFinite(r) && r > 0 ? (costUsd / r) * 100 : null,
  };
}

/**
 * Движение монеты по локальному буферу цен — HL не дёргаем вообще.
 * Буфер короткий, поэтому окна нет → null, а не ноль (ноль соврал бы «стоит»).
 */
/**
 * Размах (max−min) за N минут в бп. 🚨 Не путать с движением: рывок направлен
 * и хуже случайного входа, размах ненаправлен и автокоррелирован (0.25).
 */
function localRangeBp(coin, minutes) {
  const s = getSamplesSince(coin, minutes);
  if (s.length < 3) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (const x of s) {
    if (x.price > hi) hi = x.price;
    if (x.price < lo) lo = x.price;
  }
  const ref = getLatestPrice(coin);
  if (!(ref > 0) || !(hi > lo)) return null;
  return ((hi - lo) / ref) * 10000;
}

function localMove(coin, minutes) {
  const now = getLatestPrice(coin);
  const then = getPriceNMinAgo(coin, minutes);
  if (!(now > 0) || !(then > 0)) return null;
  return ((now - then) / then) * 100;
}

/**
 * Твоя история по каждой монете: сколько раз торговал, с каким итогом.
 *
 * Зачем в этой карточке: разбор 703 сделок показал монеты, на
 * которых оператор теряет систематически — CASHCAT 148 сделок при winrate 61% и
 * итоге −$6.21 (выигрыши вдвое мельче проигрышей), HMSTR −$26 за 34 сделки.
 * Это ЕДИНСТВЕННЫЙ вид «сигнала», который карточка себе позволяет, потому что
 * он не про рынок, а про самого оператора — и потому проверяем.
 *
 * Кэш общий с экраном (120с): чтение локальной БД дешёвое, но дёргать её на
 * каждый рендер незачем.
 *
 * @returns {Map<string, {n:number, pnl:number, wr:number}>}
 */
export function buildTrackRecord(limit = 2000) {
  const byCoin = new Map();
  let rows;
  try {
    rows = getHistory(limit);
  } catch (err) {
    logger.debug(`[Screen] track record read failed: ${err.message}`);
    return byCoin;
  }
  for (const r of rows) {
    if (r.mode !== "PRODUCTION") continue;
    const key = String(r.coin || "").toUpperCase();
    if (!key) continue;
    const acc = byCoin.get(key) || { n: 0, pnl: 0, wins: 0 };
    acc.n += 1;
    acc.pnl += Number(r.realized_pnl) || 0;
    if ((Number(r.realized_pnl) || 0) > 0) acc.wins += 1;
    byCoin.set(key, acc);
  }
  for (const [, v] of byCoin) {
    v.wr = v.n > 0 ? (v.wins / v.n) * 100 : null;
    delete v.wins;
  }
  return byCoin;
}

/**
 * Бюджет дня — счётчик, который не даёт незаметно уйти в двадцатый вход.
 *
 * Сделки считаем по закрытым за сегодня плюс открытые сейчас: оператор спрашивает
 * «сколько я уже сделал», а не «сколько закрыл».
 */
export function buildBudget(now = Date.now()) {
  const day = getLastDailyRiskStatus();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const startMs = dayStart.getTime();

  let closedToday = 0;
  try {
    closedToday = getHistory(500).filter(
      (r) => r.mode === "PRODUCTION" && r.closed_at >= startMs,
    ).length;
  } catch (err) {
    logger.debug(`[Screen] history read failed: ${err.message}`);
  }

  let openNow = 0;
  try {
    openNow = getActiveAdoptPositions().length + (getActivePosition() ? 1 : 0);
  } catch {
    /* нет БД — счётчик просто не досчитает открытые */
  }

  const equity = getCachedAccountValueSync();
  const netUsd = day?.netUsd ?? null;
  const limitUsd = day?.limitUsd ?? config.trading.dailyLossLimitUsd;

  return {
    tradesToday: closedToday + openNow,
    tradesCap: config.trading.screenTradesPerDay,
    netUsd,
    limitUsd,
    // Сколько ещё можно потерять сегодня до дневного стопа. netUsd в плюсе →
    // весь лимит цел (запас сверх лимита не накапливаем — это был бы соблазн
    // «сегодня можно больше», ровно та техника, от которой уходим).
    remainingUsd:
      netUsd == null ? null : Math.max(0, limitUsd + Math.min(0, netUsd)),
    halted: !!day?.halted,
    known: !!day,
    equity: Number.isFinite(equity) && equity > 0 ? equity : null,
    riskPct: config.trading.adoptRiskPct,
  };
}

/**
 * Собирает экран: универс → фильтр по трению → сортировка по |движению|.
 * Сортировка по движению, а НЕ по ликвидности: внутри отобранного списка все
 * монеты уже приемлемы по цене входа, и интересно, что из них шевелится.
 */
export async function buildScreenPayload() {
  const maxBp = frictionThresholdBp();
  const notional = config.trading.screenNotionalUsd;
  const equity = getCachedAccountValueSync();
  const riskUsd =
    Number.isFinite(equity) && equity > 0
      ? (equity * config.trading.adoptRiskPct) / 100
      : null;

  const res = await hlInfo({ type: "metaAndAssetCtxs" }, { priority: HL_PRIORITY.LOW });
  const [meta, ctxs] = Array.isArray(res) ? res : [null, null];
  if (!meta?.universe || !Array.isArray(ctxs)) {
    throw new Error("metaAndAssetCtxs: unexpected shape");
  }

  const track = buildTrackRecord();
  const coins = [];
  let considered = 0;
  meta.universe.forEach((u, i) => {
    if (!u || u.isDelisted) return;
    const ctx = ctxs[i];
    if (!ctx) return;
    const mid = Number(ctx.midPx);
    if (!(mid > 0)) return;
    considered += 1;

    const spreadBp = impactSpreadBp(ctx, mid);
    if (spreadBp == null || spreadBp > maxBp) return;

    const prev = Number(ctx.prevDayPx);
    const cost = frictionCost({ spreadBp, notionalUsd: notional, riskUsd });

    coins.push({
      coin: u.name,
      price: mid,
      // 24ч — из биржевого контекста; короткие окна — из локального буфера,
      // который наполняется WS-фидом и ничего не стоит.
      chg24hPct: prev > 0 ? ((mid - prev) / prev) * 100 : null,
      chg15mPct: localMove(u.name, 15),
      chg1hPct: localMove(u.name, 60),
      range1hBp: localRangeBp(u.name, 60),
      spreadBp,
      frictionBp: cost?.totalBp ?? null,
      frictionUsd: cost?.costUsd ?? null,
      frictionPctOfRisk: cost?.pctOfRisk ?? null,
      volume24hUsd: Number(ctx.dayNtlVlm) || null,
      maxLeverage: u.maxLeverage ?? null,
      // Круг лимиткой: комиссия мейкера в обе стороны, спреда нет.
      makerFrictionBp: MAKER_ROUND_TRIP_BP,
      makerFrictionUsd: (notional * MAKER_ROUND_TRIP_BP) / 10000,
      // Фандинг за час, в процентах — знак говорит, кто кому платит.
      fundingPct: Number.isFinite(Number(ctx.funding)) ? Number(ctx.funding) * 100 : null,
      oiUsd: Number(ctx.openInterest) > 0 ? Number(ctx.openInterest) * mid : null,
      // Расстановка и профиль часов — с Binance, могут быть null: пары нет
      // либо свип ещё не дошёл до этой монеты.
      pos: getPositioning(u.name),
      hours: getHourProfile(u.name),
      // Твой послужной список по этой монете — null, если ни разу не торговал.
      mine: track.get(String(u.name).toUpperCase()) ?? null,
    });
  });

  // 🚨 Ранг не по |рывку|: сортировка по движению делает из экрана hot movers,
  // а вход по рывку хуже случайного. Размах/трение — обе части измеримы.
  const payoff = (c) =>
    c.range1hBp > 0 && c.frictionBp > 0 ? c.range1hBp / c.frictionBp : -1;
  coins.forEach((c) => { c.payoff = payoff(c) > 0 ? +payoff(c).toFixed(2) : null; });
  coins.sort((a, b) => payoff(b) - payoff(a));

  // Досбор расстановки в фоне, в порядке экрана: верхние монеты обновятся
  // первыми. Ответ не ждёт — на этом рендере поля будут прошлыми, на
  // следующем свежими. Ошибку глотаем: экран живёт и без расстановки.
  sweepPositioning(coins.map((c) => c.coin)).catch(() => {});

  return {
    ok: true,
    thresholdBp: maxBp,
    notionalUsd: notional,
    riskUsd,
    takerRoundTripBp: ROUND_TRIP_FEE_BP,
    makerRoundTripBp: MAKER_ROUND_TRIP_BP,
    passed: coins.length,
    considered,
    coins,
    budget: buildBudget(),
    at: Date.now(),
  };
}

/** GET /api/screen */
/**
 * Живой срез по монете из кэша экрана: спред и цена меняются за минуты, а
 * сетка калибратора пересчитывается раз в 12 часов. Отдаём то, что уже
 * посчитано — своего запроса к HL это не стоит.
 */
export function liveCoinSnapshot(coin) {
  const row = cache.payload?.coins?.find((c) => c.coin === String(coin).toUpperCase());
  if (!row) return null;
  return {
    price: row.price,
    spreadBp: row.spreadBp,
    range1hBp: row.range1hBp,
    payoff: row.payoff,
    ageMs: Date.now() - cache.builtAt,
  };
}

export async function handleScreen(_req, res) {
  const now = Date.now();
  if (cache.payload && now - cache.builtAt < CACHE_TTL_MS) {
    // Бюджет и короткие окна живут быстрее ликвидности — пересчитываем их
    // поверх кэша, они локальные и бесплатные.
    res.json({ ...cache.payload, budget: buildBudget(), cached: true });
    return;
  }
  try {
    const payload = await buildScreenPayload();
    cache = { payload, builtAt: now };
    res.json(payload);
  } catch (err) {
    logger.warn(`[Screen] build failed: ${err.message}`);
    if (cache.payload) {
      res.json({ ...cache.payload, budget: buildBudget(), stale: true });
      return;
    }
    // Кэша ещё нет (первый заход после старта) — честно говорим причину, фронт
    // покажет её и продолжит опрашивать. Чаще всего это весовой лимит HL.
    res.json({
      ok: false,
      reason: "build-failed",
      message: String(err?.message || err).slice(0, 200),
      budget: buildBudget(),
    });
  }
}
