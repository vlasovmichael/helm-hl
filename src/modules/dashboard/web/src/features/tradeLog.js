// ─────────────────────────────────────────────────
//  Вкладка Trade log на /journal: журнал сделок, всё из закрытых сделок,
//  ручного ввода нет. Данные — /api/trade-journal (src/modules/tradeJournal.js).
//  Фильтр по монете — параметр ?coin= в адресе, общий с Chart drill.
// ─────────────────────────────────────────────────

import { fetchJson } from "../net/api.js";
import { badge, chip, segmented, stat } from "../core/ui.js";
import { emptyRow, emptyState, skeletonRows, skeletonText } from "../core/placeholders.js";
import { escapeHtml, fmtMoney } from "../utils/format.js";

const DIMENSIONS = [
  { value: "session", label: "Session" },
  { value: "side", label: "Side" },
  { value: "trend", label: "1h trend" },
  { value: "hold", label: "Hold" },
  { value: "flags", label: "Flags" },
];
const SESSION_LABELS = { asia: "Asia", europe: "Europe", us: "US", late: "Late US" };
const TREND_LABELS = { with: "With", flat: "Flat", against: "Against", unknown: "—" };
const BADGE_LABELS = {
  revenge: "Revenge",
  overtrading: "Overtrading",
  counterTrend: "Counter-trend",
  chased: "Chased",
  gaveBack: "Gave back",
};
const BREAKDOWN_COLS = 6;
const TRADE_COLS = 10;

const dateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Warsaw",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const dateOnly = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", day: "2-digit", month: "short" });

let journal = null;
let dimension = "session";
let bound = false;
let loadedCoin;
let requestId = 0;

const $ = (id) => document.getElementById(id);
const statTone = (value) => (value > 0 ? "positive" : value < 0 ? "negative" : "");
const cellTone = (value) => (value > 0 ? "num-pos" : value < 0 ? "num-neg" : "num-muted");
const grid = (tiles) => `<div class="data-grid">${tiles.join("")}</div>`;
const urlCoin = () => new URLSearchParams(location.search).get("coin") || null;

/** Монета в адресе общая для Chart drill и фильтра Trade log. */
export function setUrlCoin(coin) {
  const url = new URL(location.href);
  if (coin) url.searchParams.set("coin", coin);
  else url.searchParams.delete("coin");
  history.replaceState(null, "", url);
}

function signedPct(value, digits = 1) {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

function holdText(seconds) {
  if (seconds == null) return "—";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

function ciText(summary) {
  return summary.ci95 ? `${fmtMoney(summary.ci95[0])} … ${fmtMoney(summary.ci95[1])}` : "too few days";
}

/** CI красится знаком, только если не накрывает ноль: иначе это ещё не результат. */
function ciTone(summary) {
  if (!summary.ci95 || (summary.ci95[0] <= 0 && summary.ci95[1] >= 0)) return "num-muted";
  return cellTone(summary.avg);
}

function renderFilter(coin) {
  $("tj-filter").innerHTML = coin
    ? chip({
        label: coin,
        title: "Trade log is filtered to this coin",
        remove: { title: "Show all coins", attrs: { "data-clear-coin": true } },
      })
    : "";
}

function renderOverview({ overall, period }) {
  $("tj-period").textContent = `${dateOnly.format(period.from)} – ${dateOnly.format(period.to)}`;
  $("tj-overview").innerHTML = grid([
    stat({ label: "Trades", value: String(overall.n), sub: `${overall.winPct.toFixed(0)}% winners` }),
    stat({
      label: "Net P&L",
      value: fmtMoney(overall.net),
      tone: statTone(overall.net),
      sub: `fees ${fmtMoney(overall.fees, false)}`,
      primary: true,
    }),
    stat({ label: "Avg per trade", value: fmtMoney(overall.avg), tone: statTone(overall.avg), sub: `95% CI ${ciText(overall)}` }),
    stat({
      label: "Flagged at entry",
      value: `${overall.flagged.n} of ${overall.n}`,
      sub: `avg ${fmtMoney(overall.flagged.avg)} vs clean ${fmtMoney(overall.clean.avg)}`,
    }),
  ]);
}

function renderWeek({ week, asOf }) {
  const { current, previous } = week;
  $("tj-week-meta").textContent = `7 days to ${dateOnly.format(asOf)}`;
  if (!current.n && !previous.n) {
    $("tj-week").innerHTML = emptyState({ title: "No trades in the last two weeks" });
    return;
  }
  const prev = (text) => `previous week ${text}`;
  $("tj-week").innerHTML = grid([
    stat({ label: "Trades", value: String(current.n), sub: prev(String(previous.n)) }),
    stat({
      label: "Net P&L",
      value: fmtMoney(current.net ?? 0),
      tone: statTone(current.net ?? 0),
      sub: prev(fmtMoney(previous.net ?? 0)),
    }),
    stat({
      label: "Win rate",
      value: current.n ? `${current.winPct.toFixed(0)}%` : "—",
      sub: prev(previous.n ? `${previous.winPct.toFixed(0)}%` : "—"),
    }),
    stat({ label: "Fees", value: fmtMoney(current.fees ?? 0, false), sub: prev(fmtMoney(previous.fees ?? 0, false)) }),
  ]);
}

function renderDimensions() {
  $("tj-dims").innerHTML = segmented({ options: DIMENSIONS, value: dimension, name: "dim" });
}

function renderBreakdown() {
  const rows = journal.breakdowns[dimension].filter((row) => row.n > 0);
  if (!rows.length) {
    $("tj-breakdown").innerHTML = emptyRow(BREAKDOWN_COLS, { title: "No trades in this cut" });
    return;
  }
  $("tj-breakdown").innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(row.label)}</td>
        <td class="num">${row.n}</td>
        <td class="num">${row.winPct.toFixed(0)}%</td>
        <td class="num ${cellTone(row.net)}">${fmtMoney(row.net)}</td>
        <td class="num ${cellTone(row.avg)}">${fmtMoney(row.avg)}</td>
        <td class="num ${ciTone(row)}">${ciText(row)}</td>
      </tr>`,
    )
    .join("");
}

function renderTrades({ trades, flags, notes }) {
  $("tj-trades-meta").textContent = `last ${trades.length}`;
  $("tj-trades").innerHTML = trades
    .map((trade) => {
      const coin = escapeHtml(trade.coin);
      const trendCard = trade.trend1hPct == null ? "No 1h data at entry" : `1h move at entry ${signedPct(trade.trend1hPct)}`;
      const marks = [
        ...trade.flags.map((key) => badge({ label: BADGE_LABELS[key], tone: "accent", title: flags[key] })),
        ...trade.notes.map((key) => badge({ label: BADGE_LABELS[key], title: notes[key] })),
      ].join(" ");
      return `
      <tr>
        <td>${dateTime.format(trade.entryTime)}</td>
        <td><a href="/journal?view=trades&amp;coin=${encodeURIComponent(trade.coin)}" data-coin-filter="${coin}" data-card="Show only ${coin}">${coin}</a></td>
        <td>${badge({ label: trade.side, tone: trade.side })}</td>
        <td>${SESSION_LABELS[trade.session]}</td>
        <td data-card="${escapeHtml(trendCard)}">${TREND_LABELS[trade.trend]}</td>
        <td class="num">${holdText(trade.holdSeconds)}</td>
        <td class="num">${signedPct(trade.mfePct)} / ${signedPct(trade.maePct)}</td>
        <td class="num ${cellTone(trade.net)}">${fmtMoney(trade.net)}</td>
        <td class="num ${cellTone(trade.net)}">${signedPct(trade.netPct, 2)}</td>
        <td>${marks || "—"}</td>
      </tr>`;
    })
    .join("");
}

function renderUnavailable(title) {
  for (const id of ["tj-overview", "tj-week"]) $(id).innerHTML = emptyState({ title });
  $("tj-period").textContent = "";
  $("tj-week-meta").textContent = "";
  $("tj-trades-meta").textContent = "";
  $("tj-dims").innerHTML = "";
  $("tj-breakdown").innerHTML = emptyRow(BREAKDOWN_COLS, { title });
  $("tj-trades").innerHTML = emptyRow(TRADE_COLS, { title });
}

function bindOnce() {
  if (bound) return;
  bound = true;
  $("tj-dims").addEventListener("click", (event) => {
    const button = event.target.closest("[data-dim]");
    if (!button || !journal) return;
    dimension = button.dataset.dim;
    renderDimensions();
    renderBreakdown();
  });
  $("tj-filter").addEventListener("click", (event) => {
    if (!event.target.closest("[data-clear-coin]")) return;
    setUrlCoin(null);
    mountTradeLog();
  });
  $("tj-trades").addEventListener("click", (event) => {
    const link = event.target.closest("[data-coin-filter]");
    // Ссылка остаётся настоящей: средний клик и «открыть в новой вкладке» работают.
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    setUrlCoin(link.dataset.coinFilter);
    mountTradeLog();
  });
}

/** Показать журнал для монеты из адреса; повторный вызов с той же монетой ничего не делает. */
export async function mountTradeLog() {
  bindOnce();
  const coin = urlCoin();
  if (loadedCoin !== undefined && coin === loadedCoin) return;
  loadedCoin = coin;
  const request = ++requestId;
  renderFilter(coin);
  $("tj-overview").innerHTML = skeletonText(2);
  $("tj-week").innerHTML = skeletonText(2);
  $("tj-breakdown").innerHTML = skeletonRows(BREAKDOWN_COLS);
  $("tj-trades").innerHTML = skeletonRows(TRADE_COLS, 8);
  let data;
  try {
    data = await fetchJson(`/api/trade-journal${coin ? `?coin=${encodeURIComponent(coin)}` : ""}`);
  } catch {
    if (request === requestId) renderUnavailable("Trade log is unavailable");
    return;
  }
  // Ответ на прежнюю монету, пришедший после смены фильтра, не рисуем.
  if (request !== requestId) return;
  journal = data;
  if (journal.empty) {
    renderUnavailable(coin ? `No closed trades on ${coin}` : "No closed trades yet");
    return;
  }
  renderOverview(journal);
  renderWeek(journal);
  renderDimensions();
  renderBreakdown();
  renderTrades(journal);
}
