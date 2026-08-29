// Iter D3: breakeven храповик в checkHunterExit (pure).
// Как только peak ≥ BE_ARM_PCT, взводим; если unrealized% ≤ FLOOR — закрываем
// в безубыток ВМЕСТО полного SL. Кейс ZEC: peak +3% → развернулся → −2% SL.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS    = '0x0000000000000000000000000000000000000000';
// Изолируем храповик: trail выключен, чтобы его CLOSE не мешал ассертам.
process.env.HUNTER_TRAIL_ENABLED     = 'false';
process.env.HUNTER_TRAIL_SHADOW_LOG  = 'false';
process.env.HUNTER_BE_RATCHET_ENABLED = 'true';
process.env.HUNTER_BE_ARM_PCT        = '1';
process.env.HUNTER_BE_FLOOR_PCT      = '0';

const { clearAll } = await import('../src/core/priceHistory.js');
const {
  analyzeHunter, resetHunterCooldowns, clearHunterTrailState,
} = await import('../src/modules/strategistHunter.js');

function reset() {
  clearAll();
  resetHunterCooldowns();
}

function hunterPos(overrides = {}) {
  return {
    id:           7,
    coin:         'BTC',
    strategy_id:  'hunter',
    mode:         'PAPER',
    entry_price:  50000,
    sl_price:     50000 * 1.02,  // 51000
    tp_price:     50000 * 0.97,  // 48500
    entry_time:   Date.now(),
    size_usd:     50,
    ...overrides,
  };
}

test('be-ratchet: peak ≥ ARM, потом откат в безубыток → CLOSE breakeven', () => {
  reset();
  const pos = hunterPos();
  // Tick 1: +1.5% → arm (≥ 1%)
  analyzeHunter([{ coin: 'BTC', price: 50000 * (1 - 0.015) }], pos);
  // Tick 2: цена вернулась к entry → unrealized 0 ≤ floor 0 → CLOSE
  const r = analyzeHunter([{ coin: 'BTC', price: 50000 }], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_breakeven_ratchet');
  assert.ok(r.peakPct >= 1.4);
});

test('be-ratchet: храповик пробивается РАНЬШЕ SL (ловит подарок до полного минуса)', () => {
  reset();
  const pos = hunterPos();
  // Tick 1: +1.5% → arm
  analyzeHunter([{ coin: 'BTC', price: 50000 * (1 - 0.015) }], pos);
  // Tick 2: цена улетела вверх через SL — но храповик взведён и проверяется выше SL
  const r = analyzeHunter([{ coin: 'BTC', price: 51100 }], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_breakeven_ratchet');
});

test('be-ratchet: peak не достиг ARM → не взводится → обычный HOLD у безубытка', () => {
  reset();
  const pos = hunterPos();
  // Tick 1: только +0.5% (< ARM 1%) → НЕ armed
  analyzeHunter([{ coin: 'BTC', price: 50000 * (1 - 0.005) }], pos);
  // Tick 2: вернулась к entry → unrealized 0, но храповик не взведён → HOLD
  const r = analyzeHunter([{ coin: 'BTC', price: 50000 }], pos);
  assert.equal(r.action, 'HOLD');
});

test('be-ratchet: взведён, но всё ещё в плюсе выше floor → HOLD', () => {
  reset();
  const pos = hunterPos();
  // Tick 1: +1.5% → arm
  analyzeHunter([{ coin: 'BTC', price: 50000 * (1 - 0.015) }], pos);
  // Tick 2: ещё +0.8% — выше floor 0 → держим
  const r = analyzeHunter([{ coin: 'BTC', price: 50000 * (1 - 0.008) }], pos);
  assert.equal(r.action, 'HOLD');
});

test('be-ratchet: clearHunterTrailState сбрасывает armed (повторный вход не взведён)', () => {
  reset();
  const pos = hunterPos();
  analyzeHunter([{ coin: 'BTC', price: 50000 * (1 - 0.015) }], pos);
  clearHunterTrailState(7);
  // После сброса: цена 0 без нового arm → HOLD (а не breakeven CLOSE)
  const r = analyzeHunter([{ coin: 'BTC', price: 50000 }], pos);
  assert.equal(r.action, 'HOLD');
});
