// ─────────────────────────────────────────────────
//  Adopt SHADOW time-cut — measurement-only «не зеленеет — резать?»
// ─────────────────────────────────────────────────
// Стопы съедают больше, чем приносят победители, и стопнутые позы обычно не
// видели плюса вовсе: это не «выход упустил», а «вход не сработал, поза
// умирала часами». BE-arm тут не помогает, time-cut попадает.
//
// Модель: поза старше TIMECUT_MIN минут ни разу не показала MFE ≥ GREEN_PCT →
// would-be выход по текущей цене. Просимулировать честно нечем (тиковых свечей
// нет), поэтому МЕРИМ в проде, не трогая реальные выходы. Строка в
// shadow_exits на close: td_* = модель, ch_* = actual.
// Решение о живом включении — по месяцу данных, не раньше.
//
// ⚠️ Состояние in-memory: рестарт бота теряет peak до рестарта → у долгожителей
// time-cut может пальнуть заново по свежему peak. Для measurement-лога терпимо.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { recordShadowExit } from '../core/database.js';

const state = new Map(); // positionId → tracker

/** side-aware unrealized % от entry. */
function unrealPct(position, price, entry) {
  const isShort = (position.side || 'short') === 'short';
  return isShort ? ((entry - price) / entry) * 100 : ((price - entry) / entry) * 100;
}

/**
 * Вызывать на каждом тике сопровождения открытой adopt-позы (до реального выхода).
 * Детектит первое срабатывание time-cut: возраст ≥ TIMECUT_MIN и peak < GREEN_PCT.
 */
export function trackAdoptTimeCutTick(position, price) {
  if (!config.trading.adoptTimecutShadowEnabled) return;
  if (!Number.isFinite(price) || !position.entry_price) return;

  const id = position.id;
  let st = state.get(id);
  if (!st) {
    st = {
      entry:     position.entry_price,
      entryTime: position.entry_time || Date.now(),
      peakPct:   0,
      tcFired:   false, tcPct: null, tcMin: null,
    };
    state.set(id, st);
  }

  const unreal = unrealPct(position, price, st.entry);
  if (unreal > st.peakPct) st.peakPct = unreal;

  if (st.tcFired) return;
  const elapsedMin = (Date.now() - st.entryTime) / 60_000;
  if (elapsedMin >= config.trading.adoptTimecutMin && st.peakPct < config.trading.adoptTimecutGreenPct) {
    st.tcFired = true;
    st.tcPct   = unreal;
    st.tcMin   = elapsedMin;
    logger.info(
      `[Adopt SHADOW-TIMECUT] #${position.coin} ${position.side}: ${elapsedMin.toFixed(0)}м без MFE ≥ ` +
        `${config.trading.adoptTimecutGreenPct}% (peak +${st.peakPct.toFixed(2)}%) — would-be cut @ ` +
        `${unreal >= 0 ? '+' : ''}${unreal.toFixed(2)}% (реальную позу НЕ трогаю)`,
    );
  }
}

/**
 * Вызывать при закрытии adopt-позы (любой reason, любой путь: бот/стоп/рука).
 * Пишет строку сравнения в shadow_exits. Не сработал за жизнь позы → модель
 * «доехала» до реального выхода (td = actual). Идемпотентно: state удаляется.
 */
export function finalizeAdoptTimeCut(position, closePrice) {
  if (!config.trading.adoptTimecutShadowEnabled) return;
  const st = state.get(position.id);
  if (!st) return;
  state.delete(position.id);
  if (!Number.isFinite(closePrice)) return;

  const notional  = position.size_usd || 0;
  const actualPct = unrealPct(position, closePrice, st.entry);
  const tcPct     = st.tcFired ? st.tcPct : actualPct;

  try {
    recordShadowExit({
      position_id: position.id,
      strategy_id: 'adopt',
      side:        position.side || 'short',
      coin:        position.coin,
      closed_at:   Date.now(),
      notional_usd: notional,
      actual_pnl: (actualPct / 100) * notional, actual_pct: actualPct,
      td_pnl: (tcPct / 100) * notional, td_pct: tcPct, td_fired: st.tcFired ? 1 : 0, td_min: st.tcMin,
      // Второй модели у adopt нет: ch_* = actual («доехала до реального выхода»),
      // чтобы агрегат /strategies не делился на null.
      ch_pnl: (actualPct / 100) * notional, ch_pct: actualPct, ch_fired: 0, ch_min: null,
    });
    logger.info(
      `[Adopt SHADOW-TIMECUT] #${position.coin}: actual ${actualPct >= 0 ? '+' : ''}${actualPct.toFixed(2)}% | ` +
        `time-cut ${st.tcFired ? `@${st.tcMin.toFixed(0)}м ${tcPct >= 0 ? '+' : ''}${tcPct.toFixed(2)}%` : '(rode to exit)'}`,
    );
  } catch (e) {
    logger.warn(`[Adopt SHADOW-TIMECUT] record failed #${position.coin}: ${e.message}`);
  }
}

/** Тест-хелпер: сброс состояния между прогонами. */
export function _resetAdoptTimeCutState() { state.clear(); }
