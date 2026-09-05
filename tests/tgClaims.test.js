// Витрина канала: разбор его собственных заявлений о результате.
//
// Why: рядом с нашими фактическими сделками стоит то, что канал рисует у себя,
// и разница между колонками — весь смысл замера. Значит разбор заявлений обязан
// быть таким же строгим, как разбор сигналов.
//
// Запуск: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseClaim } from '../src/modules/tgSignals.js';

test('прибыль и убыток читаются со знаком', () => {
  assert.partialDeepStrictEqual(
    parseClaim('#BAT/USDT Take-Profit target 2 ✅ Profit: 68.2541% 📈 Period: 1 day 20 hr'),
    { coin: 'BAT', pct: 68.2541, win: true },
  );
  assert.partialDeepStrictEqual(
    parseClaim('#CRV/USDT Stop Target Hit ⛔ Loss: 132.4264% 📉'),
    { coin: 'CRV', pct: -132.4264, win: false },
  );
});

test('обратный порядок «45.5% Profit» разбирается тоже', () => {
  assert.partialDeepStrictEqual(
    parseClaim('COIN: #DOT/USDT Direction: LONG 45.5% Profit (5x)'),
    { coin: 'DOT', pct: 45.5, win: true, leverage: 5 },
  );
});

// 🚨 Проценты у каналов плечевые. Приводим к 1x только когда плечо подписано
// рядом с самим результатом — иначе сравнение превратилось бы в подгонку.
test('плечо берётся только рядом с процентом', () => {
  const stated = parseClaim('#BTR Update Target 1 ✅ Profit: 71.8% on 5x lev');
  assert.equal(stated.leverage, 5);
  assert.ok(Math.abs(stated.pctAt1x - 14.36) < 1e-9);

  // «ISOLATED 10X - 75X» — рекомендация из сигнала, а не плечо этого результата.
  const unstated = parseClaim('#SKR/USDT LEVERAGE: ISOLATED 10X - 75X\nAll targets achieved\nProfit: 270.5101%');
  assert.equal(unstated.leverage, null);
  assert.equal(unstated.pctAt1x, null);
});

test('обычная болтовня и посты без монеты заявлением не считаются', () => {
  assert.equal(parseClaim('Market looks strong today, BTC holding well'), null);
  assert.equal(parseClaim('Profit: 40% booked this month across the desk'), null);
  assert.equal(parseClaim(''), null);
});

test('нелепое плечо отбрасывается, процент остаётся', () => {
  const c = parseClaim('#ETH/USDT Profit: 20% (900x)');
  assert.equal(c.pct, 20);
  assert.equal(c.leverage, null);
});
