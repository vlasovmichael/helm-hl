// ─────────────────────────────────────────────────
//  Adopt Supervise — сопровождение ВСЕХ adopted-поз (multi-slot)
// ─────────────────────────────────────────────────
// План: plans/adopt-mode-plan.md
//
// Юзер может держать несколько ручных входов одновременно. Бот подхватывает
// каждый (adoptReconcile → reduce-only стоп на бирже + DB-row strategy_id='adopt')
// и здесь, КАЖДЫЙ ТИК, ведёт мягкий выход на каждую позу независимо:
//   • analyzeAdopt(pos, livePrice) — BE-храповик + трейл (per-position state по id)
//   • жёсткий стоп держит биржа (resting SL), здесь не дублируем
//
// Почему отдельно от coordinator: coordinator — single-slot (одна позиция-владелец
// слота). Adopt — multi-slot, поэтому его выходы вынесены сюда и идут циклом по
// getActiveAdoptPositions(). coordinator для adopt теперь возвращает HOLD.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActiveAdoptPositions } from '../core/database.js';
import { analyzeAdopt } from '../modules/strategistAdopt.js';
import { getLivePrice } from '../modules/exchange.js';
import { execute } from '../modules/executor/index.js';

/**
 * Один проход сопровождения по всем активным adopt-позам.
 * Закрывает те, по которым analyzeAdopt вернул CLOSE (трейл / BE-храповик).
 * Best-effort: ошибка по одной монете не валит остальные.
 *
 * @returns {Promise<number>} число закрытых этим проходом поз
 */
export async function superviseAdoptPositions() {
  if (!config.isProduction) return 0;
  const positions = getActiveAdoptPositions();
  if (positions.length === 0) return 0;

  let closed = 0;
  for (const pos of positions) {
    let price = null;
    try {
      price = await getLivePrice(pos.coin); // WS-first, HTTP fallback
    } catch (err) {
      logger.debug(`[Adopt] supervise getLivePrice #${pos.coin} failed: ${err.message}`);
    }
    if (!Number.isFinite(price) || price <= 0) continue; // нет цены → ждём след. тик

    const sig = analyzeAdopt(pos, price);
    if (sig.action === 'HOLD') continue;

    try {
      await execute({ ...sig, strategy_id: 'adopt' }, pos);
      closed++;
    } catch (err) {
      logger.error(`[Adopt] supervise execute #${pos.coin} failed: ${err.message}`);
    }
  }
  return closed;
}
