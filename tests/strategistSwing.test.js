// Тесты Setup Swing paper: selectSwingCandidate (чистый выбор входа) + exit.
// Entry-путь analyzeSwing тянет getSetupScannerRows (DB) + enrichSwingSignals
// (сеть) — здесь не покрываем, тестируем чистую логику отбора и выход.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.TELEGRAM_BOT_TOKEN    = '';

const {
  analyzeSwing, selectSwingCandidate, resetSwingState,
} = await import('../src/modules/strategistSwing.js');

const MIN = 60_000;
const HOUR = 3_600_000;
const T0  = 1_700_000_000_000;

// Синтетическая обогащённая строка (как из enrichSwingSignals).
function row(coin, signal, { entryZone = 'zone', strength = 5, sl = 98, tp = 104, mark = 100, rr = 2 } = {}) {
  const plan = (signal === 'LONG' || signal === 'SHORT') ? { sl, tp, slPct: 2, tpPct: 4, rr } : null;
  return {
    coin, mark, fundingRate: 0.0001, vol24hUsd: 5e6, oiUsd: 1e8,
    oi7d: { deltaOi: 0.1, deltaPx: 0.05 },
    swing: { signal, strength, entryZone, ext1h: 0.3, trend4h: 'up', trend1h: 'up', plan },
  };
}

test('LONG + zone + plan → кандидат с планом карточки', () => {
  resetSwingState();
  const now = T0;
  const best = selectSwingCandidate([row('AAA', 'LONG')], new Map([['AAA', 100.2]]), now);
  assert.ok(best);
  assert.equal(best.coin, 'AAA');
  assert.equal(best.direction, 'LONG');
  assert.equal(best.price, 100.2);     // живая цена, не mark
  assert.equal(best.swing.plan.sl, 98);
  assert.equal(best.swing.plan.tp, 104);
});

test('WAIT и extended (не зона) → нет кандидата', () => {
  resetSwingState();
  const now = T0;
  assert.equal(selectSwingCandidate([row('AAA', 'WAIT')], new Map([['AAA', 100]]), now), null);
  assert.equal(selectSwingCandidate([row('BBB', 'LONG', { entryZone: 'extended' })], new Map([['BBB', 100]]), now), null);
});

test('edge-trigger: повтор того же состояния не открывает второй раз', () => {
  resetSwingState();
  const now = T0;
  const pm = new Map([['AAA', 100]]);
  const first = selectSwingCandidate([row('AAA', 'LONG')], pm, now);
  assert.ok(first); // первый вход
  const second = selectSwingCandidate([row('AAA', 'LONG')], pm, now + MIN);
  assert.equal(second, null); // держится в зоне — не повторяем
});

test('лучший по strength среди нескольких directional', () => {
  resetSwingState();
  const now = T0;
  const best = selectSwingCandidate(
    [row('AAA', 'LONG', { strength: 3 }), row('BBB', 'SHORT', { strength: 9, sl: 102, tp: 96 })],
    new Map([['AAA', 100], ['BBB', 100]]),
    now,
  );
  assert.equal(best.coin, 'BBB');
  assert.equal(best.direction, 'SHORT');
});

test('цена fallback на mark, если нет в живом снапшоте', () => {
  resetSwingState();
  const now = T0;
  const best = selectSwingCandidate([row('AAA', 'LONG', { mark: 101 })], new Map(), now);
  assert.equal(best.price, 101);
});

test('exit LONG: цена ≤ SL → CLOSE swing_sl', () => {
  resetSwingState();
  const now = T0 + 5 * HOUR;
  const pos = {
    strategy_id: 'swing', coin: 'AAA', side: 'long', entry_price: 100,
    sl_price: 98, tp_price: 104, entry_time: now - 2 * HOUR,
  };
  const r = analyzeSwing([{ coin: 'AAA', price: 97.5 }], pos, now);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'swing_sl');
  assert.equal(r.price, 98);
});

test('exit SHORT: цена ≤ TP → CLOSE swing_tp', () => {
  resetSwingState();
  const now = T0 + 5 * HOUR;
  const pos = {
    strategy_id: 'swing', coin: 'BBB', side: 'short', entry_price: 100,
    sl_price: 102, tp_price: 96, entry_time: now - 2 * HOUR,
  };
  const r = analyzeSwing([{ coin: 'BBB', price: 95.5 }], pos, now);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'swing_tp');
  assert.equal(r.price, 96);
});

test('exit: time-stop по часам → CLOSE swing_time_stop', () => {
  resetSwingState();
  const now = T0 + 100 * HOUR;
  const pos = {
    strategy_id: 'swing', coin: 'AAA', side: 'long', entry_price: 100,
    sl_price: 98, tp_price: 104, entry_time: now - 80 * HOUR, // > 72ч
  };
  const r = analyzeSwing([{ coin: 'AAA', price: 100.5 }], pos, now);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'swing_time_stop');
});

test('post-exit cooldown: не входим в монету сразу после SL', () => {
  resetSwingState();
  const now = T0 + 5 * HOUR;
  // Выходим по SL → ставится cooldown на AAA.
  const pos = {
    strategy_id: 'swing', coin: 'AAA', side: 'long', entry_price: 100,
    sl_price: 98, tp_price: 104, entry_time: now - 2 * HOUR,
  };
  const closed = analyzeSwing([{ coin: 'AAA', price: 97.5 }], pos, now);
  assert.equal(closed.action, 'CLOSE');
  // Сразу же валидный сетап в AAA — подавлен cooldown'ом.
  const cand = selectSwingCandidate([row('AAA', 'LONG')], new Map([['AAA', 100]]), now + MIN);
  assert.equal(cand, null);
});
