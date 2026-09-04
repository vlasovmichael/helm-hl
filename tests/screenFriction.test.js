// Экран монет: отбор по ЦЕНЕ ВХОДА, а не по движению.
//
// Why: разбор 703 боевых сделок показал, что комиссии съели $27.17
// из $35.00 убытка, а HMSTR со спредом 52бп забрал $26 за 34 сделки. Экран
// отбирает монеты по трению, чтобы ошибка стоила дёшево. Здесь проверяется
// арифметика отбора — она повторяет замер на реальных числах.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { impactSpreadBp, frictionCost } = await import('../src/modules/dashboard/routes/screen.js');

test('impactSpreadBp: спред считается от mid в базисных пунктах', () => {
  // bid 99.5 / ask 100.5 при mid 100 → 100бп
  const bp = impactSpreadBp({ impactPxs: ['99.5', '100.5'] }, 100);
  assert.ok(Math.abs(bp - 100) < 1e-9);
});

test('impactSpreadBp: мусор на входе → null, а не NaN в карточке', () => {
  assert.equal(impactSpreadBp({ impactPxs: ['0', '1'] }, 100), null);
  assert.equal(impactSpreadBp({ impactPxs: [] }, 100), null);
  assert.equal(impactSpreadBp({}, 100), null);
  assert.equal(impactSpreadBp({ impactPxs: ['1', '2'] }, 0), null);
  // перевёрнутая книга (ask < bid) — данные битые, не «отрицательный спред»
  assert.equal(impactSpreadBp({ impactPxs: ['101', '100'] }, 100), null);
});

test('frictionCost: круг = спред + две тейкер-комиссии', () => {
  const c = frictionCost({ spreadBp: 10, notionalUsd: 10, riskUsd: 0.2 });
  assert.ok(Math.abs(c.totalBp - 18.64) < 1e-9);      // 10 + 4.32×2
  assert.ok(Math.abs(c.costUsd - 0.01864) < 1e-9);    // $10 × 18.64бп
});

test('frictionCost: доля бюджета риска — то самое число, ради которого карточка есть', () => {
  // BTC: спред 0.3бп на $10 при риске $0.20 → ~4.6% бюджета
  const btc = frictionCost({ spreadBp: 0.3, notionalUsd: 10, riskUsd: 0.2 });
  assert.ok(btc.pctOfRisk > 4 && btc.pctOfRisk < 5, `BTC: ${btc.pctOfRisk}`);
  // HMSTR: спред 52бп → треть бюджета уходит до того, как цена шевельнулась
  const hmstr = frictionCost({ spreadBp: 52.2, notionalUsd: 10, riskUsd: 0.2 });
  assert.ok(hmstr.pctOfRisk > 30, `HMSTR: ${hmstr.pctOfRisk}`);
});

test('frictionCost: риск неизвестен → доля null, но стоимость всё равно есть', () => {
  const c = frictionCost({ spreadBp: 10, notionalUsd: 10, riskUsd: null });
  assert.equal(c.pctOfRisk, null);
  assert.ok(c.costUsd > 0);
});

test('frictionCost: невалидный вход → null (карточка покажет прочерк)', () => {
  assert.equal(frictionCost({ spreadBp: NaN, notionalUsd: 10, riskUsd: 1 }), null);
  assert.equal(frictionCost({ spreadBp: 10, notionalUsd: 0, riskUsd: 1 }), null);
  assert.equal(frictionCost({ spreadBp: -1, notionalUsd: 10, riskUsd: 1 }), null);
});

test('порог 25бп: замер 23.08.2026 воспроизводится', () => {
  // Реальные impact-спреды с биржи в день замера.
  const measured = { BTC: 0.3, ETH: 0.6, SOL: 1.8, HYPE: 0.2, PUMP: 5.7,
                     TRUMP: 8.0, CASHCAT: 18.4, PURR: 29.0, HMSTR: 52.2 };
  const passes = (bp) => bp <= 25;
  // Внутри — то, чем оператор может торговать без потери трети риска на трение.
  for (const c of ['BTC', 'ETH', 'SOL', 'HYPE', 'PUMP', 'TRUMP']) {
    assert.ok(passes(measured[c]), `${c} должна проходить порог`);
  }
  // Снаружи — то, на чём он потерял деньги.
  for (const c of ['PURR', 'HMSTR']) {
    assert.ok(!passes(measured[c]), `${c} НЕ должна проходить порог`);
  }
});

// ── Сортировка таблицы ──────────────────────────────────────────────────────
// Why: первый вариант ранжирования по «Move» подставлял 24ч, когда короткого
// окна нет. Монета с +25% за сутки вставала выше монеты с +3% за 15 минут —
// колонка врала бы порядком. Пустые значения теперь всегда внизу.

const { sortCoins } = await import('../src/modules/dashboard/web/src/features/screen.js');

const coin = (name, over) => ({ coin: name, chg15mPct: null, chg1hPct: null,
                                chg24hPct: null, frictionPctOfRisk: null,
                                volume24hUsd: null, price: 1, mine: null, ...over });

test('sortCoins: Move ранжирует только по короткому окну, 24ч не подмешивается', () => {
  const list = [
    coin('BIG24', { chg24hPct: 25 }),          // сутки большие, короткого нет
    coin('SMALL15', { chg15mPct: 3 }),         // короткое маленькое, но ЕСТЬ
  ];
  assert.deepEqual(sortCoins(list, 'move', 'desc').map((c) => c.coin), ['SMALL15', 'BIG24']);
});

test('sortCoins: строки без данных внизу в ОБЕ стороны', () => {
  const list = [coin('NONE'), coin('A', { chg15mPct: 1 }), coin('B', { chg15mPct: 5 })];
  assert.deepEqual(sortCoins(list, 'move', 'desc').map((c) => c.coin), ['B', 'A', 'NONE']);
  assert.deepEqual(sortCoins(list, 'move', 'asc').map((c) => c.coin), ['A', 'B', 'NONE']);
});

test('sortCoins: трение по возрастанию = самые дешёвые входы сверху', () => {
  const list = [
    coin('HMSTR', { frictionPctOfRisk: 31 }),
    coin('BTC', { frictionPctOfRisk: 3 }),
    coin('PUMP', { frictionPctOfRisk: 6 }),
  ];
  assert.deepEqual(sortCoins(list, 'friction', 'asc').map((c) => c.coin), ['BTC', 'PUMP', 'HMSTR']);
});

test('sortCoins: тикер сортируется как строка', () => {
  const list = [coin('ZEC'), coin('AAVE'), coin('MON')];
  assert.deepEqual(sortCoins(list, 'coin', 'asc').map((c) => c.coin), ['AAVE', 'MON', 'ZEC']);
});

test('sortCoins: не мутирует исходный массив', () => {
  const list = [coin('A', { chg15mPct: 1 }), coin('B', { chg15mPct: 5 })];
  sortCoins(list, 'move', 'desc');
  assert.deepEqual(list.map((c) => c.coin), ['A', 'B']);
});
