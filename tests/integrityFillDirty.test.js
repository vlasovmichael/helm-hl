// Форсированная сверка после филла: пока строка в БД не сошлась с биржей,
// сверка идёт каждый тик, а не раз в 60с. Без этого перезаход оператора
// (закрыл по TP → сразу вошёл снова) до минуты не виден няньке и висит без стопа.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { markFillDirty, pruneFillDirty } = await import('../src/app/integrity.js');
const { state, INTEGRITY_FILL_RECHECK_MS } = await import('../src/app/state.js');

test('филл метит монету грязной, тикер приводится к верхнему регистру', () => {
  state.fillDirtyCoins.clear();
  markFillDirty(['hemi', 'BTC']);
  assert.deepEqual([...pruneFillDirty()].sort(), ['BTC', 'HEMI']);
});

test('метка живёт до дедлайна и снимается после него', () => {
  state.fillDirtyCoins.clear();
  markFillDirty(['HEMI']);
  const now = Date.now();
  assert.equal(pruneFillDirty(now + INTEGRITY_FILL_RECHECK_MS - 1_000).size, 1);
  assert.equal(pruneFillDirty(now + INTEGRITY_FILL_RECHECK_MS + 1_000).size, 0);
});

test('пустой и мусорный вход метку не ставит', () => {
  state.fillDirtyCoins.clear();
  markFillDirty(null);
  markFillDirty([null, '', undefined, 42]);
  assert.equal(pruneFillDirty().size, 0);
});
