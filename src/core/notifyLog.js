// ─────────────────────────────────────────────────
//  Лог отправленных уведомлений (для колокольчика на дашборде)
// ─────────────────────────────────────────────────
// fireNtfy() раньше стрелял и забывал — нигде не оставалось следа, что ушло на
// телефон. Колокольчику нужен журнал: пишем сюда каждый ушедший пуш (ring-buffer,
// последние CAP штук), персист в data/notifications.json (переживает рестарт).
//
// Только запись + чтение, без бизнес-логики. Fail-soft: ошибки диска не валят
// тик (журнал — вспомогательный, не критичный путь).

import { readFileSync, writeFileSync } from 'node:fs';
import { logger } from './logger.js';

const FILE = 'data/notifications.json';
const CAP = 100;

/** @type {Array<{id:number, ts:number, title:string, message:string, topic:string, tags:string[], priority:number, emailed:boolean}>} */
let log = [];
let nextId = 1;
let loaded = false;

// Подписчики на новые уведомления (дашборд пушит их в WS мгновенно, без поллинга
// — тот же паттерн, что subscribeLogs в logger.js). Fail-soft: ошибка подписчика
// не валит запись в журнал.
const subscribers = new Set();

/** Подписка на каждое новое уведомление. Возвращает функцию отписки. */
export function subscribeNotifications(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    if (Array.isArray(raw.items)) log = raw.items;
    nextId = (raw.nextId | 0) || (log.reduce((m, n) => Math.max(m, n.id || 0), 0) + 1);
  } catch {
    // нет файла / битый — с нуля
  }
}

function persist() {
  try {
    writeFileSync(FILE, JSON.stringify({ nextId, items: log }));
  } catch (err) {
    logger.warn(`[notifyLog] persist failed: ${err.message}`);
  }
}

/**
 * Записывает одно ушедшее уведомление в журнал.
 * @param {{title:string, message:string, topic?:string, tags?:string[], priority?:number, emailed?:boolean, ts?:number}} n
 * @returns {object} записанная строка
 */
export function recordNotification(n = {}) {
  load();
  const row = {
    id: nextId++,
    ts: n.ts ?? Date.now(),
    title: n.title || '',
    message: n.message || '',
    topic: n.topic || '',
    tags: Array.isArray(n.tags) ? n.tags : [],
    priority: n.priority ?? 3,
    emailed: !!n.emailed,
  };
  log.push(row);
  if (log.length > CAP) log = log.slice(-CAP);
  persist();
  for (const fn of subscribers) {
    try { fn(row); } catch { /* подписчик не должен валить журнал */ }
  }
  return row;
}

/**
 * Последние уведомления, новейшие первыми.
 * @param {number} [limit=50]
 */
export function getNotifications(limit = 50) {
  load();
  return log.slice(-limit).reverse();
}

/** Уведомления, ушедшие после ts (для дайджеста). Хронологически по возрастанию. */
export function getNotificationsSince(ts) {
  load();
  return log.filter((n) => n.ts >= ts);
}

/** Сброс (тесты). */
export function _resetNotifyLog() {
  log = [];
  nextId = 1;
  loaded = true;
}
