// Дев-превью торгового журнала без бота: отдаёт только /api/trade-journal из
// data/history_archive.json. `npm run dev:dash` проксирует /api сюда (:3010).
// «Неделя» считается от последней сделки снимка, а не от текущей даты.
// 🚨 core/database.js не импортировать: его config.js без ключа кошелька падает.
import { readFileSync } from "node:fs";
import express from "express";

import { buildTradeJournal } from "../src/modules/tradeJournal.js";

const PORT = Number(process.env.PORT || 3010);
const app = express();

app.get("/api/trade-journal", (req, res) => {
  const archive = JSON.parse(readFileSync("data/history_archive.json", "utf8"));
  const trades = archive.filter((row) => row.mode === "PRODUCTION");
  const asOf = trades.length ? Math.max(...trades.map((row) => row.closed_at)) : Date.now();
  res.json(buildTradeJournal(trades, { now: asOf, coin: req.query.coin || null }));
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`превью журнала: http://127.0.0.1:${PORT}/api/trade-journal`);
});
