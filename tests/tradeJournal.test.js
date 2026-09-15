import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTradeJournal,
  enrichTrades,
  notionalOf,
  sessionOf,
  summarize,
  trendAlignment,
} from "../src/modules/tradeJournal.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 3, 9, 0);

function trade(overrides = {}) {
  return {
    coin: "SOL",
    side: "long",
    entry_time: T0,
    closed_at: T0 + 10 * MIN,
    realized_pnl: 1,
    fee_paid: 0.05,
    mfe_usd: 2,
    mfe_pct: 2,
    ...overrides,
  };
}

test("сессия берётся по UTC-часу входа", () => {
  assert.equal(sessionOf(Date.UTC(2026, 0, 1, 6, 59)), "asia");
  assert.equal(sessionOf(Date.UTC(2026, 0, 1, 7, 0)), "europe");
  assert.equal(sessionOf(Date.UTC(2026, 0, 1, 14, 30)), "us");
  assert.equal(sessionOf(Date.UTC(2026, 0, 1, 23, 0)), "late");
});

test("номинал восстанавливается из MFE, а прямое поле важнее", () => {
  assert.equal(notionalOf(trade()), 100);
  assert.equal(notionalOf(trade({ size_usd: 40 })), 40);
  assert.equal(notionalOf({ mfe_usd: null, mae_usd: null }), null);
});

test("тренд 1h считается относительно стороны сделки", () => {
  assert.equal(trendAlignment(trade({ entry_trend_1h_pct: 1 })), "with");
  assert.equal(trendAlignment(trade({ side: "short", entry_trend_1h_pct: 1 })), "against");
  assert.equal(trendAlignment(trade({ entry_trend_1h_pct: 0.1 })), "flat");
  assert.equal(trendAlignment(trade({ entry_trend_1h_pct: null })), "unknown");
});

test("отыгрыш: вход в течение 30 минут после убыточного закрытия", () => {
  const [first, second, third] = enrichTrades([
    trade({ realized_pnl: -1, mfe_pct: 0.5, closed_at: T0 + 5 * MIN }),
    trade({ entry_time: T0 + 20 * MIN, closed_at: T0 + 40 * MIN }),
    trade({ entry_time: T0 + 90 * MIN, closed_at: T0 + 100 * MIN }),
  ]);
  assert.deepEqual(first.flags, []);
  assert.deepEqual(second.flags, ["revenge"]);
  assert.deepEqual(third.flags, []);
});

test("шестая сделка дня и погоня — метки входа, отданный плюс — заметка об исходе", () => {
  const rows = Array.from({ length: 6 }, (_, i) => trade({ entry_time: T0 + i * 60 * MIN, closed_at: T0 + i * 60 * MIN + MIN }));
  rows[5] = { ...rows[5], entry_trend_15m_pct: 4, realized_pnl: -0.5, mfe_pct: 1.5 };
  const enriched = enrichTrades(rows);
  assert.deepEqual(enriched[4].flags, []);
  assert.deepEqual(enriched[5].flags, ["overtrading", "chased"]);
  assert.deepEqual(enriched[5].notes, ["gaveBack"]);
});

test("заметка об исходе не попадает ни в разрез, ни в сравнение помеченных и чистых", () => {
  const journal = buildTradeJournal([trade({ realized_pnl: -1, mfe_pct: 3 })], { now: T0 + MIN });
  assert.equal(journal.overall.clean.n, 1);
  assert.equal(journal.overall.flagged.n, 0);
  assert.ok(!journal.breakdowns.flags.some((row) => row.key === "gaveBack"));
});

test("сводка без пяти дней не выдумывает CI", () => {
  const result = summarize(enrichTrades([trade(), trade({ realized_pnl: -3 })]));
  assert.equal(result.n, 2);
  assert.equal(result.net, -2);
  assert.equal(result.winPct, 50);
  assert.equal(result.ci95, null);
});

test("фильтр по монете: метки считаются по всем сделкам, в ответе только эта монета", () => {
  const rows = [
    trade({ coin: "ETH", realized_pnl: -1, mfe_pct: 0.5, closed_at: T0 + 5 * MIN }),
    trade({ coin: "sol", entry_time: T0 + 20 * MIN, closed_at: T0 + 40 * MIN }),
  ];
  const journal = buildTradeJournal(rows, { now: T0 + 60 * MIN, coin: "SOL" });
  assert.equal(journal.coin, "SOL");
  assert.equal(journal.overall.n, 1);
  assert.deepEqual(journal.trades[0].flags, ["revenge"]);
  assert.equal(buildTradeJournal(rows, { coin: "BTC" }).empty, true);
});

test("журнал: неделя считается от asOf, пустой вход — пустой ответ", () => {
  const day = 86_400_000;
  const rows = [trade({ closed_at: T0 }), trade({ entry_time: T0 - 9 * day, closed_at: T0 - 9 * day })];
  const journal = buildTradeJournal(rows, { now: T0 + day });
  assert.equal(journal.week.current.n, 1);
  assert.equal(journal.week.previous.n, 1);
  assert.equal(journal.trades[0].closedAt, T0);
  assert.equal(journal.breakdowns.flags[0].key, "clean");
  assert.equal(buildTradeJournal([]).empty, true);
});
