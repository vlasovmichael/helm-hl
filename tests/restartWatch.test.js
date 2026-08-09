// Рестарт перестаёт быть незаметным.
//
// Why: 02.08 (cgroup OOM-kill) и 09.08 (FATAL heap limit) docker молча поднимал
// процесс по restart:unless-stopped, оператор узнавал спустя часы и случайно.
// Грязный флаг в data/last_exit.json отличает «меня перезапустили» от «я упал».
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { classifyStart, humanDuration } = await import('../src/app/restartWatch.js');

test('маркера нет — первый запуск, не трубим', () => {
  assert.equal(classifyStart(null), 'first');
  assert.equal(classifyStart(undefined), 'first');
});

test('clean:true — штатный перезапуск (деплой, руки)', () => {
  assert.equal(classifyStart({ clean: true, stoppedAt: 1 }), 'graceful');
});

test('clean:false — прошлый процесс до shutdown не дожил → трубим', () => {
  assert.equal(classifyStart({ clean: false, startedAt: 1 }), 'unexpected');
});

test('битый/пустой маркер не считается штатным выходом', () => {
  // Осторожная сторона: лучше лишний раз протрубить, чем проспать падение.
  assert.equal(classifyStart({}), 'unexpected');
  assert.equal(classifyStart('мусор'), 'first');
});

test('длительность читается человеком', () => {
  assert.equal(humanDuration(30 * 60_000), '30м');
  assert.equal(humanDuration(3 * 3600_000 + 12 * 60_000), '3ч 12м');
  // Ровно тот интервал, что прожил процесс между 06.08 и 09.08.
  assert.equal(humanDuration(3 * 86400_000 + 2 * 3600_000), '3д 2ч');
});
