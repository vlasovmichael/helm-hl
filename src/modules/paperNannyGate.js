// ─────────────────────────────────────────────────
//  Кто из бумажных стратегий сейчас под нянькой
// ─────────────────────────────────────────────────
// 🚨 Гейты РАЗНЫЕ и связывать их нельзя. Личный журнал — тренировка выхода, его
// можно выключить и водить позы руками. Форвард по чужим прогнозам без няньки
// теряет смысл: без стопа и цели он мерил бы «вошёл и держу вечно», а не то,
// как отработало направление канала. Общий флаг однажды уже оставил сигнальные
// позы без плана выхода.

import { config } from '../core/config.js';

/** Ведёт ли нянька выход этой стратегии. */
export function isNannyOn(strategyId) {
  if (strategyId === 'tg_signal') return config.trading.tgSignalEnabled;
  if (strategyId === 'manual_paper') return config.trading.manualPaperAdoptEnabled;
  return false;
}

/** Стратегии под нянькой прямо сейчас. */
export function managedStrategies() {
  return ['manual_paper', 'tg_signal'].filter(isNannyOn);
}
