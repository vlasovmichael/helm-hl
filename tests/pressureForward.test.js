import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';

import {
  PRESSURE_FORWARD,
  advancePressureForward,
  buildPressureSignal,
  fadeReturnBp,
  installPressureForward,
} from '../tools/pressureForward.mjs';

// Реестр живёт в приватной лаборатории: без её рабочей копии сверка пропускается.
const REGISTRY = 'data/hypotheses/registry.json';

test('замороженные параметры совпадают с предзаявкой', { skip: !existsSync(REGISTRY) && 'нет реестра лаборатории' }, () => {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const hypothesis = registry.hypotheses.find((row) => row.id === PRESSURE_FORWARD.id);
  assert.ok(hypothesis);
  assert.ok(Object.isFrozen(PRESSURE_FORWARD));
  assert.deepEqual(hypothesis.parameters, {
    barMin: 5,
    startsAt: new Date(PRESSURE_FORWARD.startsAt).toISOString(),
    shockBars: PRESSURE_FORWARD.shockBars,
    confirmBars: PRESSURE_FORWARD.confirmBars,
    outcomeBars: PRESSURE_FORWARD.outcomeBars,
    cooldownBars: PRESSURE_FORWARD.cooldownBars,
    minShockPct: PRESSURE_FORWARD.minShockPct,
    minShockImbalance: PRESSURE_FORWARD.minShockImbalance,
    maxExhaustedImbalance: PRESSURE_FORWARD.maxExhaustedImbalance,
    minPersistentImbalance: PRESSURE_FORWARD.minPersistentImbalance,
    minShockUsd: PRESSURE_FORWARD.minShockUsd,
    economicBp: PRESSURE_FORWARD.economicBp,
  });
});

const bar = (id, o, c, buy, sell, closed = 1) => ({
  bar: id, o, h: Math.max(o, c), l: Math.min(o, c), c,
  volume: buy + sell, tbuy: buy, tsell: sell, fills: 10, closed,
});

function risingWindow(confirmBuy, confirmSell) {
  return [
    bar(100, 100, 100.3, 45_000, 5_000),
    bar(101, 100.3, 100.6, 45_000, 5_000),
    bar(102, 100.6, 101, 45_000, 5_000),
    bar(103, 101, 101.3, 45_000, 5_000),
    bar(104, 101.3, 101.6, 45_000, 5_000),
    bar(105, 101.6, 102, 45_000, 5_000),
    bar(106, 102, 102.1, confirmBuy, confirmSell),
    bar(107, 102.1, 102.2, confirmBuy, confirmSell),
  ];
}

test('направленный шок делится на иссякшее и продолжающееся давление', () => {
  const exhausted = buildPressureSignal(risingWindow(10_000, 40_000));
  assert.equal(exhausted.cohort, 'exhausted');
  assert.equal(exhausted.side, 'SHORT');

  const persistent = buildPressureSignal(risingWindow(40_000, 10_000));
  assert.equal(persistent.cohort, 'persistent');
  assert.equal(persistent.side, 'SHORT');

  assert.equal(buildPressureSignal(risingWindow(30_000, 20_000)), null);
});

test('разрыв временного ряда и слабый шок не создают сигнал', () => {
  const gap = risingWindow(10_000, 40_000);
  gap[4] = { ...gap[4], bar: 110 };
  assert.equal(buildPressureSignal(gap), null);

  const weak = risingWindow(10_000, 40_000).map((row) => ({ ...row, o: 100, h: 100.1, l: 100, c: 100.1 }));
  assert.equal(buildPressureSignal(weak), null);
});

test('доходность возврата имеет правильный знак для обеих сторон', () => {
  assert.ok(Math.abs(fadeReturnBp('SHORT', 102, 100) - 196.0784313725494) < 1e-9);
  assert.ok(Math.abs(fadeReturnBp('LONG', 100, 102) - 200) < 1e-9);
});

test('состояние проходит сигнал, вход и фиксированный часовой выход', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE coins (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL)');
  db.prepare('INSERT INTO coins (id, name) VALUES (1, ?)').run('ALT');
  installPressureForward(db);

  const insert = db.prepare(`
    INSERT INTO market_bars
      (bar, coin, o, h, l, c, volume, tbuy, tsell, fills, closed)
    VALUES (@bar, 1, @o, @h, @l, @c, @volume, @tbuy, @tsell, @fills, @closed)`);
  for (const row of risingWindow(10_000, 40_000)) insert.run(row);

  const params = { ...PRESSURE_FORWARD, startsAt: 0 };
  assert.deepEqual(advancePressureForward(db, 107, params), {
    added: 1, resolved: 0, invalidated: 0,
  });
  assert.equal(db.prepare('SELECT status FROM pressure_events').get().status, 'entry_pending');

  insert.run(bar(108, 102, 101.8, 20_000, 20_000));
  advancePressureForward(db, 108, params);
  assert.equal(db.prepare('SELECT status FROM pressure_events').get().status, 'outcome_pending');

  insert.run(bar(120, 101, 100, 20_000, 20_000));
  const done = advancePressureForward(db, 120, params);
  const event = db.prepare('SELECT status, entry_px, exit_px, fade_bp FROM pressure_events').get();
  assert.equal(done.resolved, 1);
  assert.equal(event.status, 'resolved');
  assert.equal(event.entry_px, 102);
  assert.equal(event.exit_px, 100);
  assert.ok(Math.abs(event.fade_bp - 196.0784313725494) < 1e-9);
  db.close();
});

test('незакрытый последний бар не имеет права породить сигнал', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE coins (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL)');
  db.prepare('INSERT INTO coins (id, name) VALUES (1, ?)').run('ALT');
  installPressureForward(db);
  const insert = db.prepare(`
    INSERT INTO market_bars
      (bar, coin, o, h, l, c, volume, tbuy, tsell, fills, closed)
    VALUES (@bar, 1, @o, @h, @l, @c, @volume, @tbuy, @tsell, @fills, @closed)`);
  const rows = risingWindow(10_000, 40_000);
  rows[rows.length - 1].closed = 0;
  for (const row of rows) insert.run(row);

  const result = advancePressureForward(db, 107, { ...PRESSURE_FORWARD, startsAt: 0 });
  assert.equal(result.added, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pressure_events').get().n, 0);
  db.close();
});

test('неполный бар в середине окна рвёт его, а не проходит незаметно', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE coins (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL)');
  db.prepare('INSERT INTO coins (id, name) VALUES (1, ?)').run('ALT');
  installPressureForward(db);
  const insert = db.prepare(`
    INSERT INTO market_bars
      (bar, coin, o, h, l, c, volume, tbuy, tsell, fills, closed)
    VALUES (@bar, 1, @o, @h, @l, @c, @volume, @tbuy, @tsell, @fills, @closed)`);
  const rows = risingWindow(10_000, 40_000);
  rows[3].closed = 0;
  for (const row of rows) insert.run(row);

  const result = advancePressureForward(db, 107, { ...PRESSURE_FORWARD, startsAt: 0 });
  assert.equal(result.added, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pressure_events').get().n, 0);
  db.close();
});
