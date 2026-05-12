// ─────────────────────────────────────────────────
//  App State — разделяемое мутабельное состояние
// ─────────────────────────────────────────────────
// Все модули app/ импортируют один объект state.
// Нет зависимостей от проекта.

// ── Константы ──────────────────────────────────

export const TICK_INTERVAL_MS           = 15_000;        // 15 секунд
export const FOMO_COOLDOWN_MS           = 4 * 3_600_000; // 4 часа
export const ANOMALY_THRESHOLD          = 0.30;          // 30% падение APY
export const FOMO_UPLIFT_MIN            = 1.50;          // +50% чтобы считать FOMO
export const DAILY_RECAP_HOUR           = 21;            // 21:00 по серверу
export const PNL_ALERT_PCT             = 3.0;            // ±3% от equity
export const PNL_ALERT_COOLDOWN_MS     = 60 * 60_000;    // 1 час
export const INTEGRITY_CHECK_INTERVAL_MS = 60_000;       // 60с
export const INTEGRITY_GRACE_PERIOD_MS  = 30_000;        // 30с grace после старта
export const BOT_STATE_PATH             = 'data/bot_state.json';
export const SHUTDOWN_TIMEOUT_MS        = 15_000;        // 15с на завершение
export const BOT_STATE_FLUSH_INTERVAL_MS = 60_000;       // 60с периодический snapshot

// ── Мутабельное состояние ──────────────────────

export const state = {
  db:                 null,
  tickTimer:          null,
  tickRunning:        false,
  shuttingDown:       false,
  startedAt:          Date.now(),
  botStartedAt:       0,
  dailyRecapSentDate: '',       // "YYYY-MM-DD"
  lastFomoAlert:      0,
  lastPnlAlert:       0,
  lastIntegrityCheck:  0,
  sessionStartEquity:  0,
  lastIdleAt:          0,
  prevApyMap:          new Map(),
  // Hands-off режим: оператор торгует вручную → бот паузится, не трогает позицию
  manualPositionActive: false,
  manualPositionCoins:  new Set(),   // тикеры, которые сейчас под ручным контролем
  manualWarningThrottle: new Map(),  // coin → last alert ts
  // Последний снапшот hunter-scope (для дашборда). Не используется в торговой логике.
  latestHunter:       [],
  latestHunterAt:     0,
  // Последний успешный saveBotState (для throttle периодического flush из tick'а).
  lastBotStateSaveAt: 0,
};
