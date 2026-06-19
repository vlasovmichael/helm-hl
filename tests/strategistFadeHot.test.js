import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFadeHot, resetFadeHotState } from '../src/modules/strategistFadeHot.js';
import { push, clearAll } from '../src/core/priceHistory.js';

const NOW = 1_700_000_000_000;

// 15m-свечи монотонного пампа +2%/бар → high ER + ход 30м ≈ +4% (как в fadeHotSignal.test).
function pumpCandles() {
  const out = [];
  for (let i = 0; i < 17; i++) out.push({ close: 100 * 1.02 ** i });
  return out;
}

// Наполняем priceHistory так, чтобы дешёвый пре-гейт (ход 30м) прошёл: цена 30м
// назад ниже текущей на >3%.
function seedPump(coin, priceNow) {
  push(coin, priceNow / 1.05, NOW - 30 * 60_000); // 30м назад на 5% ниже
  push(coin, priceNow, NOW);
}

beforeEach(() => {
  resetFadeHotState();
  clearAll();
});

test('analyzeFadeHot: high-ER памп → OPEN fade SHORT, только SL (tp=null)', async () => {
  const coin = 'TEST';
  const price = 130;
  seedPump(coin, price);
  const fetchCandles = async () => pumpCandles();

  const sig = await analyzeFadeHot(
    [{ coin, price, fundingRate: 0.0001, volume24hUsd: 1e7, oiUsd: 1e6 }],
    null,
    NOW,
    fetchCandles,
  );

  assert.equal(sig.action, 'OPEN');
  assert.equal(sig.strategy_id, 'fadehot');
  assert.equal(sig.direction, 'SHORT');
  assert.equal(sig.tp, null);
  assert.ok(sig.sl > price, 'SHORT SL выше цены');
  assert.ok(sig.move > 0);
  assert.ok(sig.er >= 0.47);
  assert.equal(sig.entryFeatures.entry_spike_pct, sig.move);
});

test('analyzeFadeHot: пре-гейт отсекает (нет хода 30м) → HOLD без fetch', async () => {
  const coin = 'FLAT';
  const price = 100;
  push(coin, 100, NOW - 30 * 60_000); // ровно — ход 30м ≈ 0
  push(coin, price, NOW);
  let fetched = false;
  const fetchCandles = async () => { fetched = true; return pumpCandles(); };

  const sig = await analyzeFadeHot([{ coin, price }], null, NOW, fetchCandles);
  assert.equal(sig.action, 'HOLD');
  assert.equal(fetched, false, 'тяжёлый fetch не должен вызываться при провале пре-гейта');
});

test('analyzeFadeHot: пре-гейт прошёл, но ER низкий → HOLD', async () => {
  const coin = 'CHOP';
  const price = 130;
  seedPump(coin, price);
  // пила (низкий ER) с резким финалом
  const chop = [];
  for (let i = 0; i < 15; i++) chop.push({ close: i % 2 === 0 ? 100 : 104 });
  chop.push({ close: 110 });
  chop.push({ close: 116 });
  const sig = await analyzeFadeHot([{ coin, price }], null, NOW, async () => chop);
  assert.equal(sig.action, 'HOLD');
});

test('analyzeFadeHot: сигнал есть, но рынок ХОЛОДНЫЙ (BTC пилит) → HOLD (гейт режима)', async () => {
  const coin = 'TEST';
  const price = 130;
  seedPump(coin, price);
  // монета трендит (fire fade), но BTC пилит → ER рынка низкий → гейт не пускает
  const chopBtc = [];
  for (let i = 0; i < 17; i++) chopBtc.push({ close: i % 2 === 0 ? 100 : 101 });
  const fetchCandles = async (c) => (c === 'BTC' ? chopBtc : pumpCandles());

  const sig = await analyzeFadeHot([{ coin, price }], null, NOW, fetchCandles);
  assert.equal(sig.action, 'HOLD', 'в холодном рынке fade не открывается');
});

test('analyzeFadeHot: горячий рынок → OPEN с фичами режима (btcER, breadth)', async () => {
  const coin = 'TEST';
  const price = 130;
  seedPump(coin, price);
  const fetchCandles = async () => pumpCandles(); // и монета, и BTC трендят → горячо
  const sig = await analyzeFadeHot([{ coin, price }], null, NOW, fetchCandles);

  assert.equal(sig.action, 'OPEN');
  assert.ok(sig.btcER >= 0.55, 'btcER прошёл гейт');
  assert.equal(sig.breadth, 1, 'одна монета в ходе → breadth=1');
  assert.equal(sig.entryFeatures.entry_oi_delta_2m, 1, 'breadth записан в фичу');
  assert.ok(sig.entryFeatures.entry_trend_1h_pct > 0, 'btcER записан в фичу режима');
});

test('analyzeFadeHot: своя SHORT-поза, цена ≥ SL → CLOSE fadehot_sl', async () => {
  const pos = { strategy_id: 'fadehot', coin: 'TEST', side: 'short', sl_price: 103, entry_time: NOW };
  const sig = await analyzeFadeHot([{ coin: 'TEST', price: 104 }], pos, NOW + 60_000);
  assert.equal(sig.action, 'CLOSE');
  assert.equal(sig.reason, 'fadehot_sl');
  assert.equal(sig.price, 103);
});

test('analyzeFadeHot: своя поза, time-stop истёк → CLOSE fadehot_time_stop', async () => {
  const entry = NOW;
  const pos = { strategy_id: 'fadehot', coin: 'TEST', side: 'short', sl_price: 999, entry_time: entry };
  const sig = await analyzeFadeHot(
    [{ coin: 'TEST', price: 100 }],
    pos,
    entry + 121 * 60_000, // > 120м time-stop
  );
  assert.equal(sig.action, 'CLOSE');
  assert.equal(sig.reason, 'fadehot_time_stop');
});

test('analyzeFadeHot: своя поза в плюсе, стоп не задет, время не вышло → HOLD', async () => {
  const pos = { strategy_id: 'fadehot', coin: 'TEST', side: 'short', sl_price: 110, entry_time: NOW };
  const sig = await analyzeFadeHot([{ coin: 'TEST', price: 100 }], pos, NOW + 60_000);
  assert.equal(sig.action, 'HOLD');
});
