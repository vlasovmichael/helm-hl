// Тесты Hunter SHORT +OI (A/B paper-двойник): OI-divergence ворота на входе +
// ИЗОЛЯЦИЯ cooldown-состояния (бумажный стоп двойника НЕ должен блокировать
// реальные входы боевого Hunter — иначе бумага влияет на живые деньги).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { push, clearAll } = await import('../src/core/priceHistory.js');
const { analyzeHunter, resetHunterCooldowns } = await import('../src/modules/strategistHunter.js');
const { resetHunterCrossCooldowns } = await import('../src/modules/hunterCrossCooldown.js');
const { recordOiSnapshot, _resetOiHistory } = await import('../src/core/oiHistory.js');

const MIN = 60_000;
const T0  = 1_700_000_000_000;

function reset() {
  clearAll();
  resetHunterCooldowns();
  resetHunterCrossCooldowns();
  _resetOiHistory();
}

function seedHistory(coin, basePrice, now) {
  push(coin, basePrice, now - 3 * MIN);
  push(coin, basePrice, now - 2 * MIN);
  push(coin, basePrice, now - 1 * MIN);
}

// Свежие изолированные мапы двойника на каждый вызов (как в hunterOiPaperTick).
function twinOpts(overrides = {}) {
  return {
    strategyId:     'hunter_oi',
    oiDivMaxPct:    3,
    cooldownMap:    new Map(),
    postSlMap:      new Map(),
    persistPostSl:  false,
    crossCooldown:  false,
    updateSnapshot: false,
    ...overrides,
  };
}

// ── OI-divergence ворота ─────────────────────────

test('OI-ворота: ΔOI15м > порога (+10% > 3%) → HOLD (свежие лонги = пробой)', () => {
  reset();
  const now = T0 + 16 * MIN;
  seedHistory('BTC', 50000, now);
  // OI 15мин назад = 100M, сейчас 110M → ΔOI15м = +10% > 3% → ворота режут.
  // (getOiNMinAgo требует ≥2 снапшота в буфере; второй — недавний, для 15м-lookup не берётся.)
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 100_000_000 }], now - 15 * MIN);
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 108_000_000 }], now - 2 * MIN);
  const r = analyzeHunter([{ coin: 'BTC', price: 53000, oiUsd: 110_000_000 }], null, now, twinOpts());
  assert.equal(r.action, 'HOLD');
});

test('OI-ворота: ΔOI15м ≤ порога (+2% ≤ 3%) → OPEN с strategy_id=hunter_oi', () => {
  reset();
  const now = T0 + 16 * MIN;
  seedHistory('BTC', 50000, now);
  // OI 15мин назад = 100M, сейчас 102M → ΔOI15м = +2% ≤ 3% → пропускаем.
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 100_000_000 }], now - 15 * MIN);
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 101_000_000 }], now - 2 * MIN);
  const r = analyzeHunter([{ coin: 'BTC', price: 53000, oiUsd: 102_000_000 }], null, now, twinOpts());
  assert.equal(r.action, 'OPEN');
  assert.equal(r.strategy_id, 'hunter_oi');
  assert.equal(r.direction, 'SHORT');
});

test('OI-ворота: нет OI-истории за 15м → пропускаем фильтр (как anti-trend) → OPEN', () => {
  reset();
  const now = T0 + 16 * MIN;
  seedHistory('BTC', 50000, now);
  // OI-снапшота 15мин назад нет → getOiNMinAgo=null → фильтр не блокирует.
  const r = analyzeHunter([{ coin: 'BTC', price: 53000, oiUsd: 110_000_000 }], null, now, twinOpts());
  assert.equal(r.action, 'OPEN');
  assert.equal(r.strategy_id, 'hunter_oi');
});

test('боевой Hunter (дефолт opts) ворота НЕ ставит: тот же +10% ΔOI → OPEN', () => {
  reset();
  const now = T0 + 16 * MIN;
  seedHistory('BTC', 50000, now);
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 100_000_000 }], now - 15 * MIN);
  // Без opts (oiDivMaxPct=Infinity) — боевой Hunter не фильтрует по OI.
  const r = analyzeHunter([{ coin: 'BTC', price: 53000, oiUsd: 110_000_000 }], null, now);
  assert.equal(r.action, 'OPEN');
  assert.equal(r.strategy_id, 'hunter');
});

// ── ИЗОЛЯЦИЯ cooldown (главная гарантия безопасности) ──

test('изоляция: SL двойника НЕ блокирует реальный вход боевого Hunter на той же монете', () => {
  reset();
  const opts = twinOpts();

  // 1) Двойник получает SL по BTC (пишет в СВОЙ postSlMap + НЕ бьёт cross-cooldown).
  const slPrice = 50000 * 1.02;
  const twinPos = { id: 1, coin: 'BTC', strategy_id: 'hunter_oi', sl_price: slPrice, tp_price: 50000 * 0.97 };
  const slRes = analyzeHunter([{ coin: 'BTC', price: slPrice + 1 }], twinPos, Date.now(), opts);
  assert.equal(slRes.action, 'CLOSE');
  assert.equal(slRes.reason, 'hunter_sl');

  // 2) Боевой Hunter (дефолт opts, общие мапы) ловит памп по BTC → должен ВОЙТИ.
  //    Если бы двойник писал в общий postSl/cross-cooldown — было бы HOLD.
  const now = Date.now();
  push('BTC', 50000, now - 3 * MIN);
  push('BTC', 50000, now - 2 * MIN);
  const live = analyzeHunter([{ coin: 'BTC', price: 53000 }], null, now);
  assert.equal(live.action, 'OPEN', 'бумажный стоп двойника не должен блокировать живой вход');
  assert.equal(live.strategy_id, 'hunter');
});

test('изоляция: SL двойника пишет в СВОЙ postSlMap (двойник сам себя не ре-шортит)', () => {
  reset();
  const opts = twinOpts();
  const slPrice = 50000 * 1.02;
  const twinPos = { id: 2, coin: 'BTC', strategy_id: 'hunter_oi', sl_price: slPrice, tp_price: 50000 * 0.97 };
  analyzeHunter([{ coin: 'BTC', price: slPrice + 1 }], twinPos, Date.now(), opts);

  assert.ok(opts.postSlMap.has('BTC'), 'двойник должен записать post-SL в свой map');

  // Двойник сразу пробует войти по BTC — свой post-SL cooldown держит HOLD.
  const now = Date.now();
  push('BTC', 50000, now - 3 * MIN);
  push('BTC', 50000, now - 2 * MIN);
  const entry = analyzeHunter([{ coin: 'BTC', price: 53000, oiUsd: 100 }], null, now, opts);
  assert.equal(entry.action, 'HOLD', 'свой post-SL cooldown должен блокировать ре-шорт двойника');
});
