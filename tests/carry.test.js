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

test("строка отражает все метрики, чистит историю и сортирует по доходности", () => {
  const fullPerp = new Map([
    ["BTC", { funding: 0.00001, mark: 100 }],
    ["ETH", { funding: 0.00002, mark: 200 }],
    ["HYPE", { funding: 0.00003, mark: 50 }],
  ]);
  const spot = new Map([
    ["@144", { mid: 100, dayVolUsd: 10 }],
    ["@155", { mid: 200, dayVolUsd: 20 }],
    ["@109", { mid: 50, dayVolUsd: 30 }],
  ]);
  const history = new Map([
    ["BTC", Array(48).fill(0.00001).concat([Number.NaN])],
    ["ETH", Array(48).fill(0.00002)],
    ["HYPE", Array(48).fill(-0.00001).concat([0])],
  ]);
  const rows = buildCarryRows({ perp: fullPerp, spot, history, fees });
  assert.deepEqual(rows.map((r) => r.coin), ["ETH", "BTC", "HYPE"]);
  const r = rows[1];
  assert.equal(r.pair, "@144");
  assert.ok(Math.abs(r.aprNow - 8.76) < 1e-9);
  assert.ok(Math.abs(r.aprAvg - 8.76) < 1e-9);
  assert.equal(r.positiveShare, 1);
  assert.equal(r.hours, 48);
  assert.ok(Math.abs(r.dailyBp - 2.4) < 1e-9);
  assert.equal(r.basisBp, 0);
  assert.equal(r.spotVolUsd, 10);
  assert.equal(r.makerRoundTripBp, 11);
  assert.ok(Math.abs(r.breakEvenDaysMaker - 11 / 2.4) < 1e-9);
  assert.ok(Math.abs(r.usdPerDayPer1k - 0.24) < 1e-9);
  assert.equal(rows[2].positiveShare, 0);
  assert.equal(rows[2].breakEvenDaysMaker, null);
});

test("пустые, нулевые и погранично разъехавшиеся данные не дают ложную пару", () => {
  const base = new Map([["BTC", { funding: 0, mark: 100 }]]);
  const valid = new Map([["@144", { mid: 100.99, dayVolUsd: 0 }]]);
  assert.equal(buildCarryRows({ perp: base, spot: valid, history: new Map(), fees }).length, 1);
  assert.equal(buildCarryRows({ perp: base, spot: new Map([["@144", { mid: 0, dayVolUsd: 0 }]]), history: new Map(), fees }).length, 0);
  assert.equal(buildCarryRows({ perp: new Map([["BTC", { funding: 0, mark: 0 }]]), spot: valid, history: new Map(), fees }).length, 0);
  assert.equal(buildCarryRows({ perp: base, spot: new Map([["@144", { mid: 101.01, dayVolUsd: 0 }]]), history: new Map(), fees }).length, 0);
});

test("все замороженные пары участвуют в расчёте", () => {
  const ids = ["@144", "@155", "@109", "@160", "@198", "@288"];
  const coins = ["BTC", "ETH", "HYPE", "SOL", "PUMP", "ZEC"];
  const allPerp = new Map(coins.map((coin, i) => [coin, { funding: i + 1, mark: 100 + i }]));
  const allSpot = new Map(ids.map((id, i) => [id, { mid: 100 + i, dayVolUsd: i }]));
  assert.deepEqual(buildCarryRows({ perp: allPerp, spot: allSpot, history: new Map(), fees }).map((r) => r.coin), coins);
});
