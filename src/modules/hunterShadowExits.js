// ─────────────────────────────────────────────────
//  Hunter SHADOW exits — measurement-only «что было бы»
// ─────────────────────────────────────────────────
// Мерит would-be P&L двух АЛЬТЕРНАТИВНЫХ выходов, НЕ трогая реальные выходы
// Hunter SHORT'а. На каждом тике обновляем per-position состояние; на close
// фиксируем строку в shadow_exits. Агрегат показывается в /strategies.
//
// Мотивация (2026-06-14, кейс NIL): сделка пикнула +1.34% и сползла в time-stop
// −$0.75 — прибыль была, но ничем не защищена в зоне 1–2%. На бэктесте 2 сделок
// (NIL/ZEC) time-decay/chandelier не доказуемы. Поэтому собираем реальные данные
// в shadow-режиме, прежде чем что-то включать вживую.
//
// Две модели:
//   1. TIME-DECAY TP — планка профита сжимается со временем. Сделке дано окно
//      на большой профит; не доехала — порог падает, забираем что есть. Лечит
//      «медленный фейд → time-stop в минус» (шейп NIL).
//   2. CHANDELIER (ATR-trail) — трейл от лучшей цены минус N×ATR. Отступ
//      масштабируется волатильностью монеты, а не фикс-% от пика.
//
// ⚠️ ATR здесь — грубый прокси: EWMA |Δprice| по 15-сек тикам, НЕ классический
// 14-периодный ATR (тиковых баров у бота нет). Множитель/alpha — стартовая
// догадка; смысл shadow-лога ровно в том, чтобы увидеть на данных, адекватны ли
// они, и подкрутить — НЕ доверять цифре как точной.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { recordShadowExit } from '../core/database.js';

// time-decay schedule: [до N-й минуты — целевой профит%]. Подобрано под симуляцию
// NIL (пик +1.27% на 30-й мин): к 30-й мин порог 1.2% уже задевается пиком.
const TD_SCHEDULE = [
  [15, 2.0],   // 0–15 мин: ждём большой профит (как hard TP)
  [30, 1.2],   // 15–30:    планка просела
  [45, 0.6],   // 30–45:    забираем умеренный плюс
  [60, 0.2],   // 45–60:    любой осязаемый плюс перед time-stop'ом
];
const CH_ARM_PCT  = 1.0;   // chandelier активен только после пика ≥ +1% (не шумим у входа)
const CH_ATR_MULT = 3.0;   // стоп = bestPrice + N×ATR (для шорта — над минимумом)
const ATR_ALPHA   = 0.2;   // EWMA сглаживание |Δprice| (меньше = длиннее память)
const SL_FLOOR_PCT = 2.0;  // ни один shadow-выход не может быть хуже реального SL (+2%)

const state = new Map();   // positionId → tracker

function targetForElapsed(min) {
  for (const [mm, tp] of TD_SCHEDULE) if (min <= mm) return tp;
  return TD_SCHEDULE[TD_SCHEDULE.length - 1][1];
}

/**
 * Вызывать на каждом тике для открытой hunter SHORT позиции (до реального выхода).
 * Чистый учёт состояния + детект первого срабатывания каждой shadow-модели.
 */
export function trackShadowTick(position, price) {
  if (!config.trading.hunterShadowExitsEnabled) return;
  if ((position.side || 'short') !== 'short') return;  // модели заточены под short
  if (!Number.isFinite(price) || !position.entry_price) return;

  const id = position.id;
  let st = state.get(id);
  if (!st) {
    st = {
      entry:     position.entry_price,
      entryTime: position.entry_time || Date.now(),
      bestPrice: price,    // для short = минимальная цена (лучший профит)
      peakPct:   0,
      atr:       0,
      prevPrice: price,
      tdFired:   false, tdPct: null, tdMin: null,
      chFired:   false, chPct: null, chMin: null,
    };
    state.set(id, st);
  }

  const unreal = ((st.entry - price) / st.entry) * 100;  // short unrealized %
  if (unreal > st.peakPct) st.peakPct = unreal;
  if (price < st.bestPrice) st.bestPrice = price;

  const tr = Math.abs(price - st.prevPrice);
  st.atr = st.atr === 0 ? tr : ATR_ALPHA * tr + (1 - ATR_ALPHA) * st.atr;
  st.prevPrice = price;

  const elapsedMin = (Date.now() - st.entryTime) / 60_000;

  // 1. TIME-DECAY: профит дотянулся до текущего (сжимающегося) порога.
  if (!st.tdFired) {
    const tgt = targetForElapsed(elapsedMin);
    if (unreal >= tgt) {
      st.tdFired = true; st.tdPct = unreal; st.tdMin = elapsedMin;
    }
  }

  // 2. CHANDELIER: после arm — цена пробила трейл-стоп (best + N×ATR).
  if (!st.chFired && st.peakPct >= CH_ARM_PCT && st.atr > 0) {
    const stop = st.bestPrice + CH_ATR_MULT * st.atr;
    if (price >= stop) {
      st.chFired = true;
      st.chPct = ((st.entry - stop) / st.entry) * 100;
      st.chMin = elapsedMin;
    }
  }
}

/**
 * Вызывать когда реальная позиция закрывается (любой reason). Пишет строку
 * сравнения в shadow_exits. Если модель не сработала за жизнь позиции — считаем,
 * что она «доехала» до реального выхода (shadow P&L = actual). Идемпотентно:
 * состояние удаляется, повторный вызов — no-op.
 */
export function finalizeShadow(position, closePrice) {
  if (!config.trading.hunterShadowExitsEnabled) return;
  const id = position.id;
  const st = state.get(id);
  if (!st) return;
  state.delete(id);
  if (!Number.isFinite(closePrice)) return;

  const notional = position.size_usd || position.entry_equity || 50;
  const actualPct = ((st.entry - closePrice) / st.entry) * 100;

  // Не сработала → едет до реального выхода. Сработавший chandelier не может быть
  // хуже реального SL (бирж-стоп всё равно поймал бы на −SL_FLOOR_PCT).
  const tdPct = st.tdFired ? st.tdPct : actualPct;
  const chPct = st.chFired ? Math.max(st.chPct, -SL_FLOOR_PCT) : actualPct;

  try {
    recordShadowExit({
      position_id: id,
      strategy_id: position.strategy_id || 'hunter',
      side:        position.side || 'short',
      coin:        position.coin,
      closed_at:   Date.now(),
      notional_usd: notional,
      actual_pnl: (actualPct / 100) * notional, actual_pct: actualPct,
      td_pnl: (tdPct / 100) * notional, td_pct: tdPct, td_fired: st.tdFired ? 1 : 0, td_min: st.tdMin,
      ch_pnl: (chPct / 100) * notional, ch_pct: chPct, ch_fired: st.chFired ? 1 : 0, ch_min: st.chMin,
    });
    logger.info(
      `[Hunter SHADOW-EXIT] #${position.coin}: actual ${actualPct >= 0 ? '+' : ''}${actualPct.toFixed(2)}% | ` +
        `time-decay ${st.tdFired ? `@${st.tdMin.toFixed(0)}m +${st.tdPct.toFixed(2)}%` : '(rode to exit)'} | ` +
        `chandelier ${st.chFired ? `@${st.chMin.toFixed(0)}m ${chPct >= 0 ? '+' : ''}${chPct.toFixed(2)}%` : '(rode to exit)'}`,
    );
  } catch (e) {
    logger.warn(`[Hunter SHADOW-EXIT] record failed #${position.coin}: ${e.message}`);
  }
}

/** Тест-хелпер: сброс состояния между прогонами. */
export function _resetShadowState() { state.clear(); }
