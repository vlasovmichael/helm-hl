// ─────────────────────────────────────────────────
//  Executor State — централизованное хранилище
// ─────────────────────────────────────────────────
// Maps, TTL-константы, геттеры.

import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';

// ── TTL константы (захардкожены — не настраиваются оператором) ──
export const RUNTIME_BAN_TTL_MS    = 30 * 60_000;  // 30 мин
export const SLIPPAGE_BAN_TTL_MS   = 10 * 60_000;  // 10 мин
export const REENTRY_COOLDOWN_MS   = 15 * 60_000;  // 15 мин
export const REJECTED_ALERT_TTL_MS = 30 * 60_000;  // 30 мин
// OI cap bans используют exponential backoff: 6ч → 12ч → 24ч (cap).
// OI на потолке биржи — структурный признак неликвида, не транзиентный шум:
// 30-мин бан был слишком коротким (инцидент TST 2026-05-19 — бан истёк, монета
// зашла снова через 3ч и мгновенно вылетела по SL на 2% проскальзывании).
// Счётчик сбрасывается если за OI_CAP_REPEAT_RESET_MS не было новых rejection.
export const OI_CAP_BAN_BASE_MS      = 6  * 3_600_000;     // tier 1
export const OI_CAP_BAN_MAX_MS       = 24 * 3_600_000;     // tier ≥3 (cap)
export const OI_CAP_REPEAT_RESET_MS  = 24 * 3_600_000;     // 24ч тишины → reset

// ── Risk-параметры (из .env через config.risk) ──
export const CB_WINDOW_MS     = config.risk.cbWindowMs;
export const CB_MAX_LOSSES    = config.risk.cbMaxLosses;
export const CB_PAUSE_MS      = config.risk.cbPauseMs;
export const MAX_DRAWDOWN_PCT = config.risk.maxDrawdownPct;

// ── Приватные Maps ─────────────────────────────
const runtimeBlacklist = new Map();  // coin → timestamp
const slippageBanMap   = new Map();  // coin → timestamp
const cooldownMap      = new Map();  // coin → timestamp
const rejectedAlertMap = new Map();  // coin → timestamp
const oiCapBanMap      = new Map();  // coin → expiresAt
const oiCapRepeatMap   = new Map();  // coin → { count, lastBannedAt } — для backoff

// ── Circuit Breaker state ─────────────────────
const recentLosses = [];              // [{ ts, pnl, coin }]
let circuitBrokenUntil = 0;           // timestamp когда снимается блокировка

// ── Мутации ────────────────────────────────────

export function banRuntime(coin)       { runtimeBlacklist.set(coin, Date.now()); }
export function banSlippage(coin)      { slippageBanMap.set(coin, Date.now()); }
export function setCooldown(coin)      { cooldownMap.set(coin, Date.now()); }
export function setRejectedAlert(coin) { rejectedAlertMap.set(coin, Date.now()); }

export function getLastRejectedAlert(coin) { return rejectedAlertMap.get(coin); }

// ── OI Cap Ban ────────────────────────────────

/**
 * Банит монету по OI cap с exponential backoff: 30м → 1ч → 2ч → 4ч (cap).
 * Используется когда биржа отказала в открытии из-за переполненного OI.
 *
 * Why: малокапы типа SAGA повторно бьются об cap (см. инцидент 2026-05-12,
 * 3 rejection'а за сутки). 30-минутного бана недостаточно. Счётчик сбрасывается
 * если за OI_CAP_REPEAT_RESET_MS (24ч) не было нового OI cap события.
 *
 * @returns {{ count: number, ttlMs: number }} tier и фактический TTL — для лога/notify.
 */
export function banOiCap(coin) {
  const now = Date.now();
  let rec = oiCapRepeatMap.get(coin);
  if (rec && now - rec.lastBannedAt > OI_CAP_REPEAT_RESET_MS) {
    rec = null;
  }
  const count = (rec?.count ?? 0) + 1;
  const ttlMs = Math.min(OI_CAP_BAN_BASE_MS * 2 ** (count - 1), OI_CAP_BAN_MAX_MS);
  oiCapBanMap.set(coin, now + ttlMs);
  oiCapRepeatMap.set(coin, { count, lastBannedAt: now });
  return { count, ttlMs };
}

/** Проверка по одной монете (с авто-cleanup протухших). */
export function isOiCapBanned(coin) {
  const exp = oiCapBanMap.get(coin);
  if (!exp) return false;
  if (Date.now() > exp) {
    oiCapBanMap.delete(coin);
    return false;
  }
  return true;
}

/** Возвращает оставшееся время бана в мс (0 если бана нет). */
export function getOiCapBanRemainMs(coin) {
  const exp = oiCapBanMap.get(coin);
  if (!exp) return 0;
  const remain = exp - Date.now();
  return remain > 0 ? remain : 0;
}

/** Возвращает Set актуально забаненных монет (с очисткой протухших). */
export function getOiCapBans() {
  const now = Date.now();
  const active = new Set();
  for (const [coin, exp] of oiCapBanMap) {
    if (exp > now) {
      active.add(coin);
    } else {
      oiCapBanMap.delete(coin);
    }
  }
  return active;
}

/**
 * Сериализует активные OI-cap бан для bot_state.json. Только не-протухшие.
 * Используется чтобы пережить рестарт — иначе монеты типа SAGA с постоянным
 * OI-cap получают новый шанс каждые 1-2 мин (см. инцидент 2026-05-12).
 *
 * Возвращает { bans: { coin: exp }, repeat: { coin: { count, lastBannedAt } } }.
 * Repeat-счётчики сериализуются в свежем окне OI_CAP_REPEAT_RESET_MS — иначе при
 * рестарте бот забывал бы что SAGA уже три раза билась об cap и начинал с tier 1.
 */
export function serializeOiCapBans() {
  const now = Date.now();
  const bans = {};
  for (const [coin, exp] of oiCapBanMap) {
    if (exp > now) bans[coin] = exp;
  }
  const repeat = {};
  for (const [coin, rec] of oiCapRepeatMap) {
    if (rec && now - rec.lastBannedAt <= OI_CAP_REPEAT_RESET_MS) {
      repeat[coin] = { count: rec.count, lastBannedAt: rec.lastBannedAt };
    }
  }
  return { bans, repeat };
}

/**
 * Восстанавливает OI-cap баны из bot_state.json. Толерантен к null/мусору.
 * Поддерживает старый flat-формат `{ coin: exp }` (без repeat) для обратной
 * совместимости с stateы до этого фикса.
 */
export function restoreOiCapBans(saved) {
  if (!saved || typeof saved !== 'object') return;
  const now = Date.now();

  // Новый формат: { bans, repeat }. Старый: flat { coin: exp }.
  const isNewFormat = saved.bans && typeof saved.bans === 'object';
  const bans   = isNewFormat ? saved.bans   : saved;
  const repeat = isNewFormat ? saved.repeat : null;

  let restoredBans = 0;
  for (const [coin, exp] of Object.entries(bans)) {
    if (typeof exp === 'number' && exp > now) {
      oiCapBanMap.set(coin, exp);
      restoredBans++;
    }
  }

  let restoredRepeat = 0;
  if (repeat && typeof repeat === 'object') {
    for (const [coin, rec] of Object.entries(repeat)) {
      if (rec && typeof rec.count === 'number' && typeof rec.lastBannedAt === 'number') {
        if (now - rec.lastBannedAt <= OI_CAP_REPEAT_RESET_MS) {
          oiCapRepeatMap.set(coin, { count: rec.count, lastBannedAt: rec.lastBannedAt });
          restoredRepeat++;
        }
      }
    }
  }

  if (restoredBans > 0 || restoredRepeat > 0) {
    logger.info(
      `[Executor] OI cap bans restored: ${restoredBans} active | repeat counters: ${restoredRepeat}`,
    );
  }
}

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
 * Сериализует состояние Circuit Breaker для bot_state.json.
 * Вызывается из lifecycle.saveBotState.
 * @returns {{ recent_losses: Array, broken_until: number }}
 */
export function serializeCircuitBreaker() {
  return {
    recent_losses: recentLosses.map((l) => ({ ts: l.ts, pnl: l.pnl, coin: l.coin })),
    broken_until: circuitBrokenUntil,
  };
}

/**
 * Восстанавливает Circuit Breaker из bot_state.json после рестарта.
 * Толерантен к отсутствующему/повреждённому полю — старые stateы без CB
 * просто инициализируются как пустые.
 */
export function restoreCircuitBreaker(saved) {
  if (!saved || typeof saved !== 'object') return;

  const now = Date.now();
  const cutoff = now - CB_WINDOW_MS;

  // Восстанавливаем только убытки, попадающие в актуальное окно
  if (Array.isArray(saved.recent_losses)) {
    recentLosses.length = 0;
    for (const l of saved.recent_losses) {
      if (l && typeof l.ts === 'number' && l.ts >= cutoff) {
        recentLosses.push({ ts: l.ts, pnl: l.pnl ?? 0, coin: l.coin ?? '?' });
      }
    }
  }

  // Восстанавливаем активную паузу, если она ещё не истекла
  if (typeof saved.broken_until === 'number' && saved.broken_until > now) {
    circuitBrokenUntil = saved.broken_until;
    const remainMin = Math.ceil((circuitBrokenUntil - now) / 60_000);
    logger.warn(
      `[Executor] 🛑 Circuit breaker RESTORED from state — ${recentLosses.length} losses, ${remainMin}min remaining`,
    );
  } else if (recentLosses.length > 0) {
    logger.info(
      `[Executor] Circuit breaker restored: ${recentLosses.length} recent losses in window (not tripped)`,
    );
  }
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
