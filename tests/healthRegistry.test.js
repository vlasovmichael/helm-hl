// Тесты healthRegistry — реестр проверок целостности данных.
//
// Запуск: npm test
//
// Кейсы:
//  - пустой реестр → 'unknown' (нечего показывать, а не «всё хорошо»)
//  - иерархия overall: stale > drift > fail > warn > ok
//  - протухшая запись читается как fail, даже если писалась как pass
//  - протухание относится к freshness → тянет overall в 'stale'
//  - note перезаписывает предыдущий результат той же проверки
//  - мусорный status игнорируется

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { note, drop, summary, resetHealth } from '../src/core/healthRegistry.js';

test('пустой реестр не выдаёт себя за здоровый', () => {
  resetHealth();
  const s = summary();
  assert.equal(s.overall, 'unknown');
  assert.equal(s.checks.length, 0);
});

test('всё pass → ok', () => {
  resetHealth();
  note('a', { category: 'freshness', status: 'pass' });
  note('b', { category: 'xref', status: 'pass' });
  assert.equal(summary().overall, 'ok');
});

test('warn поднимает overall до warn, но не выше', () => {
  resetHealth();
  note('a', { category: 'freshness', status: 'pass' });
  note('b', { category: 'xref', status: 'warn' });
  assert.equal(summary().overall, 'warn');
});

test('fail в xref → drift', () => {
  resetHealth();
  note('a', { category: 'xref', status: 'fail' });
  assert.equal(summary().overall, 'drift');
});

test('замёрзший фид важнее дрифта: freshness-fail кроет xref-fail', () => {
  resetHealth();
  note('drift', { category: 'xref', status: 'fail' });
  note('feed', { category: 'freshness', status: 'fail' });
  assert.equal(summary().overall, 'stale');
});

test('fail вне freshness/xref → fail', () => {
  resetHealth();
  note('cov', { category: 'completeness', status: 'fail' });
  assert.equal(summary().overall, 'fail');
});

test('молчание писателя протухает в fail, а не остаётся pass', () => {
  resetHealth();
  note('feed', { category: 'xref', status: 'pass', detail: 'было хорошо', ttlMs: -1 });
  const s = summary();
  assert.equal(s.checks[0].status, 'fail');
  assert.equal(s.checks[0].stale, true);
  assert.match(s.checks[0].detail, /no updates for/);
  // Протухшее — это всегда «источник замолчал», то есть freshness.
  assert.equal(s.overall, 'stale');
});

test('свежая запись протухшей не считается', () => {
  resetHealth();
  note('feed', { category: 'freshness', status: 'pass', ttlMs: 60_000 });
  const s = summary();
  assert.equal(s.checks[0].stale, false);
  assert.equal(s.overall, 'ok');
});

test('note перезаписывает ту же проверку, а не копит', () => {
  resetHealth();
  note('feed', { category: 'freshness', status: 'fail' });
  note('feed', { category: 'freshness', status: 'pass' });
  const s = summary();
  assert.equal(s.checks.length, 1);
  assert.equal(s.overall, 'ok');
});

test('мусорный status не попадает в реестр', () => {
  resetHealth();
  note('feed', { category: 'freshness', status: 'ок' });
  note('feed2', { category: 'freshness' });
  assert.equal(summary().checks.length, 0);
});

test('drop убирает проверку', () => {
  resetHealth();
  note('feed', { category: 'freshness', status: 'fail' });
  drop('feed');
  assert.equal(summary().overall, 'unknown');
});

test('counts считает по итоговому статусу, включая протухание', () => {
  resetHealth();
  note('a', { category: 'freshness', status: 'pass', ttlMs: 60_000 });
  note('b', { category: 'xref', status: 'warn', ttlMs: 60_000 });
  note('c', { category: 'xref', status: 'pass', ttlMs: -1 }); // протухла
  const s = summary();
  assert.deepEqual(s.counts, { pass: 1, warn: 1, fail: 1 });
});
