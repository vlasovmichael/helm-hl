// ─────────────────────────────────────────────────
//  Adopt Trail Store — персист мягкого состояния няньки между рестартами
// ─────────────────────────────────────────────────
//
// Why (09.08.2026): контейнер снова перезапустился сам — на этот раз по потолку
// кучи V8 (FATAL heap limit, см. шапку candleCache.js). Позиции в тот момент не
// было, поэтому обошлось, но дыра осталась открытой: у Hunter пик трейла и взвод
// BE-храповика лежат на диске (hunterCooldownStore.trail, фикс 20.06), а у adopt
// жили ТОЛЬКО в памяти strategistAdopt.js.
//
// Что это значило: рестарт под открытой ручной позой обнулял peak в 0. Бот
// поднимался и вёл сделку заново — трейл не срабатывал бы на откате от уже
// достигнутого пика, BE-храповик оказывался невзведённым, и позиция, которая
// была в плюсе, могла спокойно уехать в минус до биржевого стопа. Жёсткий SL
// это переживает (он resting-ордером лежит на бирже), а весь мягкий выход — нет.
//
// Формат и приёмы копируют hunterCooldownStore: своя версия схемы, атомарная
// запись (tmp + rename), ленивая загрузка, отбрасывание орфанов по hard-TTL
// (позиция закрылась, пока бот лежал → clearAdoptState не вызвался).
//
// Пишем только PROD-позиции: manualPaperSupervise гоняет ту же analyzeAdopt на
// бумажных двойниках, их состояние восстанавливать незачем.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../core/logger.js';

const VERSION = 1;
const DEFAULT_FILE = join('data', 'adopt_trail.json');

let FILE = DEFAULT_FILE;
let loaded = false;
let cache = emptyCache();

function emptyCache() {
  // { [positionId]: { peak, trough, beArmed, updatedAt } }
  return { version: VERSION, trail: {} };
}

// Орфаны чистим по тому же TTL, что и у Hunter: сутки без апдейта — значит поза
// давно закрылась, а мы проспали её close-handler.
const HARD_TTL_MS = 24 * 60 * 60_000;

/** Ленивая загрузка с отбрасыванием протухших записей. */
export function loadAdoptTrail(now = Date.now()) {
  if (loaded) return cache;
  loaded = true;

  // В тестах на дефолтном пути диск не трогаем — изоляция от прогонов.
  if (process.env.NODE_ENV === 'test' && FILE === DEFAULT_FILE) return cache;

  try {
    const data = JSON.parse(readFileSync(FILE, 'utf-8'));
    if (data?.version !== VERSION) {
      logger.warn(`[AdoptTrailStore] Unknown version ${data?.version}, ignoring`);
      return cache;
    }

    const trail = {};
    let expired = 0;
    for (const [pid, v] of Object.entries(data.trail || {})) {
      if (v && typeof v.peak === 'number' && typeof v.updatedAt === 'number' &&
          now - v.updatedAt < HARD_TTL_MS) {
        trail[pid] = {
          peak:      v.peak,
          trough:    typeof v.trough === 'number' ? v.trough : 0,
          beArmed:   v.beArmed === true,
          updatedAt: v.updatedAt,
        };
      } else expired++;
    }

    cache = { version: VERSION, trail };
    logger.info(`[AdoptTrailStore] Loaded: trail=${Object.keys(trail).length} (${expired} expired)`);
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`[AdoptTrailStore] Load failed: ${err.message}`);
    // ENOENT — нормальный первый запуск.
  }

  return cache;
}

/** Атомарная запись (tmp + rename), fire-and-forget. */
function persist() {
  if (process.env.NODE_ENV === 'test' && FILE === DEFAULT_FILE) return;
  const tmpPath = `${FILE}.${process.pid}.tmp`;
  try {
    mkdirSync('data', { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(cache, null, 2), 'utf-8');
    renameSync(tmpPath, FILE);
  } catch (err) {
    logger.warn(`[AdoptTrailStore] Save failed: ${err.message}`);
  }
}

/**
 * Мердж мягкого состояния позиции. Пик растёт монотонно, trough падает,
 * beArmed только взводится. Если ничего не изменилось — диск не трогаем
 * (иначе запись на каждом тике на каждую позу).
 */
export function setAdoptTrail(positionId, patch) {
  if (positionId == null) return;
  loadAdoptTrail();
  const key = String(positionId);
  const prev = cache.trail[key] || { peak: 0, trough: 0, beArmed: false };
  const next = {
    peak:    patch.peak    != null ? patch.peak    : prev.peak,
    trough:  patch.trough  != null ? patch.trough  : prev.trough,
    beArmed: patch.beArmed != null ? patch.beArmed : prev.beArmed,
    updatedAt: Date.now(),
  };
  if (prev.peak === next.peak && prev.trough === next.trough && prev.beArmed === next.beArmed) return;
  cache.trail[key] = next;
  persist();
}

/** Снимок для восстановления после рестарта. */
export function getAdoptTrailAll() {
  loadAdoptTrail();
  return cache.trail;
}

/** Снять персист при закрытии позиции (иначе орфан доживёт до TTL). */
export function clearAdoptTrail(positionId) {
  if (positionId == null) return;
  loadAdoptTrail();
  const key = String(positionId);
  if (cache.trail[key] !== undefined) {
    delete cache.trail[key];
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
