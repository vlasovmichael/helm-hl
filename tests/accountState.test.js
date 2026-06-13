// Тесты accountState — коалесцирующий слой над чтениями аккаунта.
//
// Запуск: npm test
//
// Кейсы:
//  - TTL: повторный вызов в окне → один фетч
//  - single-flight: параллельные вызовы → один фетч
//  - истечение TTL → новый фетч
//  - разные ключи не пересекаются
//  - invalidate сбрасывает кэш ключа

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  coalesce,
  invalidateAccountState,
  _resetAccountState,
} from '../src/core/accountState.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('TTL: второй вызов в окне отдаёт кэш без нового фетча', async () => {
  _resetAccountState();
  let calls = 0;
  const fetcher = async () => { calls++; return calls; };

  const a = await coalesce('k', fetcher, 1000);
  const b = await coalesce('k', fetcher, 1000);

  assert.equal(a, 1);
  assert.equal(b, 1);       // тот же результат
  assert.equal(calls, 1);   // фетч один
});

test('single-flight: параллельные вызовы делят один фетч', async () => {
  _resetAccountState();
  let calls = 0;
  const fetcher = async () => { calls++; await sleep(30); return 'v'; };

  const [a, b, c] = await Promise.all([
    coalesce('k', fetcher, 1000),
    coalesce('k', fetcher, 1000),
    coalesce('k', fetcher, 1000),
  ]);

  assert.equal(a, 'v');
  assert.equal(b, 'v');
  assert.equal(c, 'v');
  assert.equal(calls, 1);
});

test('истечение TTL → новый фетч', async () => {
  _resetAccountState();
  let calls = 0;
  const fetcher = async () => { calls++; return calls; };

  const a = await coalesce('k', fetcher, 20);
  await sleep(40);
  const b = await coalesce('k', fetcher, 20);

  assert.equal(a, 1);
  assert.equal(b, 2);
  assert.equal(calls, 2);
});

test('разные ключи не пересекаются', async () => {
  _resetAccountState();
  let pos = 0, bal = 0;
  const a = await coalesce('positions', async () => ++pos, 1000);
  const b = await coalesce('balance',   async () => ++bal, 1000);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(pos, 1);
  assert.equal(bal, 1);
});

test('invalidate сбрасывает кэш ключа → следующий вызов фетчит заново', async () => {
  _resetAccountState();
  let calls = 0;
  const fetcher = async () => { calls++; return calls; };

  await coalesce('k', fetcher, 10_000);
  invalidateAccountState('k');
  const after = await coalesce('k', fetcher, 10_000);

  assert.equal(after, 2);
  assert.equal(calls, 2);
});

test('ошибка фетчера не залипает в кэше (следующий вызов пробует снова)', async () => {
  _resetAccountState();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    if (calls === 1) throw new Error('boom');
    return 'ok';
  };

  await assert.rejects(() => coalesce('k', fetcher, 1000));
  const second = await coalesce('k', fetcher, 1000);

  assert.equal(second, 'ok');
  assert.equal(calls, 2);
});
