import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeAllocs,
  recordAlloc,
  probeAlloc,
  formatRecentAllocs,
  _resetAllocProbe,
  _allocRing,
} from '../src/app/allocProbe.js';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
const { shouldWriteSnapshot } = await import('../src/app/memWatch.js');

const MB = 1024 * 1024;

test('summarizeAllocs: окно отсекает старое', () => {
  const now = 1_000_000;
  const rows = summarizeAllocs(
    [
      { at: now - 90_000, name: 'old', ms: 1, bytes: 0, heapDelta: 500 * MB },
      { at: now - 10_000, name: 'fresh', ms: 1, bytes: 0, heapDelta: 10 * MB },
    ],
    { now, windowMs: 60_000, top: 5 },
  );
  assert.deepEqual(rows.map((r) => r.name), ['fresh']);
});

test('summarizeAllocs: сортирует по сумме и помнит максимум одного вызова', () => {
  const now = 1_000_000;
  const rows = summarizeAllocs(
    [
      { at: now, name: 'мелочь', ms: 1, bytes: 0, heapDelta: 5 * MB },
      { at: now, name: 'мелочь', ms: 1, bytes: 0, heapDelta: 5 * MB },
      { at: now, name: 'слон', ms: 1, bytes: 0, heapDelta: 200 * MB },
    ],
    { now, windowMs: 60_000, top: 5 },
  );
  assert.equal(rows[0].name, 'слон');
  assert.equal(rows[0].max, 200 * MB);
  assert.equal(rows[1].count, 2);
  assert.equal(rows[1].sum, 10 * MB);
});

test('summarizeAllocs: отрицательные дельты (GC внутри операции) не съедают сумму', () => {
  const now = 1_000_000;
  const [row] = summarizeAllocs(
    [
      { at: now, name: 'a', ms: 1, bytes: 0, heapDelta: 40 * MB },
      { at: now, name: 'a', ms: 1, bytes: 0, heapDelta: -30 * MB },
    ],
    { now, windowMs: 60_000, top: 5 },
  );
  assert.equal(row.sum, 40 * MB);
});

test('summarizeAllocs: пустой вход даёт пустой топ, дырки в кольце игнорируются', () => {
  assert.deepEqual(summarizeAllocs([null, null], { now: 1, windowMs: 60_000, top: 5 }), []);
});

test('probeAlloc возвращает результат и пишет замер', async () => {
  _resetAllocProbe();
  const out = await probeAlloc('работа', async () => 'готово');
  assert.equal(out, 'готово');
  const ring = _allocRing();
  assert.equal(ring.length, 1);
  assert.equal(ring[0].name, 'работа');
});

test('probeAlloc пишет замер и когда операция упала', async () => {
  _resetAllocProbe();
  await assert.rejects(probeAlloc('падение', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(_allocRing()[0].name, 'падение');
});

test('formatRecentAllocs называет виновника, пустой буфер даёт пустую строку', () => {
  _resetAllocProbe();
  assert.equal(formatRecentAllocs(), '');
  recordAlloc('hl:candleSnapshot/scout', { ms: 900, bytes: 3 * MB, heapDelta: 180 * MB });
  const line = formatRecentAllocs();
  assert.match(line, /hl:candleSnapshot\/scout ×1/);
  assert.match(line, /180\.0МБ/);
});

test('shouldWriteSnapshot: выключен по умолчанию, один раз за запуск', () => {
  const heapLimit = 452 * MB;
  assert.equal(shouldWriteSnapshot({ heapUsed: 400 * MB, heapLimit, fraction: 0, alreadyTaken: false }), false);
  assert.equal(shouldWriteSnapshot({ heapUsed: 400 * MB, heapLimit, fraction: 0.8, alreadyTaken: false }), true);
  assert.equal(shouldWriteSnapshot({ heapUsed: 400 * MB, heapLimit, fraction: 0.8, alreadyTaken: true }), false);
  assert.equal(shouldWriteSnapshot({ heapUsed: 200 * MB, heapLimit, fraction: 0.8, alreadyTaken: false }), false);
  assert.equal(shouldWriteSnapshot({ heapUsed: 400 * MB, heapLimit: 0, fraction: 0.8, alreadyTaken: false }), false);
});
