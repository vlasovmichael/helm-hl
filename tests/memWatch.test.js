// Наблюдение за памятью. Контейнер дважды за двое суток «сам перезагружался»
// (01.08, 02.08): нода упиралась в лимит cgroup 256M, ядро убивало процесс,
// docker поднимал заново — в логе бота ни строчки. Здесь проверяется то, что
// решает, будет ли предупреждение: чтение потолка из cgroup и порог алерта.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { readCgroupLimitBytes, shouldAlertMemory, shouldReportJump } = await import('../src/app/memWatch.js');

test('порог: трубим на 80% потолка, молчим ниже', () => {
  assert.equal(shouldAlertMemory({ fraction: 0.79, alreadyAlerted: false }), false);
  assert.equal(shouldAlertMemory({ fraction: 0.80, alreadyAlerted: false }), true);
  assert.equal(shouldAlertMemory({ fraction: 0.95, alreadyAlerted: false }), true);
});

test('один пуш на эпизод — второй раз не звоним', () => {
  assert.equal(shouldAlertMemory({ fraction: 0.99, alreadyAlerted: true }), false);
});

test('«max» в memory.max = безлимит, а не потолок', (t) => {
  t.mock.method(fs, 'readFileSync', () => 'max\n');
  assert.equal(readCgroupLimitBytes(), null);
});

test('число в memory.max читается как байты', (t) => {
  t.mock.method(fs, 'readFileSync', () => '536870912\n');
  assert.equal(readCgroupLimitBytes(), 536870912);
});

test('cgroup v1 без лимита (~2^63) не считается потолком', (t) => {
  t.mock.method(fs, 'readFileSync', () => '9223372036854771712\n');
  assert.equal(readCgroupLimitBytes(), null);
});

test('нет файлов cgroup (не в контейнере) → null, без исключения', (t) => {
  t.mock.method(fs, 'readFileSync', () => { throw new Error('ENOENT'); });
  assert.equal(readCgroupLimitBytes(), null);
});

// ── Ловля залпа (10.08.2026) ────────────────────────────────────────────────
// Третье и четвёртое падения пришли не течью: между замерами куча стояла на
// 145МБ, через четыре минуты процесс умер на 252. Десятиминутный интервал такое
// не видит, поэтому поверх него — частый опрос, который молчит до скачка.
const MB = 1024 * 1024;

test('скачок: молчим на плавном росте, говорим на залпе', () => {
  const jumpBytes = 40 * MB;
  assert.equal(shouldReportJump({ heapUsed: 150 * MB, prevHeapUsed: 145 * MB, jumpBytes }), false);
  assert.equal(shouldReportJump({ heapUsed: 185 * MB, prevHeapUsed: 145 * MB, jumpBytes }), true);
  assert.equal(shouldReportJump({ heapUsed: 252 * MB, prevHeapUsed: 145 * MB, jumpBytes }), true);
});

test('первый опрос после старта опорной точки не имеет и обязан молчать', () => {
  assert.equal(shouldReportJump({ heapUsed: 250 * MB, prevHeapUsed: 0, jumpBytes: 40 * MB }), false);
});

test('падение кучи (GC собрал) — не скачок', () => {
  assert.equal(shouldReportJump({ heapUsed: 90 * MB, prevHeapUsed: 240 * MB, jumpBytes: 40 * MB }), false);
});
