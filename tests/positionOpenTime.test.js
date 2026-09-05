// Время открытия позиции из ленты филлов.
//
// Why: clearinghouseState времени открытия не отдаёт, и позиции на builder-DEX'ах
// (HIP-3) оставались без возраста — карточке было нечему тикать. Филлы и так
// читаются ради списка площадок, поэтому время берётся из них даром.
//
// Запуск: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { positionOpenTimes } = await import('../src/modules/winnersPositions.js');

const fill = (time, dir, sz, extra = {}) => ({ coin: 'xyz:GOLD', time, dir, sz, ...extra });

test('открытие с нуля даёт время первого филла', () => {
  const m = positionOpenTimes([
    fill(1000, 'Open Long', 1, { startPosition: '0' }),
    fill(2000, 'Open Long', 1),
  ]);
  assert.equal(m.get('xyz:GOLD'), 1000);
});

test('закрытие в ноль стирает время, следующее открытие ставит новое', () => {
  const m = positionOpenTimes([
    fill(1000, 'Open Long', 2, { startPosition: '0' }),
    fill(2000, 'Close Long', 2),
    fill(3000, 'Open Short', 1),
  ]);
  assert.equal(m.get('xyz:GOLD'), 3000);
});

test('полностью закрытая позиция времени не имеет', () => {
  const m = positionOpenTimes([
    fill(1000, 'Open Long', 2, { startPosition: '0' }),
    fill(2000, 'Close Long', 2),
  ]);
  assert.equal(m.get('xyz:GOLD'), null);
});

// 🚨 Якорь startPosition: без него поза, открытая ДО окна филлов, выглядела бы
// открытой на первом попавшемся доборе — то есть моложе, чем есть.
test('поза старше окна филлов честно отдаёт null, а не догадку', () => {
  const m = positionOpenTimes([
    fill(5000, 'Open Long', 1, { startPosition: '3' }),
  ]);
  assert.equal(m.get('xyz:GOLD'), null);
});

test('переворот считается открытием новой позиции', () => {
  const m = positionOpenTimes([
    fill(1000, 'Open Long', 2, { startPosition: '0' }),
    fill(4000, 'Long > Short', 3),
  ]);
  assert.equal(m.get('xyz:GOLD'), 4000);
});

test('монеты не путаются между собой', () => {
  const m = positionOpenTimes([
    { coin: 'BTC', time: 100, dir: 'Open Long', sz: 1, startPosition: '0' },
    { coin: 'xyz:GOLD', time: 200, dir: 'Open Long', sz: 1, startPosition: '0' },
  ]);
  assert.equal(m.get('BTC'), 100);
  assert.equal(m.get('xyz:GOLD'), 200);
});

test('филлы приходят в любом порядке — сортируем сами', () => {
  const m = positionOpenTimes([
    fill(3000, 'Open Long', 1),
    fill(1000, 'Open Long', 2, { startPosition: '0' }),
    fill(2000, 'Close Long', 2),
  ]);
  // 1000 открыл, 2000 закрыл в ноль, 3000 открыл заново.
  assert.equal(m.get('xyz:GOLD'), 3000);
});
