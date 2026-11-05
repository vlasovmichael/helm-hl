// Отметка «нянька не ведёт»: переживает рестарт и снимается, только когда позы и входной лимитки нет.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isAdoptOff,
  markAdoptOff,
  clearAdoptOff,
  pruneAdoptOff,
  OPT_OUT_GRACE_MS,
  _setFileForTest,
} from '../src/modules/adoptOptOut.js';

const dirs = [];
function freshFile() {
  const dir = mkdtempSync(join(tmpdir(), 'adopt-opt-out-'));
  dirs.push(dir);
  const file = join(dir, 'adopt_opt_out.json');
  _setFileForTest(file);
  return file;
}

afterEach(() => {
  _setFileForTest(null);
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const NOW = 1_000_000_000;
const AFTER_GRACE = NOW + OPT_OUT_GRACE_MS;
const noOrders = async () => [];

test('отметка переживает рестарт и не зависит от регистра', () => {
  const file = freshFile();
  markAdoptOff('btc', NOW);
  _setFileForTest(file);
  assert.equal(isAdoptOff('BTC'), true);
  assert.equal(isAdoptOff('ETH'), false);
});

test('снятая отметка не возвращается после рестарта', () => {
  const file = freshFile();
  markAdoptOff('BTC', NOW);
  clearAdoptOff('BTC');
  _setFileForTest(file);
  assert.equal(isAdoptOff('BTC'), false);
});

test('битый файл не роняет бота и не даёт отметок', () => {
  const file = freshFile();
  writeFileSync(file, '{');
  _setFileForTest(file);
  assert.equal(isAdoptOff('BTC'), false);
});

test('свежую отметку не снимаем: филл рыночного ордера ещё не дошёл до позиций', async () => {
  freshFile();
  markAdoptOff('BTC', NOW);
  await pruneAdoptOff([], noOrders, AFTER_GRACE - 1);
  assert.equal(isAdoptOff('BTC'), true);
});

test('отметку снимаем, когда нет ни позиции, ни входной лимитки', async () => {
  freshFile();
  markAdoptOff('BTC', NOW);
  await pruneAdoptOff([], noOrders, AFTER_GRACE);
  assert.equal(isAdoptOff('BTC'), false);
});

test('открытая позиция держит отметку и не требует чтения ордеров', async () => {
  freshFile();
  markAdoptOff('BTC', NOW);
  let fetched = 0;
  await pruneAdoptOff(['BTC'], async () => { fetched += 1; return []; }, AFTER_GRACE);
  assert.equal(isAdoptOff('BTC'), true);
  assert.equal(fetched, 0);
});

test('лимитка на вход держит отметку, reduce-only не держит', async () => {
  freshFile();
  markAdoptOff('BTC', NOW);
  markAdoptOff('ETH', NOW);
  const orders = async () => [
    { coin: 'BTC', reduceOnly: false },
    { coin: 'ETH', reduceOnly: true },
  ];
  await pruneAdoptOff([], orders, AFTER_GRACE);
  assert.equal(isAdoptOff('BTC'), true);
  assert.equal(isAdoptOff('ETH'), false);
});

test('сбой чтения ордеров отметку не снимает', async () => {
  freshFile();
  markAdoptOff('BTC', NOW);
  await pruneAdoptOff([], async () => { throw new Error('down'); }, AFTER_GRACE);
  assert.equal(isAdoptOff('BTC'), true);
});
