// ─────────────────────────────────────────────────
//  Health Watch — плашка получает рот
// ─────────────────────────────────────────────────
//
// Why: core/healthRegistry сводит проверки фидов в одно состояние, и оно видно
// в шапке дашборда. Но плашка работает ровно пока на неё смотрят, а тихий OOM
// 02.08 и вставший тик 31.07 случились, когда никто не смотрел. Тот же вывод,
// что и у tickWatchdog: это не новая проверка здоровья, а недостающий рот у
// существующей.
//
// Правила — те же, что у tickWatchdog (один пуш на эпизод + пуш на
// восстановление), плюс подтверждение подряд: реестр обновляется раз в минуту
// от разных источников, и одиночное красное на кадре — это чаще всего один
// пропущенный ответ API, а не поломка. Будить телефон на такое нельзя, иначе
// пуш перестанут читать (см. гигиену алертов).

import { logger } from '../core/logger.js';
import { summary } from '../core/healthRegistry.js';
import { state } from './state.js';
import { fireAdoptNtfy } from './adoptReconcile.js';

const CHECK_EVERY_MS = 60_000;
// Реестр наполняется первыми замерами не мгновенно (priceFeed отчитывается раз
// в минуту, integrity — раз в минуту и только при открытых позах).
const BOOT_GRACE_MS = 240_000;
// Сколько подряд плохих кадров нужно, чтобы звонить. 3 × 60с ≈ 3 минуты.
const CONFIRM_STREAK = 3;

// Состояния, которые считаем аварией. 'warn' сюда НЕ входит: это «посмотри
// когда будешь рядом», а не «брось всё». 'unknown' — тоже нет: пустой реестр
// означает, что источники ещё не отчитались, а не что всё сломалось.
const BAD = new Set(['stale', 'drift', 'fail']);

let timer = null;
let badStreak = 0;
let alerted = false;
let alertedAt = 0;

/**
 * Чистое решение (для тестов): звонить ли при таком состоянии.
 * @returns {'alert'|'recover'|'none'}
 */
export function decideHealthAlert({ overall, streak, alreadyAlerted, uptimeMs }) {
  if (uptimeMs < BOOT_GRACE_MS) return 'none';
  const bad = BAD.has(overall);
  if (bad && !alreadyAlerted && streak >= CONFIRM_STREAK) return 'alert';
  // Выздоровление — только по фактическому измерению. 'unknown' не считается:
  // замолчавший реестр — это не «починилось», это «мы снова ничего не знаем».
  if (!bad && alreadyAlerted && (overall === 'ok' || overall === 'warn')) return 'recover';
  return 'none';
}

/** Строки непрошедших проверок для тела пуша. */
function badLines(checks) {
  return (checks || [])
    .filter((c) => c.status !== 'pass')
    .map((c) => `• ${c.name}: ${c.detail}`)
    .join('\n') || '• (детали недоступны)';
}

async function check() {
  if (state.shuttingDown) return;
  const now = Date.now();
  const uptimeMs = now - (state.startedAt || now);
  const s = summary();

  badStreak = BAD.has(s.overall) ? badStreak + 1 : 0;

  const decision = decideHealthAlert({
    overall: s.overall,
    streak: badStreak,
    alreadyAlerted: alerted,
    uptimeMs,
  });

  if (decision === 'alert') {
    alerted = true;
    alertedAt = now;
    logger.error(`[HealthWatch] 🚨 данные нездоровы: ${s.overall} | ${badLines(s.checks).replace(/\n/g, ' ')}`);
    await fireAdoptNtfy(
      `🚨 Данные бота: ${s.overall}`,
      `Держится ${badStreak} мин подряд.\n${badLines(s.checks)}\n\n` +
        `Торговые решения на этих данных считаются как обычно — проверь, ` +
        `прежде чем доверять цене на дашборде.`,
      ['rotating_light'],
      { urgent: true },
    );
    return;
  }

  if (decision === 'recover') {
    const downMs = now - alertedAt;
    alerted = false;
    logger.info(`[HealthWatch] ✅ данные в норме (${s.overall}), эпизод ~${Math.round(downMs / 60_000)} мин`);
    await fireAdoptNtfy(
      '✅ Данные бота в норме',
      `Состояние: ${s.overall}. Эпизод длился ~${Math.round(downMs / 60_000)} мин.`,
      ['white_check_mark'],
    );
  }
}

/** Поднять наблюдателя. Идемпотентно. */
export function startHealthWatch() {
  if (timer) return;
  timer = setInterval(() => {
    check().catch((err) => logger.debug(`[HealthWatch] check failed: ${err.message}`));
  }, CHECK_EVERY_MS);
  timer.unref?.();
  logger.info('[HealthWatch] started');
}

export function stopHealthWatch() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** Сброс состояния (тесты). */
export function _resetHealthWatch() {
  badStreak = 0;
  alerted = false;
  alertedAt = 0;
}
