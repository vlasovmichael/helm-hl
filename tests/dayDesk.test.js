// ─────────────────────────────────────────────────
//  Day Desk — срез дня и соблюдение правил
// ─────────────────────────────────────────────────
// Проверяем ровно то, ради чего витрина существует: комиссии видны отдельно и
// в bp, счётчик считает СДЕЛКИ (а не филлы), и правила оцениваются по данным,
// а не по ощущению.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

// Динамический импорт: статический поднялся бы ДО присвоения env выше,
// и config упал бы на required-переменной.
const { computeDayDesk, computeAdherence, feesInBp } = await import('../src/modules/dayDesk.js');
const { localDayKey } = await import('../src/modules/dailyRisk.js');

const DAY = localDayKey(Date.now());
const at = (h) => {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return d.getTime();
};

test('feesInBp: комиссия к обороту в базисных пунктах', () => {
  assert.equal(feesInBp(1, 10_000), 1);      // $1 на $10k оборота = 1 bp
  assert.equal(feesInBp(4.32, 10_000), 4.32);
  assert.equal(feesInBp(1, 0), null);        // нет оборота — bp не определены
});

test('день: gross, комиссии и net считаются раздельно', () => {
  const fills = [
    { time: at(10), closedPnl: '2.00', fee: '0.40', px: '100', sz: '10', coin: 'BTC' },
    { time: at(12), closedPnl: '-1.00', fee: '0.30', px: '50', sz: '10', coin: 'SOL' },
  ];
  const d = computeDayDesk(fills, DAY);
  assert.equal(d.gross, 1);        // 2.00 − 1.00 до комиссий
  assert.equal(d.fees, 0.7);
  assert.equal(d.net, 0.3);        // после комиссий
  assert.equal(d.notional, 1500);  // 100×10 + 50×10
  assert.equal(d.fillCount, 2);
  assert.deepEqual(d.coins.sort(), ['BTC', 'SOL']);
});

test('день: комиссии съели весь плюс — доля от gross больше единицы', () => {
  const fills = [{ time: at(9), closedPnl: '1.00', fee: '1.50', px: '10', sz: '100' }];
  const d = computeDayDesk(fills, DAY);
  assert.equal(d.gross, 1);
  assert.equal(d.net, -0.5);            // до комиссий плюс, после — минус
  assert.equal(d.feeShareOfGross, 1.5); // ровно тот случай, ради которого метрика есть
});

test('день: филлы других дней не считаются', () => {
  const yesterday = at(10) - 86_400_000;
  const fills = [
    { time: at(10), closedPnl: '1.00', fee: '0.10', px: '10', sz: '10' },
    { time: yesterday, closedPnl: '99.00', fee: '9.00', px: '10', sz: '10' },
  ];
  assert.equal(computeDayDesk(fills, DAY).fillCount, 1);
});

test('правила: чистая книга шортов со стопами проходит все пять', () => {
  const trips = Array.from({ length: 10 }, (_, i) => ({
    coin: 'SOL', side: 'short', source: 'adopted', hadStop: true,
    closeTime: at(10) - i * 86_400_000,
  }));
  const a = computeAdherence(trips, { blacklist: new Set() });
  assert.equal(a.n, 10);
  assert.equal(a.followed, 5, 'все пять правил соблюдены');
});

test('правила: лонги и сделки без стопа ловятся', () => {
  const trips = [
    ...Array.from({ length: 6 }, () => ({ coin: 'BTC', side: 'long', source: 'manual', hadStop: false, closeTime: at(11) })),
    ...Array.from({ length: 4 }, () => ({ coin: 'BTC', side: 'short', source: 'manual', hadStop: false, closeTime: at(12) })),
  ];
  const a = computeAdherence(trips, { blacklist: new Set() });
  const byN = Object.fromEntries(a.rules.map((r) => [r.n, r]));
  assert.equal(byN[2].ok, false, 'стопов не было — правило 2 нарушено');
  assert.equal(byN[3].value, 0.6, 'доля лонгов 6 из 10');
  assert.equal(byN[3].ok, false);
  assert.equal(byN[5].ok, false, 'выходы вёл не бот');
});

test('правила: монета из чёрного списка называется поимённо', () => {
  const trips = [
    { coin: 'HMSTR', side: 'short', source: 'adopted', hadStop: true, closeTime: at(10) },
    { coin: 'SOL', side: 'short', source: 'adopted', hadStop: true, closeTime: at(11) },
  ];
  const a = computeAdherence(trips, { blacklist: new Set(['HMSTR']) });
  const rule4 = a.rules.find((r) => r.n === 4);
  assert.equal(rule4.value, 1);
  assert.equal(rule4.ok, false);
});

test('правила: пустая история не выдумывает вердиктов', () => {
  const a = computeAdherence([], {});
  assert.equal(a.n, 0);
  assert.deepEqual(a.rules, []);
});
