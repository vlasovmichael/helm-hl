// ─────────────────────────────────────────────────
//  Hunter Cross-strategy Cooldown
// ─────────────────────────────────────────────────
// Общий "карантин" между Hunter SHORT и Hunter LONG. После любого CLOSE одной
// из стратегий — монета на N минут запрещена для второй. Защищает от ловли ножа
// после успешного шорта (кейс SAGA 2026-05-13: Hunter SHORT TP +$1.13, потом
// Hunter LONG в ту же SAGA дважды SL).
//
// Внутри каждой стратегии уже есть свой postSlCooldown, но он не знает про
// действия соседа. Этот модуль — общий для обоих.

import { config } from '../core/config.js';

const cooldownMs = () => config.trading.hunterCrossCooldownMin * 60_000;
const crossMap   = new Map();  // coin → ts последнего close любой Hunter-стратегии

export function setHunterCrossCooldown(coin, now = Date.now()) {
  if (!coin) return;
  crossMap.set(coin, now);
}

export function isHunterCrossCooldownActive(coin, now = Date.now()) {
  const ts = crossMap.get(coin);
  if (!ts) return false;
  return now - ts < cooldownMs();
}

export function getHunterCrossCooldownRemainMs(coin, now = Date.now()) {
  const ts = crossMap.get(coin);
  if (!ts) return 0;
  return Math.max(0, cooldownMs() - (now - ts));
}

export function resetHunterCrossCooldowns() {
  crossMap.clear();
}

/** Снимок активных cross-cooldown'ов для дашборда. [{coin, remainMs}]. */
export function getHunterCrossCooldownSnapshot(now = Date.now()) {
  const ttl = cooldownMs();
  const out = [];
  for (const [coin, ts] of crossMap) {
    const remain = ttl - (now - ts);
    if (remain > 0) out.push({ coin, remainMs: remain });
  }
  return out;
}
