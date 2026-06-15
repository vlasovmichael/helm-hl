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
  getActivePosition,
  getActivePaperPositionByStrategy,
  getShadowAggregate,
} from '../../core/database.js';
import { getFaderVirtualSnapshot } from '../faderVirtualEquity.js';

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
  // Carry / Chill Boy / Candy Girl-strategy удалены 2026-06-15 (убыточный трек,
  // см. memory/strategy_cull_2026_06_15.md). Carry+ChillBoy выключены флагами;
  // Candy Girl остаётся как radar-only (5m-сигналы для Setup Scanner · Swing),
  // но как ТОРГОВАЯ стратегия из таблицы убрана.
  {
    id: 'fader',
    label: 'Fader',
    kind: 'contrarian · fade-short',
    split: true,
    virtual: () => safe(getFaderVirtualSnapshot),
    resolve: () => {
      const enabled = config.trading.faderEnabled;
      return { enabled, status: enabled ? 'paper' : 'off' };
    },
  },
  {
    id: 'adopt',
    label: 'Adopt',
    kind: 'manual-entry · babysit',
    split: true,                              // ручные входы бывают и long, и short
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
  { id: 'setup_swing',   label: 'Setup Swing',   kind: 'HL-structure · swing' },
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

/**
 * Одна строка реестра → строка таблицы.
 * @param {Object} entry — запись REGISTRY
 * @param {'long'|'short'|null} [side] — если задан, строка по одной стороне
 *   (split). uid/label/kind получают суффикс, stats/pnl/signals фильтруются.
 * @param {{status?:string}} [overrides] — переопределение статуса для split-строки.
 */
function buildRow(entry, side = null, overrides = {}) {
  const r = entry.resolve();
  const status = overrides.status || r.status;
  const statMode = status === 'live' ? 'PRODUCTION' : 'PAPER';

  const stats  = getStrategyStats(entry.id, statMode, side);
  const series = getStrategyNetSeries(entry.id, statMode, 60, side);
  const edge   = computeEdge(stats, series);

  // Активная поза: live → реальный слот (если владелец совпал), иначе paper-слот.
  // Для split-строки показываем позу только если её сторона совпадает.
  let pos = null;
  if (status === 'live') {
    const slot = getActivePosition();
    if (slot && (slot.strategy_id || 'carry') === entry.id) pos = slot;
  } else if (status === 'paper' || status === 'radar') {
    pos = getActivePaperPositionByStrategy(entry.id);
  }
  if (pos && side && (pos.side || 'short').toLowerCase() !== side) pos = null;

  // Сигналы радара (если есть) — для split фильтруем по стороне.
  let lastSignalAt = stats.lastClosedAt || null;
  let signals = null;
  if (entry.signals) {
    signals = entry.signals();
    if (side && Array.isArray(signals)) {
      signals = signals.filter((s) => (s.direction || '').toLowerCase() === side);
    }
    if (Array.isArray(signals) && signals.length) {
      const ts = signals[0].ts || signals[0].at || signals[0].time;
      if (Number.isFinite(ts)) lastSignalAt = Math.max(lastSignalAt || 0, ts);
    }
  }

  // virtual (compound-песочница) — только на основной/long строке, не на short.
  const vsnap = entry.virtual && side !== 'short' ? entry.virtual() : null;

  // Shadow exits (measurement-only): сравнение реального выхода с time-decay /
  // chandelier. Пока пишется только для Hunter SHORT; для прочих вернёт null.
  const shadowAgg = getShadowAggregate(entry.id, side);
  const shadow = shadowAgg
    ? {
        n:          shadowAgg.n,
        actual:     shadowAgg.actual,
        td:         shadowAgg.td,
        chandelier: shadowAgg.chandelier,
        tdDelta:    shadowAgg.td - shadowAgg.actual,
        chDelta:    shadowAgg.chandelier - shadowAgg.actual,
        tdFired:    shadowAgg.tdFired,
        chFired:    shadowAgg.chFired,
      }
    : null;

  return {
    id:       entry.id,                        // базовый strategy_id (для REST)
    side,                                      // null | 'long' | 'short'
    uid:      side ? `${entry.id}:${side}` : entry.id,  // идентичность строки в UI
    label:    side ? `${entry.label} ${side.toUpperCase()}` : entry.label,
    kind:     side ? `${entry.kind} · ${side}${status === 'radar' ? '-only' : ''}` : entry.kind,
    status,                                    // live | paper | radar | off
    radar:    !!(r.radar || entry.radar),
    statMode,
    active:   activeSummary(pos),
    edge,
    pnl: {
      day:  getStrategyPnlSince(entry.id, statMode, startOfTodayMs(), side).net,
      week: getStrategyPnlSince(entry.id, statMode, Date.now() - 7 * DAY_MS, side).net,
      all:  edge.sumNet,
    },
    virtual:  vsnap ? { equity: vsnap.equity, pnlTotal: vsnap.pnlTotal, pnlPct: vsnap.pnlPct } : null,
    shadow,                                    // null | { n, actual, td, chandelier, tdDelta, chDelta }
    spark:    series,                         // raw net-серия (фронт делает cumsum)
    lastSignalAt,
    // recentTrades больше не шлём в WS — detail подгружает их постранично через
    // /api/strategy-trades (легче payload + пагинация при многих сделках).
    signals:  Array.isArray(signals) ? signals.slice(0, 8) : null,
  };
}

/**
 * Полный payload обзорной таблицы стратегий. Реестр + строки-заглушки будущих.
 * Кладётся в WS status-payload как `strategies`.
 */
export function buildStrategiesPayload() {
  const rows = [];
  for (const e of REGISTRY) {
    try {
      // Двусторонняя стратегия → две строки (LONG / SHORT) с тем же статусом.
      // Сравниваем стороны: какая сторона стратегии тащит, какая сливает.
      if (e.split) {
        const base = e.resolve().status;        // 'live' | 'paper' | 'off'
        rows.push(buildRow(e, 'long',  { status: base }));
        rows.push(buildRow(e, 'short', { status: base }));
      } else {
        rows.push(buildRow(e));
      }
    } catch {
      rows.push({ id: e.id, uid: e.id, label: e.label, kind: e.kind, status: 'off', edge: null, error: true });
    }
  }
  const planned = PLANNED.map((p) => ({ ...p, uid: p.id, status: 'planned' }));
  return { rows, planned, generatedAt: Date.now() };
}
