// liveMatchesPosition: side-aware детект «жива ли наша поза на бирже».
// Регресс на adopt flip-merge баг (2026-06-18): флип short→long не детектился,
// потому что сверялась только монета, не сторона → стоп/трейл вели фантом, а
// минусовая нога пропадала из history.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { liveMatchesPosition } = await import('../src/app/integrity.js');

const ex = (coin, szi) => ({ position: { coin, szi: String(szi) } });

test('наша сторона на бирже → match (поза на месте)', () => {
  const db = { coin: 'LIT', side: 'short' };
  assert.equal(liveMatchesPosition(db, [ex('LIT', -49)]), true);
});

test('флип: на бирже лонг, DB-поза шорт → НЕ match (исчезла)', () => {
  const db = { coin: 'LIT', side: 'short' };
  assert.equal(liveMatchesPosition(db, [ex('LIT', 47)]), false);
});

test('монеты нет на бирже → НЕ match', () => {
  const db = { coin: 'LIT', side: 'long' };
  assert.equal(liveMatchesPosition(db, [ex('ETH', 1)]), false);
});

test('szi=0 (закрыта) → НЕ match', () => {
  const db = { coin: 'LIT', side: 'long' };
  assert.equal(liveMatchesPosition(db, [ex('LIT', 0)]), false);
});

test('лонг на месте → match', () => {
  const db = { coin: 'LIT', side: 'long' };
  assert.equal(liveMatchesPosition(db, [ex('LIT', 47)]), true);
});

test('несколько монет, наша сторона среди них → match', () => {
  const db = { coin: 'LIT', side: 'short' };
  assert.equal(
    liveMatchesPosition(db, [ex('ETH', 2), ex('LIT', -10), ex('BTC', 1)]),
    true,
  );
});
