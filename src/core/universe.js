/**
 * universe.js — Единый источник истины для торгуемого universe.
 *
 * Scout записывает сюда данные после каждого fetch.
 * Executor читает отсюда для resolveAsset.
 *
 * Никаких собственных HTTP-вызовов — только хранилище.
 * Устраняет рассинхрон между модулями.
 */

import { logger } from './logger.js';

// Полный массив объектов из meta.universe
// Каждый элемент: { name: "ETH", szDecimals: 4, ... }
let cachedUniverse = [];
let cacheTime      = 0;

/**
 * Записывает свежий universe.
 * Вызывается из Scout после успешного fetch.
 *
 * @param {Array<{ name: string, szDecimals: number }>} universe
 */
export function setUniverse(universe) {
  if (!Array.isArray(universe) || universe.length === 0) {
    logger.warn(`[Universe] Attempted to set empty/invalid universe — ignored`);
    return;
  }

  cachedUniverse = universe;
  cacheTime      = Date.now();

  logger.info(
    `[Universe] Updated — ${universe.length} assets | ` +
    `sample: [${universe.slice(0, 5).map((a) => a.name).join(', ')}]`,
  );
}

/**
 * Возвращает текущий закешированный universe.
 * @returns {Array<{ name: string, szDecimals: number }>}
 */
export function getUniverse() {
  return cachedUniverse;
}

/**
 * Возвращает Set имён монет (UPPERCASE) для быстрой фильтрации.
 * @returns {Set<string>}
 */
export function getTradeableSet() {
  return new Set(cachedUniverse.map((a) => a.name.toUpperCase()));
}

/**
 * Ищет актив по имени (case-insensitive).
 * Возвращает объект из universe или undefined.
 *
 * @param {string} coin
 * @returns {{ name: string, szDecimals: number } | undefined}
 */
export function findAsset(coin) {
  const upper = coin.toUpperCase();
  return cachedUniverse.find((a) => a.name.toUpperCase() === upper);
}

/**
 * Возвращает true если кеш свежий (< 5 мин) и не пустой.
 * @returns {boolean}
 */
export function isUniverseFresh() {
  return cachedUniverse.length > 0 && Date.now() - cacheTime < 5 * 60_000;
}

/**
 * Возвращает возраст кеша в секундах.
 * @returns {number}
 */
export function getUniverseAge() {
  return cacheTime > 0 ? Math.round((Date.now() - cacheTime) / 1000) : Infinity;
}
