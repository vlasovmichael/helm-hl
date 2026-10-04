// ─────────────────────────────────────────────────
//  Tick Watchdog — тик встал → звонок, а не тишина
// ─────────────────────────────────────────────────
//
// Watchdog сообщает о залипшем tick, даже когда WS и дашборд остаются живыми.
// Один пуш на эпизод и один на восстановление не создают шум.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { state } from './state.js';
import { fireAdoptNtfy } from './adoptReconcile.js';
import { hlClientStats } from '../core/hlClient.js';

const CHECK_EVERY_MS = 30_000;
// Порог тревоги. Тик ходит раз в TICK_INTERVAL_MS (15с); 2 минуты = 8 периодов —
// переживает разовые сетевые ретраи, но не переживает затор. Совпадает с порогом
// /api/health, чтобы «unhealthy в докере» и «пуш в телефон» значили одно и то же.
const STALE_MS = parseInt(process.env.TICK_STALE_ALERT_MS || '120000', 10);
// Не будим на старте: первый тик может занять минуту (universe, свечи, снапшот).
const BOOT_GRACE_MS = 180_000;

let timer = null;
let alerted = false;      // эпизод активен → второй раз не звоним
let alertedAt = 0;

/** Чистая проверка (для тестов): нужно ли трубить при данном возрасте тика. */
export function shouldAlertStaleTick({ tickAgeMs, uptimeMs, alreadyAlerted }) {
  if (uptimeMs < BOOT_GRACE_MS) return false;
  if (alreadyAlerted) return false;
  return tickAgeMs > STALE_MS;
}

async function check() {
  if (state.shuttingDown) return;
  const now = Date.now();
  const uptimeMs = now - (state.startedAt || now);
  const tickAgeMs = state.lastTickAt > 0 ? now - state.lastTickAt : uptimeMs;

  if (shouldAlertStaleTick({ tickAgeMs, uptimeMs, alreadyAlerted: alerted })) {
    alerted = true;
    alertedAt = now;
    const s = hlClientStats();
    const top = s.topLabels.map((t) => `${t.label}=${t.weight}`).join(', ') || '—';
    logger.error(
      `[Watchdog] 🚨 тик встал: ${Math.round(tickAgeMs / 1000)}с без завершённого прохода ` +
      `| вес ${s.weightUsed}/${s.weightBudget}, в очереди за бюджетом ${s.weightQueued} | топ: ${top}`,
    );
    await fireAdoptNtfy(
      `🚨 Бот встал: тик молчит ${Math.round(tickAgeMs / 60_000)} мин`,
      `Последний завершённый проход ${Math.round(tickAgeMs / 1000)}с назад (норма 15с).\n` +
      `Вес HL: ${s.weightUsed}/${s.weightBudget}, ждут бюджета: ${s.weightQueued}.\n` +
      `Топ потребителей: ${top}.\n` +
      `Позиции под adopt ведёт WS-петля (2с) — она от тика не зависит.`,
      ['rotating_light'],
      { urgent: true },
    );
    return;
  }

  if (alerted && tickAgeMs <= STALE_MS) {
    const downMs = now - alertedAt;
    alerted = false;
    logger.info(`[Watchdog] ✅ тик ожил (простой ~${Math.round(downMs / 1000)}с)`);
    await fireAdoptNtfy(
      '✅ Тик ожил',
      `Бот снова тикает штатно. Простой ~${Math.round(downMs / 60_000)} мин.`,
      ['white_check_mark'],
    );
  }
}

/** Поднимает сторожа. Только в PROD: в paper некому и не о чем звонить. */
export function startTickWatchdog() {
  if (!config.isProduction || timer) return;
  timer = setInterval(() => {
    check().catch((err) => logger.debug(`[Watchdog] ${err.message}`));
  }, CHECK_EVERY_MS);
  timer.unref?.();
  logger.info(`[Watchdog] started — алерт, если тик молчит > ${STALE_MS / 1000}с`);
}

/** Грейсфул-стоп (вызывается из shutdown). */
export function stopTickWatchdog() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
