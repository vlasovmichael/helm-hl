// Издержки исполнения: разбор филла, проскальзывание триггера, сводка.
//
// Why: 97% филлов уходят тейкером по 5.2–5.8 бп там, где мейкер стоит 1.44 бп,
// и комиссии больше всего минуса. Это главная статья, а не побочная метрика,
// поэтому её арифметика закрыта тестами.
//
// Запуск: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { classifyFill, splitCoin, alertLagFor, summarizeCosts } =
  await import('../src/modules/execCosts.js');

// Настоящий филл с биржи (DASH, вход мейкером).
const MAKER_OPEN = {
  tid: 1, time: 1788538325278, coin: 'DASH', dir: 'Open Short',
  px: 67.992, sz: '0.15', fee: '0.001468', crossed: false, side: 'A', oid: 5,
};
// Он же на выходе, тейкером и по стопу.
const TAKER_CLOSE = {
  tid: 2, time: 1788632374626, coin: 'DASH', dir: 'Close Short',
  px: 66.888, sz: '0.15', fee: '0.004334', crossed: true, side: 'B', oid: 6,
};

test('комиссия переводится в базисные пункты от нотионала', () => {
  const r = classifyFill(MAKER_OPEN);
  assert.equal(r.crossed, 0);
  assert.equal(r.is_open, 1);
  assert.ok(Math.abs(r.notional - 10.1988) < 1e-6);
  assert.ok(Math.abs(r.fee_bp - 1.4394) < 0.01, `получили ${r.fee_bp}`);
});

test('тейкерский выход стоит втрое дороже — это и есть измеряемая разница', () => {
  const maker = classifyFill(MAKER_OPEN);
  const taker = classifyFill(TAKER_CLOSE);
  assert.equal(taker.crossed, 1);
  assert.ok(taker.fee_bp > 3 * maker.fee_bp);
});

// 🚨 Проскальзывание триггера: ордер стоял на 66.8259, налился по 66.888.
// Для шорта это ХУЖЕ нас, знак должен быть положительным.
test('проскальзывание стопа считается со знаком «хуже для нас»', () => {
  const r = classifyFill(TAKER_CLOSE, { plannedSl: 66.8259 });
  assert.ok(r.slip_bp > 0, 'филл хуже плана → положительное');
  assert.ok(Math.abs(r.slip_bp - 9.29) < 0.1, `получили ${r.slip_bp}`);
});

test('на закрытии лонга знак зеркальный', () => {
  const r = classifyFill(
    { ...TAKER_CLOSE, dir: 'Close Long', px: 99 },
    { plannedSl: 100 },
  );
  assert.ok(r.slip_bp > 0); // продали ниже плана — хуже нас
});

test('без планового стопа проскальзывание не выдумывается', () => {
  assert.equal(classifyFill(TAKER_CLOSE).slip_bp, null);
  // На открытии триггера нет вовсе.
  assert.equal(classifyFill(MAKER_OPEN, { plannedSl: 60 }).slip_bp, null);
});

test('монета builder-DEX разбирается на площадку и тикер', () => {
  assert.deepEqual(splitCoin('xyz:GOLD'), { coin: 'GOLD', dex: 'xyz' });
  assert.deepEqual(splitCoin('BTC'), { coin: 'BTC', dex: null });
  const r = classifyFill({ ...MAKER_OPEN, coin: 'xyz:GOLD' });
  assert.equal(r.coin, 'GOLD');
  assert.equal(r.dex, 'xyz');
});

test('битый филл отбрасывается, а не пишется нулями', () => {
  assert.equal(classifyFill({ tid: 1, px: 0, sz: 1, fee: 0, time: 1 }), null);
  assert.equal(classifyFill(null), null);
});

// ── задержка «пуш → сделка» ─────────────────────────────────────────────────

const NOTIFS = [
  { ts: 1000, title: 'DASH short setup', message: '' },
  { ts: 4000, title: 'BTC moved', message: '' },
];

test('берётся ближайший пуш по ТОЙ ЖЕ монете', () => {
  assert.equal(alertLagFor('DASH', 5000, NOTIFS), 4000);
  assert.equal(alertLagFor('BTC', 5000, NOTIFS), 1000);
});

test('пуш после сделки и слишком старый не считаются', () => {
  assert.equal(alertLagFor('DASH', 500, NOTIFS), null);
  assert.equal(alertLagFor('DASH', 1000 + 2 * 3600_000, NOTIFS), null);
  assert.equal(alertLagFor('SOL', 5000, NOTIFS), null);
});

// ── сводка ──────────────────────────────────────────────────────────────────

test('сводка считает долю мейкера и комиссию', () => {
  const rows = [classifyFill(MAKER_OPEN), classifyFill(TAKER_CLOSE, { plannedSl: 66.8259 })];
  const s = summarizeCosts(rows);
  assert.equal(s.n, 2);
  assert.equal(s.makerShare, 50);
  assert.equal(s.slip.n, 1);
  assert.ok(s.feeBpMaker < s.feeBpTaker);
});

test('пустая выборка не роняет сводку', () => {
  assert.deepEqual(summarizeCosts([]), { n: 0 });
});
