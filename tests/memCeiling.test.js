// Какой потолок памяти связывает первым.
//
// Why (09.08.2026): алерт, написанный после cgroup-OOM 02.08, был недостижим ПО
// ПОСТРОЕНИЮ. Он смотрел на rss/cgroup и трубил на 80% от 512 МБ, то есть на 410.
// Но Node 20 вывел heap_size_limit из того же cgroup и поставил себе 259 МБ —
// процесс умирал по FATAL heap limit на rss около 242, не дойдя до порога
// никогда. Оба падения прошли молча.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { pickBindingCeiling, shouldAlertMemory } = await import('../src/app/memWatch.js');

const MB = 1024 * 1024;

test('реальный расклад падения 09.08: связывает куча, а не cgroup', () => {
  const b = pickBindingCeiling({
    rss: 242 * MB, heapUsed: 240 * MB,
    cgroupLimit: 512 * MB, heapLimit: 259 * MB,
  });
  assert.equal(b.kind, 'heap');
  // Именно этот порог и не срабатывал раньше: по rss было 47%, по куче — 93%.
  assert.ok(b.fraction > 0.9);
  assert.equal(shouldAlertMemory({ fraction: b.fraction, alreadyAlerted: false }), true);
});

test('старый порог по rss на тех же числах молчал бы', () => {
  const rssFraction = (242 * MB) / (512 * MB);
  assert.equal(shouldAlertMemory({ fraction: rssFraction, alreadyAlerted: false }), false);
});

test('если первым упирается rss — трубим по нему', () => {
  const b = pickBindingCeiling({
    rss: 480 * MB, heapUsed: 100 * MB,
    cgroupLimit: 512 * MB, heapLimit: 1024 * MB,
  });
  assert.equal(b.kind, 'rss');
});

test('вне контейнера (нет cgroup) потолок кучи всё равно виден', () => {
  const b = pickBindingCeiling({
    rss: 300 * MB, heapUsed: 200 * MB,
    cgroupLimit: null, heapLimit: 259 * MB,
  });
  assert.equal(b.kind, 'heap');
});

test('нет ни одного потолка → null, замер просто логируется', () => {
  assert.equal(
    pickBindingCeiling({ rss: 1, heapUsed: 1, cgroupLimit: null, heapLimit: null }),
    null,
  );
});
