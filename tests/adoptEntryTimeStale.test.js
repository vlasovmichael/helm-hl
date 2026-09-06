// Возраст усыновлённой позы врал: LDO 06.09 — карточка показывала 3 часа на
// позе, открытой минуты назад. Два корня, оба здесь:
//
//   1. WS принёс открывающий филл мгновенно, а REST-лента (userFillsByTime)
//      отставала на 10-30с → openTime=null → падали на first-seen.
//   2. First-seen по монете не подрезался, пока не было НОВОГО ручного входа:
//      усыновлённая монета уходит из manualPositions, список пустеет, ранний
//      return в orphanCheck пропускал подрезку. Запись от ЗАКРЫТОЙ шортовой ноги
//      (18:27) дожила до лонга в 20:19 и стала его «временем входа».
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { mergeFills, resolveManualOpenTime, updateFirstSeen } =
  await import('../src/app/adoptReconcile.js');
const { recordLiveFills, getLiveFills } = await import('../src/core/fillFeed.js');

const MIN = 60_000;
const T0 = 1_788_712_076_373;   // 06.09 18:27 — открытие шорта LDO

const fill = (tid, time, dir, sz) => ({ tid, time, dir, sz: String(sz), coin: 'LDO', px: '0.42' });

test('mergeFills: живой филл доклеивается к REST-ленте, дубли схлопываются по tid', () => {
  const rest = [fill(1, T0, 'Open Short', 26.3), fill(2, T0 + 15 * MIN, 'Close Short', 26.3)];
  const live = [fill(2, T0 + 15 * MIN, 'Close Short', 26.3), fill(3, T0 + 111 * MIN, 'Open Long', 38)];
  const merged = mergeFills(rest, live);
  assert.equal(merged.length, 3, 'дубль tid=2 не удвоился');
  assert.deepEqual(merged.map((f) => f.tid), [1, 2, 3], 'отсортировано по времени');
});

test('REST отстаёт, WS уже принёс Open Long → время входа точное, не first-seen', () => {
  // Лента REST заканчивается флэтом: открывающего филла лонга в ней ещё нет.
  const rest = [fill(1, T0, 'Open Short', 26.3), fill(2, T0 + 15 * MIN, 'Close Short', 26.3)];
  const live = [fill(3, T0 + 111 * MIN, 'Open Long', 38)];

  const blind = resolveManualOpenTime({ coin: 'LDO', fills: rest, currentNet: 38 });
  assert.equal(blind, null, 'без живого филла честный ответ — «не знаю»');

  const seen = resolveManualOpenTime({ coin: 'LDO', fills: mergeFills(rest, live), currentNet: 38 });
  assert.equal(seen, T0 + 111 * MIN, 'время входа = момент открывающего филла лонга');
});

test('кольцо живых филлов отдаёт то, что положили, и режется по времени', () => {
  recordLiveFills([fill(10, T0, 'Open Short', 1), fill(11, T0 + MIN, 'Close Short', 1)]);
  const all = getLiveFills();
  assert.ok(all.some((f) => f.tid === 10) && all.some((f) => f.tid === 11));
  assert.deepEqual(getLiveFills(T0 + MIN).map((f) => f.tid), [11], 'отсечка снизу работает');
});

test('first-seen подрезается пустым списком — протухшая запись не переживает закрытие ноги', () => {
  const map = new Map();
  let boot = false;
  boot = updateFirstSeen(map, ['LDO'], T0, boot);            // первый цикл: старт
  boot = updateFirstSeen(map, [], T0 + 15 * MIN, boot);      // ногу закрыли/усыновили
  assert.equal(map.has('LDO'), false, 'запись ушла вместе с монетой');

  updateFirstSeen(map, ['LDO'], T0 + 111 * MIN, boot);       // новый вход по той же монете
  assert.equal(map.get('LDO').ts, T0 + 111 * MIN, 'время свежее, а не от прошлой ноги');
  assert.equal(map.get('LDO').atStartup, false, 'рождение увидели при живом боте');
});
