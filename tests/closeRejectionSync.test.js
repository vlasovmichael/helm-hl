// isPositionGoneRejection: какие отказы биржи означают «позы уже нет».
//
// Регресс на KAITO 30.07. Юзер закрыл шорт руками за секунду до того, как бот
// послал свой трейл-close. Биржа отвергла reduce-only ордер («would increase
// position»), бот просто залогировал ERROR — и DB-строка осталась OPEN со старым
// entry_price. Через 41с оператор перезашёл в тот же коин той же стороной, бот
// продолжил вести чужую позу по старому входу и записал +$1.94 вместо −$0.58.
// Теперь такой отказ = сигнал синхронизировать БД по fills.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { isPositionGoneRejection } = await import('../src/modules/executor/close.js');

test('reduce-only на флэте (текст HL) → позы нет', () => {
  assert.equal(
    isPositionGoneRejection('Reduce only order would increase position. asset=185'),
    true,
  );
});

test('No position found → позы нет', () => {
  assert.equal(isPositionGoneRejection('No position found for coin KAITO'), true);
});

test('прочие отказы биржи не трогаем', () => {
  assert.equal(isPositionGoneRejection('Insufficient margin to place order'), false);
  assert.equal(isPositionGoneRejection('Order price cannot be more than 80% away from oracle'), false);
  assert.equal(isPositionGoneRejection('Post only order would have immediately matched'), false);
});

test('пустой/невалидный вход → false', () => {
  assert.equal(isPositionGoneRejection(null), false);
  assert.equal(isPositionGoneRejection(undefined), false);
  assert.equal(isPositionGoneRejection(''), false);
});
