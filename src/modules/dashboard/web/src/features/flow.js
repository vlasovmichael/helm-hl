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
import { drawLiqHeat, clearLiqHeat } from "../charts/liqHeatChart.js";

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

const WALLET_ROWS = 25;  // строк в рейтинге кошельков
const NET_ROWS = 15;     // строк в нетто-потоке: высота карточки постоянна

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
// Картинка — в charts/liqHeatChart.js, здесь пустые состояния, шапка, легенда.
// 🚨 Интервал свечей — под ФАКТИЧЕСКОЕ окно карты, а не под окно витрины: сбор
// бывает моложе окна, и на трёх часах 15m-свечи дают десяток столбиков.
const klInterval = (ms) => {
  const h = ms / 3_600_000;
  return h <= 3 ? "1m" : h <= 12 ? "5m" : h <= 40 ? "15m" : "1h";
};

export async function renderLiqMap(el, data) {
  if (!el) return;
  const empty = (state) => { clearLiqHeat(); settle(el, emptyState(state)); };

  if (!data.ok)
    return empty({
      glyph: "hourglass",
      title: "Collecting",
      hint: "Position snapshots start after the first sweep.",
    });
  if (!data.cells?.length)
    return empty({
      glyph: "info",
      title: "No liquidation prices in range",
      hint: "Cross positions without a liquidation price are excluded — the account carries them elsewhere.",
    });

  let kl = [];
  try {
    const r = await fetch(`/api/candles?coin=${data.coin}&interval=${klInterval(data.t1 - data.t0)}`);
    kl = r.ok ? await r.json() : [];
  } catch { /* карта без свечей бессмысленна — уйдём в пустое состояние ниже */ }
  if (!Array.isArray(kl) || !kl.length)
    return empty({ glyph: "info", title: "No candles for this coin" });

  // Каркас ставим один раз: график живёт между тиками, пересоздавать его на
  // каждом обновлении — мигание и потеря зума, который поставил оператор.
  if (!el.querySelector(".liqheat-plot")) {
    el.innerHTML = `
      <div class="flow-head">
        <span class="liqheat-sum"></span>
        <span class="flq-legend">
          <i class="flq-ramp"></i> less fuel → more fuel · below price = longs, above = shorts
        </span>
      </div>
      <div class="liqheat-plot"></div>`;
  }
  el.querySelector(".liqheat-sum").textContent =
    `${data.hours}h · ${usd(data.total)} notional · ${fmtPxShort(data.ref)} now`;

  const ok = await drawLiqHeat(el.querySelector(".liqheat-plot"), data, kl);
  if (!ok) empty({ glyph: "info", title: "No candles for this window" });
}

const fmtPxShort = (p) => (p == null ? "—" : p >= 1000 ? p.toFixed(0) : p >= 1 ? p.toFixed(3) : p.toPrecision(4));

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
  el.innerHTML = '<div class="liqheat-sk sk-block"></div>';
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
