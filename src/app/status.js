// ─────────────────────────────────────────────────
//  Status Collector — данные для кнопки "📊 Статус"
// ─────────────────────────────────────────────────

import { config } from '../core/config.js';
import { getActivePosition, getHistory } from '../core/database.js';
import { getAccountSummary, getMarkPrice } from '../modules/exchange.js';
import { getAvailableBalance } from '../modules/wallet.js';
import { state } from './state.js';

/**
 * Фабрика: создаёт async-функцию для setStatusCollector().
 * @returns {() => Promise<Object>}
 */
export function createStatusCollector() {
  return async () => {
    const position = getActivePosition();
    const history  = getHistory(1000);

    let equity = 0, available = 0;
    try {
      if (config.isProduction) {
        const summary = await getAccountSummary();
        equity    = summary.equity;
        available = summary.available;
      } else {
        available = await getAvailableBalance();
        equity    = available;
      }
    } catch {
      // покажем $0
    }

    let unrealizedPnl = 0;
    let markPrice = null;
    if (position) {
      try {
        markPrice = await getMarkPrice(position.coin);
        if (markPrice != null) {
          const qty = position.size_usd / position.entry_price;
          unrealizedPnl = (position.entry_price - markPrice) * qty;
        }
      } catch {
        // не критично
      }
    }

    const realizedPnl = history.reduce((s, t) => s + t.realized_pnl, 0);

    const sessionProfit = state.sessionStartEquity > 0
      ? equity - state.sessionStartEquity
      : 0;

    return {
      equity,
      available,
      unrealizedPnl,
      markPrice,
      activePosition:  position,
      uptimeMin:       Math.round((Date.now() - state.startedAt) / 60_000),
      closedTrades:    history.length,
      openTrades:      position ? 1 : 0,
      realizedPnl,
      sessionProfit,
      sessionStartEquity: state.sessionStartEquity,
    };
  };
}
