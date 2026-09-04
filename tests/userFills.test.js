// reconstructManualTrades: матчинг ручных сделок из HL userFills,
// исключая bot-fills (по oid, с legacy time-fallback).
//
// Регресс: ручной re-open в течение GRACE_MS (60с) после
// бот-закрытия той же монеты ошибочно глотался time-fallback'ом → adopt не
// видел свежий вход → поза без стопа.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { reconstructManualTrades, findRoundTripForPosition } = await import('../src/modules/userFills.js');

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

// ═══════════════════════════════════════════════
//  Net-position по всем fills: ручная нога схлопывается на bot-close, не висит
// фантомом (−$7.36 пропадал из Recent Activities)
// ═══════════════════════════════════════════════

test('ручной re-open после adopt-close (bot) → закрытая ручная сделка, не фантом-open', () => {
  // Юзер: Open Short руками @ t0 (oid 100). Бот усыновил и ЗАКРЫЛ @ t1 (oid 200,
  // в bot_oid_log). Юзер снова Open Short @ t1+35s (oid 300), закрыл руками @ t2.
  const t0 = 0, t1 = 5 * 86_400_000, t2 = t1 + 2 * 3_600_000;
  const fills = [
    makeFill({ time: t0,          dir: 'Open Short',  oid: 100, px: 0.11, sz: 700 }),
    makeFill({ time: t1,          dir: 'Close Short', oid: 200, px: 0.10, sz: 700, closedPnl: 1.5 }),
    makeFill({ time: t1 + 35_000, dir: 'Open Short',  oid: 300, px: 0.11, sz: 777 }),
    makeFill({ time: t2,          dir: 'Close Short', oid: 301, px: 0.12, sz: 777, closedPnl: -7.36 }),
  ];
  // Бот-history: усыновлённая поза t0..t1 (entry_time = t0).
  const botTrades = [{ coin: 'X', entry_time: t0, closed_at: t1 }];
  const botOidSet = new Set([200]); // только бот-ордер закрытия

  const trades = reconstructManualTrades(fills, botTrades, botOidSet).filter((t) => t.coin === 'X');
  const open = trades.find((t) => t.status === 'open');
  assert.equal(open, undefined, 'не должно быть фантомной открытой ноги');
  // Усыновлённая поза (entry=t0) деду­плится (в history); остаётся свежая ручная.
  const fresh = trades.find((t) => t.entryTime === t1 + 35_000);
  assert.ok(fresh, 'свежий ручной re-open должен стать закрытой сделкой');
  assert.equal(fresh.status, 'closed');
  assert.equal(fresh.closeTime, t2);
  assert.ok(Math.abs(fresh.pnl - (-7.36)) < 1e-9, 'pnl = −7.36');
});

test('adopt-поза (entry матчит bot-history) НЕ дублируется как ручная', () => {
  const t0 = 1_000_000, t1 = t0 + 600_000;
  const fills = [
    makeFill({ time: t0, dir: 'Open Short',  oid: 100, px: 1, sz: 100 }),
    makeFill({ time: t1, dir: 'Close Short', oid: 101, px: 0.99, sz: 100, closedPnl: 0.5 }), // ручное закрытие adopt
  ];
  // Бот усыновил: history entry_time ≈ t0 (тот же ручной open).
  const botTrades = [{ coin: 'X', entry_time: t0 + 500, closed_at: t1 }];
  const botOidSet = new Set([999]); // close-fill oid 101 НЕ бот → иначе был бы виден как ручной

  const trades = reconstructManualTrades(fills, botTrades, botOidSet).filter((t) => t.coin === 'X');
  assert.equal(trades.length, 0, 'adopt уже в history → как ручная не эмитится');
});

// ═══════════════════════════════════════════════
// findRoundTripForPosition: анти-мердж при флипе
// ═══════════════════════════════════════════════
// Юзер: Short @1.5821→1.6034 (−1.04), флип в Long @1.6042→1.6445 (+1.89).
// classifyClose складывал обе ноги в +0.85 под шортом → минус пропадал.
// findRoundTripForPosition должен вернуть РОВНО шорт-ногу (−1.04).
test('флип short→long: для adopted-шорта берётся его нога, не сумма', () => {
  const fills = [
    makeFill({ coin: 'LIT', time: 1000,  dir: 'Open Short',  px: 1.5821, sz: 49 }),
    makeFill({ coin: 'LIT', time: 2000,  dir: 'Close Short', px: 1.6034, sz: 49, closedPnl: -1.0437 }),
    makeFill({ coin: 'LIT', time: 3000,  dir: 'Open Long',   px: 1.6042, sz: 47 }),
    makeFill({ coin: 'LIT', time: 99000, dir: 'Close Long',  px: 1.6445, sz: 47, closedPnl: 1.8941 }),
  ];
  // DB-поза = усыновлённый шорт (entry≈время open-fill шорта).
  const shortPos = { coin: 'LIT', side: 'short', entry_time: 1000 };
  const leg = findRoundTripForPosition(shortPos, fills);
  assert.ok(leg, 'нога найдена');
  assert.equal(leg.side, 'short');
  assert.ok(Math.abs(leg.pnl - (-1.0437)) < 1e-9, `pnl шорта = -1.0437, got ${leg.pnl}`);
  assert.ok(Math.abs(leg.closePx - 1.6034) < 1e-9);
  assert.equal(leg.closedAt, 2000);
});

test('флип: для лонг-ноги берётся её pnl (+1.89), не сумма', () => {
  const fills = [
    makeFill({ coin: 'LIT', time: 1000,  dir: 'Open Short',  px: 1.5821, sz: 49 }),
    makeFill({ coin: 'LIT', time: 2000,  dir: 'Close Short', px: 1.6034, sz: 49, closedPnl: -1.0437 }),
    makeFill({ coin: 'LIT', time: 3000,  dir: 'Open Long',   px: 1.6042, sz: 47 }),
    makeFill({ coin: 'LIT', time: 99000, dir: 'Close Long',  px: 1.6445, sz: 47, closedPnl: 1.8941 }),
  ];
  const longPos = { coin: 'LIT', side: 'long', entry_time: 3000 };
  const leg = findRoundTripForPosition(longPos, fills);
  assert.ok(leg);
  assert.equal(leg.side, 'long');
  assert.ok(Math.abs(leg.pnl - 1.8941) < 1e-9);
});

test('findRoundTripForPosition: нет fills → null (фолбэк на classifyClose)', () => {
  assert.equal(findRoundTripForPosition({ coin: 'LIT', side: 'short', entry_time: 0 }, []), null);
});

// ═══════════════════════════════════════════════
// два adopt-лонга с ОДНИМ (неверным) entry_time
// ═══════════════════════════════════════════════
// Флип short→long, затем второй лонг. Обе adopt-позы получили entry_time =
// closed_at шорта → матч по времени давал ОБЕИМ первый лонг: он задваивался,
// второй (победный +0.75) терялся. Матч по entry_price разводит их однозначно.
const kaitoFlipFills = [
  makeFill({ coin: 'KAITO', time: 1000,  dir: 'Open Short',  px: 0.67167, sz: 107 }),
  makeFill({ coin: 'KAITO', time: 2000,  dir: 'Close Short', px: 0.68707, sz: 107, closedPnl: -1.6478 }),
  makeFill({ coin: 'KAITO', time: 3000,  dir: 'Open Long',   px: 0.68976, sz: 90 }),
  makeFill({ coin: 'KAITO', time: 4000,  dir: 'Close Long',  px: 0.67357, sz: 90,  closedPnl: -1.4571 }),
  makeFill({ coin: 'KAITO', time: 5000,  dir: 'Open Long',   px: 0.67191, sz: 87 }),
  makeFill({ coin: 'KAITO', time: 6000,  dir: 'Close Long',  px: 0.68051, sz: 87,  closedPnl: 0.7482 }),
];
const KAITO_BAD_TIME = 2000; // closed_at шорта — обе позы застряли на нём

test('KAITO: первый лонг матчится по entry_price, не по времени', () => {
  const pos = { coin: 'KAITO', side: 'long', entry_price: 0.68976, entry_time: KAITO_BAD_TIME };
  const leg = findRoundTripForPosition(pos, kaitoFlipFills);
  assert.ok(leg, 'нога найдена');
  assert.ok(Math.abs(leg.closePx - 0.67357) < 1e-9, `close первого лонга, got ${leg.closePx}`);
  assert.ok(Math.abs(leg.pnl - (-1.4571)) < 1e-9);
});

test('KAITO: второй (победный) лонг не теряется — матч по entry_price', () => {
  const pos = { coin: 'KAITO', side: 'long', entry_price: 0.67191, entry_time: KAITO_BAD_TIME };
  const leg = findRoundTripForPosition(pos, kaitoFlipFills);
  assert.ok(leg, 'нога найдена (раньше терялась)');
  assert.ok(Math.abs(leg.closePx - 0.68051) < 1e-9, `close второго лонга, got ${leg.closePx}`);
  assert.ok(Math.abs(leg.pnl - 0.7482) < 1e-9, `победный pnl +0.7482, got ${leg.pnl}`);
});

test('KAITO: same-side нога ещё не закрыта в fills → null (integrity сделает defer)', () => {
  // fills до закрытия первого лонга: short закрыт, long1 открыт но не закрыт.
  const lagFills = kaitoFlipFills.slice(0, 3);
  const pos = { coin: 'KAITO', side: 'long', entry_price: 0.68976, entry_time: KAITO_BAD_TIME };
  assert.equal(findRoundTripForPosition(pos, lagFills), null);
});
