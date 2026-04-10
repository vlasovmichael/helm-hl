// ─────────────────────────────────────────────────
//  Executor State — централизованное хранилище
// ─────────────────────────────────────────────────
// Maps, TTL-константы, геттеры.
// Нет зависимостей от проекта — чистый модуль данных.

// ── TTL константы ──────────────────────────────
export const RUNTIME_BAN_TTL_MS    = 30 * 60_000;  // 30 мин
export const SLIPPAGE_BAN_TTL_MS   = 10 * 60_000;  // 10 мин
export const REENTRY_COOLDOWN_MS   = 15 * 60_000;  // 15 мин
export const REJECTED_ALERT_TTL_MS = 30 * 60_000;  // 30 мин

// ── Circuit Breaker ───────────────────────────
export const CB_WINDOW_MS          = 60 * 60_000;  // скользящее окно 1 час
export const CB_MAX_LOSSES         = 3;             // макс убытков в окне
export const CB_PAUSE_MS           = 2 * 3_600_000; // пауза 2 часа

// ── Max Drawdown Guard ────────────────────────
export const MAX_DRAWDOWN_PCT      = 10;            // -10% от стартового equity → стоп

// ── Приватные Maps ─────────────────────────────
const runtimeBlacklist = new Map();  // coin → timestamp
const slippageBanMap   = new Map();  // coin → timestamp
const cooldownMap      = new Map();  // coin → timestamp
const rejectedAlertMap = new Map();  // coin → timestamp

// ── Circuit Breaker state ─────────────────────
const recentLosses = [];              // [{ ts, pnl, coin }]
let circuitBrokenUntil = 0;           // timestamp когда снимается блокировка

// ── Мутации ────────────────────────────────────

export function banRuntime(coin)       { runtimeBlacklist.set(coin, Date.now()); }
export function banSlippage(coin)      { slippageBanMap.set(coin, Date.now()); }
export function setCooldown(coin)      { cooldownMap.set(coin, Date.now()); }
export function setRejectedAlert(coin) { rejectedAlertMap.set(coin, Date.now()); }

export function getLastRejectedAlert(coin) { return rejectedAlertMap.get(coin); }

// ── Circuit Breaker ───────────────────────────

/**
 * Записывает убыточную сделку в скользящее окно.
 * Если достигнут лимит — активирует паузу.
 * @returns {boolean} true если circuit breaker сработал
 */
export function recordLoss(coin, pnl) {
  const now = Date.now();
  recentLosses.push({ ts: now, pnl, coin });

  // Чистим окно
  const cutoff = now - CB_WINDOW_MS;
  while (recentLosses.length > 0 && recentLosses[0].ts < cutoff) {
    recentLosses.shift();
  }

  if (recentLosses.length >= CB_MAX_LOSSES) {
    circuitBrokenUntil = now + CB_PAUSE_MS;
    return true;
  }
  return false;
}

/**
 * Проверяет, активен ли circuit breaker.
 * @returns {{ broken: boolean, remainMs: number, losses: number }}
 */
export function getCircuitBreakerStatus() {
  const now = Date.now();

  // Чистим устаревшие записи
  const cutoff = now - CB_WINDOW_MS;
  while (recentLosses.length > 0 && recentLosses[0].ts < cutoff) {
    recentLosses.shift();
  }

  if (circuitBrokenUntil > now) {
    return { broken: true, remainMs: circuitBrokenUntil - now, losses: recentLosses.length };
  }

  // Если пауза истекла — сбрасываем
  if (circuitBrokenUntil > 0) circuitBrokenUntil = 0;

  return { broken: false, remainMs: 0, losses: recentLosses.length };
}

// ── Max Drawdown Guard ────────────────────────

/**
 * Проверяет, превышен ли максимальный drawdown.
 * @param {number} currentEquity — текущий equity
 * @param {number} sessionStartEquity — equity на старте сессии
 * @returns {{ breached: boolean, drawdownPct: number }}
 */
export function checkDrawdown(currentEquity, sessionStartEquity) {
  if (sessionStartEquity <= 0) return { breached: false, drawdownPct: 0 };

  const drawdownPct = ((sessionStartEquity - currentEquity) / sessionStartEquity) * 100;

  return {
    breached: drawdownPct >= MAX_DRAWDOWN_PCT,
    drawdownPct,
  };
}

// ── Чтение ─────────────────────────────────────

/**
 * Возвращает Set актуально заблокированных монет (с учётом TTL).
 * Включает: runtime blacklist + slippage ban + re-entry cooldown.
 * @returns {Set<string>}
 */
export function getRuntimeBlacklist() {
  const now = Date.now();
  const active = new Set();

  for (const [coin, bannedAt] of runtimeBlacklist) {
    if (now - bannedAt < RUNTIME_BAN_TTL_MS) {
      active.add(coin);
    } else {
      runtimeBlacklist.delete(coin);
    }
  }

  for (const [coin, bannedAt] of slippageBanMap) {
    if (now - bannedAt < SLIPPAGE_BAN_TTL_MS) {
      active.add(coin);
    } else {
      slippageBanMap.delete(coin);
    }
  }

  for (const [coin, closedAt] of cooldownMap) {
    if (now - closedAt < REENTRY_COOLDOWN_MS) {
      active.add(coin);
    } else {
      cooldownMap.delete(coin);
    }
  }

  return active;
}

// ── Dashboard API ──────────────────────────────

/** Полный snapshot стейта для Dashboard. */
export function getStateSnapshot() {
  const now = Date.now();
  return {
    runtimeBans:    _mapToEntries(runtimeBlacklist, RUNTIME_BAN_TTL_MS, now),
    slippageBans:   _mapToEntries(slippageBanMap, SLIPPAGE_BAN_TTL_MS, now),
    cooldowns:      _mapToEntries(cooldownMap, REENTRY_COOLDOWN_MS, now),
    blockedCoins:   [...getRuntimeBlacklist()],
    circuitBreaker: getCircuitBreakerStatus(),
  };
}

function _mapToEntries(map, ttl, now) {
  const entries = [];
  for (const [coin, ts] of map) {
    const remainMs = ttl - (now - ts);
    if (remainMs > 0) entries.push({ coin, bannedAt: ts, remainMs });
  }
  return entries;
}
