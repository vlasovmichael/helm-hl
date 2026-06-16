// Тесты Hot Movers paper: analyzeHotMovers — торгует вердикт карточки 1:1.
// Берём только trend-сценарии (OI↑ → mode trend), чтобы не тянуть 1h-HTF
// (dashboard/routes/movers.js) — fade-муты покрыты в hotMoversSetup.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.TELEGRAM_BOT_TOKEN    = '';

const { push, clearAll } = await import('../src/core/priceHistory.js');
const { recordOiSnapshot, _resetOiHistory } = await import('../src/core/oiHistory.js');
const {
  analyzeHotMovers, resetHotMoversState,
  HM_SL_PCT, HM_TP_PCT,
} = await import('../src/modules/strategistHotMovers.js');

const MIN = 60_000;
const T0  = 1_700_000_000_000;

function reset() {
  clearAll();
  _resetOiHistory();
  resetHotMoversState();
}

// Сеем окна spikePct: past_n = price / (1 + s_n/100), тогда (price-past)/past = s_n%.
function seedWindows(coin, now, price, { s2, s5, s15, s60 }) {
  clearAll();
  push(coin, price / (1 + s60 / 100), now - 60 * MIN);
  push(coin, price / (1 + s15 / 100), now - 15 * MIN);
  push(coin, price / (1 + s5 / 100),  now - 5 * MIN);
  push(coin, price / (1 + s2 / 100),  now - 2 * MIN);
}

// OI: значение 15м назад и сейчас (через два снапшота).
function seedOi(coin, now, { ago15, recent }) {
  recordOiSnapshot([{ coin, oiUsd: ago15 }], now - 15 * MIN);
  recordOiSnapshot([{ coin, oiUsd: recent }], now - 1 * MIN);
}

function item(coin, price, oiUsd) {
  return { coin, price, oiUsd, fundingRate: 0.0001, volume24hUsd: 5e6 };
}

test('trend-LONG: extended → zone (откат к базе) + OI↑ → OPEN LONG', async () => {
  reset();
  const now = T0 + 120 * MIN;
  const price = 100;
  // OI растёт +10% → mode trend.
  seedOi('AAA', now, { ago15: 100_000_000, recent: 110_000_000 });

  // Call 1: цена улетела (15m +3% → extended), score высокий.
  seedWindows('AAA', now, price, { s2: 0.4, s5: 0.4, s15: 3, s60: 3 });
  seedOi('AAA', now, { ago15: 100_000_000, recent: 110_000_000 });
  let r = await analyzeHotMovers([item('AAA', price, 110_000_000)], null, now);
  assert.equal(r.action, 'HOLD'); // extended, не зона — ждём отката

  // Call 2: откатилась к базе (15m +0.4% → zone), та же сторона LONG → fire.
  seedWindows('AAA', now, price, { s2: 0.4, s5: 0.4, s15: 0.4, s60: 3 });
  seedOi('AAA', now, { ago15: 100_000_000, recent: 110_000_000 });
  r = await analyzeHotMovers([item('AAA', price, 110_000_000)], null, now);

  assert.equal(r.action, 'OPEN');
  assert.equal(r.strategy_id, 'hotmovers');
  assert.equal(r.coin, 'AAA');
  assert.equal(r.direction, 'LONG');
  assert.equal(r.mode, 'trend');
  assert.equal(r.sl.toFixed(4), (price * (1 - HM_SL_PCT / 100)).toFixed(4)); // SL ниже
  assert.equal(r.tp.toFixed(4), (price * (1 + HM_TP_PCT / 100)).toFixed(4)); // TP выше
  assert.ok(r.entryFeatures.entry_oi_delta_15m > 0);  // trend = OI↑
  assert.ok(r.entryFeatures.entry_spike_pct >= 3);    // score ≥ порога
});

test('trend-SHORT: цена↓ + OI↑ → OPEN SHORT, SL выше / TP ниже', async () => {
  reset();
  const now = T0 + 120 * MIN;
  const price = 100;

  // Call 1: цена ушла вниз (15m −3% → extended вниз).
  seedWindows('BBB', now, price, { s2: -0.4, s5: -0.4, s15: -3, s60: -3 });
  seedOi('BBB', now, { ago15: 100_000_000, recent: 110_000_000 });
  let r = await analyzeHotMovers([item('BBB', price, 110_000_000)], null, now);
  assert.equal(r.action, 'HOLD');

  // Call 2: откат к базе (15m −0.4% → zone), та же сторона SHORT → fire.
  seedWindows('BBB', now, price, { s2: -0.4, s5: -0.4, s15: -0.4, s60: -3 });
  seedOi('BBB', now, { ago15: 100_000_000, recent: 110_000_000 });
  r = await analyzeHotMovers([item('BBB', price, 110_000_000)], null, now);

  assert.equal(r.action, 'OPEN');
  assert.equal(r.direction, 'SHORT');
  assert.equal(r.sl.toFixed(4), (price * (1 + HM_SL_PCT / 100)).toFixed(4)); // SL выше
  assert.equal(r.tp.toFixed(4), (price * (1 - HM_TP_PCT / 100)).toFixed(4)); // TP ниже
});

test('OI флэт → режим не подтверждён → HOLD даже в зоне', async () => {
  reset();
  const now = T0 + 120 * MIN;
  const price = 100;
  // Дважды зовём в зоне, но OI flat (mode null) — никогда не actionable.
  for (let i = 0; i < 2; i++) {
    seedWindows('CCC', now, price, { s2: 0.4, s5: 0.4, s15: 0.4, s60: 3 });
    seedOi('CCC', now, { ago15: 100_000_000, recent: 100_000_000 }); // ΔOI 0% → flat
    const r = await analyzeHotMovers([item('CCC', price, 100_000_000)], null, now);
    assert.equal(r.action, 'HOLD');
  }
});

test('первое наблюдение сразу в зоне (нет prev) → HOLD (анти-спам)', async () => {
  reset();
  const now = T0 + 120 * MIN;
  const price = 100;
  seedWindows('DDD', now, price, { s2: 0.4, s5: 0.4, s15: 0.4, s60: 3 });
  seedOi('DDD', now, { ago15: 100_000_000, recent: 110_000_000 });
  const r = await analyzeHotMovers([item('DDD', price, 110_000_000)], null, now);
  assert.equal(r.action, 'HOLD'); // нет перехода из не-зоны → не fire
});

test('exit LONG: цена ≤ SL → CLOSE hotmovers_sl', async () => {
  reset();
  const now = T0 + 30 * MIN;
  const pos = {
    strategy_id: 'hotmovers', coin: 'AAA', side: 'long', entry_price: 100,
    sl_price: 98, tp_price: 103, entry_time: now - 5 * MIN,
  };
  const r = await analyzeHotMovers([item('AAA', 97.5, 1e8)], pos, now);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hotmovers_sl');
  assert.equal(r.price, 98);
});

test('exit LONG: цена ≥ TP → CLOSE hotmovers_tp', async () => {
  reset();
  const now = T0 + 30 * MIN;
  const pos = {
    strategy_id: 'hotmovers', coin: 'AAA', side: 'long', entry_price: 100,
    sl_price: 98, tp_price: 103, entry_time: now - 5 * MIN,
  };
  const r = await analyzeHotMovers([item('AAA', 103.5, 1e8)], pos, now);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hotmovers_tp');
  assert.equal(r.price, 103);
});

test('exit SHORT: цена ≥ SL → CLOSE hotmovers_sl', async () => {
  reset();
  const now = T0 + 30 * MIN;
  const pos = {
    strategy_id: 'hotmovers', coin: 'BBB', side: 'short', entry_price: 100,
    sl_price: 102, tp_price: 97, entry_time: now - 5 * MIN,
  };
  const r = await analyzeHotMovers([item('BBB', 102.5, 1e8)], pos, now);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hotmovers_sl');
  assert.equal(r.price, 102);
});

test('exit: time-stop → CLOSE hotmovers_time_stop', async () => {
  reset();
  const now = T0 + 300 * MIN;
  const pos = {
    strategy_id: 'hotmovers', coin: 'AAA', side: 'long', entry_price: 100,
    sl_price: 98, tp_price: 103, entry_time: now - 150 * MIN, // > 120 мин
  };
  const r = await analyzeHotMovers([item('AAA', 100.5, 1e8)], pos, now);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hotmovers_time_stop');
});
