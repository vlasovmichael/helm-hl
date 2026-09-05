// ─────────────────────────────────────────────────
//  Издержки исполнения — что стоит КАЖДЫЙ наш филл
// ─────────────────────────────────────────────────
// 97.2% филлов уходят тейкером по 5.2–5.8 бп там, где мейкер стоит 1.44 бп.
// Комиссии больше всего минуса по adopt, поэтому это не побочная метрика, а
// главная статья.
//
// 🚨 Мерить это можно ТОЛЬКО вперёд. Свеча знает, что делала цена, но не знает,
// стояла ли в очереди НАША лимитка, налилась ли она и сколько проскользнул наш
// стоп. На истории такие вопросы превращаются в симуляцию с допущениями.
//
// Источник данных бесплатный: филлы и так приходят по WS со всеми полями
// (crossed, fee, px, sz, dir, tid). Ни одного лишнего запроса к бирже.

import { logger } from '../core/logger.js';
import { recordFillCost, getOpenPositionByCoin } from '../core/database.js';
import { getNotifications } from '../core/notifyLog.js';

/** Окно, в котором пуш считается связанным с филлом по той же монете. */
const ALERT_WINDOW_MS = 60 * 60_000;

/** Монета филла → {coin, dex}: у builder-DEX'ов тикер приходит с префиксом. */
export function splitCoin(raw) {
  const s = String(raw || '');
  const i = s.indexOf(':');
  return i > 0 ? { coin: s.slice(i + 1), dex: s.slice(0, i) } : { coin: s, dex: null };
}

/**
 * Филл → строка издержек. Чистая функция, отсюда же и тесты.
 * @param {object} f — сырой филл HL
 * @param {{plannedSl?:number|null, alertLagMs?:number|null}} [ctx]
 * @returns {object|null} null, если филл негодный
 */
export function classifyFill(f, ctx = {}) {
  const tid = Number(f?.tid);
  const px = Number(f?.px);
  const sz = Math.abs(Number(f?.sz));
  const fee = Number(f?.fee);
  const ts = Number(f?.time);
  if (!Number.isFinite(tid) || !(px > 0) || !(sz > 0) || !Number.isFinite(fee) || !Number.isFinite(ts)) {
    return null;
  }
  const notional = px * sz;
  const { coin, dex } = splitCoin(f.coin);
  const dir = String(f.dir || '');
  const plannedSl = Number(ctx.plannedSl);

  // Проскальзывание триггера: насколько филл хуже планового стопа. Знак
  // положительный = хуже для нас, и считаем его только на закрытии.
  let slipBp = null;
  if (Number.isFinite(plannedSl) && plannedSl > 0 && dir.startsWith('Close ')) {
    const isCloseLong = dir.includes('Long'); // закрытие лонга = продажа
    const worse = isCloseLong ? plannedSl - px : px - plannedSl;
    slipBp = (worse / plannedSl) * 10000;
  }

  return {
    tid,
    ts,
    coin,
    dex,
    dir,
    is_open: dir.startsWith('Open ') ? 1 : 0,
    side: f.side ?? null,
    px,
    sz,
    notional,
    fee,
    fee_bp: (fee / notional) * 10000,
    crossed: f.crossed ? 1 : 0,
    hour_utc: new Date(ts).getUTCHours(),
    oid: Number.isFinite(Number(f.oid)) ? Number(f.oid) : null,
    planned_sl: Number.isFinite(plannedSl) && plannedSl > 0 ? plannedSl : null,
    slip_bp: slipBp,
    alert_lag_ms: Number.isFinite(ctx.alertLagMs) ? ctx.alertLagMs : null,
  };
}

/** Задержка от ближайшего пуша по этой же монете, мс. null — пуша не было. */
export function alertLagFor(coin, ts, notifications) {
  let best = null;
  for (const n of notifications || []) {
    if (!Number.isFinite(n?.ts) || n.ts > ts || ts - n.ts > ALERT_WINDOW_MS) continue;
    const text = `${n.title ?? ''} ${n.message ?? ''} ${n.body ?? ''}`.toUpperCase();
    if (!text.includes(String(coin).toUpperCase())) continue;
    if (best == null || n.ts > best) best = n.ts;
  }
  return best == null ? null : ts - best;
}

/**
 * Записать издержки филла. Best-effort: сбор данных не должен ронять торговлю.
 * @returns {boolean} записана ли новая строка
 */
export function recordFill(f) {
  try {
    const { coin } = splitCoin(f?.coin);
    // Плановый стоп читаем ДО того, как integrity закроет позу: пока филл
    // обрабатывается, строка ещё OPEN, и в ней лежит цена реального ордера.
    let plannedSl = null;
    try {
      plannedSl = getOpenPositionByCoin(coin)?.sl_price ?? null;
    } catch { /* позы нет — не беда */ }

    let alertLagMs = null;
    try {
      alertLagMs = alertLagFor(coin, Number(f?.time), getNotifications(200));
    } catch { /* журнал пушей недоступен — не беда */ }

    const row = classifyFill(f, { plannedSl, alertLagMs });
    if (!row) return false;
    return recordFillCost(row);
  } catch (err) {
    logger.debug(`[ExecCosts] запись филла не удалась: ${err.message}`);
    return false;
  }
}

/**
 * Сводка по строкам издержек. Чистая функция — её же зовут CLI и витрина.
 * @param {Array} rows
 */
export function summarizeCosts(rows) {
  const n = rows.length;
  if (!n) return { n: 0 };
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const maker = rows.filter((r) => !r.crossed);
  const taker = rows.filter((r) => r.crossed);
  const slips = rows.map((r) => r.slip_bp).filter(Number.isFinite);
  const sorted = [...slips].sort((a, b) => a - b);

  // Стоимость часа: терциль дешёвых против терциля дорогих по средней комиссии.
  const byHour = new Map();
  for (const r of rows) {
    if (!byHour.has(r.hour_utc)) byHour.set(r.hour_utc, []);
    byHour.get(r.hour_utc).push(r.fee_bp);
  }
  const hours = [...byHour.entries()]
    .map(([h, a]) => ({ hour: h, n: a.length, feeBp: mean(a) }))
    .filter((h) => h.n >= 5)
    .sort((a, b) => a.feeBp - b.feeBp);
  const cut = Math.max(1, Math.floor(hours.length / 3));

  return {
    n,
    makerShare: (maker.length / n) * 100,
    feeBpAll: mean(rows.map((r) => r.fee_bp)),
    feeBpMaker: mean(maker.map((r) => r.fee_bp)),
    feeBpTaker: mean(taker.map((r) => r.fee_bp)),
    feesPaid: rows.reduce((s, r) => s + r.fee, 0),
    notional: rows.reduce((s, r) => s + r.notional, 0),
    slip: slips.length
      ? { n: slips.length, mean: mean(slips), median: sorted[sorted.length >> 1] }
      : { n: 0 },
    alertLag: (() => {
      const lags = rows.map((r) => r.alert_lag_ms).filter(Number.isFinite);
      const s = [...lags].sort((a, b) => a - b);
      return lags.length ? { n: lags.length, medianSec: s[s.length >> 1] / 1000 } : { n: 0 };
    })(),
    hours: { cheap: hours.slice(0, cut), dear: hours.slice(-cut).reverse(), counted: hours.length },
  };
}
