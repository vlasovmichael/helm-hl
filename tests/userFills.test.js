// reconstructManualTrades: матчинг ручных сделок из HL userFills,
// исключая bot-fills (по oid, с legacy time-fallback).
//
// Регресс на баг 2026-06-17: ручной re-open в течение GRACE_MS (60с) после
// бот-закрытия той же монеты ошибочно глотался time-fallback'ом → adopt не
// видел свежий вход → поза без стопа.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { reconstructManualTrades } = await import('../src/modules/userFills.js');

// ── Хелпер: fill в normalize'd-форме (как отдаёт normalizeFill) ──
function makeFill({ coin = 'X', px = 100, sz = 1, time, dir, oid = null, closedPnl = 0, fee = 0 }) {
  return { coin, px, sz, time, dir, oid, closedPnl, fee };
}

// ═══════════════════════════════════════════════
//  Баг: manual re-open сразу после bot-close той же монеты
// ═══════════════════════════════════════════════

test('manual re-open в пределах GRACE_MS после bot-close НЕ глотается (adopt видит свежий вход)', () => {
  // Бот: open short @ t=0 (oid 1), close short @ t=60_000 (oid 2).
  // Юзер: open short руками @ t=60_005 (через 5с после бот-закрытия, oid 999).
  const fills = [
    makeFill({ time: 0,      dir: 'Open Short',  oid: 1, px: 100, sz: 1 }),
    makeFill({ time: 60_000, dir: 'Close Short', oid: 2, px: 99,  sz: 1, closedPnl: 1 }),
    makeFill({ time: 60_005, dir: 'Open Short',  oid: 999, px: 98, sz: 2 }),
  ];
  const botTrades = [{ coin: 'X', entry_time: 0, closed_at: 60_000 }];
  const botOidSet = new Set([1, 2]);

  const trades = reconstructManualTrades(fills, botTrades, botOidSet);

  const open = trades.find((t) => t.coin === 'X' && t.status === 'open');
  assert.ok(open, 'ручной open должен быть распознан как открытая сделка');
  assert.equal(open.entryTime, 60_005, 'entryTime = время ручного open-fill');
  assert.equal(open.side, 'short');
});

test('bot-fills (по oid) исключаются — только ручной вход остаётся', () => {
  const fills = [
    makeFill({ time: 0,      dir: 'Open Long',  oid: 1, px: 10, sz: 5 }),
    makeFill({ time: 30_000, dir: 'Close Long', oid: 2, px: 11, sz: 5, closedPnl: 5 }),
    makeFill({ time: 35_000, dir: 'Open Long',  oid: 777, px: 11, sz: 3 }),
  ];
  const botTrades = [{ coin: 'X', entry_time: 0, closed_at: 30_000 }];
  const botOidSet = new Set([1, 2]);

  const trades = reconstructManualTrades(fills, botTrades, botOidSet);
  // Должна быть РОВНО одна сделка — ручная, открытая.
  assert.equal(trades.length, 1);
  assert.equal(trades[0].status, 'open');
  assert.equal(trades[0].entryTime, 35_000);
});

// ═══════════════════════════════════════════════
//  Legacy time-fallback (fills без oid) — не сломан
// ═══════════════════════════════════════════════

test('legacy fill без oid внутри bot-окна — отфильтрован по времени', () => {
  // oid=null → oid-фильтр неприменим → time-fallback. Внутри [entry-10s, close+60s].
  const fills = [
    makeFill({ time: 50_000, dir: 'Open Short', oid: null, px: 100, sz: 1 }),
  ];
  const botTrades = [{ coin: 'X', entry_time: 0, closed_at: 60_000 }];
  const botOidSet = new Set([1, 2]); // активен, но у fill нет oid → fallback

  const trades = reconstructManualTrades(fills, botTrades, botOidSet);
  assert.equal(trades.length, 0, 'legacy fill в bot-окне должен отфильтроваться');
});

test('legacy fill без oid ВНЕ bot-окна — остаётся', () => {
  // close+60s = 120_000; fill @ 130_000 уже вне окна.
  const fills = [
    makeFill({ time: 130_000, dir: 'Open Short', oid: null, px: 100, sz: 1 }),
  ];
  const botTrades = [{ coin: 'X', entry_time: 0, closed_at: 60_000 }];
  const botOidSet = new Set([1, 2]);

  const trades = reconstructManualTrades(fills, botTrades, botOidSet);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].status, 'open');
  assert.equal(trades[0].entryTime, 130_000);
});
