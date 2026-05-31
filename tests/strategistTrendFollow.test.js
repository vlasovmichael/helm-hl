// Тесты Strategy #4 trend_follow (Chill Boy) — analyzeTrendFollow.
// Свечи инжектируются через candleFetcher (DI), без сетевых вызовов.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.TELEGRAM_BOT_TOKEN    = '';
process.env.CHILL_BOY_ENABLED     = 'true';

const { analyzeTrendFollow, scanChillBoyRadar, getChillBoySignals, resetTrendFollowState } =
  await import('../src/modules/strategistTrendFollow.js');

const HOUR = 3_600_000;
const T0   = 1_700_000_000_000;

function candle(high, low, close) { return { high, low, close, open: close }; }
function flatCandles(n, price, hlSpread = 1) {
  return Array.from({ length: n }, () => candle(price + hlSpread / 2, price - hlSpread / 2, price));
}
function noisyCandles(n, price, hlSpread = 10) {
  return Array.from({ length: n }, () => candle(price + hlSpread / 2, price - hlSpread / 2, price));
}

/** Helper: fetcher с предзаданными свечами на coin. */
function makeFetcher(byCoin) {
  return async (coin) => byCoin[coin] || null;
}

/** Fetcher без свечей — для exit-тестов (скан идёт всегда, но ничего не находит). */
const nullFetcher = makeFetcher({});

// ═══════════════════════════════════════════════
//  Entry detection
// ═══════════════════════════════════════════════

test('IDLE + нет свечей → HOLD', async () => {
  resetTrendFollowState();
  const fetcher = makeFetcher({});
  const r = await analyzeTrendFollow([{ coin: 'BTC', price: 100 }], null, T0, fetcher);
  assert.equal(r.action, 'HOLD');
});

test('IDLE + только flat-история (no squeeze) → HOLD', async () => {
  resetTrendFollowState();
  // Одинаковая vol — ATR(20)/ATR(50) ≈ 1, не сжатие.
  const fetcher = makeFetcher({ BTC: flatCandles(60, 100, 2) });
  const r = await analyzeTrendFollow([{ coin: 'BTC', price: 100 }], null, T0, fetcher);
  assert.equal(r.action, 'HOLD');
});

test('IDLE + squeeze + цена пробила вверх → OPEN LONG', async () => {
  resetTrendFollowState();
  // 50 шумных + 25 ровных — squeeze. ATR(20) ≈ 1, range_high ≈ 100.5.
  // long trigger = 100.5 + 1 * 0.5 = 101. Передаём price=103.
  const wide   = noisyCandles(50, 100, 10);
  const narrow = flatCandles(25, 100, 1);
  const fetcher = makeFetcher({ BTC: [...wide, ...narrow] });
  const r = await analyzeTrendFollow([{ coin: 'BTC', price: 103 }], null, T0, fetcher);
  assert.equal(r.action, 'OPEN');
  assert.equal(r.strategy_id, 'trend_follow');
  assert.equal(r.direction, 'LONG');
  assert.equal(r.coin, 'BTC');
  assert.equal(r.price, 103);
  // SL ниже entry для long. TP выше. R:R = 2 (TP_MULT/SL_MULT = 3/1.5).
  assert.ok(r.sl < r.price);
  assert.ok(r.tp > r.price);
  assert.ok(r.atr > 0);
});

test('IDLE + squeeze + цена пробила вниз → OPEN SHORT', async () => {
  resetTrendFollowState();
  const wide   = noisyCandles(50, 100, 10);
  const narrow = flatCandles(25, 100, 1);
  const fetcher = makeFetcher({ BTC: [...wide, ...narrow] });
  // short trigger = 99.5 - 0.5 = 99. price=97.
  const r = await analyzeTrendFollow([{ coin: 'BTC', price: 97 }], null, T0, fetcher);
  assert.equal(r.action, 'OPEN');
  assert.equal(r.direction, 'SHORT');
  assert.ok(r.sl > r.price);
  assert.ok(r.tp < r.price);
});

test('IDLE + squeeze но цена внутри range → HOLD', async () => {
  resetTrendFollowState();
  const wide   = noisyCandles(50, 100, 10);
  const narrow = flatCandles(25, 100, 1);
  const fetcher = makeFetcher({ BTC: [...wide, ...narrow] });
  const r = await analyzeTrendFollow([{ coin: 'BTC', price: 100 }], null, T0, fetcher);
  assert.equal(r.action, 'HOLD');
});

test('IDLE + re-detect cooldown — повторный сигнал в той же монете подавляется 2мин', async () => {
  resetTrendFollowState();
  const wide   = noisyCandles(50, 100, 10);
  const narrow = flatCandles(25, 100, 1);
  const fetcher = makeFetcher({ BTC: [...wide, ...narrow] });
  const first = await analyzeTrendFollow([{ coin: 'BTC', price: 103 }], null, T0, fetcher);
  assert.equal(first.action, 'OPEN');
  // Сразу второй вызов — должен подавиться через cooldownMap
  const second = await analyzeTrendFollow([{ coin: 'BTC', price: 103 }], null, T0 + 30_000, fetcher);
  assert.equal(second.action, 'HOLD');
});

test('Slot занят чужой стратегией → HOLD, но скан идёт (радар расцеплен от слота)', async () => {
  resetTrendFollowState();
  let called = 0;
  const fetcher = async () => { called++; return null; };
  const otherPosition = { strategy_id: 'hunter', coin: 'BTC' };
  const r = await analyzeTrendFollow([{ coin: 'BTC', price: 100 }], otherPosition, T0, fetcher);
  assert.equal(r.action, 'HOLD');
  // Скан юниверса для радара/ленты идёт независимо от занятости слота.
  assert.equal(called, 1);
});

test('Чужой slot + squeeze+breakout → HOLD (не торгуем), но сигнал в ленте', async () => {
  resetTrendFollowState();
  const wide   = noisyCandles(50, 100, 10);
  const narrow = flatCandles(25, 100, 1);
  const fetcher = makeFetcher({ BTC: [...wide, ...narrow] });
  const otherPosition = { strategy_id: 'hunter', coin: 'ETH' };
  const r = await analyzeTrendFollow([{ coin: 'BTC', price: 103 }], otherPosition, T0, fetcher);
  // Слот занят чужой позой → бот не входит…
  assert.equal(r.action, 'HOLD');
  // …но пробой попал в ленту радара (traded=false).
  const signals = getChillBoySignals();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].coin, 'BTC');
  assert.equal(signals[0].traded, false);
});

// ═══════════════════════════════════════════════
//  Exit logic
// ═══════════════════════════════════════════════

test('exit LONG: цена ≤ SL → CLOSE trend_follow_sl', async () => {
  resetTrendFollowState();
  const position = {
    coin: 'BTC', strategy_id: 'trend_follow', side: 'long',
    entry_price: 100, sl_price: 98, tp_price: 106,
    entry_time: T0 - HOUR,
  };
  const r = await analyzeTrendFollow([{ coin: 'BTC', price: 97 }], position, T0, nullFetcher);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'trend_follow_sl');
  assert.equal(r.price, 98);
});

test('exit LONG: цена ≥ TP → CLOSE trend_follow_tp', async () => {
  resetTrendFollowState();
  const position = {
    coin: 'BTC', strategy_id: 'trend_follow', side: 'long',
    entry_price: 100, sl_price: 98, tp_price: 106,
    entry_time: T0 - HOUR,
  };
  const r = await analyzeTrendFollow([{ coin: 'BTC', price: 107 }], position, T0, nullFetcher);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'trend_follow_tp');
  assert.equal(r.price, 106);
});

test('exit SHORT: цена ≥ SL → CLOSE trend_follow_sl', async () => {
  resetTrendFollowState();
  const position = {
    coin: 'BTC', strategy_id: 'trend_follow', side: 'short',
    entry_price: 100, sl_price: 102, tp_price: 94,
    entry_time: T0 - HOUR,
  };
  const r = await analyzeTrendFollow([{ coin: 'BTC', price: 103 }], position, T0, nullFetcher);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'trend_follow_sl');
});

test('exit SHORT: цена ≤ TP → CLOSE trend_follow_tp', async () => {
  resetTrendFollowState();
  const position = {
    coin: 'BTC', strategy_id: 'trend_follow', side: 'short',
    entry_price: 100, sl_price: 102, tp_price: 94,
    entry_time: T0 - HOUR,
  };
  const r = await analyzeTrendFollow([{ coin: 'BTC', price: 93 }], position, T0, nullFetcher);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'trend_follow_tp');
});

test('exit: time-stop 6ч → CLOSE trend_follow_time_stop', async () => {
  resetTrendFollowState();
  const position = {
    coin: 'BTC', strategy_id: 'trend_follow', side: 'long',
    entry_price: 100, sl_price: 98, tp_price: 106,
    entry_time: T0 - 7 * HOUR,
  };
  const r = await analyzeTrendFollow([{ coin: 'BTC', price: 100 }], position, T0, nullFetcher);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'trend_follow_time_stop');
});

test('exit: монета пропала из scoutData → HOLD (ждём следующий tick)', async () => {
  resetTrendFollowState();
  const position = {
    coin: 'BTC', strategy_id: 'trend_follow', side: 'long',
    entry_price: 100, sl_price: 98, tp_price: 106,
    entry_time: T0 - HOUR,
  };
  const r = await analyzeTrendFollow([{ coin: 'ETH', price: 2000 }], position, T0, nullFetcher);
  assert.equal(r.action, 'HOLD');
});

// ═══════════════════════════════════════════════
//  Post-SL cooldown (cross-tick state)
// ═══════════════════════════════════════════════

test('post-SL cooldown: после SL та же монета не входит 2ч', async () => {
  resetTrendFollowState();
  // 1. Exit по SL
  const position = {
    coin: 'BTC', strategy_id: 'trend_follow', side: 'long',
    entry_price: 100, sl_price: 98, tp_price: 106,
    entry_time: T0 - HOUR,
  };
  const exitR = await analyzeTrendFollow([{ coin: 'BTC', price: 97 }], position, T0, nullFetcher);
  assert.equal(exitR.reason, 'trend_follow_sl');

  // 2. Через минуту — новый сигнал с пробоем. Должен подавиться post-SL cooldown.
  const wide   = noisyCandles(50, 100, 10);
  const narrow = flatCandles(25, 100, 1);
  const fetcher = makeFetcher({ BTC: [...wide, ...narrow] });
  const r = await analyzeTrendFollow([{ coin: 'BTC', price: 103 }], null, T0 + 60_000, fetcher);
  assert.equal(r.action, 'HOLD');

  // 3. Через 2.5ч cooldown снят — снова OPEN.
  const r2 = await analyzeTrendFollow(
    [{ coin: 'BTC', price: 103 }], null, T0 + 2.5 * HOUR, fetcher,
  );
  assert.equal(r2.action, 'OPEN');
});

// ═══════════════════════════════════════════════
//  Radar scan расцеплен от торгового слота
// ═══════════════════════════════════════════════

test('scanChillBoyRadar: пробой пишется в ленту, позиция не открывается', async () => {
  resetTrendFollowState();
  const wide   = noisyCandles(50, 100, 10);
  const narrow = flatCandles(25, 100, 1);
  const fetcher = makeFetcher({ BTC: [...wide, ...narrow] });
  // Возвращает undefined (не торговый сигнал) — это чистый скан.
  const out = await scanChillBoyRadar([{ coin: 'BTC', price: 103 }], T0, fetcher);
  assert.equal(out, undefined);
  const signals = getChillBoySignals();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].coin, 'BTC');
  assert.equal(signals[0].direction, 'LONG');
  assert.equal(signals[0].traded, false);   // радар никогда не «торгует»
});
