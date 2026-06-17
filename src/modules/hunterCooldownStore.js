// ─────────────────────────────────────────────────
//  Hunter Cooldown Store — персист post-SL банов между рестартами
// ─────────────────────────────────────────────────
//
// Семантика хранения (важно — у SHORT и LONG разная!):
//   - SHORT.postSlCooldown[coin] = lastSlAtMs (timestamp последнего SL).
//     Strategist сам считает истечение: now - lastSl < HUNTER_POST_SL_COOLDOWN_MS.
//     На load отбрасываем записи старше HARD_TTL (24ч) как заведомо протухшие.
//   - LONG.postSlCooldown[coin]  = unbanAtMs (timestamp когда бан истечёт).
//     На load отбрасываем записи с unbanAt < now.
//   - LONG.slStreak[coin]        = { count, lastSlAt }. TTL — STREAK_WINDOW
//     внутри strategist'а; здесь не фильтруем.
//
// Bug 2026-05-22: postSlCooldown и slStreak жили только в in-memory Map'ах
// внутри strategistHunterLong.js / strategistHunter.js. При любом рестарте
// контейнера 24h-ban (consecutive SL streak) и 3ч post-SL cooldown
// обнулялись → бот моментально снова входил в забаненую монету.
//
// Сценарий, который это показал: PURR словил streak=2 в 18:16, бан на 24ч.
// Рестарт бота в 18:44. В 19:59 бот снова открыл PURR LONG и тут же словил
// второй SL. См. memory/pending_2026_05_22 (will add).
//
// Решение: единый файл data/hunter_cooldowns.json, атомарная запись (tmp+rename),
// ленивая загрузка при первом обращении. Просроченные записи отбрасываются
// при загрузке (на момент load Date.now() > unbanAt).
//
// Не вызывать напрямую — модули strategistHunterLong / strategistHunter
// заворачивают вызовы в свои read/write helpers.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../core/logger.js';

const VERSION = 1;
const DEFAULT_FILE = join('data', 'hunter_cooldowns.json');

// Override-able для тестов (см. _setFileForTest).
let FILE = DEFAULT_FILE;

let loaded = false;
let cache = emptyCache();

function emptyCache() {
  return {
    version: VERSION,
    short: { postSlCooldown: {} },                  // { coin: unbanAtMs }
    long:  { postSlCooldown: {}, slStreak: {} },    // streak: { coin: { count, lastSlAt } }
  };
}

/**
 * Ленивая загрузка. Первый вызов читает файл, валидирует, фильтрует просроченные
 * postSlCooldown-записи (unbanAt < now). slStreak оставляем как есть — TTL
 * проверяется при следующем `recordHunterLongLossEvent` (SL_STREAK_WINDOW_MS).
 * Возвращает текущий снимок (мутировать снаружи нельзя — strategist использует
 * apply* helpers ниже).
 */
export function loadHunterCooldowns(now = Date.now()) {
  if (loaded) return cache;
  loaded = true;

  // В тестах (NODE_ENV=test + default path) не читаем диск — изоляция от других прогонов.
  if (process.env.NODE_ENV === 'test' && FILE === DEFAULT_FILE) return cache;

  try {
    const raw = readFileSync(FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (data?.version !== VERSION) {
      logger.warn(`[HunterCooldownStore] Unknown version ${data?.version}, ignoring`);
      return cache;
    }

    // LONG: фильтр по unbanAt > now.
    const filterByUnbanAt = (obj) => {
      const out = {};
      let expired = 0;
      for (const [coin, unbanAt] of Object.entries(obj || {})) {
        if (typeof unbanAt === 'number' && unbanAt > now) out[coin] = unbanAt;
        else expired++;
      }
      return { out, expired };
    };
    // SHORT: фильтр по hard-TTL (24ч) от lastSlAt. Strategist сам делает финальную проверку.
    const SHORT_HARD_TTL_MS = 24 * 60 * 60_000;
    const filterByHardTtl = (obj) => {
      const out = {};
      let expired = 0;
      for (const [coin, lastSlAt] of Object.entries(obj || {})) {
        if (typeof lastSlAt === 'number' && now - lastSlAt < SHORT_HARD_TTL_MS) out[coin] = lastSlAt;
        else expired++;
      }
      return { out, expired };
    };

    const sho = filterByHardTtl(data.short?.postSlCooldown);
    const lon = filterByUnbanAt(data.long?.postSlCooldown);

    const streakIn = data.long?.slStreak;
    const streak = {};
    if (streakIn && typeof streakIn === 'object') {
      for (const [coin, v] of Object.entries(streakIn)) {
        if (v && typeof v.count === 'number' && typeof v.lastSlAt === 'number') {
          streak[coin] = { count: v.count, lastSlAt: v.lastSlAt };
        }
      }
    }

    cache = {
      version: VERSION,
      short: { postSlCooldown: sho.out },
      long:  { postSlCooldown: lon.out, slStreak: streak },
    };

    logger.info(
      `[HunterCooldownStore] Loaded: SHORT post-SL=${Object.keys(sho.out).length} ` +
      `(${sho.expired} expired), LONG post-SL=${Object.keys(lon.out).length} ` +
      `(${lon.expired} expired), LONG streak=${Object.keys(streak).length}`,
    );
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn(`[HunterCooldownStore] Load failed: ${err.message}`);
    }
    // ENOENT — нормально для первого запуска.
  }

  return cache;
}

/** Атомарная запись (tmp + rename). Fire-and-forget — никакой await.
 *  В тестах (NODE_ENV=test) запись пропускается, чтобы не засорять data/. */
function persist() {
  if (process.env.NODE_ENV === 'test' && FILE === DEFAULT_FILE) return;
  const payload = JSON.stringify(cache, null, 2);
  const tmpPath = `${FILE}.${process.pid}.tmp`;
  try {
    mkdirSync('data', { recursive: true });
    writeFileSync(tmpPath, payload, 'utf-8');
    renameSync(tmpPath, FILE);
  } catch (err) {
    logger.warn(`[HunterCooldownStore] Save failed: ${err.message}`);
  }
}

// ── SHORT helpers ─────────────────────────────────────────────────────────
/** value = lastSlAtMs (см. семантику в шапке). */
export function setShortPostSl(coin, lastSlAt) {
  loadHunterCooldowns();
  cache.short.postSlCooldown[coin] = lastSlAt;
  persist();
}

// ── LONG helpers ──────────────────────────────────────────────────────────
export function setLongPostSl(coin, unbanAt) {
  loadHunterCooldowns();
  cache.long.postSlCooldown[coin] = unbanAt;
  persist();
}

export function setLongSlStreak(coin, entry) {
  loadHunterCooldowns();
  cache.long.slStreak[coin] = { count: entry.count, lastSlAt: entry.lastSlAt };
  persist();
}

export function clearLongSlStreak(coin) {
  loadHunterCooldowns();
  if (cache.long.slStreak[coin] !== undefined) {
    delete cache.long.slStreak[coin];
    persist();
  }
}

// ── Test helpers ──────────────────────────────────────────────────────────
export function _resetForTest() {
  loaded = false;
  cache = emptyCache();
  FILE = DEFAULT_FILE;
}

export function _setFileForTest(path) {
  FILE = path;
  loaded = false;
  cache = emptyCache();
}
