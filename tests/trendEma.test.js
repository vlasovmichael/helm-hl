import { test } from 'node:test';
import assert from 'node:assert/strict';

const { emaSeries, classifyTrend } = await import('../src/modules/trendEma.js');
const params = { fast: 2, slow: 3, slopeLookback: 1 };
const candles = (values) => values.map((close) => ({ close }));

test('EMA: невалидные и короткие серии, SMA seed и последующее сглаживание', () => {
  assert.deepEqual(emaSeries(null, 3), []);
  assert.deepEqual(emaSeries([1, 2], 0), []);
  assert.deepEqual(emaSeries([1, 2], 3), [null, null]);
  assert.deepEqual(emaSeries([1, 2, 3], 3), [null, null, 2]);
  assert.deepEqual(emaSeries([1, 2, 3, 4], 3), [null, null, 2, 3]);
  assert.deepEqual(emaSeries([2, 4, 8], 2), [null, 3, 19 / 3]);
});

test('trend EMA: не подменяет отсутствующую EMA и не принимает равенства за тренд', () => {
  const missingFast = classifyTrend(candles([1, 2, 3]), 4, { fast: 0, slow: 2, slopeLookback: 1 });
  assert.deepEqual(missingFast, { trend: 'none', emaFast: null, emaSlow: 2.5, slope: null, reason: 'insufficient_1h_history' });
  assert.equal(classifyTrend(candles([2, 2, 2, 2]), 2, params).trend, 'none');
  assert.equal(classifyTrend(candles([1, 2, 3, 4]), 3.5, params).trend, 'none');
  assert.equal(classifyTrend(candles([4, 3, 2, 1]), 1.5, params).trend, 'none');
});

test('trend EMA: все четыре условия направления обязательны', () => {
  assert.equal(classifyTrend(candles([1, 2, 3, 4]), 0, params).trend, 'none');
  assert.equal(classifyTrend(candles([4, 3, 2, 1]), 5, params).trend, 'none');
});

test('trend EMA: недостаток истории возвращает явную причину', () => {
  const expected = { trend: 'none', emaFast: null, emaSlow: null, slope: null, reason: 'insufficient_1h_history' };
  assert.deepEqual(classifyTrend(null, 1, params), expected);
  assert.deepEqual(classifyTrend(candles([1, 2, 3]), 4, params), expected);
});

test('trend EMA: различает растущий, падающий и нейтральный тренд', () => {
  const up = classifyTrend(candles([1, 2, 3, 4]), 5, params);
  assert.deepEqual(up, { trend: 'up', emaFast: 3.5, emaSlow: 3, slope: 1, reason: 'trend_up' });
  const down = classifyTrend(candles([4, 3, 2, 1]), 0.5, params);
  assert.deepEqual(down, { trend: 'down', emaFast: 1.5, emaSlow: 2, slope: -1, reason: 'trend_down' });
  const flat = classifyTrend(candles([1, 2, 3, 4]), 3, params);
  assert.equal(flat.trend, 'none');
  assert.equal(flat.reason, 'no_trend');
});
