// ─────────────────────────────────────────────────
//  FVG-будильник: склейка свечей и ритм полного обхода
// ─────────────────────────────────────────────────
// Закрываем два места, где ошибка была бы тихой: свежий хвост из HL обязан
// перекрывать историю из базы (иначе будильник смотрит на устаревший бар и
// молчит), а полный обход вселенной обязан случаться ровно на смене 4h бара
// (чаще — лишние запросы под весовым лимитом, реже — новые зоны не находятся).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { mergeBars, isNewHtfBucket } = await import('../src/modules/fvgAlerts.js');

const H4 = 4 * 3600_000;

test('свежая свеча перекрывает ту же метку времени из базы', () => {
  const db = [{ t: 100, o: 1, h: 2, l: 0.5, c: 1.5 }];
  const fresh = [{ time: 100, open: 1, high: 9, low: 0.1, close: 8 }];
  const merged = mergeBars(db, fresh);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].h, 9, 'высота обязана прийти из свежей свечи');
  assert.equal(merged[0].c, 8);
});

test('склейка достраивает хвост и держит порядок по времени', () => {
  const db = [{ t: 200, o: 1, h: 1, l: 1, c: 1 }, { t: 100, o: 1, h: 1, l: 1, c: 1 }];
  const fresh = [{ time: 300, open: 2, high: 2, low: 2, close: 2 }];
  const merged = mergeBars(db, fresh);
  assert.deepEqual(merged.map((b) => b.t), [100, 200, 300]);
});

test('пустой хвост не ломает историю', () => {
  const db = [{ t: 100, o: 1, h: 1, l: 1, c: 1 }];
  assert.deepEqual(mergeBars(db, null).map((b) => b.t), [100]);
  assert.deepEqual(mergeBars(db, []).map((b) => b.t), [100]);
});

test('битую свежую свечу без времени выбрасываем', () => {
  const merged = mergeBars([], [{ open: 1, high: 1, low: 1, close: 1 }]);
  assert.deepEqual(merged, []);
});

test('первый проход всегда полный', () => {
  assert.equal(isNewHtfBucket(0, Date.now()), true);
});

test('внутри одного 4h бара полного обхода нет', () => {
  const base = Math.floor(Date.now() / H4) * H4;
  assert.equal(isNewHtfBucket(base + 60_000, base + 2 * 3600_000), false);
});

test('на смене 4h бара обход нужен', () => {
  const base = Math.floor(Date.now() / H4) * H4;
  assert.equal(isNewHtfBucket(base - 60_000, base + 60_000), true);
});
