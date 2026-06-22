// ─────────────────────────────────────────────────
//  «Бумажный adopt» — бот ведёт ВЫХОД личных бумажных поз (manual_paper)
// ─────────────────────────────────────────────────
// Тренировка выходной логики бота на СВОИХ входах, без реальных денег. Та же
// механика, что у реального adopt (см. strategistAdopt.analyzeAdopt): BE-храповик
// + трейл. Плюс ВИРТУАЛЬНЫЙ жёсткий стоп (sl_price, проставлен ATR-ом при открытии
// в routes/manualPaper.handleOpen) — у бумаги нет биржевого resting-SL, поэтому
// жёсткий стоп исполняем здесь сами.
//
// Гейт: MANUAL_PAPER_ADOPT_ENABLED. Работает и в PROD-, и в PAPER-боте (бумажные
// позы живут независимо от режима). Закрытие — закладка в history (closePosition),
// как у любой paper-стратегии → попадает в архив строки manual_paper в Strategies.
// Тихо (без ntfy): сделки молчат (feedback_quiet_tg), исход виден в архиве/Active.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActiveManualPaperPositions, closePosition } from '../core/database.js';
import { getLivePrice } from '../modules/exchange.js';
import { analyzeAdopt, clearAdoptState, consumeAdoptMfeMae } from '../modules/strategistAdopt.js';
import { calcPnl, FEE_RATE } from '../modules/executor/math.js';

/** Сработал ли виртуальный жёсткий стоп. */
function hardStopHit(pos, price) {
  if (!Number.isFinite(pos.sl_price) || pos.sl_price <= 0) return false;
  return (pos.side || 'long') === 'short' ? price >= pos.sl_price : price <= pos.sl_price;
}

/** Закрывает бумажную позу по fillPrice, пишет в history, чистит trail-state. */
function closePaper(pos, fillPrice, reason) {
  const now = Date.now();
  const holdHours = (now - pos.entry_time) / 3_600_000;
  const { realizedPnl, totalFee } = calcPnl(pos, fillPrice, holdHours, 0, FEE_RATE);
  const { mfePct, maePct } = consumeAdoptMfeMae(pos.id);
  closePosition(pos.id, {
    close_price: fillPrice,
    realized_pnl: realizedPnl,
    fee_paid: totalFee,
    reason,
    closed_at: now,
    exitFeatures: {
      hold_seconds: Math.round((now - pos.entry_time) / 1000),
      mfe_pct: mfePct,
      mae_pct: maePct,
    },
  });
  clearAdoptState(pos.id);
  logger.info(
    `[PaperAdopt] CLOSE #${pos.coin} ${(pos.side || 'long').toUpperCase()} @ ${fillPrice} ` +
      `→ ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(4)} (${reason})`,
  );
}

/**
 * Один проход сопровождения по всем открытым бумажным позам.
 * Виртуальный жёсткий стоп → analyzeAdopt (BE-храповик + трейл). Best-effort:
 * ошибка по одной монете не валит остальные.
 * @returns {Promise<number>} число закрытых этим проходом поз
 */
export async function superviseManualPaperPositions(priceFn = getLivePrice) {
  if (!config.trading.manualPaperAdoptEnabled) return 0;
  const positions = getActiveManualPaperPositions();
  if (positions.length === 0) return 0;

  let closed = 0;
  for (const pos of positions) {
    let price = null;
    try {
      price = await priceFn(pos.coin); // WS-first, HTTP fallback (инжектится в тестах)
    } catch (err) {
      logger.debug(`[PaperAdopt] getLivePrice #${pos.coin} failed: ${err.message}`);
    }
    if (!Number.isFinite(price) || price <= 0) continue;

    try {
      // Виртуальный жёсткий стоп — исполняем по цене стопа (как resting-SL биржи).
      if (hardStopHit(pos, price)) {
        closePaper(pos, pos.sl_price, 'manual_paper_sl');
        closed++;
        continue;
      }
      // Мягкий выход (BE-храповик / трейл) — та же логика, что у реального adopt.
      const sig = analyzeAdopt(pos, price);
      if (sig.action === 'CLOSE') {
        closePaper(pos, sig.price, (sig.reason || 'manual_paper_exit').replace(/^adopt/, 'manual_paper'));
        closed++;
      }
    } catch (err) {
      logger.error(`[PaperAdopt] supervise #${pos.coin} failed: ${err.message}`);
    }
  }
  return closed;
}
