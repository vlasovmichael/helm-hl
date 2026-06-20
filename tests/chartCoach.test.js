import { test } from 'node:test';
import assert from 'node:assert';
import { rsi, findLevels, analyzeChart } from '../src/modules/chartCoach.js';

// Хелпер: свеча из close (high/low вокруг close).
const c = (close, spread = close * 0.005) => ({
  open: close, close, high: close + spread, low: close - spread, time: 0,
});

test('rsi: монотонный рост → высокий, монотонное падение → низкий', () => {
  const up = Array.from({ length: 20 }, (_, i) => 100 + i);
  const down = Array.from({ length: 20 }, (_, i) => 100 - i);
  assert.ok(rsi(up, 14) > 95, 'рост → RSI ~100');
  assert.ok(rsi(down, 14) < 5, 'падение → RSI ~0');
  assert.strictEqual(rsi([1, 2, 3], 14), null, 'мало данных → null');
});

test('findLevels: находит ближайшие поддержку/сопротивление вокруг цены', () => {
  // Пила: пивот-лоу ~90, пивот-хай ~110, цена 100.
  const candles = [
    c(100), c(95), c(90), c(95), c(100),   // лоу 90
    c(105), c(110), c(105),                // хай 110
    c(102), c(100),
  ];
  const { support, resistance } = findLevels(candles, 2, 100);
  assert.ok(support != null && support < 100, 'поддержка ниже цены');
  assert.ok(resistance != null && resistance > 100, 'сопротивление выше цены');
});

test('analyzeChart: мало данных → ok:false', () => {
  const out = analyzeChart({ candles15m: [c(100)], candles1h: [], price: 100 });
  assert.strictEqual(out.ok, false);
});

test('analyzeChart: LONG по аптренду от поддержки → reasonable', () => {
  // 1h аптренд: плавный рост 60 свечей.
  const candles1h = Array.from({ length: 60 }, (_, i) => c(80 + i * 0.5));
  // 15m: аптренд, текущая цена у недавнего пивот-лоу (откат к поддержке).
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 + i * 0.3);
  // финальный откат к поддержке
  closes.push(112, 110.5, 110.2);
  const candles15m = closes.map((x) => c(x));
  const price = 110.2;
  const out = analyzeChart({ candles15m, candles1h, price, userSide: 'LONG' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.htfTrend, 'up');
  assert.ok(out.plan, 'есть план');
  assert.ok(['reasonable', 'counter', 'neutral'].includes(out.verdict.tone));
  assert.ok(out.bull.length > 0, 'есть бычьи аргументы');
});

test('analyzeChart: LONG против явного даунтренда без уровня → knife', () => {
  const candles1h = Array.from({ length: 60 }, (_, i) => c(140 - i * 0.6)); // даунтренд
  const candles15m = Array.from({ length: 40 }, (_, i) => c(120 - i * 0.5)); // падение
  const price = candles15m.at(-1).close;
  const out = analyzeChart({ candles15m, candles1h, price, userSide: 'LONG' });
  assert.strictEqual(out.htfTrend, 'down');
  assert.strictEqual(out.verdict.tone, 'knife');
});

test('analyzeChart: план содержит стоп/цель/RR и инвалидацию', () => {
  const candles1h = Array.from({ length: 60 }, (_, i) => c(80 + i * 0.5));
  const candles15m = Array.from({ length: 45 }, (_, i) => c(100 + Math.sin(i / 3) * 3 + i * 0.1));
  const price = candles15m.at(-1).close;
  const out = analyzeChart({ candles15m, candles1h, price, userSide: 'SHORT' });
  assert.ok(out.plan.stop > 0, 'стоп задан');
  assert.strictEqual(out.plan.side, 'SHORT');
  assert.ok('rr' in out.plan, 'RR посчитан (или null)');
  assert.ok('invalidation' in out.plan);
});
