// decideAdoptByAge + updateFirstSeen: фикс рекуррентного глюка adopt-няньки
// «без стопа: возраст входа неизвестен».
//
// Корень: возраст входа берётся ТОЛЬКО из HL-fills, а userFillsByTime лагает ~30с
// после ручного входа → openTime=null → нянька консервативно НЕ усыновляла → ~30с
// поза без стопа, потом fill долетал → ADOPTED. null сваливал в кучу «свежак, fill
// не проиндексирован» и «старый orphan». Различаем по тому, видел ли бот рождение
// позы (first-seen: appeared-while-running vs present-at-startup).
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { decideAdoptByAge, updateFirstSeen } = await import('../src/app/adoptReconcile.js');

const MIN = 60_000;
const NOW = 10 * 24 * 60 * MIN; // произвольный «сейчас»
const MAX_AGE_MS = 10 * MIN;    // ADOPT_MAX_AGE_MIN=10м

// ── decideAdoptByAge ──────────────────────────────────────────────────────

test('fills знают время входа, свежее → adopt по реальному времени (не provisional)', () => {
  const openTime = NOW - 2 * MIN;
  const r = decideAdoptByAge({ openTime, firstSeen: null, now: NOW, maxAgeMs: MAX_AGE_MS });
  assert.equal(r.decision, 'adopt');
  assert.equal(r.entryTime, openTime);
  assert.equal(r.provisional, false);
  assert.ok(Math.abs(r.ageMin - 2) < 1e-9);
});

test('fills знают время входа, старше max-age → too-old', () => {
  const openTime = NOW - 30 * MIN;
  const r = decideAdoptByAge({ openTime, firstSeen: null, now: NOW, maxAgeMs: MAX_AGE_MS });
  assert.equal(r.decision, 'too-old');
});

test('fill не проиндексирован + поза появилась при живом боте → adopt provisional по first-seen', () => {
  const firstSeen = { ts: NOW - 20_000, atStartup: false }; // увидели 20с назад
  const r = decideAdoptByAge({ openTime: null, firstSeen, now: NOW, maxAgeMs: MAX_AGE_MS });
  assert.equal(r.decision, 'adopt');
  assert.equal(r.entryTime, firstSeen.ts, 'entry≈first-seen пока fill не долетел');
  assert.equal(r.provisional, true, 'помечена на бэкфилл реального времени');
});

test('fill не проиндексирован + поза висела уже на старте → unknown-age (не трогаем, защита XPL)', () => {
  const firstSeen = { ts: NOW - 5 * MIN, atStartup: true };
  const r = decideAdoptByAge({ openTime: null, firstSeen, now: NOW, maxAgeMs: MAX_AGE_MS });
  assert.equal(r.decision, 'unknown-age');
  assert.equal(r.provisional, false);
});

test('fill не проиндексирован + first-seen неизвестен → unknown-age', () => {
  const r = decideAdoptByAge({ openTime: null, firstSeen: null, now: NOW, maxAgeMs: MAX_AGE_MS });
  assert.equal(r.decision, 'unknown-age');
});

test('appeared-while-running, но first-seen давно и fill так и не пришёл → too-old', () => {
  const firstSeen = { ts: NOW - 30 * MIN, atStartup: false };
  const r = decideAdoptByAge({ openTime: null, firstSeen, now: NOW, maxAgeMs: MAX_AGE_MS });
  assert.equal(r.decision, 'too-old');
});

// ── updateFirstSeen ───────────────────────────────────────────────────────

test('первый цикл метит все наличные позы atStartup=true и наблюдает boot', () => {
  const map = new Map();
  const boot = updateFirstSeen(map, ['SPX', 'eth'], NOW, false);
  assert.equal(boot, true);
  assert.equal(map.get('SPX').atStartup, true);
  assert.equal(map.get('ETH').atStartup, true, 'ключи в верхнем регистре');
});

test('новая монета во втором цикле → atStartup=false (видели рождение)', () => {
  const map = new Map();
  let boot = updateFirstSeen(map, ['SPX'], NOW, false);
  boot = updateFirstSeen(map, ['SPX', 'WLD'], NOW + MIN, boot);
  assert.equal(map.get('SPX').atStartup, true, 'старая со старта');
  assert.equal(map.get('WLD').atStartup, false, 'появилась при живом боте → свежая');
});

test('existing монета не перезаписывается, ушедшая — удаляется', () => {
  const map = new Map();
  let boot = updateFirstSeen(map, ['SPX'], NOW, false);
  const spxTs = map.get('SPX').ts;
  boot = updateFirstSeen(map, ['WLD'], NOW + 5 * MIN, boot); // SPX ушла
  assert.equal(map.has('SPX'), false, 'ушедшая монета удалена из карты');
  assert.equal(map.get('WLD').atStartup, false);
  // SPX вернулась — это уже НОВОЕ появление при живом боте.
  boot = updateFirstSeen(map, ['WLD', 'SPX'], NOW + 6 * MIN, boot);
  assert.equal(map.get('SPX').atStartup, false);
  assert.notEqual(map.get('SPX').ts, spxTs, 'ts свежий, не старый');
});
