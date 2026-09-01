// Журнал «Гениев Уолл-стрит»: событие переживает пуш и несёт исход.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cwd = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'winlog-'));
process.chdir(dir);
const { appendEvents, readEvents, summarize } = await import('../src/modules/winnersJournal.js');
process.chdir(cwd);

const inDir = (fn) => {
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(cwd);
  }
};

test('пустой список ничего не пишет — тик без событий не плодит файл', () => {
  inDir(() => {
    appendEvents([]);
    assert.equal(existsSync(join(dir, 'data', 'winners-events.jsonl')), false);
  });
});

test('свежие события идут первыми, чтения по limit хватает', () => {
  inDir(() => {
    appendEvents([
      { ts: 1, kind: 'open', coin: 'xyz:QNT', pnlNet: null },
      { ts: 2, kind: 'close', coin: 'xyz:QNT', pnlNet: -255 },
      { ts: 3, kind: 'close', coin: 'xyz:BB', pnlNet: 120 },
    ]);
    const got = readEvents({ limit: 2 });
    assert.deepEqual(got.map((e) => e.ts), [3, 2]);
  });
});

test('свод считает только закрытия — у открытой позиции исхода ещё нет', () => {
  const s = summarize([
    { ts: 3, kind: 'open', pnlNet: null },
    { ts: 2, kind: 'close', pnlNet: -255 },
    { ts: 1, kind: 'close', pnlNet: 120 },
  ]);
  assert.equal(s.events, 3);
  assert.equal(s.closed, 2);
  assert.equal(s.win, 1);
  assert.equal(s.loss, 1);
  assert.equal(s.winSum, 120);
  assert.equal(s.lossSum, -255);
  assert.equal(s.net, -135);
});

test('«не знаем исход» ≠ «вышел в ноль»: null не попадает ни в одну колонку', () => {
  const s = summarize([{ ts: 1, kind: 'close', pnlNet: null }]);
  assert.equal(s.closed, 0);
  assert.equal(s.win + s.loss, 0);
});

test('битая строка не роняет чтение — после падения хвост мог не дописаться', () => {
  inDir(() => {
    appendFileSync(join(dir, 'data', 'winners-events.jsonl'), '{"ts":4,"kind":"clo\n');
    const got = readEvents({ limit: 10 });
    assert.ok(got.every((e) => Number.isFinite(e.ts)));
  });
});

test('sinceMs обрезает старое', () => {
  inDir(() => {
    const got = readEvents({ limit: 10, sinceMs: 3 });
    assert.deepEqual(got.map((e) => e.ts), [3]);
  });
});

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
