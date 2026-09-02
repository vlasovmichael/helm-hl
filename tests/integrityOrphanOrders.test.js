// Занятая маржа сама по себе не означает лаг индексатора HL.
//
// Why (02.09.2026): позиция #HEMI закрылась по стопу в 18:18, её reduce-only
// ордера остались висеть и держали маржу. Эвристика «позиций нет + маржа занята
// → API отстал» читала это как лаг и четыре часа подряд, каждую минуту,
// откладывала закрытие строки. Круг замыкался сам: ордера не снимались, пока
// строка открыта, а строка не закрывалась, пока маржа выглядела занятой.
//
// Reduce-only ордер не может существовать без позиции — если позиции нет, он
// осиротел. Это и есть признак, отличающий сироту от лага.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { orphanReduceOnlyCoins } = await import('../src/app/integrity.js');

const dbPos = [{ coin: 'HEMI', side: 'long' }];

test('reduce-only ордер без позиции = сирота, а не лаг API', () => {
  const orders = [
    { coin: 'HEMI', orderType: 'Stop Market', reduceOnly: true },
    { coin: 'HEMI', orderType: 'Limit', reduceOnly: true },
  ];
  assert.deepEqual(orphanReduceOnlyCoins(orders, dbPos), ['HEMI']);
});

test('позиционный TP/SL тоже считается сиротой', () => {
  const orders = [{ coin: 'HEMI', orderType: 'Take Profit Market', isPositionTpsl: true }];
  assert.deepEqual(orphanReduceOnlyCoins(orders, dbPos), ['HEMI']);
});

test('обычный ордер на открытие сиротой НЕ считается — маржа занята законно', () => {
  const orders = [{ coin: 'HEMI', orderType: 'Limit', reduceOnly: false }];
  assert.deepEqual(orphanReduceOnlyCoins(orders, dbPos), [], 'иначе закроем строку живой позиции');
});

test('ордера по чужой монете не влияют на решение', () => {
  const orders = [{ coin: 'SOL', orderType: 'Stop Market', reduceOnly: true }];
  assert.deepEqual(orphanReduceOnlyCoins(orders, dbPos), []);
});

test('пустые входы безопасны', () => {
  assert.deepEqual(orphanReduceOnlyCoins([], dbPos), []);
  assert.deepEqual(orphanReduceOnlyCoins(null, dbPos), []);
  assert.deepEqual(orphanReduceOnlyCoins([{ coin: 'HEMI', reduceOnly: true }], []), []);
  assert.deepEqual(orphanReduceOnlyCoins([{ coin: 'HEMI', reduceOnly: true }], null), []);
});

test('регистр монеты не важен, дубли схлопываются', () => {
  const orders = [
    { coin: 'hemi', reduceOnly: true },
    { coin: 'HEMI', reduceOnly: true },
  ];
  assert.deepEqual(orphanReduceOnlyCoins(orders, dbPos), ['HEMI']);
});
