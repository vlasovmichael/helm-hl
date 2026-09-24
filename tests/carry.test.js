// Carry: окупаемость захеджированного фандинга и защита от чужой пары.
//
// Запуск: npm test

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PUBLIC_WALLET_ADDRESS = "0x0000000000000000000000000000000000000000";
const { buildCarryRows } = await import("../src/modules/carry.js");

const fees = { perpTaker: 4.5, perpMaker: 1.5, spotTaker: 7, spotMaker: 4 };
const perp = new Map([["BTC", { funding: 0.0000125, mark: 100 }], ["ETH", { funding: 0.0000125, mark: 100 }]]);

test("окупаемость — круг комиссий, делённый на суточный фандинг по среднему", () => {
  const spot = new Map([["@144", { mid: 100.1, dayVolUsd: 1e6 }]]);
  const history = new Map([["BTC", Array(100).fill(0.0000125)]]);
  const [r] = buildCarryRows({ perp, spot, history, fees });
  assert.equal(r.coin, "BTC");
  assert.ok(Math.abs(r.dailyBp - 3) < 1e-9);
  assert.equal(r.takerRoundTripBp, 23);
  assert.ok(Math.abs(r.breakEvenDaysTaker - 23 / 3) < 1e-9);
  assert.ok(Math.abs(r.aprNow - 10.95) < 1e-9);
  assert.ok(Math.abs(r.basisBp - 10) < 1e-6);
});

test("пара с разъехавшейся ценой не показывается", () => {
  const spot = new Map([["@155", { mid: 90, dayVolUsd: 1e6 }]]);
  assert.equal(buildCarryRows({ perp, spot, history: new Map(), fees }).length, 0);
});

test("без двух суток истории окупаемость не считается, отрицательный фандинг не окупается", () => {
  const spot = new Map([["@144", { mid: 100, dayVolUsd: 1e6 }]]);
  const short = buildCarryRows({ perp, spot, history: new Map([["BTC", Array(10).fill(0.0000125)]]), fees })[0];
  assert.equal(short.dailyBp, null);
  assert.equal(short.breakEvenDaysTaker, null);
  const neg = buildCarryRows({ perp, spot, history: new Map([["BTC", Array(60).fill(-0.00001)]]), fees })[0];
  assert.equal(neg.breakEvenDaysTaker, null);
});
