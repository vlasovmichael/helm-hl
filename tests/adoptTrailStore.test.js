import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadAdoptTrail, getAdoptTrailAll, setAdoptTrail, clearAdoptTrail,
  _resetForTest, _setFileForTest,
} from '../src/modules/adoptTrailStore.js';

let dir;
function setup() {
  dir = mkdtempSync(join(tmpdir(), 'adopt-store-'));
  const file = join(dir, 'trail.json');
  _setFileForTest(file);
  return file;
}
afterEach(() => {
  _resetForTest();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

test('пустое хранилище лениво стартует без файла', () => {
  const file = setup();
  assert.deepEqual(loadAdoptTrail(), { version: 1, trail: {} });
  assert.equal(existsSync(file), false);
  assert.equal(getAdoptTrailAll(), getAdoptTrailAll(), 'кэш возвращается без повторного чтения');
});

test('set мерджит peak, trough и BE, а пик не понижает сам хранилище', () => {
  const file = setup();
  setAdoptTrail(7, { peak: 3 });
  setAdoptTrail(7, { trough: -2 });
  setAdoptTrail(7, { beArmed: true });
  const row = getAdoptTrailAll()['7'];
  assert.equal(row.peak, 3);
  assert.equal(row.trough, -2);
  assert.equal(row.beArmed, true);
  assert.ok(Number.isFinite(row.updatedAt));
  assert.equal(JSON.parse(readFileSync(file)).trail['7'].peak, 3);
});

test('неизменившийся patch не переписывает сохранённое состояние', () => {
  const file = setup();
  setAdoptTrail(3, { peak: 2 });
  const before = readFileSync(file, 'utf8');
  setAdoptTrail(3, { peak: 2 });
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('clear удаляет запись и null id ничего не меняет', () => {
  const file = setup();
  setAdoptTrail(3, { peak: 2 });
  clearAdoptTrail(null);
  assert.ok(getAdoptTrailAll()['3']);
  clearAdoptTrail(3);
  assert.equal(getAdoptTrailAll()['3'], undefined);
  assert.equal(JSON.parse(readFileSync(file)).trail['3'], undefined);
});

test('после рестарта сохраняются только свежие корректные записи текущей версии', () => {
  const file = setup();
  const now = 1_000_000_000;
  writeFileSync(file, JSON.stringify({ version: 1, trail: {
    fresh: { peak: 4, trough: -1, beArmed: true, updatedAt: now - 1 },
    old: { peak: 5, updatedAt: now - 24 * 60 * 60_000 },
    broken: { peak: 2, updatedAt: 'no' },
  } }));
  const loaded = loadAdoptTrail(now);
  assert.deepEqual(loaded.trail, { fresh: { peak: 4, trough: -1, beArmed: true, updatedAt: now - 1 } });
});

test('другая версия и битый JSON безопасно дают пустой кэш', () => {
  const file = setup();
  writeFileSync(file, JSON.stringify({ version: 2, trail: { x: { peak: 2, updatedAt: Date.now() } } }));
  assert.deepEqual(loadAdoptTrail().trail, {});
  _setFileForTest(file);
  writeFileSync(file, '{');
  assert.deepEqual(loadAdoptTrail().trail, {});
});

test('TTL оставляет часовую запись, но отбрасывает неполные и null-строки', () => {
  const file = setup();
  const now = 2_000_000_000;
  writeFileSync(file, JSON.stringify({ version: 1, trail: {
    hour: { peak: 2, updatedAt: now - 60 * 60_000 },
    noPeak: { updatedAt: now - 1 },
    noTime: { peak: 2 },
    nil: null,
  } }));
  const trail = loadAdoptTrail(now).trail;
  assert.deepEqual(trail, { hour: { peak: 2, trough: 0, beArmed: false, updatedAt: now - 60 * 60_000 } });
});

test('reset сбрасывает и кэш, и флаг загрузки перед новым файлом', () => {
  const first = setup();
  setAdoptTrail(1, { peak: 2 });
  assert.ok(getAdoptTrailAll()['1']);
  _resetForTest();
  const secondDir = mkdtempSync(join(tmpdir(), 'adopt-store-second-'));
  const second = join(secondDir, 'trail.json');
  try {
    writeFileSync(second, JSON.stringify({ version: 1, trail: { 2: { peak: 4, updatedAt: Date.now() } } }));
    _setFileForTest(second);
    assert.equal(getAdoptTrailAll()['1'], undefined);
    assert.equal(getAdoptTrailAll()['2'].peak, 4);
  } finally {
    rmSync(secondDir, { recursive: true, force: true });
  }
  assert.ok(first);
});
