// ─────────────────────────────────────────────────
//  Strategies View — единый обзор всех стратегий для /strategies
// ─────────────────────────────────────────────────
// Одна большая таблица: строка = стратегия. Реестр-driven — добавить будущую
// стратегию = одна запись в REGISTRY (или PLANNED для зарезервированного места).
//
// Источник данных уже существует: history (mode PRODUCTION/PAPER) per strategy_id,
// независимые paper shadow-слоты (getActivePaperPositionByStrategy), virtual-equity
// снапшоты compound-песочниц. Здесь это сводится в один payload для дашборда.
//
// Статусы: live (реальные prod-сделки) · paper (накопление в shadow-слоте) ·
// radar (только сигналы, торгует виртуально) · off (флаг выключен) ·
// planned (место под будущую стратегию, кода ещё нет).

import { config } from '../../core/config.js';
import {
  getStrategyStats,
  getStrategyPnlSince,
  getStrategyNetSeries,
  getRecentStrategyTrades,
  getActivePosition,
  getActivePaperPositionByStrategy,
} from '../../core/database.js';
import { getVirtualEquitySnapshot } from '../chillBoyVirtualEquity.js';
import { getCandyGirlVirtualEquitySnapshot } from '../candyGirlVirtualEquity.js';
import { getFaderVirtualSnapshot } from '../faderVirtualEquity.js';
import { getCandyGirlSignals } from '../strategistCandyGirl.js';
import { getChillBoySignals } from '../strategistTrendFollow.js';

const DAY_MS = 86_400_000;

function startOfTodayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Реестр стратегий. `kind` — короткий тег стиля. `resolve()` отдаёт runtime-статус
 * (читает config-флаги + слоты). `virtual()` — снапшот compound-песочницы (или null).
 * Добавление будущей стратегии: новая запись здесь.
 */
const REGISTRY = [
  {
    id: 'hunter',
    label: 'Hunter SHORT',
    kind: 'momentum · short',
    resolve: () => {
      const enabled = config.trading.hunterEnabled;
      const live = config.isProduction && config.trading.hunterProdEnabled;
      return { enabled, status: !enabled ? 'off' : live ? 'live' : 'paper' };
    },
  },
  {
    id: 'hunter_long',
    label: 'Hunter LONG',
    kind: 'momentum · long',
    resolve: () => {
      const enabled = config.trading.hunterLongEnabled;
      const live = config.isProduction && config.trading.hunterLongProdEnabled;
      return { enabled, status: !enabled ? 'off' : live ? 'live' : 'paper' };
    },
  },
  {
    id: 'carry',
    label: 'Carry (дед)',
    kind: 'mean-reversion · funding',
    resolve: () => {
      const enabled = config.trading.carryEnabled !== false;
      const live = config.isProduction && config.trading.carryProdEnabled;
      return { enabled, status: !enabled ? 'off' : live ? 'live' : 'paper' };
    },
  },
  {
    id: 'trend_follow',
    label: 'Chill Boy',
    kind: 'trend-follow',
    virtual: () => safe(getVirtualEquitySnapshot),
    signals: () => safe(getChillBoySignals) || [],
    resolve: () => {
      const enabled = config.trading.chillBoyEnabled;
      const live = config.isProduction && config.trading.chillBoyProdEnabled;
      return { enabled, status: !enabled ? 'off' : live ? 'live' : 'paper' };
    },
  },
  {
    id: 'candy_girl',
    label: 'Candy Girl',
    kind: 'radar · pullback-reclaim',
    radar: true,
    virtual: () => safe(getCandyGirlVirtualEquitySnapshot),
    signals: () => safe(getCandyGirlSignals) || [],
    resolve: () => {
      const enabled = config.trading.candyGirlEnabled;
      // Candy Girl всегда radar+paper (prod-гейт лишь глушит shadow-слот).
      return { enabled, status: enabled ? 'paper' : 'off', radar: true };
    },
  },
  {
    id: 'fader',
    label: 'Fader',
    kind: 'contrarian · fade',
    virtual: () => safe(getFaderVirtualSnapshot),
    resolve: () => {
      const enabled = config.trading.faderEnabled;
      return { enabled, status: enabled ? 'paper' : 'off' };
    },
  },
  {
    id: 'adopt',
    label: 'Adopt (нянька)',
    kind: 'ручной вход · сопровождение',
    resolve: () => {
      const enabled = config.trading.adoptEnabled;
      // Подхватывает РУЧНЫЕ позы и ведёт их вживую → live, своих сделок не открывает.
      return { enabled, status: enabled ? 'live' : 'off' };
    },
  },
];

// Зарезервированное место под будущие стратегии (кода ещё нет).
const PLANNED = [
  { id: 'vulture',       label: 'Vulture',       kind: 'liquidation sniper' },
  { id: 'setup_swing',   label: 'Setup Swing',   kind: 'HL-структура · свинг' },
];

/** Безопасный вызов опционального источника (модуль может быть не инициализирован). */
function safe(fn) {
  try { return fn(); } catch { return null; }
}

/** payoff / expectancy / maxDD из stats + серии net-P&L. */
function computeEdge(stats, series) {
  const expectancy = stats.n > 0 ? stats.avgNet : null;
  const payoff = stats.avgLoss < 0 ? stats.avgWin / Math.abs(stats.avgLoss) : null;

  // Max drawdown по кумулятивной кривой net-P&L (в $).
  let cum = 0, peak = 0, maxDd = 0;
  for (const net of series) {
    cum += net;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    trades:     stats.n,
    winRate:    stats.winRate,
    expectancy,
    payoff,
    maxDd:      maxDd > 0 ? -maxDd : 0,
    sumNet:     stats.sumNet,
  };
}

/** Краткая сводка активной позиции (slot или paper-slot) или null. */
function activeSummary(pos) {
  if (!pos) return null;
  return {
    coin:       pos.coin,
    side:       (pos.side || 'short').toUpperCase(),
    sizeUsd:    pos.size_usd,
    entryPrice: pos.entry_price,
    entryTime:  pos.entry_time,
    heldHours:  (Date.now() - pos.entry_time) / 3_600_000,
  };
}

/** Одна строка реестра → строка таблицы. */
function buildRow(entry) {
  const r = entry.resolve();
  const statMode = r.status === 'live' ? 'PRODUCTION' : 'PAPER';

  const stats  = getStrategyStats(entry.id, statMode);
  const series = getStrategyNetSeries(entry.id, statMode, 60);
  const edge   = computeEdge(stats, series);

  // Активная поза: live → реальный слот (если владелец совпал), иначе paper-слот.
  let pos = null;
  if (r.status === 'live') {
    const slot = getActivePosition();
    if (slot && (slot.strategy_id || 'carry') === entry.id) pos = slot;
  } else if (r.status === 'paper' || r.status === 'radar') {
    pos = getActivePaperPositionByStrategy(entry.id);
  }

  // Возраст последнего сигнала (radar) — из последнего сигнала, иначе last trade.
  let lastSignalAt = stats.lastClosedAt || null;
  let signals = null;
  if (entry.signals) {
    signals = entry.signals();
    if (Array.isArray(signals) && signals.length) {
      const ts = signals[0].ts || signals[0].at || signals[0].time;
      if (Number.isFinite(ts)) lastSignalAt = Math.max(lastSignalAt || 0, ts);
    }
  }

  const vsnap = entry.virtual ? entry.virtual() : null;

  return {
    id:       entry.id,
    label:    entry.label,
    kind:     entry.kind,
    status:   r.status,                       // live | paper | radar | off
    radar:    !!(r.radar || entry.radar),
    statMode,
    active:   activeSummary(pos),
    edge,
    pnl: {
      day:  getStrategyPnlSince(entry.id, statMode, startOfTodayMs()).net,
      week: getStrategyPnlSince(entry.id, statMode, Date.now() - 7 * DAY_MS).net,
      all:  edge.sumNet,
    },
    virtual:  vsnap ? { equity: vsnap.equity, pnlTotal: vsnap.pnlTotal, pnlPct: vsnap.pnlPct } : null,
    spark:    series,                         // raw net-серия (фронт делает cumsum)
    lastSignalAt,
    recentTrades: getRecentStrategyTrades(entry.id, statMode, 8),
    signals:  Array.isArray(signals) ? signals.slice(0, 8) : null,
  };
}

/**
 * Полный payload обзорной таблицы стратегий. Реестр + строки-заглушки будущих.
 * Кладётся в WS status-payload как `strategies`.
 */
export function buildStrategiesPayload() {
  const rows = REGISTRY.map((e) => {
    try {
      return buildRow(e);
    } catch {
      return { id: e.id, label: e.label, kind: e.kind, status: 'off', edge: null, error: true };
    }
  });
  const planned = PLANNED.map((p) => ({ ...p, status: 'planned' }));
  return { rows, planned, generatedAt: Date.now() };
}
