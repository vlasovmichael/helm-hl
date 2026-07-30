// Очередь за весовым бюджетом /info.
//
// Инцидент 2026-07-31: бюджет раздавался «кто успел» — новоприбывшие
// расхватывали освободившийся вес мимо тех, кто уже ждал. Отдельные запросы
// стояли по 2 минуты при загрузке всего 69%, tick() раздуло с 15с до 5 минут,
// и трейл adopt-позы (жил внутри тика) замер вместе с ним.
//
// Здесь проверяется контракт новой очереди:
//   • порядок строгий: приоритет, при равном — FIFO (никакого barging);
//   • косметика не копит очередь бесконечно — отваливается по дедлайну;
//   • отвал по дедлайну НЕ ретраится (иначе он бессмысленен).
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.HL_WEIGHT_BUDGET = '40';        // 2 тяжёлых запроса (по 20) в окне
process.env.HL_WEIGHT_LOW_SHARE = '0.5';    // → LOW/NORMAL видят 20 = ровно один
process.env.HL_WEIGHT_WINDOW_MS = '400';    // окно вместо минуты — чтобы тест жил
process.env.HL_WEIGHT_WAIT_LOW_MS = '150';
process.env.HL_WEIGHT_WAIT_NORMAL_MS = '5000';
process.env.HL_WEIGHT_WAIT_HIGH_MS = '5000';
process.env.HL_MIN_GAP_MS = '0';
process.env.HL_MAX_CONCURRENT = '8';

const axiosModule = await import('axios');
const { hlInfo, HL_PRIORITY, hlClientStats } = await import('../src/core/hlClient.js');

let postCalls = 0;
axiosModule.default.post = async () => {
  postCalls++;
  return { data: 'ok' };
};

const heavy = { type: 'candleSnapshot' }; // вес 20
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('LOW отваливается по дедлайну вместо бесконечного ожидания', async () => {
  await hlInfo(heavy, { label: 'test/fill', priority: HL_PRIORITY.LOW }); // съел 20 из 20

  const before = postCalls;
  const startedAt = Date.now();
  await assert.rejects(
    () => hlInfo(heavy, { label: 'test/low-timeout', priority: HL_PRIORITY.LOW }),
    (err) => err.isWeightTimeout === true,
  );
  const waited = Date.now() - startedAt;

  assert.ok(waited >= 140, `ждал ${waited}ms — должен был досидеть до дедлайна`);
  assert.ok(waited < 400, `ждал ${waited}ms — дедлайн 150ms не соблюдён`);
  // Главное: отвал по бюджету не ретраится. Ретрай встал бы в ту же очередь.
  assert.equal(postCalls, before, 'запрос не должен был уйти в сеть');

  await sleep(450); // окно выпало → чистый лист для следующего кейса
});

test('HIGH проходит вперёд LOW, как бы рано тот ни встал в очередь', async () => {
  // Забиваем весь бюджет (40) двумя HIGH — дальше ждут все.
  await hlInfo(heavy, { label: 'test/fill1', priority: HL_PRIORITY.HIGH });
  await hlInfo(heavy, { label: 'test/fill2', priority: HL_PRIORITY.HIGH });

  const order = [];
  // NORMAL встаёт в очередь ПЕРВЫМ, HIGH — вторым.
  const normal = hlInfo(heavy, { label: 'test/normal', priority: HL_PRIORITY.NORMAL })
    .then(() => order.push('normal'));
  await sleep(10);
  const high = hlInfo(heavy, { label: 'test/high', priority: HL_PRIORITY.HIGH })
    .then(() => order.push('high'));

  await high;
  assert.deepEqual(order, ['high'], 'HIGH должен пройти первым, несмотря на поздний приход');

  await normal;
  assert.deepEqual(order, ['high', 'normal']);
  await sleep(450);
});

test('внутри приоритета — FIFO: кто встал раньше, тот и пройдёт раньше', async () => {
  await hlInfo(heavy, { label: 'test/fill', priority: HL_PRIORITY.NORMAL }); // бюджет NORMAL занят

  const order = [];
  const first = hlInfo(heavy, { label: 'test/n1', priority: HL_PRIORITY.NORMAL })
    .then(() => order.push('first'));
  await sleep(20);
  const second = hlInfo(heavy, { label: 'test/n2', priority: HL_PRIORITY.NORMAL })
    .then(() => order.push('second'));
  // Поздний гость — тот самый barging-кейс: раньше он мог обогнать ждущих.
  await sleep(100);
  const late = hlInfo(heavy, { label: 'test/n3', priority: HL_PRIORITY.NORMAL })
    .then(() => order.push('late'));

  await Promise.all([first, second, late]);
  assert.deepEqual(order, ['first', 'second', 'late']);
  await sleep(450);
});

test('stats показывают, кто именно съел бюджет (свечи схлопнуты по кэшу)', async () => {
  await hlInfo(heavy, { label: 'candleCache15m/SOL', priority: HL_PRIORITY.HIGH });
  await hlInfo(heavy, { label: 'candleCache15m/BTC', priority: HL_PRIORITY.HIGH });

  const s = hlClientStats();
  const candles = s.topLabels.find((t) => t.label === 'candleCache15m');
  assert.ok(candles, 'группа candleCache15m должна быть в топе');
  assert.equal(candles.weight, 40, 'две монеты по 20 = 40, а не две строки по 20');
  assert.equal(typeof s.weightQueued, 'number');
  assert.equal(typeof s.weightTimeouts, 'number');
  await sleep(450);
});
