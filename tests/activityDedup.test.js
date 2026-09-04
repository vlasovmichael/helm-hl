// makeHistoryCoverage: дедуп display-лент (/api/activity, /api/trade-markers)
// против БД-истории. ЕДИНЫЙ источник правды для bot+adopted — таблица history;
// fills-реконструкция нужна только для чисто ручных трейдов. Баг:
// adopted-поза живёт И в history, И в fills (вход — ручной fill). Если reconstruct
// не успел пометить ногу `adopted` (entry_time не бэкфилнут / нет бот-OID), та же
// сделка задваивалась в ленте — `close` из history + `manual_close` из fills.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { makeHistoryCoverage } = await import('../src/modules/dashboard/server.js');

const T = 1_700_000_000_000;

test('closedCovered: ручная нога с тем же coin+временем закрытия выкидывается', () => {
  const cov = makeHistoryCoverage([{ coin: 'DYDX', entry_time: T, closed_at: T + 1000 }], null);
  // та же сделка из fills (закрытие в пределах допуска) — покрыта историей
  assert.equal(cov.closedCovered('DYDX', T + 1000), true);
  assert.equal(cov.closedCovered('DYDX', T + 1000 + 3000), true); // +3с — ещё в допуске
});

test('closedCovered: чисто ручной трейд (нет в истории) остаётся', () => {
  const cov = makeHistoryCoverage([{ coin: 'DYDX', closed_at: T }], null);
  assert.equal(cov.closedCovered('WLD', T), false);          // другой coin
  assert.equal(cov.closedCovered('DYDX', T + 60_000), false); // то же coin, но >5с — другая сделка
});

test('closedCovered: регистр coin не важен, кривые входы не матчат', () => {
  const cov = makeHistoryCoverage([{ coin: 'DYDX', closed_at: T }], null);
  assert.equal(cov.closedCovered('dydx', T + 2000), true);
  assert.equal(cov.closedCovered('DYDX', NaN), false);
  assert.equal(cov.closedCovered(null, T), false);
});

test('openCovered: открытая ручная нога = активный слот → выкидывается (single-slot)', () => {
  const cov = makeHistoryCoverage([], { coin: 'DYDX' });
  assert.equal(cov.openCovered('DYDX'), true);
  assert.equal(cov.openCovered('dydx'), true);
  assert.equal(cov.openCovered('WLD'), false);
});

test('openCovered: нет активной позы → ничего не покрыто', () => {
  const cov = makeHistoryCoverage([], null);
  assert.equal(cov.openCovered('DYDX'), false);
});

test('пустая/битая история не падает', () => {
  const cov = makeHistoryCoverage(undefined, undefined);
  assert.equal(cov.closedCovered('DYDX', T), false);
  assert.equal(cov.openCovered('DYDX'), false);
});
