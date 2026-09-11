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

// ── Карта ликвидаций ────────────────────────────────────────────────────────
// Форма выбрана по задаче: величина на шкале цены → горизонтальные бары с осью
// цены по вертикали. Лонги ликвидируются ВНИЗ, шорты ВВЕРХ, поэтому это не одна
// величина, а две стороны относительно текущей цены — она и есть базовая линия.
//
// 🚨 Стороны не складываются в один бар: сумма «сколько всего ликвидируется на
// уровне» не имеет смысла, пока цена не пришла на этот уровень с нужной стороны.

const WALLET_ROWS = 25;  // строк в рейтинге кошельков
const NET_ROWS = 15;     // строк в нетто-потоке: высота карточки постоянна
const LIQ_H = 22;        // высота уровня
const LIQ_LABEL_W = 74;  // колонка цены слева
const LIQ_VAL_W = 96;    // колонка суммы справа

export function renderLiqMap(el, data) {
  if (!el) return;
  if (!data.ok || !data.buckets.length) {
    settle(el, emptyState({
      glyph: data.ok ? "info" : "hourglass",
      title: data.ok ? "No liquidation prices in range" : "Collecting",
      hint: data.ok
        ? "Cross positions without a liquidation price are excluded — the account carries them elsewhere."
        : "Position snapshots start after the first sweep.",
    }));
    return;
  }

  const rows = data.buckets.slice().sort((a, b) => b.pct - a.pct);
  const max = Math.max(...rows.map((b) => b.longUsd + b.shortUsd)) || 1;
  const h = rows.length * LIQ_H;

  // Текущая цена — базовая линия графика, а не подпись сбоку: весь смысл карты
  // в том, насколько далеко от неё стоят чужие вынужденные закрытия.
  const zeroIdx = rows.findIndex((b) => b.pct <= 0);
  const zeroY = (zeroIdx < 0 ? rows.length : zeroIdx) * LIQ_H;

  const bars = rows.map((b, i) => {
    const total = b.longUsd + b.shortUsd;
    const isLong = b.longUsd >= b.shortUsd;
    const px = data.ref * (1 + b.pct / 100);
    const w = (total / max) * 100;
    const y = i * LIQ_H;
    const label = px < 1 ? px.toPrecision(4) : px.toFixed(px < 100 ? 2 : 0);
    return `<div class="flq-row ${isLong ? "long" : "short"}" style="--y:${y}px;--w:${w.toFixed(1)}%;--i:${i}"
        tabindex="0" data-tip="${usd(total)} · ${b.n} ${b.n === 1 ? "wallet" : "wallets"} · ${isLong ? "longs" : "shorts"} liquidate at ${label}">
        <span class="flq-px">${label}</span>
        <span class="flq-track"><i class="flq-bar"></i></span>
        <span class="flq-usd">${usd(total)}</span>
      </div>`;
  }).join("");

  settle(el, `
    <div class="flow-head">
      <span>${data.wallets} wallets · ${usd(data.total)} notional</span>
      <span class="flq-legend">
        <i class="flq-key long"></i> longs liquidate down
        <i class="flq-key short"></i> shorts liquidate up
      </span>
    </div>
    <div class="flq" style="--liq-h:${h}px;--label-w:${LIQ_LABEL_W}px;--val-w:${LIQ_VAL_W}px">
      <div class="flq-plot" style="height:${h}px">
        ${bars}
        <div class="flq-now" style="top:${zeroY}px">
          <span class="flq-now-tag">${data.ref < 1 ? data.ref.toPrecision(4) : data.ref.toFixed(data.ref < 100 ? 2 : 0)}</span>
        </div>
      </div>
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
