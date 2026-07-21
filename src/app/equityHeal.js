// ─────────────────────────────────────────────────
//  Equity Heal — авто-самолечение Performance-истории из HL
// ─────────────────────────────────────────────────
// Основной источник Performance-графика — локальные 5-мин снапшоты (гладко +
// live-кончик). Но если они когда-нибудь встанут (инцидент с API-ключом 07–11.07
// был близок) — в кривой появится провал. Этот джоб периодически берёт
// accountValueHistory из портфельного API HL (у биржи история есть всегда) и
// ДОТЯГИВАЕТ только недостающие точки: где рядом нет своего снапшота. Плотные
// локальные данные не трогаются (HL в 20–40× грубее — только на заполнение дыр).
//
// LOW-приоритет в HL-пуле → не конкурирует с торговлей. Fail-soft.

import { hlInfo, HL_PRIORITY } from '../core/hlClient.js';
import { backfillEquityGaps, purgeNonPositiveEquity } from '../core/database.js';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const HEAL_INTERVAL_MS = 6 * 3_600_000; // раз в 6ч
const GAP_TOLERANCE_MS = 30 * 60_000;   // «своя точка рядом» = ±30 мин

// Портфель HL: массив пар [period, {accountValueHistory:[[ts,"val"],...]}]. Сливаем
// несколько периодов (allTime — предыстория, month/week/day — плотнее к настоящему).
function collectHistory(portfolio) {
  const merged = new Map();
  if (!Array.isArray(portfolio)) return [];
  for (const key of ['allTime', 'month', 'week', 'day']) {
    const entry = portfolio.find((p) => Array.isArray(p) && p[0] === key);
    const hist = entry?.[1]?.accountValueHistory;
    if (Array.isArray(hist)) {
      for (const [ts, v] of hist) merged.set(Number(ts), Number(v));
    }
  }
  return [...merged.entries()].map(([ts, equity]) => ({ ts, equity }));
}

/** Один проход самолечения. Можно звать вручную. */
export async function healEquityGapsOnce() {
  try {
    const addr = config.wallet?.address;
    if (!addr) return 0;
    const portfolio = await hlInfo(
      { type: 'portfolio', user: addr },
      { label: 'equity-heal', priority: HL_PRIORITY.LOW },
    );
    const points = collectHistory(portfolio);
    if (points.length === 0) return 0;
    const n = backfillEquityGaps(points, GAP_TOLERANCE_MS);
    if (n > 0) logger.info(`[EquityHeal] дотянул ${n} точек из HL (провалы/предыстория)`);
    return n;
  } catch (err) {
    logger.warn(`[EquityHeal] failed: ${err.message}`);
    return 0;
  }
}

let timer = null;

/** Запуск: чистим $0-мусор, лечим на старте и раз в 6ч. */
export function startEquityHeal() {
  try {
    const purged = purgeNonPositiveEquity();
    if (purged > 0) logger.info(`[EquityHeal] убрал ${purged} нулевых equity-точек`);
  } catch (err) {
    logger.warn(`[EquityHeal] purge failed: ${err.message}`);
  }
  healEquityGapsOnce();
  if (timer) clearInterval(timer);
  timer = setInterval(healEquityGapsOnce, HEAL_INTERVAL_MS);
  if (timer.unref) timer.unref();
}
