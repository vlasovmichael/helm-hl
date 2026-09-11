import "./src/styles/index.scss";
// ─────────────────────────────────────────────────
// flow.html — поток ордеров HL с адресами участников.
// 🚨 Страница описательная: вердиктов не выносит и сигналов не даёт. Ни один
// из трёх срезов не проходил предзаявленный форвард.
// ─────────────────────────────────────────────────

import { bindTheme, startFooterTimer } from "./src/core/shell.js";
import { mountPageHeader } from "./src/core/pageHeader.js";
import { mountTopnav } from "./src/core/topnav.js";
import {
  renderWallets,
  renderLiqMap,
  renderNetFlow,
  flowSkeleton,
  renderCoinPicker,
} from "./src/features/flow.js";
import { segmented } from "./src/core/ui.js";

mountTopnav("flow");
mountPageHeader({ eyebrow: "Research · on-chain participants", title: "Order Flow" });
bindTheme();
startFooterTimer();

const state = { hours: 24, liqCoin: "BTC", netCoin: "BTC", coins: [] };

const el = (id) => document.getElementById(id);
const getJson = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

/** Селектор монеты — общий компонент, монеты те, по которым поток уже собран. */
function coinPicker(node, value, onPick) {
  if (!node) return;
  renderCoinPicker(node, state.coins, value);
  node.onclick = (e) => {
    const c = e.target.closest("[data-coin]")?.dataset.coin;
    if (c) onPick(c);
  };
}

function windowPicker() {
  const node = el("flow-window");
  if (!node) return;
  node.innerHTML = segmented({
    name: "h",
    value: String(state.hours),
    options: [6, 24, 72].map((h) => ({ value: String(h), label: `${h}h` })),
  });
  node.onclick = (e) => {
    const h = Number(e.target.closest("[data-h]")?.dataset.h);
    if (h) { state.hours = h; loadWallets(); }
  };
}

async function loadWallets() {
  windowPicker();
  flowSkeleton(el("flow-wallets"), 7);
  try {
    renderWallets(el("flow-wallets"), await getJson(`/api/flow/wallets?hours=${state.hours}`));
  } catch {
    renderWallets(el("flow-wallets"), { ok: false });
  }
}

async function loadLiq() {
  coinPicker(el("flow-liq-coin"), state.liqCoin, (c) => { state.liqCoin = c; loadLiq(); });
  flowSkeleton(el("flow-liqmap"), 4);
  try {
    renderLiqMap(el("flow-liqmap"), await getJson(`/api/flow/liqmap?coin=${state.liqCoin}`));
  } catch {
    renderLiqMap(el("flow-liqmap"), { ok: false, buckets: [] });
  }
}

async function loadNet() {
  coinPicker(el("flow-net-coin"), state.netCoin, (c) => { state.netCoin = c; loadNet(); });
  flowSkeleton(el("flow-net"), 4);
  try {
    renderNetFlow(el("flow-net"), await getJson(`/api/flow/coin?coin=${state.netCoin}&hours=${state.hours}`));
  } catch {
    renderNetFlow(el("flow-net"), { ok: false });
  }
}

async function refresh() {
  try {
    const c = await getJson("/api/flow/coins");
    if (c.ok) state.coins = c.coins;
  } catch { /* витрина исследовательская: молчим, следующий тик перерисует */ }
  await Promise.all([loadWallets(), loadLiq(), loadNet()]);
}

refresh();
setInterval(refresh, 60_000);
