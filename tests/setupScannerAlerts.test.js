// Тесты Setup Scanner Swing алертов: exit-контекст, парсинг позиций, тихий час.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── ENV до импорта: модуль тянет config (exchange/ntfy) ──
process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const {
  evaluateExitContext, parseAccountPositions, isQuietHour, analyzeSlTp,
} = await import('../src/modules/setupScannerAlerts.js');

// ── evaluateExitContext ────────────────────────

test('exit: 1h тренд против LONG → level trend', () => {
  const r = evaluateExitContext('long', { trend1h: 'down', trend4h: 'down', ext1h: -3 });
  assert.equal(r.level, 'trend');
  assert.ok(r.reason.includes('LONG'));
});

test('exit: 1h тренд против SHORT → level trend', () => {
  const r = evaluateExitContext('short', { trend1h: 'up', trend4h: 'none', ext1h: 2 });
  assert.equal(r.level, 'trend');
});

test('exit: цена под 1h EMA20 против LONG (тренд ещё up) → level ema20', () => {
  const r = evaluateExitContext('long', { trend1h: 'up', trend4h: 'up', ext1h: -1.2 });
  assert.equal(r.level, 'ema20');
  assert.ok(r.reason.includes('EMA20'));
});

test('exit: цена над 1h EMA20 против SHORT → level ema20', () => {
  const r = evaluateExitContext('short', { trend1h: 'down', trend4h: 'down', ext1h: 0.9 });
  assert.equal(r.level, 'ema20');
});

test('exit: контекст за позицию → level null', () => {
  const long = evaluateExitContext('long', { trend1h: 'up', trend4h: 'up', ext1h: 0.8 });
  assert.equal(long.level, null);
  const short = evaluateExitContext('short', { trend1h: 'down', trend4h: 'down', ext1h: -0.9 });
  assert.equal(short.level, null);
});

test('exit: нет данных по тренду → level null (не пугаем зря)', () => {
  assert.equal(evaluateExitContext('long', { trend1h: null, trend4h: null, ext1h: null }).level, null);
  assert.equal(evaluateExitContext('long', null).level, null);
});

test('exit: trend1h none (mixed) против LONG — это не разворот, но EMA20 ловит', () => {
  // none ≠ down: жёсткий warn не срабатывает, но закрепление под EMA20 — да.
  const r = evaluateExitContext('long', { trend1h: 'none', trend4h: 'up', ext1h: -2 });
  assert.equal(r.level, 'ema20');
});

// ── parseAccountPositions ──────────────────────

test('parseAccountPositions: long/short по знаку szi, пустые скипаются', () => {
  const out = parseAccountPositions([
    { position: { coin: 'BCH', szi: '-1.5', positionValue: '290.1' } },
    { position: { coin: 'SOL', szi: '4', positionValue: '250' } },
    { position: { coin: 'ETH', szi: '0' } },        // нулевая — скип
    { position: { szi: '2' } },                      // без coin — скип
  ]);
  assert.deepEqual(out.map((p) => [p.coin, p.side]), [['BCH', 'short'], ['SOL', 'long']]);
  assert.equal(out[0].sizeUsd, 290.1);
});

// ── analyzeSlTp ────────────────────────────────
// Фикстура = реальные ордера оператора 2026-06-11 (ETH short, SL/TP position tpsl).

const ETH_ORDERS = [
  { coin: 'ETH', isTrigger: true, reduceOnly: true, orderType: 'Stop Market', triggerPx: '1677.3' },
  { coin: 'ETH', isTrigger: true, reduceOnly: true, orderType: 'Take Profit Market', triggerPx: '1488.3' },
  { coin: 'BNB', isTrigger: true, reduceOnly: true, orderType: 'Stop Market', triggerPx: '615.17' },
];

test('analyzeSlTp: SHORT с SL выше и TP ниже → дистанции и R:R', () => {
  const r = analyzeSlTp({ coin: 'ETH', side: 'short', entryPx: 1622.6 }, ETH_ORDERS);
  assert.equal(r.sl, 1677.3);
  assert.equal(r.tp, 1488.3);
  assert.ok(Math.abs(r.riskPct - 3.37) < 0.05);
  assert.ok(Math.abs(r.rewardPct - 8.28) < 0.05);
  assert.ok(Math.abs(r.rr - 2.45) < 0.05);
  assert.equal(r.noSl, false);
  assert.equal(r.slWrongSide, false);
});

test('analyzeSlTp: чужие монеты не подмешиваются', () => {
  const r = analyzeSlTp({ coin: 'BNB', side: 'short', entryPx: 586.07 }, ETH_ORDERS);
  assert.equal(r.sl, 615.17);
  assert.equal(r.tp, null);
  assert.equal(r.rr, null);
});

test('analyzeSlTp: нет стопа → noSl', () => {
  const r = analyzeSlTp({ coin: 'SOL', side: 'long', entryPx: 62 }, ETH_ORDERS);
  assert.equal(r.noSl, true);
  assert.equal(r.sl, null);
});

test('analyzeSlTp: стоп не с той стороны → slWrongSide', () => {
  // LONG со «стопом» ВЫШЕ входа — инвалидации нет.
  const r = analyzeSlTp({ coin: 'ETH', side: 'long', entryPx: 1622.6 }, ETH_ORDERS);
  assert.equal(r.slWrongSide, true);
});

test('analyzeSlTp: LONG зеркало — SL ниже, TP выше', () => {
  const orders = [
    { coin: 'SOL', isTrigger: true, reduceOnly: true, orderType: 'Stop Market', triggerPx: '60' },
    { coin: 'SOL', isTrigger: true, reduceOnly: true, orderType: 'Take Profit Market', triggerPx: '70' },
  ];
  const r = analyzeSlTp({ coin: 'SOL', side: 'long', entryPx: 62 }, orders);
  assert.ok(Math.abs(r.riskPct - 3.23) < 0.05);
  assert.ok(Math.abs(r.rr - 4.0) < 0.05);
  assert.equal(r.slWrongSide, false);
});

// ── isQuietHour ────────────────────────────────

test('quiet hour: 03:00 Warsaw = тихо, 12:00 = нет', () => {
  // 2026-06-11: Warsaw = UTC+2 → 01:00 UTC = 03:00 Warsaw, 10:00 UTC = 12:00.
  assert.equal(isQuietHour(Date.parse('2026-06-11T01:00:00Z')), true);
  assert.equal(isQuietHour(Date.parse('2026-06-11T10:00:00Z')), false);
});

test('quiet hour: границы — 08:00 Warsaw уже не тихо, 00:30 тихо', () => {
  assert.equal(isQuietHour(Date.parse('2026-06-11T06:00:00Z')), false); // 08:00 Warsaw
  assert.equal(isQuietHour(Date.parse('2026-06-10T22:30:00Z')), true);  // 00:30 Warsaw
});
