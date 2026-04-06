import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { initDB, getActivePosition, getHistory } from './core/database.js';
import { scan } from './modules/scout.js';
import { analyze } from './modules/strategist.js';
import { execute } from './modules/executor.js';
import { sendAnomalyAlert, sendFomoAlert, sendDailySummary } from './modules/reporter.js';

const TICK_INTERVAL_MS    = 15_000;          // 15 секунд
const DAILY_INTERVAL_MS   = 24 * 3_600_000;  // 24 часа
const FOMO_COOLDOWN_MS    = 4 * 3_600_000;   // не чаще 1 раза в 4 часа
const ANOMALY_THRESHOLD   = 0.30;            // 30% падение APY за тик → аномалия
const FOMO_UPLIFT_MIN     = 1.50;            // лучший кандидат должен быть на 50% выше

let db;
let tickTimer;
let tickRunning      = false;
let lastDailySummary = Date.now();           // первая сводка через 24ч
let lastFomoAlert    = 0;                    // UNIX ms последнего FOMO-алерта
let prevApyMap       = new Map();            // coin → smoothedApy прошлого тика

async function runSmartAlerts(scoutData, signal, activePosition) {
  const now = Date.now();

  // ── 1. Аномалия APY (только при открытой позиции) ─────────────────
  if (activePosition) {
    const coin    = activePosition.coin;
    const current = scoutData.find((m) => m.coin === coin);
    const prevApy = prevApyMap.get(coin);

    if (current && prevApy != null && prevApy > 0) {
      const drop = (prevApy - current.smoothedApy) / prevApy;
      if (drop >= ANOMALY_THRESHOLD) {
        await sendAnomalyAlert(coin, prevApy, current.smoothedApy);
      }
    }
  }

  // Обновляем карту APY для следующего тика
  for (const m of scoutData) {
    prevApyMap.set(m.coin, m.smoothedApy);
  }

  // ── 2. FOMO-алерт (позиция открыта, ротация невыгодна) ───────────
  if (
    activePosition &&
    signal.action === 'HOLD' &&
    now - lastFomoAlert >= FOMO_COOLDOWN_MS
  ) {
    const currentCoin = activePosition.coin;
    const current     = scoutData.find((m) => m.coin === currentCoin);
    const best        = scoutData.find((m) => m.coin !== currentCoin);

    if (current && best && best.smoothedApy >= current.smoothedApy * FOMO_UPLIFT_MIN) {
      // Стратег уже посчитал paybackHours — вычислим здесь по той же формуле
      const ROUND_TRIP   = (0.0002 + 0.0001) * 2;
      const deltaHourly  = (best.smoothedApy - current.smoothedApy) / 100 / 365 / 24;
      const paybackHours = deltaHourly > 0 ? ROUND_TRIP / (0.5 * deltaHourly) : Infinity;

      if (paybackHours > 6) { // только если ротация невыгодна (иначе Стратег бы уже переключил)
        await sendFomoAlert(currentCoin, best.coin, current.smoothedApy, best.smoothedApy, paybackHours);
        lastFomoAlert = now;
      }
    }
  }

  // ── 3. Дневная сводка ─────────────────────────────────────────────
  if (now - lastDailySummary >= DAILY_INTERVAL_MS) {
    await runDailySummary();
    lastDailySummary = now;
  }
}

async function runDailySummary() {
  const history       = getHistory(1000); // всё за последние 1000 сделок
  const activePosition = getActivePosition();

  const totalTrades = history.length;
  const winTrades   = history.filter((t) => t.realized_pnl > 0).length;
  const totalPnl    = history.reduce((s, t) => s + t.realized_pnl, 0);
  const totalFees   = history.reduce((s, t) => s + t.fee_paid, 0);
  const bestTrade   = history.reduce(
    (best, t) => (!best || t.realized_pnl > best.realized_pnl ? t : best),
    null,
  );

  await sendDailySummary({ totalTrades, winTrades, totalPnl, totalFees, bestTrade, activePosition });
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;

  try {
    const scoutData = await scan();

    if (scoutData.length === 0) {
      logger.info('[Tick] Scout returned empty data — skipping');
      return;
    }

    const activePosition = getActivePosition();
    const signal         = analyze(scoutData, activePosition);

    if (signal.action !== 'HOLD') {
      await execute(signal, activePosition);
    }

    await runSmartAlerts(scoutData, signal, activePosition);

  } catch (err) {
    logger.error(`[Tick] ${err.message}`);
  } finally {
    tickRunning = false;
  }
}

function shutdown(signal) {
  logger.info(`[System] ${signal} received — shutting down...`);

  if (tickTimer) clearInterval(tickTimer);

  if (db) {
    db.close();
    logger.info('[System] Database closed');
  }

  logger.info('[System] Goodbye.');
  process.exit(0);
}

async function main() {
  logger.info('═══════════════════════════════════════════════');
  logger.info(`  HL Paper Scanner v2.0`);
  logger.info(`  Mode:   ${config.mode}`);
  logger.info(`  Wallet: ${config.wallet.address}`);
  logger.info(`  Entry:  ≥ ${config.trading.entryApy}% APY`);
  logger.info(`  Exit:   < ${config.trading.minApy}% APY`);
  logger.info('═══════════════════════════════════════════════');

  db = initDB();

  await tick();

  tickTimer = setInterval(tick, TICK_INTERVAL_MS);

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(`[Fatal] ${err.message}`);
  process.exit(1);
});
