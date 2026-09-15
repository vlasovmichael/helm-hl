// ─────────────────────────────────────────────────
//  /api/trade-journal — торговый журнал по закрытым PRODUCTION-сделкам
// ─────────────────────────────────────────────────
import { getAllTradesMerged } from '../../../core/database.js';
import { logger } from '../../../core/logger.js';
import { buildTradeJournal } from '../../tradeJournal.js';

export function handleTradeJournal(_req, res) {
  try {
    res.json(buildTradeJournal(getAllTradesMerged('PRODUCTION')));
  } catch (err) {
    logger.warn(`[Dashboard] /api/trade-journal error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}
