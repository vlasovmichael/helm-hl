// Монеты, которые нянька не подхватывает: вход из окна сделки с выключенным Adopted.
// Отметка на диске: лимитка может налиться после рестарта, и поза не должна получить стоп.
// Сторонней ручной позе отметка не нужна, поэтому её отсутствие значит «вести как обычно».

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const VERSION = 1;
const DEFAULT_FILE = join(config.accountDir, 'adopt_opt_out.json');

// Пауза перед снятием отметки: филл рыночного ордера появляется в позициях не сразу.
export const OPT_OUT_GRACE_MS = 60_000;

let file = DEFAULT_FILE;
let loaded = false;
let marks = {};

const key = (coin) => String(coin).toUpperCase();
const isolatedInTests = () => process.env.NODE_ENV === 'test' && file === DEFAULT_FILE;

function load() {
  if (loaded) return;
  loaded = true;
  if (isolatedInTests()) return;
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    if (data?.version === VERSION && data.marks && typeof data.marks === 'object') marks = data.marks;
    else logger.warn(`[AdoptOptOut] Unknown format in ${file}, ignoring`);
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`[AdoptOptOut] Load failed: ${err.message}`);
  }
}

function persist() {
  if (isolatedInTests()) return;
  const tmpPath = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(config.accountDir, { recursive: true });
    writeFileSync(tmpPath, JSON.stringify({ version: VERSION, marks }, null, 2), 'utf-8');
    renameSync(tmpPath, file);
  } catch (err) {
    logger.warn(`[AdoptOptOut] Save failed: ${err.message}`);
  }
}

export function isAdoptOff(coin) {
  load();
  return marks[key(coin)] !== undefined;
}

export function markAdoptOff(coin, now = Date.now()) {
  load();
  marks[key(coin)] = now;
  persist();
}

export function clearAdoptOff(coin) {
  load();
  if (marks[key(coin)] === undefined) return;
  delete marks[key(coin)];
  persist();
}

/** Снимает отметки монет без позы и без лимитки на вход; ошибка чтения ордеров их не трогает. */
export async function pruneAdoptOff(positionCoins, fetchOpenOrders, now = Date.now()) {
  load();
  const present = new Set([...positionCoins].map(key));
  const candidates = Object.entries(marks)
    .filter(([coin, markedAt]) => !present.has(coin) && now - markedAt >= OPT_OUT_GRACE_MS)
    .map(([coin]) => coin);
  if (candidates.length === 0) return;

  let orders;
  try {
    orders = await fetchOpenOrders();
  } catch (err) {
    logger.debug(`[AdoptOptOut] open orders unavailable: ${err.message}`);
    return;
  }
  const resting = new Set(orders.filter((order) => !order.reduceOnly).map((order) => key(order.coin)));
  for (const coin of candidates) {
    if (!resting.has(coin)) clearAdoptOff(coin);
  }
}

export function _setFileForTest(path) {
  file = path ?? DEFAULT_FILE;
  loaded = false;
  marks = {};
}
