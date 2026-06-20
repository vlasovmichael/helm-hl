// Тесты Hunter LONG trailing TP (Iter E.2). PAPER-only, зеркало hunterTrailing.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.TELEGRAM_BOT_TOKEN    = '';
process.env.HUNTER_LONG_TRAIL_ENABLED  = 'true';
process.env.HUNTER_LONG_TRAIL_ARM_PCT  = '2';
process.env.HUNTER_LONG_TRAIL_GIVE_BACK_PCT = '30';

const { clearAll } = await import('../src/core/priceHistory.js');
const {
  analyzeHunterLong, resetHunterLongCooldowns, getHunterLongPeakPct,
} = await import('../src/modules/strategistHunterLong.js');

const MIN = 60_000;

function reset() {
  clearAll();
  resetHunterLongCooldowns();
}

function makePos(id = 1) {
  return {
    id,
    coin: 'BTC',
    strategy_id: 'hunter_long',
    side: 'long',
    entry_price: 100,
    sl_price:    98,   // -2%
    tp_price:    103,  // +3%
    entry_time:  Date.now(),
    size_usd:    50,
  };
}

test('Цена ниже ARM_PCT → trail не активен, peak не достигает порога', () => {
  reset();
  const pos = makePos();
  // +1% — peak = 1, ниже ARM=2
  const r = analyzeHunterLong([{ coin: 'BTC', price: 101 }], pos);
  assert.equal(r.action, 'HOLD');
  assert.ok(getHunterLongPeakPct(pos.id) < 2);
});

test('Peak ≥ ARM_PCT, откат < giveback → HOLD', () => {
  reset();
  const pos = makePos();
  // Тик 1: цена 102.5 → peak=2.5%
  analyzeHunterLong([{ coin: 'BTC', price: 102.5 }], pos);
  assert.equal(getHunterLongPeakPct(pos.id).toFixed(2), '2.50');
  // Тик 2: цена 102.2 → giveback=0.3%, threshold=2.5*0.3=0.75% → HOLD
  const r = analyzeHunterLong([{ coin: 'BTC', price: 102.2 }], pos);
  assert.equal(r.action, 'HOLD');
});

test('Peak ≥ ARM_PCT, откат ≥ giveback → CLOSE hunter_long_trail_tp', () => {
  reset();
  const pos = makePos();
  // Peak 2.5% → giveback threshold = 0.75%
  analyzeHunterLong([{ coin: 'BTC', price: 102.5 }], pos);
  // Откат до 101.5 → unrealized=1.5%, giveback=1.0% ≥ 0.75 → CLOSE
  const r = analyzeHunterLong([{ coin: 'BTC', price: 101.5 }], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_long_trail_tp');
  assert.ok(r.peakPct >= 2);
  assert.ok(r.giveBackPct >= 30);
});

test('Trail срабатывает РАНЬШЕ fixed TP (suite сценарий: peak 2.9%, откат → trail)', () => {
  reset();
  const pos = makePos();
  // Подъём почти до TP (2.9%), но не пробил TP=3%
  analyzeHunterLong([{ coin: 'BTC', price: 102.9 }], pos);
  // Откат: 102.0 → unrealized=2.0%, giveback=0.9% ≥ 2.9*0.3=0.87 → CLOSE TRAIL
  const r = analyzeHunterLong([{ coin: 'BTC', price: 102.0 }], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_long_trail_tp');
});

test('Fixed TP пробит → возвращается hunter_long_tp, не trail', () => {
  reset();
  const pos = makePos();
  // Один тик сразу выше TP=103
  const r = analyzeHunterLong([{ coin: 'BTC', price: 103.5 }], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_long_tp');
});

test('Цена ушла ниже SL → SL имеет приоритет, не trail', () => {
  reset();
  const pos = makePos();
  // peak до 2.5%, затем глубокий откат ниже SL=98
  analyzeHunterLong([{ coin: 'BTC', price: 102.5 }], pos);
  const r = analyzeHunterLong([{ coin: 'BTC', price: 97 }], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_long_sl');
});
