import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { initDB, getActivePosition } from './core/database.js';
import { scan } from './modules/scout.js';
import { analyze } from './modules/strategist.js';
import { execute } from './modules/executor.js';

const TICK_INTERVAL_MS = 15_000; // 15 секунд

let db;
let tickTimer;
let tickRunning = false;

async function tick() {
  // Защита от наложения: если предыдущий тик ещё не завершён — пропускаем
  if (tickRunning) return;
  tickRunning = true;

  try {
    const scoutData = await scan();

    if (scoutData.length === 0) {
      logger.info('[Tick] Scout returned empty data — skipping');
      return;
    }

    const activePosition = getActivePosition();
    const signal = analyze(scoutData, activePosition);

    if (signal.action !== 'HOLD') {
      await execute(signal, activePosition);
    }
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

  // Первый тик сразу
  await tick();

  tickTimer = setInterval(tick, TICK_INTERVAL_MS);

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(`[Fatal] ${err.message}`);
  process.exit(1);
});
