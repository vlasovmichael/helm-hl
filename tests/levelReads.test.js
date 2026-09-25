// Разбор страницы уровней: тонкие коридоры, связь с BTC, пробой и журнал исходов.
//
// Запуск: npm test

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PUBLIC_WALLET_ADDRESS = "0x0000000000000000000000000000000000000000";

const { thinCorridors, btcLink } = await import("../src/modules/dashboard/routes/levels.js");
const { breakPlan, closesBeyond, readPrice, marketRead } = await import(
  "../src/modules/dashboard/web/src/features/levelPlan.js"
);
const { oiMode, oiRead } = await import("../src/modules/dashboard/routes/levelsOi.js");
const { simulate, placeboFor, scenariosOf, summarize, groupOf } = await import("../src/modules/levelReads.js");

const zone = (price, w = 0.5) => ({ price, lo: price - w, hi: price + w, sources: ["swing"], touches: 3, strength: 3 });
const bar = (close, high = close, low = close) => ({ open: close, high, low, close });
const market = (price, zones, closes = [price, price], thin = []) => ({
  price,
  atr: 2,
  zones,
  thin,
  candles: closes.map((c) => bar(c)),
});

test("thinCorridors: провал между двумя полками — коридор, края профиля — нет", () => {
  const vols = [1, 1, 10, 10, 10, 1, 1, 1, 1, 10, 10, 10, 1, 1];
  const bins = vols.map((vol, i) => ({ price: 100 + i, vol }));
  const out = thinCorridors(bins, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].lo, 104.5);
  assert.equal(out[0].hi, 108.5);
});

test("thinCorridors: провал меряется от соседних полок, а не от среднего по профилю", () => {
  const vols = [0.2, 1.5, 2.5, 1.2, 0.7, 0.6, 0.5, 0.6, 0.7, 1.1, 1.4, 1.2, 0.2];
  const out = thinCorridors(vols.map((vol, i) => ({ price: i, vol })), 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].lo, 4.5);
  assert.equal(out[0].hi, 7.5);
});

test("thinCorridors: провал уже трёх бинов — шум, не коридор", () => {
  const vols = [10, 10, 10, 1, 10, 10, 10, 10];
  assert.equal(thinCorridors(vols.map((vol, i) => ({ price: i, vol })), 1).length, 0);
});

test("btcLink: монета ходит как BTC с плечом 2 — бета 2, корреляция 1", () => {
  const btc = [];
  const coin = [];
  let b = 100;
  let c = 10;
  for (let i = 0; i < 40; i++) {
    const r = (i % 3 === 0 ? 1 : -1) * 0.01 * ((i % 5) + 1);
    b *= 1 + r;
    c *= 1 + 2 * r;
    btc.push({ time: i, close: b });
    coin.push({ time: i, close: c });
  }
  const link = btcLink(coin, btc, [["1h", 4]]);
  assert.ok(Math.abs(link.corr - 1) < 1e-9);
  assert.ok(Math.abs(link.beta - 2) < 1e-9);
  assert.equal(link.windows[0].label, "1h");
});

test("closesBeyond: живой бар не в счёт", () => {
  const candles = [bar(9), bar(11), bar(12), bar(8)];
  assert.equal(closesBeyond(candles, 10, "long"), 2);
});

test("breakPlan: до двух закрытий — ждать триггер, после — вход по рынку", () => {
  const r1 = zone(105);
  const r2 = zone(115);
  const waiting = breakPlan(market(103, [r1, r2]), r1, "long");
  assert.equal(waiting.accepted, false);
  assert.equal(waiting.entry, 105.5);
  assert.equal(waiting.stop, 104.5 - 0.5);
  assert.equal(waiting.target, 114.5);

  const broke = breakPlan(market(106.5, [r1, r2], [104, 106, 106.2, 106.5]), r1, "long");
  assert.equal(broke.accepted, true);
  assert.equal(broke.atMarket, true);
  assert.equal(broke.entry, 106.5);
});

test("breakPlan: путь к цели через тонкий объём помечается", () => {
  const r1 = zone(105);
  const r2 = zone(115);
  const p = breakPlan(market(103, [r1, r2], [103, 103], [{ lo: 106, hi: 113 }]), r1, "long");
  assert.ok(p.thin);
});

test("readPrice: свежепробитая зона под ценой остаётся зоной пробоя", () => {
  const z = zone(105);
  const r2 = zone(115);
  const read = readPrice(market(106.5, [z, r2], [104, 106, 106.2, 106.5]));
  assert.equal(read.breakUp.stopZone, z);
  assert.equal(read.breakUp.accepted, true);
});

test("marketRead: ход целиком объясняется бетой — ход рыночный", () => {
  const ctx = { corr: 0.8, beta: 2, windows: [{ label: "4h", coin: 2, btc: 1 }] };
  assert.equal(marketRead(ctx).market, true);
  assert.equal(marketRead({ ...ctx, windows: [{ label: "4h", coin: 5, btc: 0.5 }] }).market, false);
});

test("simulate: пробой срабатывает на втором закрытии, стоп и цель в одном баре — стоп", () => {
  const sc = { kind: "break", side: "long", trigger: 100, entry: 100, stop: 98, target: 110 };
  const bars = [bar(101), bar(102), bar(105, 111, 97)];
  const o = simulate(sc, bars, 16);
  assert.equal(o.triggered, true);
  assert.equal(o.how, "stop");
  assert.equal(o.entry, 102);
});

test("simulate: отскок заполняется касанием, цель — после", () => {
  const sc = { kind: "bounce", side: "long", entry: 100, stop: 98, target: 104 };
  const bars = [bar(101, 102, 101), bar(100.5, 101, 99.5), bar(104, 104.5, 101)];
  const o = simulate(sc, bars, 16);
  assert.equal(o.how, "target");
  assert.ok(o.r > 1.9 && o.r < 2);
});

test("simulate: триггер не сработал — исхода нет", () => {
  const sc = { kind: "break", side: "short", trigger: 90, entry: 90, stop: 92, target: 80 };
  assert.equal(simulate(sc, [bar(95), bar(89), bar(91)], 16).triggered, false);
});

test("placeboFor: та же геометрия, другой уровень, для принятого пробоя — нет", () => {
  const real = { id: "break-up", kind: "break", side: "long", trigger: 105, entry: 105, stop: 103, target: 115 };
  const p = placeboFor(real, 100, () => 0);
  assert.equal(p.trigger, 102.5);
  assert.equal(p.stop, 100.5);
  assert.equal(p.target, 112.5);
  assert.equal(p.placebo, true);
  assert.equal(placeboFor({ ...real, accepted: true }, 100), null);
});

test("scenariosOf и summarize: группы считаются по исходам за сутки", () => {
  const data = { ...market(100, [zone(95), zone(105), zone(115), zone(85)]), coin: "X", tf: "15m" };
  const scs = scenariosOf(data, () => 0.5);
  assert.ok(scs.some((s) => groupOf(s) === "placebo"));
  const up = scs.find((s) => s.id === "break-up");
  const outcome = { [up.id]: { h4: { triggered: true, how: "target", r: 2 }, h24: { triggered: true, how: "target", r: 2 } } };
  const sum = summarize([{ scenarios: JSON.stringify(scs), outcome: JSON.stringify(outcome) }]);
  assert.equal(sum.break.h24.triggered, 1);
  assert.equal(sum.break.h24.avgR, 2);
});

test("oiMode: знак цены и знак OI дают режим, мелкий ход OI — без изменений", () => {
  assert.equal(oiMode(5, -2.5), "short-covering");
  assert.equal(oiMode(5, 3), "new-longs");
  assert.equal(oiMode(-4, 2), "new-shorts");
  assert.equal(oiMode(-4, -2), "long-exit");
  assert.equal(oiMode(5, 0.2), "flat");
  assert.equal(oiMode(0.1, 2), "build");
});

test("oiRead: ход считается от ближайшего снимка к началу окна, далёкий снимок не годится", () => {
  const H = 3_600_000;
  const at = 10 * H;
  const rows = [
    { t: at - 4 * H, d: { NIL: { oi: 100, px: 0.1 } } },
    { t: at - H - 5 * 60_000, d: { NIL: { oi: 120, px: 0.11 } } },
  ];
  const r = oiRead("NIL", { oi: 116.4, px: 0.121 }, rows, [["1h", H], ["4h", 4 * H], ["24h", 24 * H]], at);
  assert.ok(Math.abs(r.windows[0].oiPct + 3) < 1e-9);
  assert.equal(r.windows[0].mode, "short-covering");
  assert.ok(Math.abs(r.windows[1].oiPct - 16.4) < 1e-9);
  assert.equal(r.windows[2].oiPct, null);
});
