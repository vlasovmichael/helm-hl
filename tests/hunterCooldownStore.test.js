// Tests for hunterCooldownStore — bug-fix 2026-05-22 (post-SL cooldowns теряются при рестарте).

import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  loadHunterCooldowns,
  setShortPostSl,
  setLongPostSl,
  setLongSlStreak,
  clearLongSlStreak,
  setHunterTrail,
  getHunterTrailAll,
  clearHunterTrail,
  _resetForTest,
  _setFileForTest,
} from '../src/modules/hunterCooldownStore.js';

const TEST_FILE = join(tmpdir(), `hunter_cooldowns_test_${process.pid}.json`);

function freshState() {
  if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
  _resetForTest();
  _setFileForTest(TEST_FILE);
}

test('store: пустая загрузка не падает (файл отсутствует)', () => {
  freshState();
  const snap = loadHunterCooldowns();
  assert.deepStrictEqual(snap.short.postSlCooldown, {});
  assert.deepStrictEqual(snap.long.postSlCooldown, {});
  assert.deepStrictEqual(snap.long.slStreak, {});
});

test('store: setLongPostSl + setLongSlStreak персистятся на диск', () => {
  freshState();
  const future = Date.now() + 24 * 3600_000;
  const now = Date.now();
  setLongPostSl('PURR', future);
  setLongSlStreak('PURR', { count: 2, lastSlAt: now });

  assert.ok(existsSync(TEST_FILE), 'файл должен быть создан');
  const raw = JSON.parse(readFileSync(TEST_FILE, 'utf-8'));
  assert.strictEqual(raw.long.postSlCooldown.PURR, future);
  assert.strictEqual(raw.long.slStreak.PURR.count, 2);
  assert.strictEqual(raw.long.slStreak.PURR.lastSlAt, now);
});

test('store: после "рестарта" LONG postSlCooldown восстанавливается', () => {
  freshState();
  const future = Date.now() + 24 * 3600_000;
  const now = Date.now();
  setLongPostSl('PURR', future);
  setLongSlStreak('PURR', { count: 2, lastSlAt: now });

  // Симулируем рестарт: сбрасываем in-memory, заново указываем тот же файл, читаем.
  _resetForTest();
  _setFileForTest(TEST_FILE);

  const snap = loadHunterCooldowns();
  assert.strictEqual(snap.long.postSlCooldown.PURR, future, 'PURR ban должен пережить рестарт');
  assert.strictEqual(snap.long.slStreak.PURR.count, 2, 'streak должен пережить рестарт');
});

test('store: просроченные LONG cooldowns фильтруются при загрузке', () => {
  freshState();
  const past = Date.now() - 1000;
  const future = Date.now() + 24 * 3600_000;
  writeFileSync(TEST_FILE, JSON.stringify({
    version: 1,
    short: { postSlCooldown: {} },
    long: { postSlCooldown: { OLD: past, FRESH: future }, slStreak: {} },
  }));

  const snap = loadHunterCooldowns();
  assert.strictEqual(snap.long.postSlCooldown.OLD, undefined, 'просроченный отбрасывается');
  assert.strictEqual(snap.long.postSlCooldown.FRESH, future);
});

test('store: SHORT cooldown старше 24ч отбрасывается на load', () => {
  freshState();
  const ancient = Date.now() - 25 * 3600_000;
  const recent  = Date.now() - 60_000;
  writeFileSync(TEST_FILE, JSON.stringify({
    version: 1,
    short: { postSlCooldown: { OLD: ancient, FRESH: recent } },
    long: { postSlCooldown: {}, slStreak: {} },
  }));

  const snap = loadHunterCooldowns();
  assert.strictEqual(snap.short.postSlCooldown.OLD, undefined);
  assert.strictEqual(snap.short.postSlCooldown.FRESH, recent);
});

test('store: clearLongSlStreak удаляет запись', () => {
  freshState();
  setLongSlStreak('PURR', { count: 2, lastSlAt: Date.now() });
  clearLongSlStreak('PURR');
  const raw = JSON.parse(readFileSync(TEST_FILE, 'utf-8'));
  assert.strictEqual(raw.long.slStreak.PURR, undefined);
});

test('store: setShortPostSl персистится', () => {
  freshState();
  const now = Date.now();
  setShortPostSl('LIT', now);
  const raw = JSON.parse(readFileSync(TEST_FILE, 'utf-8'));
  assert.strictEqual(raw.short.postSlCooldown.LIT, now);
});

test('store: некорректный version — игнор файла', () => {
  freshState();
  writeFileSync(TEST_FILE, JSON.stringify({ version: 999, long: { postSlCooldown: { PURR: Date.now() + 1e9 } } }));
  const snap = loadHunterCooldowns();
  assert.deepStrictEqual(snap.long.postSlCooldown, {}, 'другая version игнорируется');
});

test('store: trail (peak+beArmed) переживает рестарт', () => {
  freshState();
  setHunterTrail(384, { peak: 8.57 });
  setHunterTrail(384, { beArmed: true }); // мердж, peak не теряется

  _resetForTest();        // симуляция рестарта
  _setFileForTest(TEST_FILE);

  const snap = loadHunterCooldowns();
  assert.strictEqual(snap.trail['384'].peak, 8.57, 'пик должен пережить рестарт');
  assert.strictEqual(snap.trail['384'].beArmed, true, 'BE-флаг должен пережить рестарт');
});

test('store: setHunterTrail мерджит, не затирает другое поле', () => {
  freshState();
  setHunterTrail(1, { peak: 3.0 });
  setHunterTrail(1, { peak: 5.0 }); // монотонный рост, beArmed остаётся false
  const all = getHunterTrailAll();
  assert.strictEqual(all['1'].peak, 5.0);
  assert.strictEqual(all['1'].beArmed, false);
});

test('store: trail-орфаны старше 24ч отбрасываются на load', () => {
  freshState();
  const ancient = Date.now() - 25 * 3600_000;
  const recent  = Date.now() - 60_000;
  writeFileSync(TEST_FILE, JSON.stringify({
    version: 1,
    short: { postSlCooldown: {} },
    long: { postSlCooldown: {}, slStreak: {} },
    trail: {
      '10': { peak: 4.0, beArmed: true, updatedAt: ancient },
      '11': { peak: 2.0, beArmed: false, updatedAt: recent },
    },
  }));
  const snap = loadHunterCooldowns();
  assert.strictEqual(snap.trail['10'], undefined, 'орфан > 24ч отброшен');
  assert.strictEqual(snap.trail['11'].peak, 2.0, 'свежий остаётся');
});

test('store: clearHunterTrail удаляет запись', () => {
  freshState();
  setHunterTrail(7, { peak: 1.5 });
  clearHunterTrail(7);
  const raw = JSON.parse(readFileSync(TEST_FILE, 'utf-8'));
  assert.strictEqual(raw.trail['7'], undefined);
});

test('cleanup: удалить тестовый файл', () => {
  if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
  _resetForTest();
});
