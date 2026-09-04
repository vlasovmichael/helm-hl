// ─────────────────────────────────────────────────
//  Adopt SHADOW trail — measurement-only «а если отступ мерить в риске»
// ─────────────────────────────────────────────────
// Гипотеза adopt-trail-025r (data/hypotheses/registry.json).
//
// Текущий трейл отдаёт долю ПИКА: пол = пик × (1 − 30%). Пока пик мал, буфер
// микроскопический — при пике +2% терпимый откат всего 0.6%, внутри обычного
// шума альты. Проверяемая альтернатива: отступ = 0.25 × R, где R — исходный
// риск (вход → resting-SL); такой буфер от размера пика не зависит.
//
// 🚨 Только замер: реальные выходы не трогаются, конфиг не меняется.
//
// Пишем строку в shadow_exits со strategy_id='adopt_trail' (отдельно от
// time-cut на 'adopt', иначе агрегаты смешаются):
// td_* — модель 0.25R
// ch_* — ТЕКУЩИЙ трейл, просимулированный на том же потоке тиков
// actual_* — что вышло на самом деле
// Пара td vs ch и есть предмет гипотезы: обе модели видят одни и те же цены,
// поэтому сравнение парное. Симуляция текущего трейла рядом — ещё и
// самопроверка: расходится с actual на сделках, закрытых трейлом → модель
// врёт, и разницу td−ch читать нельзя.
//
// ⚠️ Состояние in-memory: рестарт теряет пик до рестарта.
// ⚠️ Позиции без resting-SL пропускаются: без R модель не определена.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { recordShadowExit } from '../core/database.js';

const state = new Map(); // positionId → tracker

// Запись вынесена за indirection: ESM-экспорты только для чтения, подменить
// recordShadowExit в тесте нельзя, а гонять тесты по живой trades.db — плохой
// обмен. Прод использует значение по умолчанию и об этой развилке не знает.
let recorder = recordShadowExit;
export function _setShadowTrailRecorder(fn) {
  recorder = fn || recordShadowExit;
}

/** side-aware unrealized % от входа (плюс = прибыль). */
function unrealPct(position, price, entry) {
  const isShort = (position.side || 'short') === 'short';
  return isShort ? ((entry - price) / entry) * 100 : ((price - entry) / entry) * 100;
}

/**
 * Тик сопровождения открытой adopt-позы. Обе модели считаются на ОДНОМ и том же
 * потоке цен — в этом весь смысл парного замера.
 */
export function trackAdoptShadowTrailTick(position, price) {
  if (!config.trading.adoptTrailShadowEnabled) return;
  if (!Number.isFinite(price) || !position.entry_price) return;

  const id = position.id;
  let st = state.get(id);
  if (!st) {
    const entry = position.entry_price;
    // R = расстояние до реального resting-SL. Нет стопа → нет риска → нет модели.
    const riskPct = position.sl_price != null
      ? Math.abs((entry - position.sl_price) / entry) * 100
      : null;
    if (!(riskPct > 0)) {
      // Метим позицию как непригодную, чтобы не считать её заново каждый тик.
      state.set(id, { skip: true });
      return;
    }
    st = {
      skip: false,
      entry,
      riskPct,
      peakPct: 0,
      rFired: false, rPct: null, rMin: null,
      curFired: false, curPct: null, curMin: null,
      startedAt: Date.now(),
    };
    state.set(id, st);
  }
  if (st.skip) return;

  const unreal = unrealPct(position, price, st.entry);

  // ── Модель A: отступ 0.25R, взвод при пике ≥ 1R ────────────────────────
  if (!st.rFired && st.peakPct >= st.riskPct) {
    const floor = st.peakPct - config.trading.adoptShadowTrailR * st.riskPct;
    if (unreal <= floor) {
      st.rFired = true;
      st.rPct = unreal;
      st.rMin = (Date.now() - st.startedAt) / 60_000;
    }
  }

  // ── Модель B: текущий трейл (доля пика), просимулированный рядом ───────
  if (!st.curFired && st.peakPct >= config.trading.adoptTrailArmPct) {
    const floor = st.peakPct * (1 - config.trading.adoptTrailGiveBackPct / 100);
    if (unreal <= floor) {
      st.curFired = true;
      st.curPct = unreal;
      st.curMin = (Date.now() - st.startedAt) / 60_000;
    }
  }

  // Пик обновляем ПОСЛЕ проверок: иначе пол пересчитается по цене этого же
  // тика и откат от неё же никогда не сработает.
  if (unreal > st.peakPct) st.peakPct = unreal;
}

/**
 * Закрытие adopt-позы любым путём (бот/стоп/рука). Модель, не сработавшая за
 * жизнь позы, «доезжает» до реального выхода — это и есть её результат.
 */
export function finalizeAdoptShadowTrail(position, closePrice) {
  if (!config.trading.adoptTrailShadowEnabled) return;
  const st = state.get(position.id);
  if (!st) return;
  state.delete(position.id);
  if (st.skip || !Number.isFinite(closePrice)) return;

  const notional = position.size_usd || 0;
  const actualPct = unrealPct(position, closePrice, st.entry);
  const rPct = st.rFired ? st.rPct : actualPct;
  const curPct = st.curFired ? st.curPct : actualPct;

  try {
    recorder({
      position_id: position.id,
      strategy_id: 'adopt_trail',
      side: position.side || 'short',
      coin: position.coin,
      closed_at: Date.now(),
      notional_usd: notional,
      actual_pnl: (actualPct / 100) * notional,
      actual_pct: actualPct,
      td_pnl: (rPct / 100) * notional,
      td_pct: rPct,
      td_fired: st.rFired ? 1 : 0,
      td_min: st.rMin,
      ch_pnl: (curPct / 100) * notional,
      ch_pct: curPct,
      ch_fired: st.curFired ? 1 : 0,
      ch_min: st.curMin,
    });
    const sign = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
    logger.info(
      `[Adopt SHADOW-TRAIL] #${position.coin}: R=${st.riskPct.toFixed(2)}% пик ${sign(st.peakPct)} | ` +
        `0.25R ${st.rFired ? `@${st.rMin.toFixed(0)}м ${sign(rPct)}` : '(доехал)'} | ` +
        `текущий ${st.curFired ? `@${st.curMin.toFixed(0)}м ${sign(curPct)}` : '(доехал)'} | ` +
        `факт ${sign(actualPct)}`,
    );
  } catch (e) {
    logger.warn(`[Adopt SHADOW-TRAIL] record failed #${position.coin}: ${e.message}`);
  }
}

/**
 * Чистка по одной позиции. Вызывать рядом с clearAdoptState: позиции без
 * resting-SL помечены skip и сами никогда не финализируются, а Map, которая
 * только растёт, — это ровно то, чем 09.08 выбило кучу V8.
 */
export function clearAdoptShadowTrail(positionId) {
  state.delete(positionId);
}

/** Тест-хелпер: сброс состояния между прогонами. */
export function _resetAdoptShadowTrailState() {
  state.clear();
}
