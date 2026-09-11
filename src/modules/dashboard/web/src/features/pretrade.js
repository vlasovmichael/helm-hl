// ─────────────────────────────────────────────────
//  Pre-trade — карточка решения перед входом.
//
//  🚨 Стороны здесь нет и не будет: направление в ценовом ряду не
//  предсказуемо. Карточка отвечает на вопросы, у которых ответ есть —
//  сколько монета проходит, сколько стоит круг, какая пара цель/стоп
//  окупается, какой размер держит риск и сколько попыток оплачено бюджетом.
// ─────────────────────────────────────────────────

import { emptyState, settle, skeletonText } from "../core/placeholders.js";
import { badge, segmented } from "../core/ui.js";

const bp = (v) => (v == null ? "—" : `${v.toFixed(1)} bp`);
const usd = (v) =>
  v == null ? "—" : Math.abs(v) >= 1000 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;
const pp = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)} pp`);

const TONE = { ok: "pt--ok", warn: "pt--warn", bad: "pt--bad" };

/** Одна строка «вопрос → число → чем это число является». */
const line = (label, value, note, cls = "") =>
  `<div class="pt-line ${cls}">
     <span class="pt-label">${label}</span>
     <span class="pt-value mono">${value}</span>
     <span class="pt-note">${note}</span>
   </div>`;

/**
 * Скелетон карточки. Ставится ТОЛЬКО на смену монеты: settle() играет вход
 * лишь поверх скелетона, и без этого условия карточка дёргалась бы на каждом
 * тике поллинга — то самое «движение по таймеру», которого в системе нет.
 */
export function pretradeSkeleton(el) {
  if (el) el.innerHTML = skeletonText(8);
}

export function renderPretrade(el, d) {
  if (!el) return;

  if (!d.ok) {
    settle(el, emptyState({
      glyph: "hourglass",
      title: "Calibrator has not run yet",
      hint: "The grid is rebuilt on a schedule — the card fills in once it lands.",
    }));
    return;
  }

  if (!d.coin) {
    settle(el, emptyState({
      glyph: "info",
      title: d.missing ? `${d.missing} is not covered` : "Pick a coin",
      // Отсутствие монеты в сетке — это ответ, а не пробел.
      hint: d.missing
        ? "The grid only covers coins above $3M daily volume. Below that the spread is wider than anything the card could recommend."
        : "Cheapest attempts first.",
    }));
    return;
  }

  const c = d.coin;
  const v = c.verdict;
  const day = d.day;

  // Порядок строк — это и есть метод: сначала цена попытки, потом размер,
  // и только в конце то, что оператор выбирает сам.
  const body = `
    <div class="pt-verdict ${TONE[v.tone] || ""}">
      <b class="pt-coin">${c.name}</b>
      ${badge({ label: v.label, cls: `pt-badge pt-badge--${v.tone}` })}
      <span class="pt-note">${v.note}</span>
    </div>

    ${line("Typical range", bp(c.atr), `median 1h range · cost is ${c.share.toFixed(0)}% of it`)}
    ${line("Round trip", bp(c.cost), `fees + ${c.half.toFixed(2)} bp half-spread`)}
    ${line("Best pair", `${bp(c.best.tgt)} / ${bp(c.best.stp)}`, `target / stop · ${c.best.mt}× and ${c.best.ms}× the range · ${d.mode === "M" ? "limit entry" : "market entry"}`)}
    ${line("Hit rate needed", `${c.best.need.toFixed(1)}%`, `market gives ${c.best.hit.toFixed(1)}% ± ${c.best.ci.toFixed(1)} · gap ${pp(c.best.gap)}`, c.best.gap > 0 ? "pt-row--warn" : "pt-row--ok")}
    ${line("Direction", "coin flip", "not shown because it is not predictable — autocorrelation −0.01", "pt-row--flat")}

    <div class="pt-split"></div>

    ${line("Position size", usd(c.size.notional), c.size.riskUsd == null
      ? "needs account value"
      : `risking ${usd(c.size.riskUsd)} (${c.size.riskPct}%) at a ${bp(c.best.stp)} stop`)}
    ${line("Costs you", usd(c.size.costUsd), "round trip at that size")}
    ${line("Attempts left today", day.triesLeft == null ? "—" : String(day.triesLeft),
      day.feeBudgetPct
        ? `fee budget ${day.feeBudgetPct}% of equity · spent ${usd(day.feesUsd)}`
        : "fee budget not set")}
    ${day.halted ? `<div class="pt-halt">Daily stop hit — ${usd(day.netUsd)} net. New entries are closed until midnight.</div>` : ""}
  `;

  settle(el, body);
}

/** Список монет по цене попытки. Замена отбору по рывку — тот вычитал. */
export function renderPretradeRanked(el, d, current, onPick) {
  if (!el || !d.ok) return;
  el.innerHTML = segmented({
    name: "coin",
    value: current,
    options: d.ranked.slice(0, 10).map((r) => ({ value: r.coin, label: r.coin })),
  });
  el.onclick = (e) => {
    const coin = e.target.closest("[data-coin]")?.dataset.coin;
    if (coin) onPick(coin);
  };
}
