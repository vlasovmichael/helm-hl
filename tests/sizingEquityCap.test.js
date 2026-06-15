// equityCappedNotional: сайзинг «доля депо с потолком по свободной марже».
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { equityCappedNotional } = await import('../src/modules/executor/sizing.js');

const UTIL = 0.5;
const LEV = 2;
const SAFETY = 0.97;

test('нет других позиций (free=equity): нотионал = equity×util×lev (как старый free-based)', () => {
  // depo $50, ничего не открыто → free=50, equity=50
  const n = equityCappedNotional(50, 50, UTIL, LEV);
  assert.equal(n, 50); // 50×0.5×2 = 50; потолок free×0.97×2=97 не бьёт
});

test('поза открыта, свободного хватает: бот берёт полную «половину депо», не ужимается', () => {
  // depo $50, занято $10 маржи → free=40. Желаемая маржа = 50×0.5 = 25 < free 40.
  const n = equityCappedNotional(40, 50, UTIL, LEV);
  assert.equal(n, 50); // 25 маржи × 2 = 50 (не зависит от того, что free упал до 40)
});

test('поза открыта, свободного мало: режется по свободной марже (с буфером)', () => {
  // depo $50, занято $38 → free=12. Желаемая маржа 25 > free. Берём free×0.97.
  const n = equityCappedNotional(12, 50, UTIL, LEV);
  assert.ok(Math.abs(n - 12 * SAFETY * LEV) < 1e-9, `got ${n}`); // 12×0.97×2 = 23.28
});

test('нет свободной маржи → 0', () => {
  assert.equal(equityCappedNotional(0, 50, UTIL, LEV), 0);
});

test('старый free-based и новый совпадают, когда free=equity (для любого util)', () => {
  for (const util of [0.3, 0.5, 0.7]) {
    const oldFreeBased = 50 * LEV * util; // capBase(free×lev) × capUtil(util)
    const neu = equityCappedNotional(50, 50, util, LEV);
    assert.ok(Math.abs(oldFreeBased - neu) < 1e-9, `util=${util}: ${oldFreeBased} vs ${neu}`);
  }
});
