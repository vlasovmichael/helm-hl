// ─────────────────────────────────────────────────
//  Entry filter — «куда входить нельзя», JSON для карточки на /oi.html
// ─────────────────────────────────────────────────
// Гипотеза `entry-into-continuation`: вход В СТОРОНУ уже случившегося сильного
// движения даёт результат хуже, чем вход против него.
//
// ⚠️ Карточка НИЧЕГО не предсказывает и монету не выбирает. Она отвечает на
// один вопрос: «эта сторона по этой монете сейчас — вход по движению или против
// него». Гипотеза post-hoc, поэтому до 60 новых сделок вердикт — метка для
// форвард-замера, а не рекомендация.
//
// Дёшево по сети: тренды берутся из priceHistory (кольцевой буфер в памяти,
// который и так наполняет scout), свечи не тянутся вообще — карточка не может
// устроить шторм candleSnapshot (грабли 429 / голодания пула HL).

import { state } from '../../../app/state.js';
import { logger } from '../../../core/logger.js';
import { getPriceNMinAgo, getLatestPrice } from '../../../core/priceHistory.js';
import { getPositionsCached } from '../../exchange.js';
import { getHistorySince } from '../../../core/database.js';

// Пороги. STRONG_1H — из журнала: срез |тренд 1ч| ≥ 3% и есть, и статистически
// заметен; ниже него разделения в данных нет, поэтому фильтр там молчит, а не
// придумывает вердикт.
export const EF = {
  STRONG_1H: 3,        // % за час — «сильное движение»
  EXTREME_1H: 5,       // % за час — худший срез журнала (−0.487 на сделку)
  STRONG_15M: 1.5,     // % за 15 мин — быстрый разгон
  MIN_COINS: 8,        // сколько строк отдаём в карточку
  FORWARD_TARGET: 60,  // стоп-правило гипотезы: оценка ровно один раз на 60 сделках
  REGISTERED_AT: Date.parse('2026-09-02T20:00:00.000Z'),
};

/** Тренд в % за N минут из буфера цен. null, если истории не хватает. */
function trendPct(coin, minutes, now, price) {
  const past = getPriceNMinAgo(coin, minutes, now);
  if (!(past > 0)) return null;
  const p = price > 0 ? price : getLatestPrice(coin);
  if (!(p > 0)) return null;
  return ((p - past) / past) * 100;
}

/**
 * Вердикт по монете. Возвращает, какая сторона сейчас «по движению» (её фильтр
 * помечает), какая «против», и насколько сильно движение.
 *
 * Намеренно НЕ говорит «входи в fade»: отсутствие метки — это не сигнал, а
 * молчание. Единственное утверждение карточки — «вот эта сторона в журнале
 * стоила дорого».
 */
export function classify({ trend1h, trend15m }) {
  const t1 = trend1h, t15 = trend15m;
  const strong = t1 != null && Math.abs(t1) >= EF.STRONG_1H;
  const extreme = t1 != null && Math.abs(t1) >= EF.EXTREME_1H;
  const fast = t15 != null && Math.abs(t15) >= EF.STRONG_15M;

  if (!strong && !fast) {
    // 🚨 Текст уезжает в карточку на /oi — страница английская целиком.
    return { level: 'quiet', blockedSide: null, allowedSide: null,
             text: 'Quiet: no strong move, the filter says nothing' };
  }
  const dir = (strong ? t1 : t15) > 0 ? 'LONG' : 'SHORT';   // сторона «по движению»
  const level = extreme ? 'extreme' : strong ? 'strong' : 'fast';
  const move = strong ? `${t1 > 0 ? '+' : ''}${t1.toFixed(1)}% in an hour` : `${t15 > 0 ? '+' : ''}${t15.toFixed(1)}% in 15 min`;
  return {
    level,
    blockedSide: dir,
    allowedSide: dir === 'LONG' ? 'SHORT' : 'LONG',
    text: extreme
      ? `${move} — the journal's worst slice (−0.49 per trade). Entering ${dir} is entering a move that already happened`
      : `${move} — entering ${dir} goes with the move; in the journal that returned −0.18 against −0.05 for entering against it`,
  };
}

/** Открытые позиции с биржи → COIN → сторона. Источник правды — биржа, не БД. */
async function loadPositions() {
  try {
    const raw = await getPositionsCached();
    const map = new Map();
    for (const ap of raw || []) {
      const p = ap?.position;
      const szi = parseFloat(p?.szi ?? NaN);
      if (!p?.coin || !Number.isFinite(szi) || szi === 0) continue;
      map.set(p.coin.toUpperCase(), { side: szi < 0 ? 'SHORT' : 'LONG', unrealizedPnl: parseFloat(p.unrealizedPnl ?? 0) });
    }
    return map;
  } catch (err) {
    logger.debug(`[EntryFilter] positions read failed: ${err.message}`);
    return new Map();
  }
}

/**
 * Прогресс форвард-замера. Гипотеза post-hoc, поэтому смотреть на неё можно
 * ровно один раз — когда наберётся FORWARD_TARGET сделок, открытых ПОСЛЕ
 * регистрации. Здесь считается только счётчик, но не результат: показывать
 * промежуточный итог значит вернуть optional stopping, ради защиты от которого
 * стоп-правило и заводилось.
 */
function forwardProgress() {
  try {
    const rows = getHistorySince(EF.REGISTERED_AT) || [];
    const n = rows.filter((r) => r.mode === 'PRODUCTION' && r.strategy_id === 'adopt'
                              && (r.entry_time ?? r.closed_at) >= EF.REGISTERED_AT).length;
    return { n, target: EF.FORWARD_TARGET };
  } catch {
    return { n: null, target: EF.FORWARD_TARGET };
  }
}

export function buildEntryFilter(marketRows, positions, now = Date.now()) {
  const rows = [];
  for (const r of marketRows || []) {
    const coin = String(r?.coin || '').toUpperCase();
    if (!coin || !(r.price > 0)) continue;
    const trend1h = trendPct(coin, 60, now, r.price);
    const trend15m = trendPct(coin, 15, now, r.price);
    if (trend1h == null && trend15m == null) continue;      // буфер пуст — судить не о чем
    const verdict = classify({ trend1h, trend15m });
    const pos = positions.get(coin) || null;
    rows.push({
      coin,
      price: r.price,
      dayChangePct: r.dayChangePct ?? null,
      trend1h,
      trend15m,
      ...verdict,
      position: pos,
      // сидит ли оператор ПРЯМО СЕЙЧАС в стороне, которую фильтр пометил
      holdingBlocked: !!(pos && verdict.blockedSide && pos.side === verdict.blockedSide),
    });
  }

  const rank = { extreme: 3, strong: 2, fast: 1, quiet: 0 };
  rows.sort((a, b) =>
    (b.holdingBlocked - a.holdingBlocked) ||
    (rank[b.level] - rank[a.level]) ||
    (Math.abs(b.trend1h ?? 0) - Math.abs(a.trend1h ?? 0)));

  return {
    rows: rows.slice(0, EF.MIN_COINS),
    flagged: rows.filter((r) => r.level !== 'quiet').length,
    holdingBlocked: rows.filter((r) => r.holdingBlocked),
    thresholds: EF,
    scanned: rows.length,
  };
}

export async function handleEntryFilter(_req, res) {
  const now = Date.now();
  try {
    const positions = await loadPositions();
    const payload = buildEntryFilter(state.latestHunter, positions, now);
    res.json({
      ...payload,
      forward: forwardProgress(),
      marketAgeSec: state.latestHunterAt ? Math.round((now - state.latestHunterAt) / 1000) : null,
    });
  } catch (err) {
    logger.warn(`[EntryFilter] failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}
