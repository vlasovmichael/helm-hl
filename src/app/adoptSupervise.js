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
import { analyzeAdopt, getAdoptPeakPct } from '../modules/strategistAdopt.js';
import { getLivePrice } from '../modules/exchange.js';
import { execute } from '../modules/executor/index.js';
import { trackAdoptTimeCutTick } from '../modules/adoptShadowTimeCut.js';
import { fireAdoptNtfy } from './adoptReconcile.js';

// Пик-алерт: систематизация дискрец-выхода (оператор закрывает 63% adopt-поз рукой,
// capture 68% MFE) — звонок в момент решения вместо оракула. Условие: пик ≥
// ADOPT_PEAK_ALERT_MFE_PCT и откат ≥ ADOPT_PEAK_ALERT_GIVEBACK_PCT от пика (строго
// раньше трейла с его 30%). Один раз на позицию — иначе спам на болтанке у пика.
const _peakAlerted = new Set(); // position.id

// Чистое (для теста) условие пик-алерта.
export function shouldFirePeakAlert({ peakPct, unrealizedPct, alreadyFired }) {
  const t = config.trading;
  if (!t.adoptPeakAlertEnabled || alreadyFired) return false;
  if (peakPct < t.adoptPeakAlertMfePct) return false;
  if (unrealizedPct <= 0) return false; // ушли в минус — это уже история про BE/стоп
  return peakPct - unrealizedPct >= peakPct * (t.adoptPeakAlertGiveBackPct / 100);
}

async function maybeFirePeakAlert(pos, price) {
  const peak = getAdoptPeakPct(pos.id);
  const isShort = (pos.side || 'short') === 'short';
  const unrealized = isShort
    ? ((pos.entry_price - price) / pos.entry_price) * 100
    : ((price - pos.entry_price) / pos.entry_price) * 100;
  if (!shouldFirePeakAlert({ peakPct: peak, unrealizedPct: unrealized, alreadyFired: _peakAlerted.has(pos.id) })) return;

  _peakAlerted.add(pos.id);
  const retracePct = ((peak - unrealized) / peak) * 100;
  await fireAdoptNtfy(
    `Пик пройден? #${pos.coin} ${pos.side.toUpperCase()} +${unrealized.toFixed(2)}%`,
    `Пик был +${peak.toFixed(2)}%, откат ${retracePct.toFixed(0)}% от пика.\n` +
    `Решай: забрать у пика рукой или дать трейлу (закроет при −${config.trading.adoptTrailGiveBackPct}% отката).`,
    ['bell'],
  );
  logger.info(`[Adopt] 🔔 peak-alert #${pos.coin}: peak +${peak.toFixed(2)}% → +${unrealized.toFixed(2)}% (retrace ${retracePct.toFixed(0)}%)`);
}

/**
 * Один проход сопровождения по всем активным adopt-позам.
 * Закрывает те, по которым analyzeAdopt вернул CLOSE (трейл / BE-храповик).
 * Best-effort: ошибка по одной монете не валит остальные.
 *
 * @param {Function} [priceFn=getLivePrice] — источник цены. Быстрая WS-петля
 *   (wsExitTick) передаёт сюда чистый WS-ридер: на 2-секундном цикле HTTP-
 *   фолбэк не нужен и вреден (лишний вес → затор бюджета).
 * @returns {Promise<number>} число закрытых этим проходом поз
 */
export async function superviseAdoptPositions(priceFn = getLivePrice) {
  if (!config.isProduction) return 0;
  const positions = getActiveAdoptPositions();
  // Прополка peak-alert метки: позиция закрылась → id из Set (иначе копит мусор).
  const activeIds = new Set(positions.map((p) => p.id));
  for (const id of [..._peakAlerted]) if (!activeIds.has(id)) _peakAlerted.delete(id);
  if (positions.length === 0) return 0;

  let closed = 0;
  for (const pos of positions) {
    let price = null;
    try {
      price = await priceFn(pos.coin); // default: WS-first, HTTP fallback
    } catch (err) {
      logger.debug(`[Adopt] supervise getLivePrice #${pos.coin} failed: ${err.message}`);
    }
    if (!Number.isFinite(price) || price <= 0) continue; // нет цены → ждём след. тик

    const sig = analyzeAdopt(pos, price);
    // Shadow time-cut: measurement-only, реальный выход не трогает. После
    // analyzeAdopt — peak в strategistAdopt уже обновлён этим тиком.
    try { trackAdoptTimeCutTick(pos, price); } catch (err) {
      logger.debug(`[Adopt] shadow time-cut tick #${pos.coin} failed: ${err.message}`);
    }
    if (sig.action === 'HOLD') {
      // Пик-алерт (best-effort): звонок оператору у пика, пока трейл ещё не сработал.
      try { await maybeFirePeakAlert(pos, price); } catch (err) {
        logger.debug(`[Adopt] peak-alert #${pos.coin} failed: ${err.message}`);
      }
      continue;
    }

    try {
      await execute({ ...sig, strategy_id: 'adopt' }, pos);
      closed++;
    } catch (err) {
      logger.error(`[Adopt] supervise execute #${pos.coin} failed: ${err.message}`);
    }
  }
  return closed;
}
