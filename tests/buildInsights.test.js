// buildInsights: чистая агрегация Insights (per-coin + daily + bySide +
// byStrategy). Срезы long/short и по стратегии добавлены под текущие стратегии
// (эдж = шорты, главный леак = payoff) — проверяем expectancy/payoff и сплиты.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { buildInsights, buildExcursion } = await import('../src/modules/dashboard/routes/pnl.js');

const T = 1_700_000_000_000;
const DAY = 86_400_000;

// coin, pnl, fee, strategy, side, entry, close
function rt(coin, pnl, strategy, side, closeOffsetDays = 0) {
  return {
    coin,
    realized_pnl: pnl,
    fee_paid: 0.05,
    strategy_id: strategy,
    side,
    entry_time: T + closeOffsetDays * DAY,
    closed_at: T + closeOffsetDays * DAY + 3600_000,
  };
}

test('перевод пустого входа — все срезы пустые, без падений', () => {
  const r = buildInsights([]);
  assert.deepEqual(r.perCoin, []);
  assert.deepEqual(r.daily, []);
  assert.deepEqual(r.bySide, []);
  assert.deepEqual(r.byStrategy, []);
});

test('bySide делит long/short и считает win% + P&L', () => {
  const combined = [
    rt('A', 2, 'bot', 'short'),
    rt('B', -1, 'bot', 'short'),
    rt('C', 3, 'adopted', 'long'),
  ];
  const r = buildInsights(combined);
  const short = r.bySide.find((s) => s.side === 'short');
  const long = r.bySide.find((s) => s.side === 'long');
  assert.equal(short.trades, 2);
  assert.ok(Math.abs(short.pnl - 1) < 1e-9);
  assert.equal(short.winRate, 50);
  assert.equal(long.trades, 1);
  assert.ok(Math.abs(long.pnl - 3) < 1e-9);
  assert.equal(long.winRate, 100);
});

test('payoff: avgWin/avgLoss; <1 = леак', () => {
  // wins: +1, +1 (avgWin 1); loss: -4 (avgLoss -4) → payoff 0.25 (леак)
  const combined = [
    rt('A', 1, 'bot', 'short'),
    rt('B', 1, 'bot', 'short'),
    rt('C', -4, 'bot', 'short'),
  ];
  const r = buildInsights(combined);
  const short = r.bySide.find((s) => s.side === 'short');
  assert.ok(Math.abs(short.payoffRatio - 0.25) < 1e-9, 'payoff 0.25');
  assert.ok(short.expectancy < 0, 'expectancy отрицательный при леаке');
});

test('byStrategy сортируется по P&L, метки = source', () => {
  const combined = [
    rt('A', 5, 'adopted', 'short'),
    rt('B', -2, 'bot', 'short'),
    rt('C', 1, 'manual', 'long'),
  ];
  const r = buildInsights(combined);
  assert.deepEqual(r.byStrategy.map((s) => s.strategy), ['adopted', 'manual', 'bot']);
});

test('perCoin агрегирует по монете, daily — по дню закрытия', () => {
  const combined = [
    rt('A', 2, 'bot', 'short', 0),
    rt('A', -1, 'bot', 'short', 0), // тот же день
    rt('B', 4, 'bot', 'short', 1),
  ];
  const r = buildInsights(combined);
  const a = r.perCoin.find((c) => c.coin === 'A');
  assert.equal(a.trades, 2);
  assert.ok(Math.abs(a.pnl - 1) < 1e-9);
  assert.equal(r.daily.length, 2, 'два дня с торговлей');
});

// ── buildExcursion (Exit quality / MFE-MAE) ──
function hrow(coin, pnl, mfe, mae, side = 'long') {
  return {
    coin,
    side,
    strategy_id: 'adopt',
    realized_pnl: pnl,
    mfe_usd: mfe,
    mae_usd: mae,
    close_price: 1, // помечает сделку закрытой
    closed_at: T,
  };
}

test('buildExcursion: пустой / без mfe — sample 0, не падает', () => {
  assert.equal(buildExcursion([]).sample, 0);
  // строка без mfe_usd отфильтровывается
  assert.equal(buildExcursion([{ coin: 'X', exit_price: 1 }]).sample, 0);
});

test('buildExcursion: capture = realized/MFE на winners', () => {
  // POPCAT: realized 6, mfe 12 → capture 50%; heat |mae|=2
  const r = buildExcursion([hrow('POPCAT', 6, 12, -2, 'short')]);
  assert.equal(r.sample, 1);
  assert.equal(r.winners, 1);
  assert.ok(Math.abs(r.avgCapturePct - 50) < 1e-9);
  assert.ok(Math.abs(r.avgLeftOnTable - 6) < 1e-9, 'mfe-realized = 6 на столе');
  assert.ok(Math.abs(r.avgHeat - 2) < 1e-9);
});

test('buildExcursion: round-tripped = был в плюсе, закрылся в минус', () => {
  const r = buildExcursion([
    hrow('A', 5, 10, -1), // winner
    hrow('B', -1.5, 2, -3), // был +$2, закрылся -$1.5 → round-trip
    hrow('C', -0.4, 0.1, -0.5), // mfe ниже floor 0.3 → не round-trip
  ]);
  assert.equal(r.roundTripped, 1, 'только B считается round-tripped');
  assert.equal(r.winners, 1, 'только A — winner');
});
