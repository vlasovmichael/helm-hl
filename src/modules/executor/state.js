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

// ── Приватные Maps ─────────────────────────────
const runtimeBlacklist = new Map();  // coin → timestamp
const slippageBanMap   = new Map();  // coin → timestamp
const cooldownMap      = new Map();  // coin → timestamp
const rejectedAlertMap = new Map();  // coin → timestamp

// ── Мутации ────────────────────────────────────

export function banRuntime(coin)       { runtimeBlacklist.set(coin, Date.now()); }
export function banSlippage(coin)      { slippageBanMap.set(coin, Date.now()); }
export function setCooldown(coin)      { cooldownMap.set(coin, Date.now()); }
export function setRejectedAlert(coin) { rejectedAlertMap.set(coin, Date.now()); }

export function getLastRejectedAlert(coin) { return rejectedAlertMap.get(coin); }

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
    runtimeBans:  _mapToEntries(runtimeBlacklist, RUNTIME_BAN_TTL_MS, now),
    slippageBans: _mapToEntries(slippageBanMap, SLIPPAGE_BAN_TTL_MS, now),
    cooldowns:    _mapToEntries(cooldownMap, REENTRY_COOLDOWN_MS, now),
    blockedCoins: [...getRuntimeBlacklist()],
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
