// reconstructRoundTrips: единый движок round-trip'ов для Ledger + дашборда.
// Проверяем source-классификацию (bot/adopted/manual) и startPosition-якорь
// (позы, открытые до 60d-окна HL, не теряют closedPnl).
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { reconstructRoundTrips } = await import('../src/modules/userFills.js');

function makeFill({ coin = 'X', px = 100, sz = 1, time, dir, oid = null, closedPnl = 0, fee = 0, startPosition }) {
  const f = { coin, px, sz, time, dir, oid, closedPnl, fee };
  if (startPosition !== undefined) f.startPosition = startPosition;
  return f;
}

// ── source: bot (открыл бот) ──────────────────────
test('бот открыл и закрыл → source=bot', () => {
  const fills = [
    makeFill({ time: 0,      dir: 'Open Short',  oid: 1, px: 100, sz: 1 }),
    makeFill({ time: 60_000, dir: 'Close Short', oid: 2, px: 99,  sz: 1, closedPnl: 1, fee: 0.05 }),
  ];
  const trades = reconstructRoundTrips(fills, [], new Set([1, 2]));
  assert.equal(trades.length, 1);
  assert.equal(trades[0].source, 'bot');
  assert.equal(trades[0].status, 'closed');
  assert.ok(Math.abs(trades[0].pnl - 1) < 1e-9);
});

// ── source: adopted (я открыл, бот закрыл) ────────
test('ручной вход + бот-выход → source=adopted', () => {
  const fills = [
    makeFill({ time: 0,      dir: 'Open Short',  oid: 100, px: 100, sz: 1 }),   // ручной open
    makeFill({ time: 60_000, dir: 'Close Short', oid: 200, px: 99,  sz: 1, closedPnl: 1 }), // бот-close
  ];
  // bot history знает усыновлённую позу (entry≈ручной open) + close-oid бота.
  const botTrades = [{ coin: 'X', entry_time: 0, closed_at: 60_000 }];
  const trades = reconstructRoundTrips(fills, botTrades, new Set([200]));
  assert.equal(trades.length, 1);
  assert.equal(trades[0].source, 'adopted');
});

// ── source: adopted (ручной вход + РУЧНОЙ выход, протухший entry_time) ──
// Корневой кейс: вход ручной (нет бот-OID), выход ручной/external
// (нет бот-OID), а entry_time в history бэкфилнут с лагом → промахивается мимо
// ±3с. Спасает матч по времени ЗАКРЫТИЯ (history.closed_at = реальная нога).
test('ручной вход + ручной выход, но history знает закрытие → source=adopted', () => {
  const fills = [
    makeFill({ time: 1_000_000, dir: 'Open Short',  oid: 100, px: 100, sz: 1 }),   // ручной open
    makeFill({ time: 1_300_000, dir: 'Close Short', oid: 101, px: 99,  sz: 1, closedPnl: 1 }), // ручной close
  ];
  // entry_time в history протух (отстаёт на 2 мин), но closed_at = реальная нога.
  const botTrades = [{ coin: 'X', entry_time: 1_000_000 - 120_000, closed_at: 1_300_000 }];
  const trades = reconstructRoundTrips(fills, botTrades, new Set([999]));
  assert.equal(trades.length, 1);
  assert.equal(trades[0].source, 'adopted', 'матч по времени закрытия, не по entry_time');
});

test('close-матч в пределах допуска (±5с округление индексации) → adopted', () => {
  const fills = [
    makeFill({ time: 1_000_000, dir: 'Open Short',  oid: 100, px: 100, sz: 1 }),
    makeFill({ time: 1_300_000, dir: 'Close Short', oid: 101, px: 99,  sz: 1, closedPnl: 1 }),
  ];
  const botTrades = [{ coin: 'X', entry_time: 0, closed_at: 1_300_000 + 4000 }]; // +4с
  const trades = reconstructRoundTrips(fills, botTrades, new Set([999]));
  assert.equal(trades[0].source, 'adopted');
});

// ── source: manual (я открыл и закрыл) ────────────
test('ручной вход + ручной выход → source=manual', () => {
  const fills = [
    makeFill({ time: 0,      dir: 'Open Long',  oid: 100, px: 10, sz: 5 }),
    makeFill({ time: 30_000, dir: 'Close Long', oid: 101, px: 11, sz: 5, closedPnl: 5 }),
  ];
  const trades = reconstructRoundTrips(fills, [], new Set([999]));
  assert.equal(trades.length, 1);
  assert.equal(trades[0].source, 'manual');
  assert.equal(trades[0].status, 'closed');
});

test('чужое закрытие той же монеты в истории (далеко по времени) → остаётся manual', () => {
  const fills = [
    makeFill({ time: 5_000_000, dir: 'Open Long',  oid: 100, px: 10, sz: 5 }),
    makeFill({ time: 5_030_000, dir: 'Close Long', oid: 101, px: 11, sz: 5, closedPnl: 5 }),
  ];
  // history знает ДРУГУЮ сделку по X, закрытую на час раньше — не должна матчить.
  const botTrades = [{ coin: 'X', entry_time: 1_000_000, closed_at: 1_300_000 }];
  const trades = reconstructRoundTrips(fills, botTrades, new Set([999]));
  assert.equal(trades[0].source, 'manual', 'close-матч не должен ловить чужую ногу');
});

// ── startPosition-якорь: поза открыта ДО окна ─────
test('закрытие позы, открытой до окна (startPosition) → closedPnl не теряется', () => {
  // Первый fill в окне — Close Short на 2 контракта; позиция была -2 ДО него.
  const fills = [
    makeFill({ time: 1_000, dir: 'Close Short', oid: 5, px: 50, sz: 2, closedPnl: 3.2, fee: 0.1, startPosition: -2 }),
  ];
  const trades = reconstructRoundTrips(fills, [], new Set([5]));
  assert.equal(trades.length, 1, 'нога должна схлопнуться по startPosition-якорю');
  assert.equal(trades[0].status, 'closed');
  assert.ok(Math.abs(trades[0].pnl - 3.2) < 1e-9);
});

test('без startPosition (старые тест-fills) поведение прежнее — open-anchored', () => {
  // Close без предшествующего Open и без startPosition: net стартует с 0, уходит
  // в +2 и не возвращается → нога остаётся открытой (status open), не теряем pnl.
  const fills = [
    makeFill({ time: 1_000, dir: 'Close Short', oid: 5, px: 50, sz: 2, closedPnl: 3.2 }),
  ];
  const trades = reconstructRoundTrips(fills, [], new Set([5]));
  assert.equal(trades.length, 1);
  assert.equal(trades[0].status, 'open');
});
