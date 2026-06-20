// Тесты Vapor (Exhaustion Short, Трек A): analyzeVapor pure logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.TELEGRAM_BOT_TOKEN    = '';

const { push, clearAll } = await import('../src/core/priceHistory.js');
const { recordOiSnapshot, _resetOiHistory } = await import('../src/core/oiHistory.js');
const {
  analyzeVapor, resetVaporState,
  VAPOR_SL_PCT, VAPOR_TP_PCT,
} = await import('../src/modules/strategistVapor.js');

const MIN = 60_000;
const T0  = 1_700_000_000_000;

function reset() {
  clearAll();
  _resetOiHistory();
  resetVaporState();
}

// Гринд вверх за 15 мин до хая, затем небольшой откат к `now`.
// peak в момент now-1мин, текущая цена чуть ниже (rollover).
function seedGrind(coin, base, now, { peak, last }) {
  push(coin, base, now - 16 * MIN);
  push(coin, base * 1.005, now - 12 * MIN);
  push(coin, base * 1.01, now - 8 * MIN);
  push(coin, peak, now - 2 * MIN);    // хай окна
  push(coin, peak, now - 1.5 * MIN);  // 2мин-назад ≈ peak (слабое 2м-движение)
  push(coin, last, now - 0.2 * MIN);  // откат
}

// OI: задаём значение 15 мин назад и сейчас через два снапшота.
function seedOi(coin, now, { ago15, recent }) {
  recordOiSnapshot([{ coin, oiUsd: ago15 }], now - 15 * MIN);
  recordOiSnapshot([{ coin, oiUsd: recent }], now - 1 * MIN);
}

test('гринд + OI-дивергенция + rollover → OPEN SHORT', () => {
  reset();
  const now = T0 + 20 * MIN;
  // base 100 → peak 102 (+2% гринд), откат до 101.7 (drawFromHigh ≈ 0.29% ∈ [0.2,1.5]).
  seedGrind('AAA', 100, now, { peak: 102, last: 101.7 });
  // OI flat (дивергенция): 15м назад 100M, сейчас 100M → ΔOI 0% ≤ 0.
  seedOi('AAA', now, { ago15: 100_000_000, recent: 100_000_000 });

  const r = analyzeVapor([{ coin: 'AAA', price: 101.7, oiUsd: 100_000_000, fundingRate: 0.0001, volume24hUsd: 5e6 }], null, now);

  assert.equal(r.action, 'OPEN');
  assert.equal(r.strategy_id, 'vapor');
  assert.equal(r.coin, 'AAA');
  assert.equal(r.direction, 'SHORT');
  assert.equal(r.sl.toFixed(4), (101.7 * (1 + VAPOR_SL_PCT / 100)).toFixed(4));
  assert.equal(r.tp.toFixed(4), (101.7 * (1 - VAPOR_TP_PCT / 100)).toFixed(4));
  assert.ok(r.entryFeatures.entry_trend_15m_pct > 1.5);   // гринд
  assert.ok(r.entryFeatures.entry_oi_delta_15m <= 0);     // выдох
});

test('OI ПОДТВЕРЖДАЕТ (растёт) → HOLD (это брейкаут, не выдох)', () => {
  reset();
  const now = T0 + 20 * MIN;
  seedGrind('AAA', 100, now, { peak: 102, last: 101.7 });
  // OI вырос +20% — свежие лонги, реальный брейкаут.
  seedOi('AAA', now, { ago15: 100_000_000, recent: 120_000_000 });

  const r = analyzeVapor([{ coin: 'AAA', price: 101.7, oiUsd: 120_000_000 }], null, now);
  assert.equal(r.action, 'HOLD');
});

test('нет rollover (цена всё ещё на хае) → HOLD', () => {
  reset();
  const now = T0 + 20 * MIN;
  // last == peak → drawFromHigh = 0 < ROLLOVER_MIN.
  seedGrind('AAA', 100, now, { peak: 102, last: 102 });
  seedOi('AAA', now, { ago15: 100_000_000, recent: 100_000_000 });

  const r = analyzeVapor([{ coin: 'AAA', price: 102, oiUsd: 100_000_000 }], null, now);
  assert.equal(r.action, 'HOLD');
});

test('нет OI-истории → HOLD (нечем подтвердить ядро)', () => {
  reset();
  const now = T0 + 20 * MIN;
  seedGrind('AAA', 100, now, { peak: 102, last: 101.7 });
  // OI не сидим.
  const r = analyzeVapor([{ coin: 'AAA', price: 101.7, oiUsd: 100_000_000 }], null, now);
  assert.equal(r.action, 'HOLD');
});

test('exit: цена ≥ SL → CLOSE vapor_sl', () => {
  reset();
  const now = T0 + 30 * MIN;
  const pos = {
    strategy_id: 'vapor', coin: 'AAA', entry_price: 100,
    sl_price: 102, tp_price: 98, entry_time: now - 5 * MIN,
  };
  const r = analyzeVapor([{ coin: 'AAA', price: 102.5 }], pos, now);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'vapor_sl');
  assert.equal(r.price, 102);
});

test('exit: цена ≤ TP → CLOSE vapor_tp', () => {
  reset();
  const now = T0 + 30 * MIN;
  const pos = {
    strategy_id: 'vapor', coin: 'AAA', entry_price: 100,
    sl_price: 102, tp_price: 98, entry_time: now - 5 * MIN,
  };
  const r = analyzeVapor([{ coin: 'AAA', price: 97.5 }], pos, now);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'vapor_tp');
  assert.equal(r.price, 98);
});

test('exit: time-stop → CLOSE vapor_time_stop', () => {
  reset();
  const now = T0 + 200 * MIN;
  const pos = {
    strategy_id: 'vapor', coin: 'AAA', entry_price: 100,
    sl_price: 102, tp_price: 98, entry_time: now - 90 * MIN,  // > 60 мин
  };
  const r = analyzeVapor([{ coin: 'AAA', price: 100.5 }], pos, now);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'vapor_time_stop');
});

test('post-exit cooldown: не входим в монету сразу после SL', () => {
  reset();
  const now = T0 + 30 * MIN;
  // Сначала выходим по SL → ставится cooldown.
  const pos = {
    strategy_id: 'vapor', coin: 'AAA', entry_price: 100,
    sl_price: 102, tp_price: 98, entry_time: now - 5 * MIN,
  };
  const closed = analyzeVapor([{ coin: 'AAA', price: 102.5 }], pos, now);
  assert.equal(closed.action, 'CLOSE');

  // Сразу же валидный сетап в той же монете — должен быть подавлен cooldown'ом.
  const t2 = now + 2 * MIN;
  seedGrind('AAA', 100, t2, { peak: 102, last: 101.7 });
  seedOi('AAA', t2, { ago15: 100_000_000, recent: 100_000_000 });
  const r = analyzeVapor([{ coin: 'AAA', price: 101.7, oiUsd: 100_000_000 }], null, t2);
  assert.equal(r.action, 'HOLD');
});
