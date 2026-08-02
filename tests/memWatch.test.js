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

const { readCgroupLimitBytes, shouldAlertMemory } = await import('../src/app/memWatch.js');

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
