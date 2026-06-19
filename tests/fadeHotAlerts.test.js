import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.HL_PRIVATE_KEY        = '0x0000000000000000000000000000000000000000000000000000000000000001';
process.env.TELEGRAM_BOT_TOKEN    = '';

const { runOnce, clearFadeHotAlertState } = await import('../src/modules/fadeHotAlerts.js');
const { state } = await import('../src/app/state.js');
const { config } = await import('../src/core/config.js');
const { push, clearAll } = await import('../src/core/priceHistory.js');

const NOW = 1_700_000_000_000;

// Глушим сеть: пустой ntfy.url → fireNtfy резолвит false без HTTP.
config.ntfy.url = '';

function pumpCandles() {
  const out = [];
  for (let i = 0; i < 17; i++) out.push({ close: 100 * 1.02 ** i }); // монотонный памп → high ER
  return out;
}
function chopCandles() {
  const out = [];
  for (let i = 0; i < 17; i++) out.push({ close: i % 2 === 0 ? 100 : 101 }); // пила → ER≈0
  return out;
}
function seedPump(coin, priceNow) {
  push(coin, priceNow / 1.05, NOW - 30 * 60_000);
  push(coin, priceNow, NOW);
}

beforeEach(() => {
  clearFadeHotAlertState();
  clearAll();
  state.latestHunter = [];
});

test('runOnce: пустой снапшот → no-op без fetch', async () => {
  let fetched = 0;
  await runOnce(NOW, async () => { fetched++; return pumpCandles(); });
  assert.equal(fetched, 0);
});

test('runOnce: рынок ХОЛОДНЫЙ (BTC пилит) → сетап подтверждаем и шлём eyes-only (cold-топик)', async () => {
  state.latestHunter = [{ coin: 'TEST', price: 130 }];
  seedPump('TEST', 130);
  const calls = [];
  const fetchCandles = async (coin) => {
    calls.push(coin);
    return coin === 'BTC' ? chopCandles() : pumpCandles();
  };
  await runOnce(NOW, fetchCandles);
  assert.ok(calls.includes('BTC'), 'режим проверён по BTC');
  assert.ok(calls.includes('TEST'), 'в холодном рынке сетап всё равно подтверждаем для cold-ленты');
});

test('runOnce: ГОРЯЧИЙ рынок + fade-сетап → дёргаем свечи монеты (проход гейта)', async () => {
  state.latestHunter = [{ coin: 'TEST', price: 130 }];
  seedPump('TEST', 130);
  const calls = [];
  const fetchCandles = async (coin) => { calls.push(coin); return pumpCandles(); };
  await runOnce(NOW, fetchCandles);
  assert.ok(calls.includes('BTC'), 'режим проверён по BTC');
  assert.ok(calls.includes('TEST'), 'в горячем рынке монета-кандидат подтверждается');
});

test('runOnce: пре-гейт отсекает (нет хода 30м) → ни одного fetch', async () => {
  state.latestHunter = [{ coin: 'FLAT', price: 100 }];
  push('FLAT', 100, NOW - 30 * 60_000); // ход ≈ 0
  push('FLAT', 100, NOW);
  let fetched = 0;
  await runOnce(NOW, async () => { fetched++; return pumpCandles(); });
  assert.equal(fetched, 0, 'без хода 30м даже BTC-режим не запрашиваем');
});
