// Бейдж LATE в строке Hot Movers: метка «вход в уже случившееся движение».
//
// Главное, что здесь защищается: бейдж не превращается в сигнал. Он загорается
// РОВНО на стороне, помеченной классификатором, — на противоположной стороне
// его отсутствие ничего не разрешает, а на тихом рынке он молчит совсем.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { chaseBadge } = await import('../src/modules/dashboard/web/src/hotMovers/render.js');

const strongLong = { level: 'strong', blockedSide: 'LONG', text: '+4.2% in an hour — entering LONG goes with the move' };

test('помеченная сторона совпала со стороной строки — бейдж есть', () => {
  const html = chaseBadge(strongLong, 'LONG');
  assert.match(html, /hm-chase--strong/);
  assert.match(html, />LATE</);
});

test('противоположная сторона бейджа не получает', () => {
  assert.equal(chaseBadge(strongLong, 'SHORT'), '');
});

test('тихий рынок и отсутствие стороны молчат', () => {
  assert.equal(chaseBadge({ level: 'quiet', blockedSide: null, text: '' }, 'LONG'), '');
  assert.equal(chaseBadge(strongLong, null), '');
  assert.equal(chaseBadge(null, 'LONG'), '');
});

test('уровень extreme едет в класс — строка журнала с худшим срезом видна глазом', () => {
  const html = chaseBadge({ ...strongLong, level: 'extreme' }, 'LONG');
  assert.match(html, /hm-chase--extreme/);
});
