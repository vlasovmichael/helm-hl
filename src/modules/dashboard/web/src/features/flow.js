// ─────────────────────────────────────────────────
//  Order Flow — витрина потока HL с адресами участников.
//  Считает и копит tools/flowCollector.mjs, здесь только показ.
//
//  🚨 Витрина ОПИСЫВАЕТ рынок и ничего не предсказывает: ни одна цифра тут не
//  прошла предзаявленный форвард. Читать её как сигнал — тот же класс ошибки,
//  что «винрейт 83%» при отрицательном E[R].
// ─────────────────────────────────────────────────

import { skeletonRows, emptyState, settle } from "../core/placeholders.js";

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
  if (pct >= 80) return { label: "taker", tone: "hot" };
  if (pct <= 20) return { label: "maker", tone: "cool" };
  return { label: "mixed", tone: "" };
}

const explorer = (a) => `https://app.hyperliquid.xyz/explorer/address/${a}`;

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

  const rows = data.wallets.map((w) => {
    const r = role(w.takerPct);
    const pos = w.positions
      .slice(0, 3)
      .map((p) => `<span class="chip${p.szi > 0 ? " chip--long" : " chip--short"}">${p.coin} ${usd(p.ntl)}</span>`)
      .join(" ");
    const more = w.positions.length > 3 ? ` <span class="muted">+${w.positions.length - 3}</span>` : "";
    return `<tr>
      <td class="strong mono"><a href="${explorer(w.addr)}" target="_blank" rel="noopener">${short(w.addr)}</a></td>
      <td class="num mono">${usd(w.vol)}</td>
      <td class="num"><span class="chip${r.tone ? ` chip--${r.tone}` : ""}">${r.label} ${w.takerPct.toFixed(0)}%</span></td>
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
      <tbody>${rows}</tbody>
    </table>`);
}

// ── Карта ликвидаций ────────────────────────────────────────────────────────
// Приём отрисовки взят у стакана (.ob-row / .ob-bar): те же уровни цены с
// заливкой пропорционально объёму. Лонги ликвидируются вниз, шорты вверх —
// поэтому стороны раскрашены как bid/ask и НЕ складываются в одну полосу.
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

  const max = Math.max(...data.buckets.map((b) => b.longUsd + b.shortUsd));
  const rows = data.buckets
    .slice()
    .sort((a, b) => b.pct - a.pct)
    .map((b) => {
      const total = b.longUsd + b.shortUsd;
      const isLong = b.longUsd >= b.shortUsd;
      const px = data.ref * (1 + b.pct / 100);
      return `<div class="ob-row ${isLong ? "bid" : "ask"}">
        <span class="ob-bar" style="width:${((total / max) * 100).toFixed(1)}%"></span>
        <span class="ob-tag">${b.pct > 0 ? "+" : ""}${b.pct}%</span>
        <span class="ob-px">${px < 1 ? px.toPrecision(4) : px.toFixed(px < 100 ? 2 : 0)}</span>
        <span class="ob-sz">${usd(total)}</span>
        <span class="ob-usd">${b.n}</span>
      </div>`;
    }).join("");

  settle(el, `
    <div class="flow-liq-head">
      <span>${data.wallets} wallets · ${usd(data.total)} notional tracked</span>
      <span class="muted">longs liquidate down, shorts up · % from reference price</span>
    </div>
    <div class="ob-ladder">${rows}</div>`);
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
  const rows = data.top.map((t) => {
    const w = (Math.abs(t.net) / max) * 100;
    return `<tr>
      <td class="strong mono"><a href="${explorer(t.addr)}" target="_blank" rel="noopener">${short(t.addr)}</a></td>
      <td class="num mono ${t.net > 0 ? "pos" : "neg"}">${signed(t.net)}</td>
      <td class="flow-track">
        <i class="flow-fill ${t.net > 0 ? "pos" : "neg"}" style="width:${w.toFixed(1)}%"></i>
      </td>
      <td class="num mono muted col-opt">${usd(t.taker + t.maker)}</td>
    </tr>`;
  }).join("");

  settle(el, `
    <table class="table table--compact flow-net">
      <thead><tr>
        <th>Wallet</th><th class="num">Net taken</th><th>Direction</th>
        <th class="num col-opt">Total traded</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`);
}

export const flowSkeleton = (el, cols) => { if (el) el.innerHTML = skeletonRows(cols, 6); };
