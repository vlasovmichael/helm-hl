// ─────────────────────────────────────────────────
//  Order Flow — витрина потока HL с адресами участников.
//  Считает и копит tools/flowCollector.mjs, здесь только показ.
//
//  🚨 Витрина ОПИСЫВАЕТ рынок и ничего не предсказывает: ни одна цифра тут не
//  прошла предзаявленный форвард. Читать её как сигнал — тот же класс ошибки,
//  что «винрейт 83%» при отрицательном E[R].
// ─────────────────────────────────────────────────

import { skeletonRows, emptyState, settle } from "../core/placeholders.js";
import { badge, chip, segmented } from "../core/ui.js";

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const usd = (v) => {
  const x = Math.abs(v);
  if (x >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
};
const signed = (v) => (v > 0 ? `+${usd(v)}` : usd(v));

// Роль кошелька — это доля тейкера в обороте, а не размер. Тот, кто стоит
// лимитками, и тот, кто их выносит, зарабатывают на противоположных вещах.
function role(pct) {
  if (pct >= 80) return { label: "taker", tone: "taker" };
  if (pct <= 20) return { label: "maker", tone: "maker" };
  return { label: "mixed", tone: "mixed" };
}

const explorer = (a) => `https://app.hyperliquid.xyz/explorer/address/${a}`;
const addrLink = (a) =>
  `<a class="flow-addr" href="${explorer(a)}" target="_blank" rel="noopener">${short(a)}</a>`;

// ── Кошельки ────────────────────────────────────────────────────────────────
export function renderWallets(el, data) {
  if (!el) return;
  if (!data.ok) {
    settle(el, emptyState({
      glyph: "hourglass",
      title: "Collecting",
      hint: "The flow collector has not written its first bar yet.",
    }));
    return;
  }
  if (!data.wallets.length) {
    settle(el, emptyState({ glyph: "info", title: "No flow in this window" }));
    return;
  }

  const fillerW = Math.max(0, WALLET_ROWS - data.wallets.length);
  const rows = data.wallets.slice(0, WALLET_ROWS).map((w) => {
    const r = role(w.takerPct);
    const pos = w.positions
      .slice(0, 3)
      .map((p) => chip({ label: p.coin, sub: usd(p.ntl), cls: `flow-pos-chip ${p.szi > 0 ? "long" : "short"}` }))
      .join(" ");
    const more = w.positions.length > 3 ? ` <span class="muted">+${w.positions.length - 3}</span>` : "";
    return `<tr>
      <td>${addrLink(w.addr)}</td>
      <td class="num mono">${usd(w.vol)}</td>
      <td class="num flow-role">${badge({ label: `${r.label} ${w.takerPct.toFixed(0)}%`, cls: `flow-role--${r.tone || "mixed"}` })}</td>
      <td class="num mono ${w.net > 0 ? "pos" : "neg"}">${signed(w.net)}</td>
      <td class="num mono muted col-opt">${w.coins}</td>
      <td class="num mono col-opt">${w.equity === null ? "—" : usd(w.equity)}</td>
      <td>${pos || '<span class="muted">flat</span>'}${more}</td>
    </tr>`;
  }).join("");

  settle(el, `
    <table class="table table--compact">
      <thead><tr>
        <th>Wallet</th><th class="num">Volume</th><th class="num">Role</th>
        <th class="num">Net taken</th><th class="num col-opt">Coins</th>
        <th class="num col-opt">Equity</th><th>Open positions</th>
      </tr></thead>
      <tbody>${rows}${Array.from(
        { length: fillerW },
        () => `<tr class="flow-blank"><td colspan="7">&nbsp;</td></tr>`,
      ).join("")}</tbody>
    </table>`);
}

// ── Тепловая карта: время × цена, справа профиль по уровню ──────────────────
// 🚨 Шкала интенсивности логарифмическая: суммы в ячейках различаются на три
// порядка, на линейной вся карта кроме одного пятна уходит в пустоту.
const HEAT_ROWS = 24;
const HEAT_COLS = 48;

const heatAlpha = (v, max) =>
  v <= 0 ? 0 : Math.min(1, 0.12 + (0.88 * Math.log10(1 + v)) / Math.log10(1 + max));

export function renderLiqMap(el, data) {
  if (!el) return;
  if (!data.ok) {
    settle(el, emptyState({
      glyph: "hourglass",
      title: "Collecting",
      hint: "Position snapshots start after the first sweep.",
    }));
    return;
  }
  if (!data.cells?.length) {
    settle(el, emptyState({
      glyph: "info",
      title: "No liquidation prices in range",
      hint: "Cross positions without a liquidation price are excluded — the account carries them elsewhere.",
    }));
    return;
  }

  const { cols, rows, range, ref, max } = data;

  // Профиль по уровню цены: сумма ячеек строки за всё окно.
  const byRow = new Array(rows).fill(null).map(() => ({ long: 0, short: 0 }));
  const grid = new Map();
  for (const c of data.cells) {
    grid.set(`${c.x}|${c.y}`, c);
    byRow[c.y].long += c.longUsd;
    byRow[c.y].short += c.shortUsd;
  }
  const rowMax = Math.max(...byRow.map((r) => r.long + r.short)) || 1;

  const priceAt = (y) => ref * (1 + (range - ((y + 0.5) / rows) * 2 * range) / 100);
  const fmtPx = (p) => (p < 1 ? p.toPrecision(4) : p.toFixed(p < 100 ? 2 : 0));

  const cells = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const c = grid.get(`${x}|${y}`);
      if (!c) { cells.push('<i class="heat-cell"></i>'); continue; }
      const total = c.longUsd + c.shortUsd;
      const side = c.longUsd >= c.shortUsd ? "long" : "short";
      const when = new Date(data.t0 + ((x + 0.5) / cols) * (data.t1 - data.t0));
      cells.push(
        `<i class="heat-cell ${side}" style="--a:${heatAlpha(total, max).toFixed(3)}"` +
        ` data-tip="${usd(total)} · ${fmtPx(priceAt(y))} · ${c.n} ${c.n === 1 ? "position" : "positions"} · ${when.toISOString().slice(11, 16)}"></i>`,
      );
    }
  }

  // Подписи цены — каждая четвёртая: ось обязана читаться, но не заслонять карту.
  const ticks = [];
  for (let y = 0; y < rows; y += 4) {
    ticks.push(`<span class="heat-tick" style="--y:${y}">${fmtPx(priceAt(y))}</span>`);
  }

  const profile = byRow
    .map((r, y) => {
      const total = r.long + r.short;
      const side = r.long >= r.short ? "long" : "short";
      return `<i class="heat-prof ${side}" style="--y:${y};--w:${((total / rowMax) * 100).toFixed(1)}%"></i>`;
    })
    .join("");

  const nowY = ((range - 0) / (2 * range)) * rows;

  settle(el, `
    <div class="flow-head">
      <span>${data.hours}h · ${usd(data.cells.reduce((a, c) => a + c.longUsd + c.shortUsd, 0))} notional</span>
      <span class="flq-legend">
        <i class="flq-key long"></i> longs liquidate down
        <i class="flq-key short"></i> shorts liquidate up
      </span>
    </div>
    <div class="heat" style="--cols:${cols};--rows:${rows}">
      <div class="heat-axis">${ticks.join("")}</div>
      <div class="heat-plot">
        ${cells.join("")}
        <div class="heat-now" style="--y:${nowY.toFixed(2)}">
          <span class="heat-now-tag">${fmtPx(ref)}</span>
        </div>
      </div>
      <div class="heat-profile">${profile}</div>
    </div>`);
}

// ── Нетто-поток тейкеров ────────────────────────────────────────────────────
export function renderNetFlow(el, data) {
  if (!el) return;
  if (!data.ok || !data.top?.length) {
    settle(el, emptyState({
      glyph: data.ok ? "info" : "hourglass",
      title: data.ok ? "No taker flow in this window" : "Collecting",
    }));
    return;
  }

  const max = Math.max(...data.top.map((t) => Math.abs(t.net))) || 1;
  // 🚨 Число строк добивается до NET_ROWS пустышками. У разных монет кошельков
  // разное количество, и без добивки карточка меняла высоту на каждом
  // переключении монеты — приём тот же, что в ленте Hot Movers.
  const filler = Math.max(0, NET_ROWS - data.top.length);
  const rows = data.top.slice(0, NET_ROWS).map((t) => {
    const w = (Math.abs(t.net) / max) * 100;
    return `<tr>
      <td>${addrLink(t.addr)}</td>
      <td class="num mono ${t.net > 0 ? "pos" : "neg"}">${signed(t.net)}</td>
      <td>
        <span class="flow-track">
          <i class="flow-fill ${t.net > 0 ? "pos" : "neg"}" style="width:${(w / 2).toFixed(1)}%"></i>
        </span>
      </td>
      <td class="num mono muted col-opt">${usd(t.taker + t.maker)}</td>
    </tr>`;
  }).join("");

  const blanks = Array.from(
    { length: filler },
    () => `<tr class="flow-blank"><td colspan="4">&nbsp;</td></tr>`,
  ).join("");

  settle(el, `
    <table class="table table--compact flow-net">
      <thead><tr>
        <th>Wallet</th><th class="num">Net taken</th><th>Direction</th>
        <th class="num col-opt">Total traded</th>
      </tr></thead>
      <tbody>${rows}${blanks}</tbody>
    </table>`);
}

export const flowSkeleton = (el, cols) => { if (el) el.innerHTML = skeletonRows(cols, 6); };

/** Скелетон карты — та же сетка, что и сама карта: подмена не меняет габарит. */
export function heatSkeleton(el) {
  if (!el) return;
  const cells = Array.from({ length: HEAT_ROWS * HEAT_COLS }, () => '<i class="heat-cell sk"></i>').join("");
  el.innerHTML =
    `<div class="heat" style="--cols:${HEAT_COLS};--rows:${HEAT_ROWS}">` +
    `<div class="heat-axis"></div><div class="heat-plot">${cells}</div>` +
    `<div class="heat-profile"></div></div>`;
}

/** Селектор монет — компонент дизайн-системы, не самодельные кнопки. */
export function renderCoinPicker(el, coins, value, name = "coin") {
  if (!el) return;
  const list = coins.slice(0, 8).map((c) => (typeof c === "string" ? c : c.name));
  if (value && !list.includes(value)) list.unshift(value);
  el.innerHTML = segmented({
    name,
    value,
    options: list.map((c) => ({ value: c, label: c })),
  });
}
