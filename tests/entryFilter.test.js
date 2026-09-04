// Фильтр входа: помечает сторону, которая идёт В СТОРОНУ уже случившегося движения.
//
// Why: гипотеза `entry-into-continuation` из разбора 650 ручных
// сделок. Проверяется именно чистое ядро — classify/buildEntryFilter не трогают
// ни config, ни БД, ни биржу, поэтому тест не требует живого кошелька (тот же
// приём, что в tradeGuards).
//
// Главное, что здесь защищается: карточка не должна превращаться в генератор
// сигналов. Молчание фильтра — это молчание, а не «разрешено входить».
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { classify, buildEntryFilter, EF } = await import('../src/modules/dashboard/routes/entryFilter.js');

test('рост за час помечает LONG как вход по движению', () => {
  const v = classify({ trend1h: 4.2, trend15m: 0.3 });
  assert.equal(v.blockedSide, 'LONG');
  assert.equal(v.allowedSide, 'SHORT');
  assert.equal(v.level, 'strong');
});

test('обвал за час помечает SHORT и поднимает уровень до extreme', () => {
  const v = classify({ trend1h: -6.1, trend15m: -1.0 });
  assert.equal(v.blockedSide, 'SHORT');
  assert.equal(v.level, 'extreme');
  // Текст карточки английский (страница /oi английская целиком).
  assert.match(v.text, /worst slice/);
});

test('спокойный фон: фильтр молчит и НЕ называет разрешённую сторону', () => {
  const v = classify({ trend1h: 0.8, trend15m: 0.4 });
  assert.equal(v.level, 'quiet');
  assert.equal(v.blockedSide, null);
  assert.equal(v.allowedSide, null, 'молчание не должно читаться как разрешение входа');
});

test('быстрый разгон на 15м ловится даже при спокойном часе', () => {
  const v = classify({ trend1h: 0.5, trend15m: 2.4 });
  assert.equal(v.level, 'fast');
  assert.equal(v.blockedSide, 'LONG');
});

test('открытая позиция на помеченной стороне поднимается наверх списка', () => {
  const market = [
    { coin: 'AAA', price: 100, dayChangePct: 1 },
    { coin: 'BBB', price: 50, dayChangePct: -2 },
  ];
  // подменяем тренды: buildEntryFilter читает их из priceHistory, поэтому
  // наполняем буфер напрямую
  return import('../src/core/priceHistory.js').then((ph) => {
    const now = Date.now();
    ph.push('AAA', 100, now - 61 * 60_000);   // час назад столько же → тренд ~0
    ph.push('AAA', 100, now);
    ph.push('BBB', 100, now - 61 * 60_000);   // упала вдвое за час
    ph.push('BBB', 50, now);

    const positions = new Map([['BBB', { side: 'SHORT', unrealizedPnl: -1 }]]);
    const out = buildEntryFilter(market, positions, now);

    assert.equal(out.rows[0].coin, 'BBB', 'монета с позицией на помеченной стороне идёт первой');
    assert.equal(out.rows[0].holdingBlocked, true);
    assert.equal(out.rows[0].blockedSide, 'SHORT');
    assert.equal(out.holdingBlocked.length, 1);
    assert.ok(out.thresholds.STRONG_1H === EF.STRONG_1H);
  });
});

test('монета без ценовой истории в карточку не попадает', () => {
  const out = buildEntryFilter([{ coin: 'NOHIST', price: 7, dayChangePct: 0 }], new Map(), Date.now());
  assert.equal(out.rows.find((r) => r.coin === 'NOHIST'), undefined);
});
